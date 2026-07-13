import { buildScale, detectMood, hashText, ROOT_CANDIDATES_LOW, ROOT_CANDIDATES_MID, chordFromScale, MODE_ORDER } from './mood.js';

// ── Audio Engine ─────────────────────────────────────────────
// All shared audio state (AudioContext, reverb, RNG cursor, current
// scale/mood, ambient density, timers, stopping flag) lives here so
// every synthesis function mutates the exact same state — identical
// runtime behavior to the original single-file version.

let AC = null;
let stopping = false;

let ambTimers = [];
let reverbNode = null, reverbSend = null;

export function ac() {
  if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
  return AC;
}
// ── Seeded randomness ──────────────────────────────────────────
// Every "random" choice during playback (which note, which voice, how
// long, ambient timing) must come out the SAME way every time the same
// text is played, or the piece sounds different on every replay even
// though the key/scale is locked. So rnd()/pick() draw from a seeded
// PRNG (mulberry32) that gets reset to a fixed seed at the start of
// every play() call — same text → same seed → same exact sequence.
let _rngState = 123456789;
export function seedRng(seed) { _rngState = (seed >>> 0) || 1; }
function _rand() {
  // mulberry32
  _rngState |= 0; _rngState = (_rngState + 0x6D2B79F5) | 0;
  let t = Math.imul(_rngState ^ (_rngState >>> 15), 1 | _rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
export function rnd(a, b) { return a + _rand() * (b - a); }
export function pick(a)   { return a[Math.floor(_rand() * a.length)]; }

// Word-note palette is built per-text from currentScale (set by deriveTextHarmony),
// spread across octaves that match the mood's register:
// dark moods → lower, tighter range; bright moods → wider, higher range
export function wordNoteScale() {
  const out = [];
  const modeIdx = MODE_ORDER.indexOf(currentMood);
  let octaves;
  if (modeIdx <= 4)       octaves = [0.5, 1, 2];           // dark — low and heavy
  else if (modeIdx <= 8)  octaves = [0.5, 1, 2, 3];        // mid — normal range
  else if (modeIdx <= 12) octaves = [1, 2, 3, 4];          // lighter — higher, wider
  else                    octaves = [1, 2, 3, 4, 6];       // bright — wide, airy
  octaves.forEach(oct => currentScale.forEach(f => out.push(f * oct)));
  return out;
}

function buildReverb(c) {
  const dur = 4.5, decay = 2.2;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++)
      d[i] = (_rand() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  const conv = c.createConvolver();
  conv.buffer = buf;
  return conv;
}

export function ensureReverb(dests) {
  const c = ac();
  if (!reverbNode) {
    reverbNode = buildReverb(c);
    reverbSend = c.createGain();
    reverbSend.gain.value = 0.38;
    reverbNode.connect(reverbSend);
    dests.forEach(d => reverbSend.connect(d));
  }
}


export const VOICES = [
  // 1. Soft pad — slow attack, sine+sub
  (freq, vol, dur, dests) => {
    const c = ac();
    [[freq, 'sine', 1.0], [freq*0.5, 'sine', 0.4], [freq*2, 'triangle', 0.12]].forEach(([f, type, lv]) => {
      const osc = c.createOscillator(), g = c.createGain();
      osc.type = type; osc.frequency.value = f;
      g.gain.setValueAtTime(0, c.currentTime);
      g.gain.linearRampToValueAtTime(vol * lv * 0.7, c.currentTime + 0.12);
      g.gain.setValueAtTime(vol * lv * 0.7, c.currentTime + dur * 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur + 0.5);
      osc.connect(g); g.connect(reverbNode);
      dests.forEach(d => g.connect(d));
      osc.start(); osc.stop(c.currentTime + dur + 0.6);
    });
  },
  // 2. Plucked string — fast attack, slow decay
  (freq, vol, dur, dests) => {
    const c = ac();
    const osc = c.createOscillator(), g = c.createGain();
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = freq * 3; lp.Q.value = 2;
    osc.type = 'sawtooth'; osc.frequency.value = freq;
    g.gain.setValueAtTime(vol * 0.55, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur + 0.9);
    osc.connect(lp); lp.connect(g);
    g.connect(reverbNode); dests.forEach(d => g.connect(d));
    osc.start(); osc.stop(c.currentTime + dur + 1.0);

    // Harmonic overtone
    const osc2 = c.createOscillator(), g2 = c.createGain();
    osc2.type = 'sine'; osc2.frequency.value = freq * 2.01;
    g2.gain.setValueAtTime(vol * 0.12, c.currentTime);
    g2.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur * 0.5);
    osc2.connect(g2); g2.connect(reverbNode); dests.forEach(d => g2.connect(d));
    osc2.start(); osc2.stop(c.currentTime + dur * 0.6);
  },
  // 3. Breath — detuned saw cluster, very filtered
  (freq, vol, dur, dests) => {
    const c = ac();
    [-7, 0, 5].forEach(det => {
      const osc = c.createOscillator(), lp = c.createBiquadFilter(), g = c.createGain();
      lp.type = 'lowpass'; lp.frequency.value = 500 + rnd(0, 200); lp.Q.value = 0.5;
      osc.type = 'sawtooth'; osc.frequency.value = freq; osc.detune.value = det;
      g.gain.setValueAtTime(0, c.currentTime);
      g.gain.linearRampToValueAtTime(vol * 0.22, c.currentTime + 0.18);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur + 0.4);
      osc.connect(lp); lp.connect(g);
      g.connect(reverbNode); dests.forEach(d => g.connect(d));
      osc.start(); osc.stop(c.currentTime + dur + 0.5);
    });
  },
  // 4. Bell / metallic — inharmonic partials
  (freq, vol, dur, dests) => {
    const c = ac();
    const partials = [1, 2.756, 5.404, 8.933, 13.35].map((r, i) => ({ f: freq * r, v: vol * Math.pow(0.55, i) }));
    partials.forEach(({ f, v }) => {
      const osc = c.createOscillator(), g = c.createGain();
      osc.type = 'sine'; osc.frequency.value = f;
      g.gain.setValueAtTime(v * 0.35, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur + rnd(0.3, 1.2));
      osc.connect(g); g.connect(reverbNode); dests.forEach(d => g.connect(d));
      osc.start(); osc.stop(c.currentTime + dur + 1.3);
    });
  },
  // 5. Ghost chord — three quiet sine notes
  (freq, vol, dur, dests) => {
    const c = ac();
    const ratios = [1, 1.498, 1.782]; // root, fifth, minor seventh
    ratios.forEach(r => {
      const osc = c.createOscillator(), g = c.createGain();
      osc.type = 'sine'; osc.frequency.value = freq * r;
      g.gain.setValueAtTime(0, c.currentTime);
      g.gain.linearRampToValueAtTime(vol * 0.28, c.currentTime + 0.08);
      g.gain.setValueAtTime(vol * 0.28, c.currentTime + dur * 0.7);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur + 0.6);
      osc.connect(g); g.connect(reverbNode); dests.forEach(d => g.connect(d));
      osc.start(); osc.stop(c.currentTime + dur + 0.7);
    });
  },
  // 6. Piano — fast hammer attack, multiple inharmonic-ish partials, natural decay
  (freq, vol, dur, dests) => {
    const c = ac();
    const partials = [
      { r: 1,     v: 1.0,  det: 0   },
      { r: 2.0,   v: 0.35, det: 3   },
      { r: 3.005, v: 0.16, det: -2  },
      { r: 4.02,  v: 0.08, det: 0   },
    ];
    partials.forEach(({ r, v, det }) => {
      const osc = c.createOscillator(), g = c.createGain();
      const lp  = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = freq * r * 4;
      osc.type = 'triangle'; osc.frequency.value = freq * r; osc.detune.value = det;
      const decay = dur + rnd(0.9, 1.8);
      g.gain.setValueAtTime(0, c.currentTime);
      g.gain.linearRampToValueAtTime(vol * v, c.currentTime + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + decay);
      osc.connect(lp); lp.connect(g);
      g.connect(reverbNode); dests.forEach(d => g.connect(d));
      osc.start(); osc.stop(c.currentTime + decay + 0.1);
    });
    // hammer noise transient
    const buf = c.createBuffer(1, Math.ceil(c.sampleRate * 0.02), c.sampleRate);
    const bd = buf.getChannelData(0);
    for (let i = 0; i < bd.length; i++) bd[i] = (_rand()*2-1) * Math.exp(-i / (c.sampleRate*0.004));
    const src = c.createBufferSource(); src.buffer = buf;
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800;
    const ng = c.createGain(); ng.gain.value = vol * 0.1;
    src.connect(hp); hp.connect(ng);
    dests.forEach(d => ng.connect(d));
    src.start();
  },
  // 7. Warm synth pad — slow swell, analog-style, Daft Punk-ish
  (freq, vol, dur, dests) => {
    const c = ac();
    const swell = Math.max(dur * 1.4, 0.5);
    [
      { type: 'sawtooth', det: -6,  v: 0.5  },
      { type: 'sawtooth', det: 6,   v: 0.5  },
      { type: 'sine',     det: 0,   v: 0.4  },
      { type: 'sine',     det: 0,   v: 0.22, oct: 0.5 },
    ].forEach(({ type, det, v, oct }) => {
      const osc = c.createOscillator(), g = c.createGain();
      const lp  = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1100; lp.Q.value = 0.7;
      osc.type = type; osc.frequency.value = freq * (oct || 1); osc.detune.value = det;
      g.gain.setValueAtTime(0, c.currentTime);
      g.gain.linearRampToValueAtTime(vol * v * 0.55, c.currentTime + swell * 0.45);
      g.gain.linearRampToValueAtTime(0, c.currentTime + swell);
      osc.connect(lp); lp.connect(g);
      g.connect(reverbNode); dests.forEach(d => g.connect(d));
      osc.start(); osc.stop(c.currentTime + swell + 0.1);
    });
  },
  // 8. Plucked string ensemble — guitar/harp-like pluck with body resonance
  (freq, vol, dur, dests) => {
    const c = ac();
    const decay = dur + rnd(1.2, 2.4);
    const osc  = c.createOscillator(), g = c.createGain();
    const bp   = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq * 1.5; bp.Q.value = 3;
    osc.type = 'sawtooth'; osc.frequency.value = freq;
    g.gain.setValueAtTime(vol * 0.5, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + decay);
    osc.connect(bp); bp.connect(g);
    g.connect(reverbNode); dests.forEach(d => g.connect(d));
    osc.start(); osc.stop(c.currentTime + decay + 0.1);
    // body resonance octave below
    const osc2 = c.createOscillator(), g2 = c.createGain();
    osc2.type = 'sine'; osc2.frequency.value = freq * 0.5;
    g2.gain.setValueAtTime(vol * 0.22, c.currentTime);
    g2.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + decay * 0.8);
    osc2.connect(g2); g2.connect(reverbNode); dests.forEach(d => g2.connect(d));
    osc2.start(); osc2.stop(c.currentTime + decay * 0.85);
  },
  // 9. Marimba — woody, fast attack, mid partials, quick decay
  (freq, vol, dur, dests) => {
    const c = ac();
    [{r:1,v:1,t:'sine'},{r:4.0,v:0.18,t:'sine'},{r:9.8,v:0.06,t:'sine'}].forEach(({r,v,t}) => {
      const osc = c.createOscillator(), g = c.createGain();
      osc.type = t; osc.frequency.value = freq * r;
      const decay = dur * 0.6 + rnd(0.15, 0.35);
      g.gain.setValueAtTime(vol * v * 0.6, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + decay);
      osc.connect(g); g.connect(reverbNode); dests.forEach(d => g.connect(d));
      osc.start(); osc.stop(c.currentTime + decay + 0.05);
    });
  },
  // 10. Glass / FM-ish bell — clean inharmonic ring, longer tail
  (freq, vol, dur, dests) => {
    const c = ac();
    [1, 2.41, 3.9, 6.13].forEach((r, i) => {
      const osc = c.createOscillator(), g = c.createGain();
      osc.type = 'sine'; osc.frequency.value = freq * r;
      const decay = dur + rnd(0.6, 1.6) + i * 0.2;
      g.gain.setValueAtTime(vol * Math.pow(0.5, i) * 0.4, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + decay);
      osc.connect(g); g.connect(reverbNode); dests.forEach(d => g.connect(d));
      osc.start(); osc.stop(c.currentTime + decay + 0.1);
    });
  },
  // 11. Vibraphone — sine with slow tremolo shimmer
  (freq, vol, dur, dests) => {
    const c = ac();
    const osc = c.createOscillator(), g = c.createGain();
    const lfo = c.createOscillator(), lfoGain = c.createGain();
    lfo.type = 'sine'; lfo.frequency.value = 5.5;
    lfoGain.gain.value = vol * 0.15;
    lfo.connect(lfoGain); lfoGain.connect(g.gain);
    osc.type = 'sine'; osc.frequency.value = freq;
    const decay = dur + rnd(1.0, 2.0);
    g.gain.setValueAtTime(vol * 0.5, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + decay);
    osc.connect(g); g.connect(reverbNode); dests.forEach(d => g.connect(d));
    lfo.start(); osc.start();
    lfo.stop(c.currentTime + decay + 0.1); osc.stop(c.currentTime + decay + 0.1);
  },
  // 12. Music box — bright, fast decay, slightly detuned twin oscillators
  (freq, vol, dur, dests) => {
    const c = ac();
    [0, 6].forEach(det => {
      const osc = c.createOscillator(), g = c.createGain();
      osc.type = 'triangle'; osc.frequency.value = freq * 2; osc.detune.value = det;
      const decay = dur * 0.5 + rnd(0.3, 0.7);
      g.gain.setValueAtTime(vol * 0.35, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + decay);
      osc.connect(g); g.connect(reverbNode); dests.forEach(d => g.connect(d));
      osc.start(); osc.stop(c.currentTime + decay + 0.1);
    });
  },
  // 13. Choir pad — stacked detuned sines with slow vowel-like filter sweep
  (freq, vol, dur, dests) => {
    const c = ac();
    const swell = Math.max(dur * 1.6, 0.8);
    [-5, 0, 5, 12].forEach(det => {
      const osc = c.createOscillator(), g = c.createGain();
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq * 2; bp.Q.value = 1.5;
      bp.frequency.setValueAtTime(freq * 1.5, c.currentTime);
      bp.frequency.linearRampToValueAtTime(freq * 2.5, c.currentTime + swell);
      osc.type = 'sawtooth'; osc.frequency.value = freq; osc.detune.value = det;
      g.gain.setValueAtTime(0, c.currentTime);
      g.gain.linearRampToValueAtTime(vol * 0.13, c.currentTime + swell * 0.4);
      g.gain.linearRampToValueAtTime(0, c.currentTime + swell);
      osc.connect(bp); bp.connect(g);
      g.connect(reverbNode); dests.forEach(d => g.connect(d));
      osc.start(); osc.stop(c.currentTime + swell + 0.1);
    });
  },
  // 14. Soft organ — additive square/sine drawbar style, even sustain
  (freq, vol, dur, dests) => {
    const c = ac();
    [{r:1,v:0.6},{r:2,v:0.3},{r:3,v:0.15},{r:4,v:0.1}].forEach(({r,v}) => {
      const osc = c.createOscillator(), g = c.createGain();
      osc.type = 'sine'; osc.frequency.value = freq * r;
      g.gain.setValueAtTime(0, c.currentTime);
      g.gain.linearRampToValueAtTime(vol * v * 0.5, c.currentTime + 0.05);
      g.gain.setValueAtTime(vol * v * 0.5, c.currentTime + dur * 0.7);
      g.gain.linearRampToValueAtTime(0, c.currentTime + dur + 0.3);
      osc.connect(g); g.connect(reverbNode); dests.forEach(d => g.connect(d));
      osc.start(); osc.stop(c.currentTime + dur + 0.35);
    });
  },
  // 15. Sub thump — deep, percussive, mostly felt not heard
  (freq, vol, dur, dests) => {
    const c = ac();
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = 'sine'; osc.frequency.setValueAtTime(freq * 0.25, c.currentTime);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.18, c.currentTime + 0.3);
    g.gain.setValueAtTime(vol * 0.6, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur + 0.4);
    osc.connect(g); g.connect(reverbNode); dests.forEach(d => g.connect(d));
    osc.start(); osc.stop(c.currentTime + dur + 0.5);
  },
  // 16. Reed / woodwind-ish — square wave softened, gentle vibrato
  (freq, vol, dur, dests) => {
    const c = ac();
    const osc = c.createOscillator(), g = c.createGain();
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = freq * 4;
    const lfo = c.createOscillator(), lfoGain = c.createGain();
    lfo.type = 'sine'; lfo.frequency.value = 4.5; lfoGain.gain.value = 3;
    lfo.connect(lfoGain); lfoGain.connect(osc.frequency);
    osc.type = 'square'; osc.frequency.value = freq;
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(vol * 0.28, c.currentTime + 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur + 0.5);
    osc.connect(lp); lp.connect(g); g.connect(reverbNode); dests.forEach(d => g.connect(d));
    lfo.start(); osc.start();
    lfo.stop(c.currentTime + dur + 0.6); osc.stop(c.currentTime + dur + 0.6);
  },
  // 17. Bowed cello-ish — slow attack sawtooth with formant filter
  (freq, vol, dur, dests) => {
    const c = ac();
    const osc = c.createOscillator(), g = c.createGain();
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq * 2.2; bp.Q.value = 2.5;
    osc.type = 'sawtooth'; osc.frequency.value = freq * 0.5;
    const swell = Math.max(dur * 1.3, 0.6);
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(vol * 0.4, c.currentTime + swell * 0.5);
    g.gain.linearRampToValueAtTime(0, c.currentTime + swell);
    osc.connect(bp); bp.connect(g); g.connect(reverbNode); dests.forEach(d => g.connect(d));
    osc.start(); osc.stop(c.currentTime + swell + 0.1);
  },
  // 18. Kalimba — plucky metallic, layered odd harmonics
  (freq, vol, dur, dests) => {
    const c = ac();
    [{r:1,v:1},{r:3.2,v:0.2},{r:5.1,v:0.08}].forEach(({r,v}) => {
      const osc = c.createOscillator(), g = c.createGain();
      osc.type = 'triangle'; osc.frequency.value = freq * r;
      const decay = dur * 0.7 + rnd(0.4, 0.9);
      g.gain.setValueAtTime(vol * v * 0.5, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + decay);
      osc.connect(g); g.connect(reverbNode); dests.forEach(d => g.connect(d));
      osc.start(); osc.stop(c.currentTime + decay + 0.1);
    });
  },
  // 19. Synth brass swell — bright sawtooth stack with filter sweep up
  (freq, vol, dur, dests) => {
    const c = ac();
    const swell = Math.max(dur * 1.2, 0.4);
    [-4, 4].forEach(det => {
      const osc = c.createOscillator(), g = c.createGain();
      const lp = c.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.setValueAtTime(300, c.currentTime);
      lp.frequency.linearRampToValueAtTime(freq * 5, c.currentTime + swell * 0.4);
      osc.type = 'sawtooth'; osc.frequency.value = freq; osc.detune.value = det;
      g.gain.setValueAtTime(0, c.currentTime);
      g.gain.linearRampToValueAtTime(vol * 0.3, c.currentTime + swell * 0.3);
      g.gain.linearRampToValueAtTime(0, c.currentTime + swell);
      osc.connect(lp); lp.connect(g); g.connect(reverbNode); dests.forEach(d => g.connect(d));
      osc.start(); osc.stop(c.currentTime + swell + 0.1);
    });
  },
  // 20. Detuned celeste — delicate, high register, twinkling
  (freq, vol, dur, dests) => {
    const c = ac();
    [0, 9, -9].forEach(det => {
      const osc = c.createOscillator(), g = c.createGain();
      osc.type = 'sine'; osc.frequency.value = freq * 2; osc.detune.value = det;
      const decay = dur + rnd(0.8, 1.5);
      g.gain.setValueAtTime(vol * 0.22, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + decay);
      osc.connect(g); g.connect(reverbNode); dests.forEach(d => g.connect(d));
      osc.start(); osc.stop(c.currentTime + decay + 0.1);
    });
  },
  // 21. Granular texture — short noise-filtered grain pitched to the note
  (freq, vol, dur, dests) => {
    const c = ac();
    const glen = Math.max(0.08, dur * 0.5);
    const buf = c.createBuffer(1, Math.ceil(c.sampleRate * glen), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let j = 0; j < d.length; j++) d[j] = (_rand()*2-1) * Math.pow(Math.sin(Math.PI * j / d.length), 0.7);
    const src = c.createBufferSource(); src.buffer = buf;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq * 2; bp.Q.value = 4;
    const g = c.createGain(); g.gain.value = vol * 0.4;
    src.connect(bp); bp.connect(g); g.connect(reverbNode); dests.forEach(d2 => g.connect(d2));
    src.start();
    // pair with a quiet sine to keep it pitched and musical, not just noise
    const osc = c.createOscillator(), g2 = c.createGain();
    osc.type = 'sine'; osc.frequency.value = freq;
    g2.gain.setValueAtTime(vol * 0.15, c.currentTime);
    g2.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur + 0.3);
    osc.connect(g2); g2.connect(reverbNode); dests.forEach(d2 => g2.connect(d2));
    osc.start(); osc.stop(c.currentTime + dur + 0.4);
  },
  // 22. Deep gong-ish swell — slow, dark, long inharmonic tail
  (freq, vol, dur, dests) => {
    const c = ac();
    [1, 1.78, 2.4, 3.6].forEach((r, i) => {
      const osc = c.createOscillator(), g = c.createGain();
      osc.type = 'sine'; osc.frequency.value = freq * 0.5 * r;
      const decay = dur + rnd(1.5, 3) + i * 0.3;
      g.gain.setValueAtTime(0, c.currentTime);
      g.gain.linearRampToValueAtTime(vol * Math.pow(0.6, i) * 0.4, c.currentTime + 0.3);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + decay);
      osc.connect(g); g.connect(reverbNode); dests.forEach(d => g.connect(d));
      osc.start(); osc.stop(c.currentTime + decay + 0.1);
    });
  },
];


