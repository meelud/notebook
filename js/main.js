import { hashText } from './mood.js';
import {
  ac, seedRng, VOICES, playWord, setMood, wordNoteScale,
  startAmbient, stopAmbient, isAmbientRunning, ensureCtx, getMasterBus,
  getSilenceDuration, rnd,
} from './audio-engine.js';

// ──────────────────────────────────────────────────────────────
//  DOM refs
// ──────────────────────────────────────────────────────────────
const editor = document.getElementById('editor');
const playBtn = document.getElementById('bPlay');
const stopBtn = document.getElementById('bStop');
const saveBtn = document.getElementById('bSave');
const clearBtn = document.getElementById('bClear');
const wcEl = document.getElementById('wc');
const renderEl = document.getElementById('render');
const progEl = document.getElementById('prog');
const progFill = document.getElementById('pf');
const vizEl = document.getElementById('viz');
const vizBars = vizEl ? [...vizEl.querySelectorAll('.bar')] : [];

// ──────────────────────────────────────────────────────────────
//  State
// ──────────────────────────────────────────────────────────────
let playing = false;
let playTimeout = null;


// ──────────────────────────────────────────────────────────────
//  Tokenizer — split text into words + keep punctuation context
// ──────────────────────────────────────────────────────────────
function tokenize(text) {
  // Robust tokenizer: handles Persian (with ZWNJ/نیم‌فاصله), Arabic, English,
  // numbers, emoji, and preserves punctuation context for silence/breath logic.
  const tokens = [];
  // Match: word characters (incl. Persian/Arabic + ZWNJ + numbers + emoji)
  // or whitespace/punctuation chunks
  const regex = /([\p{L}\p{N}\u200c]+)|(\s+)|([^\p{L}\p{N}\u200c\s]+)/gu;
  let lastPunct = '';
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match[1]) {
      // Word (letters/numbers/ZWNJ)
      tokens.push({ word: match[1], punctBefore: lastPunct, len: match[1].length });
      lastPunct = '';
    } else if (match[2]) {
      // Whitespace — detect paragraph breaks
      if (/\n\s*\n/.test(match[2])) lastPunct += '\n\n';
    } else if (match[3]) {
      // Punctuation
      lastPunct += match[3];
    }
  }
  return tokens;
}

// ──────────────────────────────────────────────────────────────
//  Sentence type detection
// ──────────────────────────────────────────────────────────────
function detectSentenceType(text) {
  const trimmed = text.trim();
  if (/[?؟]\s*$/.test(trimmed)) return 'question';
  if (/[!]\s*$/.test(trimmed)) return 'exclamation';
  return 'statement';
}

// ──────────────────────────────────────────────────────────────
//  Word highlight (render overlay)
// ──────────────────────────────────────────────────────────────
let wordSpans = [];

function buildRenderOverlay(text) {
  if (!renderEl) return;
  // Split text preserving whitespace for display
  const parts = text.split(/(\s+)/);
  renderEl.innerHTML = '';
  wordSpans = [];
  for (const part of parts) {
    if (/^\s+$/.test(part)) {
      // Preserve whitespace as text node
      renderEl.appendChild(document.createTextNode(part));
    } else if (part) {
      const span = document.createElement('span');
      span.textContent = part;
      renderEl.appendChild(span);
      wordSpans.push(span);
    }
  }
  renderEl.style.display = 'block';
  if (editor) editor.style.color = 'transparent';
}

function highlightWord(idx) {
  // Remove previous highlights
  wordSpans.forEach(s => s.classList.remove('w-active'));
  if (idx >= 0 && idx < wordSpans.length) {
    wordSpans[idx].classList.add('w-active');
  }
}

function clearRenderOverlay() {
  if (renderEl) { renderEl.style.display = 'none'; renderEl.innerHTML = ''; }
  if (editor) editor.style.color = '';
  wordSpans = [];
}

