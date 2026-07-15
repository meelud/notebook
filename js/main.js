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
const statusEl = document.getElementById('wc');
const renderEl = document.getElementById('render');

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
  // Split on whitespace but keep track of punctuation before each word
  const tokens = [];
  const parts = text.split(/(\s+)/);
  let lastPunct = '';
  for (const part of parts) {
    if (/^\s+$/.test(part)) {
      // whitespace — check for paragraph breaks
      if (/\n\s*\n/.test(part)) lastPunct += '\n\n';
      continue;
    }
    if (!part) continue;
    // Extract leading punctuation
    const leadMatch = part.match(/^([^a-zA-Z\u0600-\u06FF\u0750-\u077F]+)/);
    if (leadMatch) lastPunct += leadMatch[1];
    // The word itself (strip trailing punct for word, but save it)
    const wordMatch = part.match(/([a-zA-Z\u0600-\u06FF\u0750-\u077F\u200c]+)/g);
    const trailMatch = part.match(/([^a-zA-Z\u0600-\u06FF\u0750-\u077F]+)$/);
    if (wordMatch) {
      for (const w of wordMatch) {
        tokens.push({ word: w, punctBefore: lastPunct, len: w.length });
        lastPunct = '';
      }
    }
    if (trailMatch) lastPunct += trailMatch[1];
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
  if (statusEl) statusEl.textContent = '▶ Playing...';

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
  updatePlayState(); // re-enable play if there's text
  if (stopBtn) stopBtn.disabled = true;
  if (saveBtn) saveBtn.disabled = (recordedChunks.length === 0);
  if (statusEl) statusEl.textContent = '⏹ Stopped';
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
    if (statusEl) statusEl.textContent = '⚠ Nothing recorded yet';
    return;
  }
  const blob = new Blob(recordedChunks, { type: 'audio/webm' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `notebook-${Date.now()}.webm`;
  a.click();
  URL.revokeObjectURL(url);
  if (statusEl) statusEl.textContent = '💾 Saved!';
}

// ──────────────────────────────────────────────────────────────
//  Event Listeners & Keyboard Shortcuts
// ──────────────────────────────────────────────────────────────
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

// Initial state
if (stopBtn) stopBtn.disabled = true;
if (saveBtn) saveBtn.disabled = true;

// Enable play button when there's text
function updatePlayState() {
  const text = editor.value || '';
  if (playBtn) playBtn.disabled = !text.trim();
}
if (editor) {
  editor.addEventListener('input', updatePlayState);
  updatePlayState(); // check on load
}