export function playPunctuation(ch, dests, intensity) {
  const c = ac();
  if (ch === '.') {
    // soft low closing tone — settles
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = 'sine'; osc.frequency.setValueAtTime(130.81, c.currentTime);
    osc.frequency.exponentialRampToValueAtTime(98, c.currentTime + 0.5);
    g.gain.setValueAtTime(0.22 * intensity, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.7);
    osc.connect(g); g.connect(reverbNode); dests.forEach(d => g.connect(d));
    osc.start(); osc.stop(c.currentTime + 0.8);
  } else if (ch === ',') {
    // light upward tick — a small breath
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = 'sine'; osc.frequency.setValueAtTime(196, c.currentTime);
    g.gain.setValueAtTime(0.12 * intensity, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.22);
    osc.connect(g); g.connect(reverbNode); dests.forEach(d => g.connect(d));
    osc.start(); osc.stop(c.currentTime + 0.3);
  } else if (ch === '!') {
    // bright stacked accent — emphatic
    [523.25, 659.25, 784].forEach((f, i) => {
      const osc = c.createOscillator(), g = c.createGain();
      osc.type = 'triangle'; osc.frequency.value = f;
      g.gain.setValueAtTime(0.2 * intensity * (1 - i*0.25), c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.4);
      osc.connect(g); g.connect(reverbNode); dests.forEach(d => g.connect(d));
      osc.start(); osc.stop(c.currentTime + 0.5);
    });
  } else if (ch === '?') {
    // rising pitch glide — questioning
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = 'sine'; osc.frequency.setValueAtTime(293.66, c.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, c.currentTime + 0.35);
    g.gain.setValueAtTime(0.18 * intensity, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.5);
    osc.connect(g); g.connect(reverbNode); dests.forEach(d => g.connect(d));
    osc.start(); osc.stop(c.currentTime + 0.6);
  } else if (ch === '\n') {
    // deep resonant gap marker
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = 'sine'; osc.frequency.setValueAtTime(73.42, c.currentTime);
    g.gain.setValueAtTime(0.15 * intensity, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 1.1);
    osc.connect(g); g.connect(reverbNode); dests.forEach(d => g.connect(d));
    osc.start(); osc.stop(c.currentTime + 1.2);
  }
}