// ──────────────────────────────────────────────────────────────
//  Playback loop
// ──────────────────────────────────────────────────────────────
function startPlayback() {
  const text = editor.value || editor.innerText || '';
  if (!text.trim()) return;

  playing = true;
  if (playBtn) playBtn.disabled = true;
  if (stopBtn) stopBtn.disabled = false;
  if (wcEl) wcEl.textContent = '▶ playing';
  startViz();

  // Seed RNG from text hash for deterministic output
  const hash = hashText(text);
  seedRng(hash);

  // Set mood/scale from text
  const { mood, analysis } = setMood(text);

  // Tokenize
  const tokens = tokenize(text);
  if (tokens.length === 0) { stopPlayback(); return; }

  const sentenceType = detectSentenceType(text);
  const totalWords = tokens.length;

  // Start ambient bed
  const masterDest = getMasterBus();
  startAmbient([masterDest]);

  // Start recording if MediaRecorder available
  recSourceText = text;
  startRecording();
  buildRenderOverlay(text);

  // Play words one by one with timing
  let idx = 0;
  let wordHighlightIdx = 0;
  function playNext() {
    if (!playing || idx >= tokens.length) {
      // Let ambient ring out for a moment then stop
      playTimeout = setTimeout(() => stopPlayback(), 3000);
      return;
    }

    const token = tokens[idx];
    const progress = idx / totalWords;
    showProgress(progress);

    // Check for silence/breath before this word
    const silence = getSilenceDuration(token.punctBefore, idx, totalWords);
    if (silence > 0) {
      idx++; // consume the token but play silence
      // After silence, replay this word (or skip if it's just punctuation)
      playTimeout = setTimeout(() => {
        // Now play the actual word after the breath
        if (!playing) return;
        const result = playWord(token.word, sentenceType, progress, null, token.len);
        highlightWord(wordHighlightIdx++);
        const wordDur = result.duration || 0.4;
        // Base timing between words
        const gap = wordDur * rnd(0.5, 0.8) + 0.05;
        playTimeout = setTimeout(playNext, (silence + gap) * 1000);
      }, silence * 1000);
      return;
    }

    // Play the word
    const result = playWord(token.word, sentenceType, progress, token.punctBefore, token.len);

    if (result.played) {
      highlightWord(wordHighlightIdx++);
      const wordDur = result.duration || 0.4;
      const gap = wordDur * rnd(0.4, 0.7) + 0.03;
      idx++;
      playTimeout = setTimeout(playNext, gap * 1000);
    } else {
      // silence returned from playWord itself
      idx++;
      const gap = result.silenceDur || 0.2;
      playTimeout = setTimeout(playNext, gap * 1000);
    }
  }

  playNext();
}

function stopPlayback() {
  playing = false;
  if (playTimeout) { clearTimeout(playTimeout); playTimeout = null; }
  stopAmbient();
  clearRenderOverlay();
  hideProgress();
  stopViz();
  updatePlayState();
  updateWordCount();
  if (stopBtn) stopBtn.disabled = true;
  if (saveBtn) saveBtn.disabled = (recLength === 0);
  stopRecording();
}

// ──────────────────────────────────────────────────────────────
//  Recording — raw PCM capture → WAV export (zero dependency)
// ──────────────────────────────────────────────────────────────
let recProcessor = null;
let recBuffersL = [];
let recBuffersR = [];
let recLength = 0;
let recSampleRate = 44100;
let recSourceText = '';

function startRecording() {
  try {
    const ctx = ensureCtx();
    recSampleRate = ctx.sampleRate;
    recBuffersL = [];
    recBuffersR = [];
    recLength = 0;
    // ScriptProcessor captures raw stereo PCM from the master bus
    const bufferSize = 4096;
    recProcessor = ctx.createScriptProcessor(bufferSize, 2, 2);
    recProcessor.onaudioprocess = (e) => {
      const l = e.inputBuffer.getChannelData(0);
      const r = e.inputBuffer.getChannelData(1);
      recBuffersL.push(new Float32Array(l));
      recBuffersR.push(new Float32Array(r));
      recLength += l.length;
    };
    // Tap the master bus into the processor (processor → destination to keep it alive,
    // but at zero gain so it doesn't double the audio)
    const silentSink = ctx.createGain();
    silentSink.gain.value = 0;
    getMasterBus().connect(recProcessor);
    recProcessor.connect(silentSink);
    silentSink.connect(ctx.destination);
  } catch (e) {
    recProcessor = null;
  }
}

