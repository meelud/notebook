import { buildScale, detectMood, analyzeText, buildVoicing, hashText, ROOT_CANDIDATES_LOW, ROOT_CANDIDATES_MID, MODE_ORDER } from './mood.js';

// ──────────────────────────────────────────────────────────────
//  Audio Context & Master Bus
// ──────────────────────────────────────────────────────────────
export let ac;
function ensureCtx() {
  if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
  // resume() returns a Promise that rejects on iOS/Safari before the first user
  // gesture — catch it so we don't throw an unhandled rejection. unlockAudio()
  // in main.js retries on the next interaction.
  if (ac.state === 'suspended') {
    try { ac.resume().catch(() => {}); } catch (e) {}
  }
  return ac;
}

// ── Master Bus: Compressor → Destination ──
let masterComp, masterGain;
function getMasterBus() {
  if (masterComp) return masterGain;
  const c = ensureCtx();
  masterComp = c.createDynamicsCompressor();
  masterComp.threshold.value = -8;   // only catch peaks above -8dB
  masterComp.knee.value = 20;        // very soft knee — transparent
  masterComp.ratio.value = 3;        // gentle ratio
  masterComp.attack.value = 0.01;    // fast enough to catch transients
  masterComp.release.value = 0.25;   // smooth release
  masterGain = c.createGain();
  masterGain.gain.value = 0.85;      // slight headroom
  masterGain.connect(masterComp);
  masterComp.connect(c.destination);
  return masterGain;
}

// ──────────────────────────────────────────────────────────────
//  Seeded RNG (UNTOUCHED — deterministic core)
// ──────────────────────────────────────────────────────────────
let _rng;
export function seedRng(seed) {
  let s = seed >>> 0;
  _rng = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  // Bug A fix: reset the stepwise-melody cursor on every (re)seed so the same
  // text always starts the melody from the same point, independent of what was
  // played before. Restores the "same text = same song" guarantee. Timbres,
  // voice selection and mix are untouched — only note ORDER becomes deterministic.
  lastNoteIndex = 3;
}
function rnd(a = 0, b = 1) { return _rng() * (b - a) + a; }
function pick(arr) { return arr[Math.floor(_rng() * arr.length)]; }
function chance(p) { return _rng() < p; }

// ═══════════════════════════════════════════════════════════════
//  Noise Buffer Cache — Production-Grade LRU with Memory Pressure
// ═══════════════════════════════════════════════════════════════

/**
 * @typedef {Object} CacheEntry
 * @property {AudioBuffer} buffer — the cached audio buffer
 * @property {number} byteSize — approximate memory footprint in bytes
 * @property {number} lastAccess — timestamp from performance.now()
 * @property {number} hitCount — cache hit counter for analytics
 */

/** @type {Map<string, CacheEntry>} */
const noiseCache = new Map();

/** @type {number} — max entries before LRU eviction */
const MAX_CACHE_ENTRIES = 50;

/**
 * @type {number} — max approximate bytes before aggressive cleanup.
 * Adaptive: 64MB for mobile, 128MB for desktop (detected by screen width heuristic).
 */
const MAX_CACHE_BYTES = (typeof window !== 'undefined' && window.innerWidth < 768)
  ? 64 * 1024 * 1024   // Mobile: conservative
  : 128 * 1024 * 1024; // Desktop: generous

/** @type {number} — current approximate byte size of all cached buffers */
let currentCacheBytes = 0;