let currentScale = buildScale(110.00, 'minor');
let currentMood = 'minor';

export function deriveTextHarmony(text) {
  const { mode, normScore, tenseScore } = detectMood(text);
  const h = hashText(text);

  // ── Bُعد ۲: octave weighting — dark/tense moods get lower register, bright moods higher ──
  // modeIdx 0-5 = dark → use low roots; 6-10 = mid; 11-15 = mid-high
  const modeIdx = MODE_ORDER.indexOf(mode);
  const candidates = modeIdx <= 5 ? ROOT_CANDIDATES_LOW : ROOT_CANDIDATES_MID;

  // ── Bُعد ۳: root selection weighted toward lower pitches for dark moods ──
  // instead of pure hash mod, bias the index toward lower candidates when score is negative
  const baseIdx = h % candidates.length;
  const bias = Math.round((1 - Math.max(0, Math.min(1, (normScore + 1.5) / 3.0))) * 4); // 0 (bright) to 4 (dark) semitone shift
  const rootIdx = Math.max(0, baseIdx - bias) % candidates.length;
  const root = candidates[rootIdx];

  currentMood = mode;
  currentScale = buildScale(root, mode);
  return { mood: mode, root, scale: currentScale };
}


// ── Aphex Twin #3 (SAW 85-92) inspired ambient ───────────────
// Everything here shares ONE clock (a slow quarter-note pulse) so the
// pad, the sub pulse, and the motif lock together rhythmically. Harmony
// is drawn from currentScale, which is derived per-text from its mood.
export function clearAmb() {
  ambTimers.forEach(id => clearTimeout(id));
  ambTimers = [];
  clockRunning = false;
}