function stopRecording() {
  if (recProcessor) {
    try {
      getMasterBus().disconnect(recProcessor);
      recProcessor.disconnect();
    } catch (e) {}
    recProcessor = null;
  }
}

// Merge chunked Float32 buffers into one
function mergeBuffers(buffers, len) {
  const result = new Float32Array(len);
  let offset = 0;
  for (const b of buffers) { result.set(b, offset); offset += b.length; }
  return result;
}

// Encode stereo PCM Float32 → 16-bit WAV Blob (pure, zero-dependency)
function encodeWAV(left, right, sampleRate) {
  const length = left.length + right.length;
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);       // PCM chunk size
  view.setUint16(20, 1, true);        // PCM format
  view.setUint16(22, 2, true);        // stereo
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true); // byte rate (2 ch * 2 bytes)
  view.setUint16(32, 4, true);        // block align
  view.setUint16(34, 16, true);       // bits per sample
  writeString(36, 'data');
  view.setUint32(40, length * 2, true);
  // interleave L/R and clamp to 16-bit
  let offset = 44;
  for (let i = 0; i < left.length; i++) {
    let s = Math.max(-1, Math.min(1, left[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true); offset += 2;
    s = Math.max(-1, Math.min(1, right[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true); offset += 2;
  }
  return new Blob([view], { type: 'audio/wav' });
}

// Build a simple black cover PNG with the text (Canvas, zero-dependency)
function buildCover(text) {
  const size = 1000;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  // black background
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, size, size);
  // text style — iPhone-like system font
  ctx.fillStyle = '#f2f2f2';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const isRTL = /[\u0600-\u06FF]/.test(text);
  ctx.direction = isRTL ? 'rtl' : 'ltr';
  // fit text: wrap into lines, shrink font to fit
  const clean = text.trim().replace(/\s+/g, ' ');
  let fontSize = 64;
  const maxWidth = size * 0.82;
  const maxHeight = size * 0.82;
  function wrapLines(fs) {
    ctx.font = `500 ${fs}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif`;
    const words = clean.split(' ');
    const lines = [];
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; }
      else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }
  let lines = wrapLines(fontSize);
  while ((lines.length * fontSize * 1.4) > maxHeight && fontSize > 18) {
    fontSize -= 4;
    lines = wrapLines(fontSize);
  }
  ctx.font = `500 ${fontSize}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif`;
  const lineH = fontSize * 1.4;
  const startY = size / 2 - ((lines.length - 1) * lineH) / 2;
  lines.forEach((ln, i) => ctx.fillText(ln, size / 2, startY + i * lineH));
  return canvas;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function slugFromText(text) {
  const s = (text || '').trim().replace(/\s+/g, '-').slice(0, 24).replace(/[^\p{L}\p{N}-]/gu, '');
  return s || 'notebook';
}

function saveRecording() {
  if (recLength === 0) {
    if (wcEl) wcEl.textContent = '⚠ nothing recorded';
    setTimeout(updateWordCount, 2000);
    return;
  }
  const left = mergeBuffers(recBuffersL, recLength);
  const right = mergeBuffers(recBuffersR, recLength);
  const wavBlob = encodeWAV(left, right, recSampleRate);
  const base = `notebook-${slugFromText(recSourceText)}`;
  downloadBlob(wavBlob, `${base}.wav`);
  // cover art PNG
  try {
    const cover = buildCover(recSourceText);
    cover.toBlob((pngBlob) => {
      if (pngBlob) downloadBlob(pngBlob, `${base}-cover.png`);
    }, 'image/png');
  } catch (e) {}
  if (wcEl) wcEl.textContent = '💾 saved!';
  setTimeout(updateWordCount, 2000);
}

// ──────────────────────────────────────────────────────────────
//  Event Listeners & Keyboard Shortcuts
// ──────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────
//  iOS / Mobile: unlock AudioContext on first user interaction
// ──────────────────────────────────────────────────────────────
let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked) return;
  const ctx = ensureCtx();
  if (ctx.state === 'suspended') ctx.resume();
  // Create a silent buffer and play it to unlock on iOS Safari
  const silent = ctx.createBuffer(1, 1, ctx.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = silent;
  src.connect(ctx.destination);
  src.start();
  audioUnlocked = true;
  // Remove listeners after unlock
  ['touchstart', 'touchend', 'mousedown', 'keydown'].forEach(evt => {
    document.removeEventListener(evt, unlockAudio, { capture: true });
  });
}
['touchstart', 'touchend', 'mousedown', 'keydown'].forEach(evt => {
  document.addEventListener(evt, unlockAudio, { capture: true, once: false });
});

if (playBtn) playBtn.addEventListener('click', startPlayback);
if (stopBtn) stopBtn.addEventListener('click', stopPlayback);
if (saveBtn) saveBtn.addEventListener('click', saveRecording);

document.addEventListener('keydown', (e) => {
  // Shift+Enter → play
  if (e.shiftKey && e.key === 'Enter') {
    e.preventDefault();
    if (!playing) startPlayback();
  }
  // Escape → stop
  if (e.key === 'Escape') {
    e.preventDefault();
    stopPlayback();
  }
  // Cmd/Ctrl+S → save recording
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    saveRecording();
  }
});