/** @type {boolean} — enable verbose logging in development only */
const DEBUG_CACHE = (() => {
  try {
    return typeof location !== 'undefined' &&
           (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
  } catch (e) {
    return false;
  }
})();

/**
 * Calculate approximate byte size of an AudioBuffer.
 * Float32 = 4 bytes per sample × channels × length.
 * @param {AudioBuffer} buf
 * @returns {number}
 */
function estimateBufferBytes(buf) {
  return buf.length * buf.numberOfChannels * 4;
}

/**
 * Evict the oldest entry (LRU) and update byte tracking.
 * @returns {boolean} — true if an entry was evicted
 */
function evictLRU() {
  if (noiseCache.size === 0) return false;

  const oldestKey = noiseCache.keys().next().value;
  const entry = noiseCache.get(oldestKey);

  noiseCache.delete(oldestKey);
  currentCacheBytes -= entry.byteSize;

  if (DEBUG_CACHE) {
    // eslint-disable-next-line no-console
    console.log(
      `[🔴 Cache Evict] key: "${oldestKey}", ` +
      `freed: ${(entry.byteSize / 1024).toFixed(1)}KB, ` +
      `remaining: ${noiseCache.size} entries`
    );
  }

  return true;
}

/**
 * Aggressive cleanup: remove entries until we're under the byte limit.
 * Removes 25% of entries (oldest first) in one batch for efficiency.
 */
function evictUnderPressure() {
  const targetCount = Math.floor(noiseCache.size * 0.75); // keep 75%
  let evicted = 0;

  while (noiseCache.size > targetCount && noiseCache.size > 0) {
    if (evictLRU()) evicted++;
  }

  if (DEBUG_CACHE && evicted > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[⚠️ Memory Pressure] Evicted ${evicted} entries, ` +
      `${noiseCache.size} remaining, ` +
      `${(currentCacheBytes / 1024 / 1024).toFixed(2)}MB used`
    );
  }
}

/**
 * Memory pressure monitoring (Chrome-only, guarded).
 * Checks heap usage every 10 seconds and triggers cleanup if >80%.
 */
(function setupMemoryPressure() {
  if (typeof performance === 'undefined' || !performance.memory) return;

  const CHECK_INTERVAL = 10000;

  setInterval(() => {
    try {
      const used = performance.memory.usedJSHeapSize;
      const total = performance.memory.totalJSHeapSize;
      const ratio = used / total;

      // If heap usage > 80%, trigger cache cleanup
      if (ratio > 0.8 && noiseCache.size > 10) {
        if (DEBUG_CACHE) {
          // eslint-disable-next-line no-console
          console.log(`[🚨 Heap Pressure] ${(ratio * 100).toFixed(1)}% used`);
        }
        evictUnderPressure();
      }
    } catch (e) {
      // Silently fail if memory API becomes unavailable
    }
  }, CHECK_INTERVAL);
})();

/**
 * Get or create a noise buffer. LRU eviction prevents unbounded growth.
 *
 * @param {string} key — noise type (e.g. 'breath', 'wind')
 * @param {number} dur — duration in seconds
 * @param {function(Float32Array, number): void} generatorFn — fills the buffer
 * @returns {AudioBuffer}
 */
function getOrCreateNoiseBuffer(key, dur, generatorFn) {
  const ctx = ensureCtx();

  // Round duration to 0.1s to avoid near-duplicate keys
  const roundedDur = Math.round(dur * 10) / 10;
  const cacheKey = `${key}_${roundedDur}_${ctx.sampleRate}`;

  // ── Cache Hit: promote to MRU position ──
  const existing = noiseCache.get(cacheKey);
  if (existing) {
    // Move to end (most-recently-used) by re-inserting
    noiseCache.delete(cacheKey);
    existing.lastAccess = performance.now();
    existing.hitCount++;
    noiseCache.set(cacheKey, existing);

    if (DEBUG_CACHE && existing.hitCount === 1) {
      // eslint-disable-next-line no-console
      console.log(`[🟢 Cache Hit] ${cacheKey} (hits: ${existing.hitCount})`);
    }

    return existing.buffer;
  }

  // ── Cache Miss: generate new buffer ──
  // Using Math.ceil to ensure integer sample count (Web Audio API requirement)
  const bufLen = Math.ceil(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
  generatorFn(buf.getChannelData(0), bufLen);

  const byteSize = estimateBufferBytes(buf);

  // ── Evict if at capacity (bytes or entries) ──
  while (
    (noiseCache.size >= MAX_CACHE_ENTRIES ||
     currentCacheBytes + byteSize > MAX_CACHE_BYTES) &&
    noiseCache.size > 0
  ) {
    evictLRU();
  }

  // ── Insert new entry ──
  /** @type {CacheEntry} */
  const entry = {
    buffer: buf,
    byteSize,
    lastAccess: performance.now(),
    hitCount: 0,
  };

  noiseCache.set(cacheKey, entry);
  currentCacheBytes += byteSize;

  if (DEBUG_CACHE) {
    // eslint-disable-next-line no-console
    console.log(
      `[🔵 Cache Miss] ${cacheKey}, ` +
      `size: ${(byteSize / 1024).toFixed(1)}KB, ` +
      `entries: ${noiseCache.size}, ` +
      `total: ${(currentCacheBytes / 1024 / 1024).toFixed(2)}MB`
    );
  }

  return buf;
}

/**
 * Manually clear the entire cache. Useful for:
 * - Long-running sessions (hours)
 * - Memory debugging
 * - Before recording (clean state)
 * - After playback stops
 */
export function clearNoiseCache() {
  const count = noiseCache.size;
  const bytes = currentCacheBytes;

  noiseCache.clear();
  currentCacheBytes = 0;

  if (DEBUG_CACHE && count > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[🗑️ Cache Clear] ${count} entries, ` +
      `${(bytes / 1024 / 1024).toFixed(2)}MB freed`
    );
  }
}

/**
 * Get cache statistics for debugging/monitoring.
 * @returns {{entries: number, bytes: number, bytesFormatted: string, maxEntries: number, maxBytes: number, maxBytesFormatted: string}}
 */
export function getNoiseCacheStats() {
  return {
    entries: noiseCache.size,
    bytes: currentCacheBytes,
    bytesFormatted: `${(currentCacheBytes / 1024 / 1024).toFixed(2)}MB`,
    maxEntries: MAX_CACHE_ENTRIES,
    maxBytes: MAX_CACHE_BYTES,
    maxBytesFormatted: `${(MAX_CACHE_BYTES / 1024 / 1024).toFixed(0)}MB`,
  };
}

// ──────────────────────────────────────────────────────────────
//  Reverb — Task 3: dark warm reverb (LP-filtered noise buffer)
// ──────────────────────────────────────────────────────────────
let reverbNode;
function buildReverb() {
  const c = ensureCtx();
  const len = 3.2, rate = c.sampleRate, frames = rate * len;
  const buf = c.createBuffer(2, frames, rate);
  // generate LP-filtered noise for a dark, warm reverb tail (Burial aesthetic)
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let prev = 0;
    const lpCoeff = 0.72; // strong LP filtering — removes all harshness from tail
    for (let i = 0; i < frames; i++) {
      const noise = _rng() * 2 - 1;
      // one-pole LP filter applied directly during buffer generation
      prev = prev * lpCoeff + noise * (1 - lpCoeff);
      // exponential decay envelope
      data[i] = prev * Math.pow(1 - i / frames, 2.2);
    }
  }
  const conv = c.createConvolver();
  conv.buffer = buf;
  // reverb send chain: convolver → gentle LP to darken further → master bus
  const rvbLP = c.createBiquadFilter();
  rvbLP.type = 'lowpass';
  rvbLP.frequency.value = 2200; // dark reverb — cut highs
  const rvbGain = c.createGain();
  rvbGain.gain.value = 0.35;
  conv.connect(rvbLP);
  rvbLP.connect(rvbGain);
  rvbGain.connect(getMasterBus());
  reverbNode = conv;
}

// ──────────────────────────────────────────────────────────────
//  Voice / Polyphony Management — Task 2: Voice Stealing
// ──────────────────────────────────────────────────────────────
const MAX_POLY = 4; // max simultaneous word-triggered notes
const activeVoices = []; // { gainNode, startTime, release() }

