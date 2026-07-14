import { buildScale, detectMood, analyzeText, hashText, ROOT_CANDIDATES_LOW, ROOT_CANDIDATES_MID, chordFromScale, MODE_ORDER, CHORD_VOICINGS, buildVoicing } from './mood.js';

// ── Audio Engine ─────────────────────────────────────────────
// All shared audio state (AudioContext, reverb, RNG cursor, current
// scale/mood, ambient density, timers, stopping flag) lives here so
// every synthesis function mutates the exact same state — identical
// runtime behavior to the original single-file version.

let AC = null;
let stopping = false;

let ambTimers = [];
let droneStops = []; // long-lived drone oscillators/LFOs, stopped in clearAmb
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

// Per-text harmony state — declared up here (before wordNoteScale, which reads
// them) so there's no temporal-dead-zone fragility. Set by deriveTextHarmony().
let currentScale = buildScale(110.00, 'minor');
let currentMood = 'minor';

// Per-text signals (from analyzeText) that drive the atmospheric layers below.
// Each new sound layer is tied to the signal it belongs to:
//   drone   → darkness   (weight & depth of the piece)
//   crackle → nostalgia  (memory / the past → vinyl dust)
//   hiss    → tension    (unease → restless air/noise)
let sig = { darkness: 0.5, tension: 0, nostalgia: 0, density: 0, valence: 0 };

// Darkness of the current mood on a 0..1 scale (0 = brightest mode, 1 = darkest),
// derived from where the mood sits in MODE_ORDER (which runs dark → bright).
// This is the single knob that drives the atmospheric dynamics below —
// keeping everything tied to the text's feeling without changing any timbre.
function moodDarkness() {
  const i = MODE_ORDER.indexOf(currentMood);
  if (i < 0) return 0.5;
  return 1 - (i / (MODE_ORDER.length - 1)); // index 0 = darkest → 1.0
}

// Word-note palette is built per-text from currentScale (set by deriveTextHarmony),
// spread across octaves that match the mood's register:
// dark moods → lower, tighter range; bright moods → wider, higher range
export function wordNoteScale() {
  const out = [];
  const modeIdx = MODE_ORDER.indexOf(currentMood);
  // IMPORTANT: octave multipliers MUST be powers of two. Multiplying a scale
  // frequency by 2^k transposes it by whole octaves, so it stays exactly on a
  // note of the scale (in-key). Non-power-of-two factors like 3 or 6 shift by an
  // octave + a fifth and land OFF the scale — that was the source of off-key notes.
  let octaves;
  if (modeIdx <= 4)       octaves = [0.5, 1, 2];        // dark — low and heavy
  else if (modeIdx <= 8)  octaves = [0.5, 1, 2, 4];     // mid — normal range
  else if (modeIdx <= 12) octaves = [1, 2, 4];          // lighter — higher, wider
  else                    octaves = [1, 2, 4, 8];       // bright — wide, airy
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
  // capture the full signal set so the atmospheric layers can each track the
  // aspect of the text they belong to
  sig = analyzeText(text);
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
  // fade & stop the long-lived deep drone (if any)
  droneStops.forEach(node => { try { node.stop(); } catch (e) {} });
  droneStops = [];
}

let ambientDensity = 1; // 0.55 = sparse/start, 1 = normal/middle, 1.35 = dense/end
let clockRunning = false;

const BEAT_SEC = 1.15; // shared tempo — slow, ~52 BPM quarter notes
const BAR_BEATS = 4;

// scale degree roots to drift between for the pad chords — i, iii, v, vii
// (kept generic; actual frequencies come from currentScale at play time)
// Stable, consonant scale degrees for the pad progression: i, iv, v, vi.
// (Avoids iii and vii°, whose triads are unstable/diminished in many modes and
//  made the harmony lurch when the pad jumped to them.)
const CHORD_DEGREES = [0, 3, 4, 5];
// A smooth default progression the pad prefers to walk along, so chord changes
// feel like motion through a key rather than random leaps. Falls back to a
// nearest-choice pick when it needs to vary.
const PROGRESSION = [0, 5, 3, 4]; // i – vi – iv – v (classic, always resolves)
// motif notes now pulled live from currentScale (octave-shifted), not a fixed list