let ambientDensity = 1; // 0.55 = sparse/start, 1 = normal/middle, 1.35 = dense/end
let clockRunning = false;

const BEAT_SEC = 1.15; // shared tempo — slow, ~52 BPM quarter notes
const BAR_BEATS = 4;

// scale degree roots to drift between for the pad chords — i, iii, v, vii
// (kept generic; actual frequencies come from currentScale at play time)
const CHORD_DEGREES = [0, 2, 4, 6];
// motif notes now pulled live from currentScale (octave-shifted), not a fixed list

export function startAmbient(dests) {
  const c = ac();
  clockRunning = true;
  let beat = 0;       // global beat counter
  let lastDegree = null;

  // ---- warm pad: holds the current chord, crossfades into the next ----
  function playChord(freqs, dur) {
    const detunes = [-7, 7, 0, 4];
    freqs.forEach((f, idx) => {
      const type = idx === 0 ? 'sine' : (idx % 2 === 0 ? 'sine' : 'sawtooth');
      const osc = c.createOscillator(), g = c.createGain();
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1200; lp.Q.value = 0.4;
      osc.type = type; osc.frequency.value = f; osc.detune.value = detunes[idx % detunes.length];
      const peak = (idx === 0 ? 0.085 : 0.05) * ambientDensity;
      const attack = dur * 0.35;
      const release = dur * 0.5;
      g.gain.setValueAtTime(0, c.currentTime);
      g.gain.linearRampToValueAtTime(peak, c.currentTime + attack);
      g.gain.setValueAtTime(peak, c.currentTime + dur - release);
      g.gain.linearRampToValueAtTime(0, c.currentTime + dur);
      osc.connect(lp); lp.connect(g);
      g.connect(reverbNode); dests.forEach(d => g.connect(d));
      osc.start(); osc.stop(c.currentTime + dur + 0.1);
    });
  }

  // ---- soft sub pulse on beat 1 and 3 of each bar — the heartbeat ----
  function playPulse() {
    const osc = c.createOscillator(), g = c.createGain();
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 180;
    osc.type = 'sine'; osc.frequency.value = 55;
    const dur = BEAT_SEC * 0.8;
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(0.09 * ambientDensity, c.currentTime + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    osc.connect(lp); lp.connect(g);
    dests.forEach(d => g.connect(d));
    osc.start(); osc.stop(c.currentTime + dur + 0.05);
  }

  // ---- sparse motif note, quantized to the beat grid, drawn from current chord's scale ----
  function playMotifNote() {
    const f = pick(currentScale) * 2; // octave up from the pad register, into a singing range
    const osc = c.createOscillator(), g = c.createGain();
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2000;
    osc.type = 'sine'; osc.frequency.value = f;
    const dur = BEAT_SEC * rnd(1.4, 2.2);
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(rnd(0.03, 0.055) * ambientDensity, c.currentTime + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    osc.connect(lp); lp.connect(g);
    g.connect(reverbNode); dests.forEach(d => g.connect(d));
    osc.start(); osc.stop(c.currentTime + dur + 0.1);
  }

  // ---- gentle tape warmth bed, slow and continuous, tied to bar length ----
  function playTapeWarmth(dur) {
    const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let j = 0; j < d.length; j++) d[j] = (_rand() * 2 - 1) * 0.4;
    const src = c.createBufferSource(); src.buffer = buf;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = 0.5;
    const g = c.createGain();
    const attack = dur * 0.3, release = dur * 0.3;
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(0.015 * ambientDensity, c.currentTime + attack);
    g.gain.setValueAtTime(0.015 * ambientDensity, c.currentTime + dur - release);
    g.gain.linearRampToValueAtTime(0, c.currentTime + dur);
    src.connect(bp); bp.connect(g);
    dests.forEach(dd => g.connect(dd));
    src.start();
  }

  // ---- the shared clock: one bar = 4 beats, chord changes every bar ----
  function tick() {
    if (stopping || !clockRunning) return;
    const beatInBar = beat % BAR_BEATS;
    const barDur = BEAT_SEC * BAR_BEATS;

    if (beatInBar === 0) {
      // new bar — drift to a new (different) scale degree within currentScale,
      // re-voice the pad with overlap so it crossfades into the previous chord
      let degree = pick(CHORD_DEGREES);
      if (degree === lastDegree) degree = pick(CHORD_DEGREES.filter(d => d !== lastDegree));
      lastDegree = degree;
      playChord(chordFromScale(currentScale, degree), barDur * 1.15); // slightly longer than the bar so it crossfades into the next
      playTapeWarmth(barDur * 1.1);
    }

    // pulse on beats 0 and 2 (the "1 and 3")
    if (beatInBar === 0 || beatInBar === 2) playPulse();

    // motif notes: sparse, mostly on off-beats, density-gated
    if (_rand() < 0.32 * ambientDensity && (beatInBar === 1 || beatInBar === 3)) {
      playMotifNote();
    }

    beat++;
    ambTimers.push(setTimeout(tick, BEAT_SEC * 1000));
  }

  tick();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── State accessors for main.js (no logic change — just module boundary wrappers) ──
export function setStopping(v) { stopping = v; }
export function isStopping() { return stopping; }
export function setAmbientDensity(v) { ambientDensity = v; }
export function getAmbientDensity() { return ambientDensity; }
export function resetReverb() { reverbNode = null; reverbSend = null; }
export function randUnit() { return _rand(); }
export function getCurrentMood() { return currentMood; }