function registerVoice(gainNode, releaseTime, extraNodes = []) {
  const entry = { gainNode, startTime: ac.currentTime, releaseTime, extraNodes };
  activeVoices.push(entry);
  // if over polyphony limit, fade out oldest voice
  while (activeVoices.length > MAX_POLY) {
    const oldest = activeVoices.shift();
    const now = ac.currentTime;
    try {
      oldest.gainNode.gain.cancelScheduledValues(now);
      oldest.gainNode.gain.setValueAtTime(oldest.gainNode.gain.value, now);
      oldest.gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
      // Disconnect connections gently after fade out complete
      setTimeout(() => {
        try { oldest.gainNode.disconnect(); } catch (e) {}
        if (oldest.extraNodes) {
          oldest.extraNodes.forEach(node => { try { node.disconnect(); } catch(e){} });
        }
      }, 200);
    } catch(e) {}
  }
}

function cleanupVoices() {
  const now = ac.currentTime;
  for (let i = activeVoices.length - 1; i >= 0; i--) {
    if (now > activeVoices[i].releaseTime) activeVoices.splice(i, 1);
  }
}

// ──────────────────────────────────────────────────────────────
//  Melodic State — Task 1: Stepwise motion (Toby Fox approach)
// ──────────────────────────────────────────────────────────────
let lastNoteIndex = 3; // start mid-scale

function stepwiseNoteIndex(scaleLen) {
  // 70% chance of step (±1 or ±2), 20% small leap (±3), 10% free jump
  const r = _rng();
  let step;
  if (r < 0.7) step = chance(0.5) ? 1 : 2;
  else if (r < 0.9) step = 3;
  else step = Math.floor(rnd(0, scaleLen));

  if (step < scaleLen) {
    // direction: slight bias toward center of scale
    const dir = chance(0.5 + (scaleLen / 2 - lastNoteIndex) * 0.08) ? 1 : -1;
    lastNoteIndex = lastNoteIndex + dir * step;
  } else {
    lastNoteIndex = step;
  }
  // wrap within scale
  lastNoteIndex = ((lastNoteIndex % scaleLen) + scaleLen) % scaleLen;
  return lastNoteIndex;
}

// ──────────────────────────────────────────────────────────────
//  Silence / Breath — Task 8: Musical rests
// ──────────────────────────────────────────────────────────────
export function getSilenceDuration(punctBefore, wordIndex, totalWords) {
  // After paragraph break / double newline: long breath
  if (punctBefore && /(\n\s*\n|\.{3,})/.test(punctBefore)) return rnd(1.2, 2.0);
  // After period / exclamation / question: medium breath
  if (punctBefore && /[.!?؟]/.test(punctBefore)) return rnd(0.5, 1.0);
  // After comma / semicolon: short breath
  if (punctBefore && /[,;،؛:]/.test(punctBefore)) return rnd(0.15, 0.4);
  // Random musical rest (sparse): ~12% chance of a tiny breath between words
  if (chance(0.12)) return rnd(0.08, 0.25);
  return 0;
}