export function startAmbient(dests) {
  const c = ac();
  clockRunning = true;
  let beat = 0;       // global beat counter
  let lastDegree = null;
  let progStep = 0;   // position along PROGRESSION for smooth chord motion
  droneStops.length = 0; // reset the drone node list for this run

  // Effective beat length: darker text breathes slower (Burial-esque drag),
  // brighter text moves a touch quicker — a gentle ±15% around BEAT_SEC, never
  // a jarring tempo change. Computed live so it tracks the mood of the text.
  function beatDur() {
    const d = moodDarkness();            // 0 bright .. 1 dark
    return BEAT_SEC * (1 + d * 0.18 - (1 - d) * 0.06);
  }

  // ---- warm pad: holds the current chord, crossfades into the next ----
  function playChord(freqs, dur) {
    const detunes = [-7, 7, 0, 4];
    // darker moods sit behind a lower, more closed filter (Hecker's veiled pads);
    // brighter moods open up a little. Base cutoff moves with darkness.
    const baseCutoff = 1400 - moodDarkness() * 700; // ~700Hz dark .. ~1400Hz bright
    freqs.forEach((f, idx) => {
      const type = idx === 0 ? 'sine' : (idx % 2 === 0 ? 'sine' : 'sawtooth');
      const osc = c.createOscillator(), g = c.createGain();
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = baseCutoff; lp.Q.value = 0.4;

      // slow filter "breathing" — a gentle LFO opens/closes the cutoff over the
      // life of the pad, giving the analog, living texture of Hecker/Daft pads
      // without altering the underlying tone. Rate/depth are subtle & deterministic.
      const lfo = c.createOscillator(), lfoGain = c.createGain();
      lfo.type = 'sine';
      lfo.frequency.value = rnd(0.04, 0.09); // very slow — one breath every ~11-25s
      lfoGain.gain.value = baseCutoff * 0.35;
      lfo.connect(lfoGain); lfoGain.connect(lp.frequency);
      lfo.start(); lfo.stop(c.currentTime + dur + 0.1);

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
    const dur = beatDur() * 0.8;
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(0.09 * ambientDensity, c.currentTime + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    osc.connect(lp); lp.connect(g);
    dests.forEach(d => g.connect(d));
    osc.start(); osc.stop(c.currentTime + dur + 0.05);
  }

  // ---- sparse motif note — the "singing" voice of the piece ----
  // This is the warm, familiar melodic tone from the original version. The
  // character came from SIMPLICITY: a single pure sine, one octave up (a warm,
  // vocal register), a gentle filter, a soft slow attack, and long sustained
  // notes that "sing". Adding a bright triangle, plucky short notes, and higher
  // octaves made it thin and cold — so we keep it pure and soft here. In-key is
  // preserved by using power-of-two octaves only.
  function playMotifNote() {
    const f = pick(currentScale) * 2; // one octave up — warm, singing register
    const osc = c.createOscillator(), g = c.createGain();
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2000 - moodDarkness() * 400;
    osc.type = 'sine'; osc.frequency.value = f;
    const dur = beatDur() * rnd(1.4, 2.2); // long, sustained, vocal
    const peak = rnd(0.035, 0.06) * ambientDensity; // soft & gentle, like the original
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(peak, c.currentTime + 0.12); // soft slow attack — no plucky bite
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

  // ════════════════════════════════════════════════════════════
  //  NEW atmospheric layers — each tied to a TEXT SIGNAL, so the
  //  soundstage grows out of what's written. No existing timbre is
  //  changed; these are additive background textures in the same
  //  Hecker / Burial / Daft-Punk space.
  // ════════════════════════════════════════════════════════════

  // (A) DEEP DRONE ← darkness. A sub-register sustained pad, one octave below
  //     the root, that gives the piece its "belly". The darker the text, the
  //     louder, lower, and more present the drone. Bright text ≈ silent.
  let droneNode = null;
  function startDrone() {
    // Only real, emotionally-dark text gets a drone. Gate on darkness AND density
    // so a neutral sentence (which lands mid-scale by default) stays clean and
    // doesn't get a drone that would make every piece sound the same.
    const droneStrength = Math.max(0, sig.darkness - 0.5) * 2 * Math.min(1, sig.density * 1.5);
    if (droneStrength < 0.15) return;
    const rootHz = currentScale[0] * 0.5; // an octave below the tonic
    const master = c.createGain();
    master.gain.value = 0;
    const target = 0.04 + droneStrength * 0.09; // scaled by how dark AND saturated the text is
    master.gain.linearRampToValueAtTime(target, c.currentTime + 4);
    // two slightly detuned low oscillators through a very low lowpass = warm sub drone
    [-4, 4].forEach(det => {
      const osc = c.createOscillator();
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 220 - sig.darkness * 90;
      osc.type = 'sawtooth'; osc.frequency.value = rootHz; osc.detune.value = det;
      // slow "breathing" of the drone's filter
      const lfo = c.createOscillator(), lfoGain = c.createGain();
      lfo.type = 'sine'; lfo.frequency.value = rnd(0.03, 0.07); lfoGain.gain.value = 40;
      lfo.connect(lfoGain); lfoGain.connect(lp.frequency);
      osc.connect(lp); lp.connect(master);
      lfo.start(); osc.start();
      droneStops.push(osc, lfo);
    });
    // a quiet pure sub-sine an octave lower still, for weight
    const sub = c.createOscillator(), subG = c.createGain();
    sub.type = 'sine'; sub.frequency.value = rootHz * 0.5;
    subG.gain.value = target * 0.6;
    sub.connect(subG); subG.connect(master);
    sub.start(); droneStops.push(sub);

    master.connect(reverbNode);
    dests.forEach(d => master.connect(d));
    droneNode = master;
  }

  // (B) VINYL CRACKLE ← nostalgia (+ a little darkness). Sparse dust/pops and a
  //     faint continuous crackle bed — the memory/old-recording feel of Burial.
  //     Fires occasionally; probability scales with nostalgia.
  function playCrackle() {
    const amount = sig.nostalgia * 0.8 + sig.darkness * 0.15;
    if (amount < 0.05) return;
    const dur = rnd(0.4, 1.1);
    const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
    const d = buf.getChannelData(0);
    // mostly silence with occasional sharp specks = crackle, not hiss
    for (let j = 0; j < d.length; j++) {
      d[j] = (_rand() < 0.004) ? (_rand() * 2 - 1) * (0.5 + _rand() * 0.5) : 0;
    }
    const src = c.createBufferSource(); src.buffer = buf;
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1500;
    const g = c.createGain(); g.gain.value = 0.10 * amount;
    src.connect(hp); hp.connect(g);
    dests.forEach(dd => g.connect(dd));
    src.start();
  }

  // (C) TAPE HISS / AIR ← tension. A soft filtered pink-ish noise bed whose level
  //     and restlessness rise with the text's tension/unease. Calm text ≈ silent.
  function playHiss(dur) {
    const amount = sig.tension;
    if (amount < 0.08) return;
    const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let j = 0; j < d.length; j++) {
      // simple lowpassed noise → soft "air" rather than white static
      const white = _rand() * 2 - 1;
      last = last * 0.96 + white * 0.04;
      d[j] = last * 3;
    }
    const src = c.createBufferSource(); src.buffer = buf;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.value = 2000 + amount * 3000; bp.Q.value = 0.4;
    const g = c.createGain();
    const peak = 0.012 * amount;
    const a = dur * 0.3, r = dur * 0.3;
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(peak, c.currentTime + a);
    g.gain.setValueAtTime(peak, c.currentTime + dur - r);
    g.gain.linearRampToValueAtTime(0, c.currentTime + dur);
    src.connect(bp); bp.connect(g);
    dests.forEach(dd => g.connect(dd));
    src.start();
  }

  // ---- the shared clock: one bar = 4 beats, chord changes every bar ----
  function tick() {
    if (stopping || !clockRunning) return;
    const beatInBar = beat % BAR_BEATS;
    const thisBeat = beatDur();
    const barDur = thisBeat * BAR_BEATS;

    if (beatInBar === 0) {
      // new bar — move the pad to the NEXT chord. Mostly walk the smooth
      // i–vi–iv–v progression (so changes feel like motion within the key,
      // not random leaps); occasionally take a small variation to a nearby
      // stable degree. This fixes the jarring key/scale transitions.
      let degree;
      if (_rand() < 0.78) {
        degree = PROGRESSION[progStep % PROGRESSION.length];
        progStep++;
      } else {
        degree = pick(CHORD_DEGREES);
        if (degree === lastDegree) degree = pick(CHORD_DEGREES.filter(d => d !== lastDegree));
      }
      lastDegree = degree;
      playChord(chordFromScale(currentScale, degree), barDur * 1.15); // slightly longer than the bar so it crossfades into the next
      playTapeWarmth(barDur * 1.1);
      playHiss(barDur * 1.1);   // tension-driven air bed, renewed each bar
    }

    // pulse on beats 0 and 2 (the "1 and 3")
    if (beatInBar === 0 || beatInBar === 2) playPulse();

    // motif notes: sparse & singing, like the original — a gentle recurring
    // melodic voice, not a busy lead. Brighter text is a little more active.
    // Mostly on off-beats so it floats over the pad rather than marching.
    const motifChance = (0.34 + (1 - moodDarkness()) * 0.12) * ambientDensity;
    if (_rand() < motifChance && (beatInBar === 1 || beatInBar === 3)) {
      playMotifNote();
    }

    // vinyl crackle — nostalgia-driven, sparse & random across the bar (Burial dust)
    if (_rand() < 0.5 * (sig.nostalgia * 0.8 + sig.darkness * 0.15)) {
      playCrackle();
    }

    beat++;
    // micro-timing jitter — a subtle human/tape drift (Burial's loose swing),
    // scaled by darkness so tense/dark pieces feel slightly less mechanical.
    // Deterministic (uses the seeded RNG), so a given text still replays identically.
    const jitter = 1 + (_rand() - 0.5) * 0.06 * (0.5 + moodDarkness());
    ambTimers.push(setTimeout(tick, thisBeat * jitter * 1000));
  }

  startDrone(); // darkness-driven sub drone runs under the whole piece
  tick();
}

// Play a brief, soft chord that colours a meaningful moment in the text (end of
// a sentence, a strong/peak word). The voicing is chosen from CHORD_VOICINGS by
// the text's mood and built from currentScale, so it's always in-key. It's quiet
// and short — harmonic colour, never the backbone. `moodKey` selects the group.
export function playChordVoicing(moodKey, dests, pan = 0, strength = 1) {
  const c = ac();
  const group = CHORD_VOICINGS[moodKey] || CHORD_VOICINGS.calm;
  const offsets = pick(group);
  // pick a stable-ish root degree (i, iv, v, vi) so the chord sits well in key
  const rootDeg = pick([0, 0, 3, 4, 5]);
  const freqs = buildVoicing(currentScale, offsets, rootDeg);
  const panner = c.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  panner.connect(reverbNode);
  dests.forEach(d => panner.connect(d));
  const dur = rnd(1.1, 2.0);
  freqs.forEach((f, i) => {
    const osc = c.createOscillator(), g = c.createGain();
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2200;
    // soft, warm tone; slightly staggered entry = gentle "strum"
    osc.type = i === 0 ? 'sine' : 'triangle';
    osc.frequency.value = f;
    const t0 = c.currentTime + i * 0.012;
    const peak = (0.05 + strength * 0.05) * (1 - i * 0.08); // quiet; top notes softer
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(Math.max(0.008, peak), t0 + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(lp); lp.connect(g); g.connect(panner);
    osc.start(t0); osc.stop(t0 + dur + 0.1);
  });
}

// Play a word's voice through a per-note stereo panner, so successive words
// drift gently across the stereo field (adds spatial depth without touching any
// timbre). `pan` is -1..1. The panner sits between the voice and the real
// destinations; the voice itself is unchanged — it just connects to the panner.
export function playPannedVoice(voiceIdx, freq, vol, dur, dests, pan) {
  const c = ac();
  const panner = c.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  panner.connect(dests[0]);          // to speakers
  for (let i = 1; i < dests.length; i++) panner.connect(dests[i]); // to recorder etc.
  VOICES[voiceIdx](freq, vol, dur, [panner]);
}

// ── State accessors for main.js (no logic change — just module boundary wrappers) ──
export function setStopping(v) { stopping = v; }
export function isStopping() { return stopping; }
export function setAmbientDensity(v) { ambientDensity = v; }
export function getAmbientDensity() { return ambientDensity; }
export function resetReverb() { reverbNode = null; reverbSend = null; }
export function randUnit() { return _rand(); }
export function getCurrentMood() { return currentMood; }

// Map the current text signals to a chord-voicing group name for playChordVoicing.
export function currentChordMood() {
  if (sig.tension > 0.45) return 'tense';
  if (sig.darkness > 0.62) return 'dark';
  if (sig.darkness < 0.32) return 'bright';
  return 'calm';
}
