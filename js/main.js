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
let mediaRecorder = null;
let recordedChunks = [];

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
  if (saveBtn) saveBtn.disabled = (recordedChunks.length === 0);
  stopRecording();
}

// ──────────────────────────────────────────────────────────────
//  Recording (MediaRecorder → .webm export)
// ──────────────────────────────────────────────────────────────
function startRecording() {
  try {
    const ctx = ensureCtx();
    const dest = ctx.createMediaStreamDestination();
    getMasterBus().connect(dest);
    mediaRecorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm' });
    recordedChunks = [];
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.start();
  } catch (e) {
    // MediaRecorder not supported — silent fail
    mediaRecorder = null;
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

function saveRecording() {
  if (recordedChunks.length === 0) {
    if (wcEl) wcEl.textContent = '⚠ nothing recorded';
    setTimeout(updateWordCount, 2000);
    return;
  }
  const blob = new Blob(recordedChunks, { type: 'audio/webm' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `notebook-${Date.now()}.webm`;
  a.click();
  URL.revokeObjectURL(url);
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