// ──────────────────────────────────────────────────────────────
//  22 Voices (Optimized Synthesis Core under Golden Rule)
// ──────────────────────────────────────────────────────────────
export const VOICES = {
  pad(f, dur, vol, dest, wordLen) {
    const c = ac;
    const osc = c.createOscillator(), g = c.createGain();
    osc.detune.value = rnd(-4, 4);
    osc.type = 'sine';
    osc.frequency.value = f;
    const attackTime = 0.05 + Math.min(wordLen || 4, 10) * 0.012;
    const peakVol = vol * rnd(0.85, 1.0);
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(peakVol, c.currentTime + attackTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = f > 300 ? 90 : 30; // only filter non-bass notes
    osc.connect(hp); hp.connect(g);
    g.connect(reverbNode); g.connect(dest);
    osc.start(); osc.stop(c.currentTime + dur + 0.1);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); hp.disconnect(); } catch(e){} };
    registerVoice(g, c.currentTime + dur, [osc, hp]);
    return dur;
  },

  pluck(f, dur, vol, dest, wordLen) {
    const c = ac;
    const osc = c.createOscillator(), g = c.createGain();
    osc.detune.value = rnd(-3, 3);
    osc.type = 'triangle';
    osc.frequency.value = f;
    const peakVol = vol * rnd(0.8, 1.0);
    g.gain.setValueAtTime(peakVol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur * 0.7);
    const hp = c.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = f > 250 ? 100 : 40;
    osc.connect(hp); hp.connect(g);
    g.connect(reverbNode); g.connect(dest);
    osc.start(); osc.stop(c.currentTime + dur + 0.05);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); hp.disconnect(); } catch(e){} };
    registerVoice(g, c.currentTime + dur, [osc, hp]);
    return dur * 0.7;
  },

  breath(f, dur, vol, dest, wordLen) {
    const c = ac;
    const buf = getOrCreateNoiseBuffer('breath', dur, (data, bufLen) => {
      let prev = 0;
      for (let i = 0; i < bufLen; i++) {
        prev = prev * 0.85 + (_rng() * 2 - 1) * 0.15;
        data[i] = prev * (1 - i / bufLen);
      }
    });
    const src = c.createBufferSource(), g = c.createGain();
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = f * 1.5; bp.Q.value = 1.5;
    src.buffer = buf;
    const peakVol = vol * 0.4 * rnd(0.8, 1.0);
    g.gain.setValueAtTime(peakVol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    src.connect(bp); bp.connect(g);
    g.connect(reverbNode); g.connect(dest);
    src.start(); src.stop(c.currentTime + dur + 0.05);
    src.onended = () => { try { src.disconnect(); g.disconnect(); bp.disconnect(); } catch(e){} };
    registerVoice(g, c.currentTime + dur, [src, bp]);
    return dur;
  },

  bell(f, dur, vol, dest, wordLen) {
    const c = ac;
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = f * 2;
    osc.detune.value = rnd(-5, 5);
    const peakVol = vol * 0.5 * rnd(0.85, 1.0);
    g.gain.setValueAtTime(peakVol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur * 1.5);
    const hp = c.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 150;
    osc.connect(hp); hp.connect(g);
    g.connect(reverbNode); g.connect(dest);
    osc.start(); osc.stop(c.currentTime + dur * 1.5 + 0.1);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); hp.disconnect(); } catch(e){} };
    registerVoice(g, c.currentTime + dur * 1.5, [osc, hp]);
    return dur * 1.5;
  },

  piano(f, dur, vol, dest, wordLen) {
    const c = ac;
    const osc1 = c.createOscillator(), osc2 = c.createOscillator(), g = c.createGain();
    osc1.type = 'triangle'; osc1.frequency.value = f;
    osc2.type = 'sine'; osc2.frequency.value = f * 2.01;
    osc2.detune.value = rnd(-2, 2);
    const peakVol = vol * 0.6 * rnd(0.85, 1.0);
    g.gain.setValueAtTime(peakVol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    const hp = c.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = f > 250 ? 80 : 30;
    osc1.connect(hp); osc2.connect(hp); hp.connect(g);
    g.connect(reverbNode); g.connect(dest);
    osc1.start(); osc2.start();
    osc1.stop(c.currentTime + dur + 0.05); osc2.stop(c.currentTime + dur + 0.05);
    osc1.onended = () => { try { osc1.disconnect(); osc2.disconnect(); g.disconnect(); hp.disconnect(); } catch(e){} };
    registerVoice(g, c.currentTime + dur, [osc1, osc2, hp]);
    return dur;
  },

  marimba(f, dur, vol, dest, wordLen) {
    const c = ac;
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = 'sine'; osc.frequency.value = f;
    const peakVol = vol * 0.7 * rnd(0.85, 1.0);
    g.gain.setValueAtTime(peakVol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur * 0.5);
    const hp = c.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = f > 300 ? 100 : 40;
    osc.connect(hp); hp.connect(g);
    g.connect(reverbNode); g.connect(dest);
    osc.start(); osc.stop(c.currentTime + dur * 0.5 + 0.05);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); hp.disconnect(); } catch(e){} };
    registerVoice(g, c.currentTime + dur * 0.5, [osc, hp]);
    return dur * 0.5;
  },

  choir(f, dur, vol, dest, wordLen) {
    const c = ac;
    const oscs = [];
    const g = c.createGain();
    for (let i = 0; i < 3; i++) {
      const osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      osc.detune.value = (i - 1) * rnd(3, 6);
      osc.connect(g);
      oscs.push(osc);
    }
    const attackTime = 0.1 + Math.min(wordLen || 4, 10) * 0.015;
    const peakVol = vol * 0.3 * rnd(0.85, 1.0);
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(peakVol, c.currentTime + attackTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    const hp = c.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 120;
    g.connect(hp); hp.connect(reverbNode); hp.connect(dest);
    oscs.forEach(o => { o.start(); o.stop(c.currentTime + dur + 0.1); });
    oscs[0].onended = () => { try { oscs.forEach(o => o.disconnect()); g.disconnect(); hp.disconnect(); } catch(e){} };
    registerVoice(g, c.currentTime + dur, [...oscs, hp]);
    return dur;
  },

  cello(f, dur, vol, dest, wordLen) {
    const c = ac;
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = f / 2;
    osc.detune.value = rnd(-3, 3);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 800;
    const attackTime = 0.08 + Math.min(wordLen || 4, 8) * 0.02;
    const peakVol = vol * 0.4 * rnd(0.85, 1.0);
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(peakVol, c.currentTime + attackTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    osc.connect(lp); lp.connect(g);
    g.connect(reverbNode); g.connect(dest);
    osc.start(); osc.stop(c.currentTime + dur + 0.1);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); lp.disconnect(); } catch(e){} };
    registerVoice(g, c.currentTime + dur, [osc, lp]);
    return dur;
  },

  kalimba(f, dur, vol, dest, wordLen) {
    const c = ac;
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = 'sine'; osc.frequency.value = f * 2;
    osc.detune.value = rnd(-2, 2);
    const peakVol = vol * 0.55 * rnd(0.85, 1.0);
    g.gain.setValueAtTime(peakVol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur * 0.6);
    const hp = c.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 200;
    osc.connect(hp); hp.connect(g);
    g.connect(reverbNode); g.connect(dest);
    osc.start(); osc.stop(c.currentTime + dur * 0.6 + 0.05);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); hp.disconnect(); } catch(e){} };
    registerVoice(g, c.currentTime + dur * 0.6, [osc, hp]);
    return dur * 0.6;
  },

  gong(f, dur, vol, dest, wordLen) {
    const c = ac;
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = 'sine'; osc.frequency.value = f / 2;
    osc.detune.value = rnd(-8, 8);
    const longDur = dur * 2.5;
    const peakVol = vol * 0.3 * rnd(0.85, 1.0);
    g.gain.setValueAtTime(peakVol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + longDur);
    osc.connect(g);
    g.connect(reverbNode); g.connect(dest);
    osc.start(); osc.stop(c.currentTime + longDur + 0.1);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch(e){} };
    registerVoice(g, c.currentTime + longDur, [osc]);
    return longDur;
  },

  glass(f, dur, vol, dest, wordLen) {
    const c = ac;
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = 'sine'; osc.frequency.value = f * 3;
    osc.detune.value = rnd(-3, 3);
    const peakVol = vol * 0.25 * rnd(0.85, 1.0);
    g.gain.setValueAtTime(peakVol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur * 1.2);
    const hp = c.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 400;
    osc.connect(hp); hp.connect(g);
    g.connect(reverbNode); g.connect(dest);
    osc.start(); osc.stop(c.currentTime + dur * 1.2 + 0.05);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); hp.disconnect(); } catch(e){} };
    registerVoice(g, c.currentTime + dur * 1.2, [osc, hp]);
    return dur * 1.2;
  },

  harp(f, dur, vol, dest, wordLen) {
    const c = ac;
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = 'triangle'; osc.frequency.value = f;
    osc.detune.value = rnd(-2, 2);
    const peakVol = vol * 0.5 * rnd(0.85, 1.0);
    g.gain.setValueAtTime(peakVol, c.currentTime);
    g.gain.setValueAtTime(peakVol * 0.7, c.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur * 0.8);
    const hp = c.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = f > 300 ? 100 : 50;
    osc.connect(hp); hp.connect(g);
    g.connect(reverbNode); g.connect(dest);
    osc.start(); osc.stop(c.currentTime + dur * 0.8 + 0.05);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); hp.disconnect(); } catch(e){} };
    registerVoice(g, c.currentTime + dur * 0.8, [osc, hp]);
    return dur * 0.8;
  },

  flute(f, dur, vol, dest, wordLen) {
    const c = ac;
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = 'sine'; osc.frequency.value = f * 2;
    osc.detune.value = rnd(-3, 3);
    const attackTime = 0.06 + Math.min(wordLen || 4, 8) * 0.01;
    const peakVol = vol * 0.35 * rnd(0.85, 1.0);
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(peakVol, c.currentTime + attackTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    const hp = c.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 250;
    osc.connect(hp); hp.connect(g);
    g.connect(reverbNode); g.connect(dest);
    osc.start(); osc.stop(c.currentTime + dur + 0.1);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); hp.disconnect(); } catch(e){} };
    registerVoice(g, c.currentTime + dur, [osc, hp]);
    return dur;
  },

  organ(f, dur, vol, dest, wordLen) {
    const c = ac;
    const osc1 = c.createOscillator(), osc2 = c.createOscillator(), g = c.createGain();
    osc1.type = 'sine'; osc1.frequency.value = f;
    osc2.type = 'sine'; osc2.frequency.value = f * 2;
    osc2.detune.value = rnd(-2, 2);
    const attackTime = 0.05 + Math.min(wordLen || 4, 8) * 0.012;
    const peakVol = vol * 0.35 * rnd(0.85, 1.0);
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(peakVol, c.currentTime + attackTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    const hp = c.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 80;
    osc1.connect(hp); osc2.connect(hp); hp.connect(g);
    g.connect(reverbNode); g.connect(dest);
    osc1.start(); osc2.start();
    osc1.stop(c.currentTime + dur + 0.05); osc2.stop(c.currentTime + dur + 0.05);
    osc1.onended = () => { try { osc1.disconnect(); osc2.disconnect(); g.disconnect(); hp.disconnect(); } catch(e){} };
    registerVoice(g, c.currentTime + dur, [osc1, osc2, hp]);
    return dur;
  },

  musicbox(f, dur, vol, dest, wordLen) {
    const c = ac;
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = 'sine'; osc.frequency.value = f * 4;
    osc.detune.value = rnd(-2, 2);
    const peakVol = vol * 0.3 * rnd(0.85, 1.0);
    g.gain.setValueAtTime(peakVol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur * 0.4);
    const hp = c.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 500;
    osc.connect(hp); hp.connect(g);
    g.connect(reverbNode); g.connect(dest);
    osc.start(); osc.stop(c.currentTime + dur * 0.4 + 0.05);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); hp.disconnect(); } catch(e){} };
    registerVoice(g, c.currentTime + dur * 0.4, [osc, hp]);
    return dur * 0.4;
  },

  strings(f, dur, vol, dest, wordLen) {
    const c = ac;
    const oscs = [];
    const g = c.createGain();
    for (let i = 0; i < 2; i++) {
      const osc = c.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = f * (i + 1);
      osc.detune.value = rnd(-4, 4);
      osc.connect(g);
      oscs.push(osc);
    }
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1200;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 100;
    const attackTime = 0.1 + Math.min(wordLen || 4, 10) * 0.018;
    const peakVol = vol * 0.3 * rnd(0.85, 1.0);
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(peakVol, c.currentTime + attackTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    g.connect(lp); lp.connect(hp); hp.connect(reverbNode); hp.connect(dest);
    oscs.forEach(o => { o.start(); o.stop(c.currentTime + dur + 0.1); });
    oscs[0].onended = () => { try { oscs.forEach(o => o.disconnect()); g.disconnect(); lp.disconnect(); hp.disconnect(); } catch(e){} };
    registerVoice(g, c.currentTime + dur, [...oscs, lp, hp]);
    return dur;
  },

  whisper(f, dur, vol, dest, wordLen) {
    const c = ac;
    const buf = getOrCreateNoiseBuffer('whisper', dur, (data, bufLen) => {
      for (let i = 0; i < bufLen; i++) {
        data[i] = (_rng() * 2 - 1) * (1 - i / bufLen) * 0.5;
      }
    });
    const src = c.createBufferSource(), g = c.createGain();
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = f * 2; bp.Q.value = 2;
    src.buffer = buf;
    const peakVol = vol * 0.2 * rnd(0.85, 1.0);
    g.gain.setValueAtTime(peakVol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    src.connect(bp); bp.connect(g);
    g.connect(reverbNode); g.connect(dest);
    src.start(); src.stop(c.currentTime + dur + 0.05);
    src.onended = () => { try { src.disconnect(); g.disconnect(); bp.disconnect(); } catch(e){} };
    registerVoice(g, c.currentTime + dur, [src, bp]);
    return dur;
  },

  wind(f, dur, vol, dest, wordLen) {
    const c = ac;
    const buf = getOrCreateNoiseBuffer('wind', dur * 1.5, (data, bufLen) => {
      let prev = 0;
      for (let i = 0; i < bufLen; i++) {
        prev = prev * 0.92 + (_rng() * 2 - 1) * 0.08;
        data[i] = prev;
      }
    });
    const src = c.createBufferSource(), g = c.createGain();
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 600;
    src.buffer = buf;
    const peakVol = vol * 0.25 * rnd(0.85, 1.0);
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(peakVol, c.currentTime + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur * 1.5);
    src.connect(lp); lp.connect(g);
    g.connect(reverbNode); g.connect(dest);
    src.start(); src.stop(c.currentTime + dur * 1.5 + 0.05);
    src.onended = () => { try { src.disconnect(); g.disconnect(); lp.disconnect(); } catch(e){} };
    registerVoice(g, c.currentTime + dur * 1.5, [src, lp]);
    return dur * 1.5;
  },

  rain(f, dur, vol, dest, wordLen) {
    const c = ac;
    const buf = getOrCreateNoiseBuffer('rain', dur, (data, bufLen) => {
      for (let i = 0; i < bufLen; i++) {
        data[i] = chance(0.02) ? rnd(-0.5, 0.5) : 0;
      }
    });
    const src = c.createBufferSource(), g = c.createGain();
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 3000;
    src.buffer = buf;
    const peakVol = vol * 0.15 * rnd(0.85, 1.0);
    g.gain.setValueAtTime(peakVol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    src.connect(lp); lp.connect(g);
    g.connect(reverbNode); g.connect(dest);
    src.start(); src.stop(c.currentTime + dur + 0.05);
    src.onended = () => { try { src.disconnect(); g.disconnect(); lp.disconnect(); } catch(e){} };
    registerVoice(g, c.currentTime + dur, [src, lp]);
    return dur;
  },

  vinyl(f, dur, vol, dest, wordLen) {
    const c = ac;
    const buf = getOrCreateNoiseBuffer('vinyl', dur, (data, bufLen) => {
      for (let i = 0; i < bufLen; i++) {
        data[i] = (_rng() * 2 - 1) * 0.03 + (chance(0.005) ? rnd(-0.3, 0.3) : 0);
      }
    });
    const src = c.createBufferSource(), g = c.createGain();
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2000;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 200;
    src.buffer = buf;
    const peakVol = vol * 0.12 * rnd(0.85, 1.0);
    g.gain.setValueAtTime(peakVol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    src.connect(lp); lp.connect(hp); hp.connect(g);
    g.connect(dest);
    src.start(); src.stop(c.currentTime + dur + 0.05);
    src.onended = () => { try { src.disconnect(); g.disconnect(); lp.disconnect(); hp.disconnect(); } catch(e){} };
    registerVoice(g, c.currentTime + dur, [src, lp, hp]);
    return dur;
  },

  tape(f, dur, vol, dest, wordLen) {
    const c = ac;
    const buf = getOrCreateNoiseBuffer('tape', dur, (data, bufLen) => {
      let prev = 0;
      for (let i = 0; i < bufLen; i++) {
        prev = prev * 0.95 + (_rng() * 2 - 1) * 0.05;
        data[i] = prev * 0.4;
      }
    });
    const src = c.createBufferSource(), g = c.createGain();
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1500;
    src.buffer = buf;
    const peakVol = vol * 0.1 * rnd(0.85, 1.0);
    g.gain.setValueAtTime(peakVol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    src.connect(lp); lp.connect(g);
    g.connect(dest);
    src.start(); src.stop(c.currentTime + dur + 0.05);
    src.onended = () => { try { src.disconnect(); g.disconnect(); lp.disconnect(); } catch(e){} };
    registerVoice(g, c.currentTime + dur, [src, lp]);
    return dur;
  },

  drone(f, dur, vol, dest, wordLen) {
    const c = ac;
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = 'sawtooth'; osc.frequency.value = f / 4;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 300;
    const attackTime = 0.2;
    const peakVol = vol * 0.2 * rnd(0.85, 1.0);
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(peakVol, c.currentTime + attackTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur * 2);
    osc.connect(lp); lp.connect(g);
    g.connect(reverbNode); g.connect(dest);
    osc.start(); osc.stop(c.currentTime + dur * 2 + 0.1);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); lp.disconnect(); } catch(e){} };
    registerVoice(g, c.currentTime + dur * 2, [osc, lp]);
    return dur * 2;
  },
};

// Voice group mapping (UNTOUCHED logic)
const VOICE_GROUPS = {
  statement: ['pad', 'strings', 'cello', 'organ', 'drone', 'wind', 'tape'],
  question: ['bell', 'glass', 'harp', 'flute', 'kalimba', 'musicbox', 'piano'],
  exclamation: ['pluck', 'marimba', 'choir', 'gong', 'rain', 'vinyl', 'breath', 'whisper'],
};

// ──────────────────────────────────────────────────────────────
//  playWord — with stepwise motion, silence, velocity, cleanup
// ──────────────────────────────────────────────────────────────
let currentScale = [];
let currentMode = 'minor';
let ambientDensity   = 0;
let currentDarkness  = 0.5; // 0=bright .. 1=dark — from analyzeText
let currentTension   = 0.0; // 0=calm  .. 1=tense
let currentNostalgia = 0.0; // 0=none  .. 1=strong

export function playWord(word, sentenceType, progress, punctBefore, wordLen) {
  const c = ensureCtx();
  if (!reverbNode) buildReverb();
  cleanupVoices();

  const panner = c.createStereoPanner ? c.createStereoPanner() : null;
  let dest;
  if (panner) {
    panner.pan.value = Math.max(-0.85, Math.min(0.85, rnd(-0.55, 0.55)));
    panner.connect(getMasterBus());
    dest = panner;
    setTimeout(() => { try { panner.disconnect(); } catch (e) {} }, 8000);
  } else {
    dest = getMasterBus();
  }

  // Voice group: sentence type is primary. Analysis values add a secondary bias only —
  // they shift probabilities, never hard-override the sentence type choice.
  let group = VOICE_GROUPS[sentenceType] || VOICE_GROUPS.statement;
  if (currentTension > 0.6 && sentenceType === 'statement') {
    // tense statements lean toward edgier exclamation voices
    if (_rng() < 0.45) group = VOICE_GROUPS.exclamation;
  } else if (currentDarkness > 0.65 && sentenceType === 'question') {
    // dark questions lean away from bright bell/glass/harp voices
    if (_rng() < 0.4) group = VOICE_GROUPS.statement;
  }
  const voiceName = pick(group);
  const voiceFn = VOICES[voiceName];
  if (!voiceFn) return { played: false, silenceDur: 0 };

  const noteIdx = stepwiseNoteIndex(currentScale.length || 7);
  const baseFreq = currentScale[noteIdx] || 220;
  // Octave bias: darkness + nostalgia pull register down, brightness pulls up.
  // Purely probabilistic — never a hard override.
  const darkBias  = Math.max(0, currentDarkness  - 0.4) * 0.35;
  const nostBias  = currentNostalgia * 0.12;
  const lowProb   = 0.08 + darkBias + nostBias;
  const highProb  = Math.max(0, 0.15 - darkBias * 0.8);
  const roll = _rng();
  const octaveShift = roll < lowProb ? 0.5 : roll < lowProb + highProb ? 2 : 1;
  const freq = baseFreq * octaveShift;

  const wl = wordLen || word.length || 4;
  const baseVol = 0.12 + progress * 0.06;
  const vol = baseVol * rnd(0.75, 1.0) * (1 - Math.min(wl, 12) * 0.015);
  const dur = 0.4 + rnd(0, 0.6) + Math.min(wl, 10) * 0.05;

  const actualDur = voiceFn(freq, dur, vol, dest, wl);
  return { played: true, silenceDur: 0, duration: actualDur };
}

// ──────────────────────────────────────────────────────────────
//  Scale & Mood (interface for main.js — UNTOUCHED logic)
// ──────────────────────────────────────────────────────────────
export function setMood(text) {
  const mood = detectMood(text);
  const analysis = analyzeText(text);
  currentMode = mood.mode;
  // Pick root from text hash so same text = same root (deterministic).
  // Darkness selects the register: dark text uses the low octave candidates,
  // bright/neutral text uses the mid register. This is the missing link between
  // emotional content and the actual pitch of the piece.
  const h = hashText(text);
  const dark = analysis.darkness ?? 0.5;
  const candidates = dark > 0.55 ? ROOT_CANDIDATES_LOW : ROOT_CANDIDATES_MID;
  const rootHz = candidates[h % candidates.length];
  currentScale = buildScale(rootHz, currentMode);
  ambientDensity   = analysis.density   ?? 0;
  currentDarkness  = analysis.darkness  ?? 0.5;
  currentTension   = analysis.tension   ?? 0.0;
  currentNostalgia = analysis.nostalgia ?? 0.0;
  return { mood, analysis };
}

export function wordNoteScale() { return currentScale; }

// ──────────────────────────────────────────────────────────────
//  Ambient Engine (structure UNTOUCHED — routing updated)
// ──────────────────────────────────────────────────────────────
const BEAT_SEC = 1.15; // shared tempo — slow, ~52 BPM quarter notes
const BAR_BEATS = 4;

function beatDur() { return BEAT_SEC; }
function barDur() { return BEAT_SEC * BAR_BEATS; }
function moodDarkness() {
  const idx = MODE_ORDER.indexOf(currentMode);
  // 🚨 BUG FIX: MODE_ORDER goes from darkest (index 0) to brightest (index 21).
  // Therefore, 'idx' represents BRIGHTNESS, not darkness. 
  // We must invert it (1 - ...) so darkest modes yield 1.0 (heavy muffle, sub-bass)
  // and brightest modes yield 0.0 (crystal-clear registers, airy drone).
  return idx < 0 ? 0.5 : 1 - (idx / (MODE_ORDER.length - 1));
}

let ambientRunning = false;
let ambientTimers = [];

export function startAmbient(dests) {
  if (ambientRunning) return;
  ambientRunning = true;
  const c = ensureCtx();
  if (!reverbNode) buildReverb();
  const masterDest = getMasterBus();

  // ---- deep drone bed, always present, slow evolving ----
  function playDrone() {
    if (!ambientRunning) return;
    const f = (currentScale[0] || 220) / 2;
    const osc = c.createOscillator(), g = c.createGain();
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 250 - moodDarkness() * 80;
    osc.type = 'sawtooth'; osc.frequency.value = f;
    osc.detune.value = rnd(-6, 6);
    const dur = barDur() * rnd(2, 4);
    // Dynamic volume matching: reduce the heavy deep drone volume in bright moods
    // so the mix becomes clean, airy, and joyful, while retaining deep weight in dark moods.
    const peak = rnd(0.02, 0.04) * (0.5 + ambientDensity * 0.5) * (0.2 + moodDarkness() * 0.8);
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(peak, c.currentTime + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    osc.connect(lp); lp.connect(g);
    g.connect(reverbNode); g.connect(masterDest);
    osc.start(); osc.stop(c.currentTime + dur + 0.2);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); lp.disconnect(); } catch(e){} };
    ambientTimers.push(setTimeout(playDrone, dur * 800));
  }

  // ---- vinyl crackle texture, always-on lo-fi layer ----
  function playCrackle() {
    if (!ambientRunning) return;
    const dur = barDur() * rnd(1.5, 3);
    const buf = getOrCreateNoiseBuffer('vinyl_crackle', dur, (data, bufLen) => {
      for (let i = 0; i < bufLen; i++) {
        data[i] = chance(0.003) ? rnd(-0.15, 0.15) : (_rng() * 2 - 1) * 0.008;
      }
    });
    const src = c.createBufferSource(), g = c.createGain();
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2500;
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 300;
    src.buffer = buf;
    // Quiet down vinyl crackle when the music is bright so it feels less koder/dirty
    const peak = rnd(0.015, 0.03) * (0.3 + ambientDensity * 0.4) * (0.3 + moodDarkness() * 0.7);
    g.gain.setValueAtTime(peak, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    src.connect(lp); lp.connect(hp); hp.connect(g);
    g.connect(masterDest);
    src.start(); src.stop(c.currentTime + dur + 0.05);
    src.onended = () => { try { src.disconnect(); g.disconnect(); lp.disconnect(); hp.disconnect(); } catch(e){} };
    ambientTimers.push(setTimeout(playCrackle, dur * 750));
  }

  // ---- tape hiss / warmth bed ----
  function playHiss() {
    if (!ambientRunning) return;
    const dur = barDur() * rnd(2, 4);
    const buf = getOrCreateNoiseBuffer('tape_hiss', dur, (data, bufLen) => {
      let prev = 0;
      for (let i = 0; i < bufLen; i++) {
        prev = prev * 0.93 + (_rng() * 2 - 1) * 0.07;
        data[i] = prev;
      }
    });
    const src = c.createBufferSource(), g = c.createGain();
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800;
    src.buffer = buf;
    // Lower tape hiss in bright moods
    const peak = rnd(0.008, 0.018) * (0.4 + ambientDensity * 0.3) * (0.3 + moodDarkness() * 0.7);
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(peak, c.currentTime + dur * 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    src.connect(lp); lp.connect(g);
    g.connect(masterDest);
    src.start(); src.stop(c.currentTime + dur + 0.05);
    src.onended = () => { try { src.disconnect(); g.disconnect(); lp.disconnect(); } catch(e){} };
    ambientTimers.push(setTimeout(playHiss, dur * 850));
  }

  // ---- warm motif note (Toby Fox-ish singing line) ----
  function playMotifNote() {
    if (!ambientRunning) return;
    const f = pick(currentScale) * 2;
    const osc = c.createOscillator(), g = c.createGain();
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1500 - moodDarkness() * 400;
    osc.type = 'sine'; osc.frequency.value = f;
    const dur = beatDur() * rnd(2.2, 3.2);
    const peak = rnd(0.035, 0.06) * ambientDensity;
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(peak, c.currentTime + 0.30);
    g.gain.setValueAtTime(peak, c.currentTime + dur * 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur + 0.8);
    osc.connect(lp); lp.connect(g);
    g.connect(reverbNode); dests.forEach(d => g.connect(d));
    osc.start(); osc.stop(c.currentTime + dur + 1.0);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); lp.disconnect(); } catch(e){} };
    const nextDelay = chance(0.2) ? beatDur() * rnd(4, 6) : beatDur() * rnd(2, 3.5);
    ambientTimers.push(setTimeout(playMotifNote, nextDelay * 1000));
  }

  // ---- gentle tape warmth bed, slow and continuous, tied to bar length ----
  function playTapeWarmth() {
    if (!ambientRunning) return;
    const dur = barDur() * rnd(3, 5);
    const buf = getOrCreateNoiseBuffer('tape_warmth_bed', dur, (data, bufLen) => {
      let prev = 0;
      for (let i = 0; i < bufLen; i++) {
        prev = prev * 0.96 + (_rng() * 2 - 1) * 0.04;
        data[i] = prev * Math.sin(Math.PI * i / bufLen);
      }
    });
    const src = c.createBufferSource(), g = c.createGain();
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    src.buffer = buf;
    const peak = rnd(0.01, 0.02) * (0.3 + ambientDensity * 0.3);
    g.gain.setValueAtTime(peak, c.currentTime);
    src.connect(lp); lp.connect(g);
    g.connect(masterDest);
    src.start(); src.stop(c.currentTime + dur + 0.05);
    src.onended = () => { try { src.disconnect(); g.disconnect(); lp.disconnect(); } catch(e){} };
    ambientTimers.push(setTimeout(playTapeWarmth, dur * 900));
  }

  // ---- chord pad (smooth progression from in-key voicings) ----
  function playChordPad() {
    if (!ambientRunning) return;
    if (currentScale.length < 5) { ambientTimers.push(setTimeout(playChordPad, 3000)); return; }
    const degrees = [[0, 2, 4], [5, 0, 2], [3, 5, 0], [4, 6, 1]];
    const deg = pick(degrees);
    const voicing = buildVoicing(currentScale, deg, chance(0.5) ? 0 : 7);
    const dur = barDur() * rnd(2, 3);
    const peak = rnd(0.015, 0.03) * (0.3 + ambientDensity * 0.5);
    voicing.forEach((f, i) => {
      const osc = c.createOscillator(), g = c.createGain();
      osc.type = 'sine'; osc.frequency.value = f;
      osc.detune.value = rnd(-4, 4);
      g.gain.setValueAtTime(0, c.currentTime);
      g.gain.linearRampToValueAtTime(peak * (1 - i * 0.15), c.currentTime + 0.4);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 100;
      osc.connect(hp); hp.connect(g);
      g.connect(reverbNode); g.connect(masterDest);
      osc.start(); osc.stop(c.currentTime + dur + 0.2);
      osc.onended = () => { try { osc.disconnect(); g.disconnect(); hp.disconnect(); } catch(e){} };
    });
    ambientTimers.push(setTimeout(playChordPad, dur * 900));
  }

  // ---- sub-bass pulse (very gentle, only on dark moods) ----
  function playSubPulse() {
    if (!ambientRunning) return;
    if (moodDarkness() < 0.3) { ambientTimers.push(setTimeout(playSubPulse, barDur() * 2000)); return; }
    const f = (currentScale[0] || 220) / 4;
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = 'sine'; osc.frequency.value = f;
    const dur = beatDur() * rnd(2, 4);
    const peak = rnd(0.03, 0.05) * ambientDensity;
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(peak, c.currentTime + 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    osc.connect(g);
    g.connect(masterDest);
    osc.start(); osc.stop(c.currentTime + dur + 0.1);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch(e){} };
    ambientTimers.push(setTimeout(playSubPulse, dur * 1000 + rnd(500, 1500)));
  }

  playDrone();
  playCrackle();
  playHiss();
  playMotifNote();
  playTapeWarmth();
  playChordPad();
  playSubPulse();
}

export function stopAmbient() {
  ambientRunning = false;
  ambientTimers.forEach(t => clearTimeout(t));
  ambientTimers = [];
}

export function isAmbientRunning() { return ambientRunning; }

// ──────────────────────────────────────────────────────────────
//  Exports for main.js
// ──────────────────────────────────────────────────────────────
export { ensureCtx, getMasterBus, reverbNode, stepwiseNoteIndex, cleanupVoices, rnd };