// ──────────────────────────────────────────────────────────────
//  Word count
// ──────────────────────────────────────────────────────────────
function updateWordCount() {
  const text = editor ? (editor.value || '') : '';
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  if (wcEl && !playing) wcEl.textContent = `${words} word${words !== 1 ? 's' : ''}`;
}

// ──────────────────────────────────────────────────────────────
//  Progress bar & Visualizer
// ──────────────────────────────────────────────────────────────
function showProgress(fraction) {
  if (progEl) progEl.classList.add('on');
  if (progFill) progFill.style.width = `${Math.min(fraction * 100, 100)}%`;
}
function hideProgress() {
  if (progEl) progEl.classList.remove('on');
  if (progFill) progFill.style.width = '0%';
}

let vizInterval = null;
function startViz() {
  if (vizEl) vizEl.classList.add('on');
  vizInterval = setInterval(() => {
    vizBars.forEach(bar => {
      bar.style.height = `${2 + Math.random() * 14}px`;
    });
  }, 120);
}
function stopViz() {
  if (vizEl) vizEl.classList.remove('on');
  if (vizInterval) { clearInterval(vizInterval); vizInterval = null; }
  vizBars.forEach(bar => { bar.style.height = '1.5px'; });
}

// ──────────────────────────────────────────────────────────────
//  Clear button
// ──────────────────────────────────────────────────────────────
if (clearBtn) {
  clearBtn.addEventListener('click', () => {
    if (playing) stopPlayback();
    if (editor) editor.value = '';
    updateWordCount();
    updatePlayState();
  });
}

// ──────────────────────────────────────────────────────────────
//  Initial state & play-button logic
// ──────────────────────────────────────────────────────────────
if (stopBtn) stopBtn.disabled = true;
if (saveBtn) saveBtn.disabled = true;

function updatePlayState() {
  const text = editor ? (editor.value || '') : '';
  if (playBtn) playBtn.disabled = !text.trim();
}
if (editor) {
  editor.addEventListener('input', () => {
    updatePlayState();
    updateWordCount();
  });
  updatePlayState();
  updateWordCount();
}
