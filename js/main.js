import { hashText } from './mood.js';
import {
  ac, seedRng, VOICES, playPannedVoice,
  ensureReverb, playPunctuation, deriveTextHarmony,
  startAmbient, clearAmb, wordNoteScale,
  setStopping, isStopping, setAmbientDensity, getAmbientDensity, resetReverb,
  rnd, pick, randUnit,
} from './audio-engine.js';

const editor = document.getElementById('editor');
const render = document.getElementById('render');
const bPlay  = document.getElementById('bPlay');
const bStop  = document.getElementById('bStop');
const bSave  = document.getElementById('bSave');
const bClear = document.getElementById('bClear');
const wcEl   = document.getElementById('wc');
const viz    = document.getElementById('viz');
const bars   = viz.querySelectorAll('.bar');
// (status pill removed — no stEl reference needed)
const prog   = document.getElementById('prog');
const pf     = document.getElementById('pf');

let playing = false;
let rec = null, chunks = [], audioBlob = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\n') {
      tokens.push({ type: 'space', start: i, end: i + 1, text: ch });
      i++;
    } else if ('.!?,;:'.includes(ch)) {
      tokens.push({ type: 'punct', start: i, end: i + 1, text: ch });
      i++;
    } else {
      let j = i;
      while (j < text.length && text[j] !== ' ' && text[j] !== '\n' && !'.!?,;:'.includes(text[j])) j++;
      tokens.push({ type: 'word', start: i, end: j, text: text.slice(i, j) });
      i = j;
    }
  }

  // annotate words with sentence context — look ahead to find each
  // sentence's ending punctuation so words get tagged with THEIR sentence's type
  const totalWords = tokens.filter(t => t.type === 'word').length;
  let wordIdx = 0;

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === 'word') {
      // scan forward to the next sentence-ending punctuation
      let endType = 'statement';
      for (let m = k + 1; m < tokens.length; m++) {
        if (tokens[m].type === 'punct') {
          if (tokens[m].text === '?') { endType = 'question'; break; }
          if (tokens[m].text === '!') { endType = 'exclaim'; break; }
          if (tokens[m].text === '.') { endType = 'statement'; break; }
        }
      }
      t.sentenceType = endType;
      wordIdx++;
      t.paraPos = wordIdx < totalWords * 0.18 ? 'start' : (wordIdx > totalWords * 0.82 ? 'end' : 'middle');
    }
  }
  return tokens;
}

function esc(s) {
  // #render uses white-space: pre-wrap, so real newlines render correctly —
  // we only need to neutralize HTML-significant characters here.
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function buildRender(text, a, b) {
  if (a >= b) return esc(text);
  return esc(text.slice(0, a))
    + `<span class="w-active">${esc(text.slice(a, b))}</span>`
    + esc(text.slice(b));
}

function animBars(vol) {
  bars.forEach(b => { b.style.height = Math.round(rnd(1.5, vol * 17)) + 'px'; });
  setTimeout(() => bars.forEach(b => b.style.height = '1.5px'), 120);
}

// status text used to render to a visible "ready" pill — that pill is gone now,
// but status() stays as a no-op hook so the rest of the playback logic (which
// calls it to report progress) doesn't need to change.
function status(s) { /* intentionally no-op — no visible status indicator */ }

// Harmony is only (re)derived once per text session — the first time play is pressed
// after a clear. Every subsequent press of play (even after continuing to write more)
// reads the WHOLE text from the very beginning again, using that same locked key.
let harmonyLocked = false;

async function play() {
  const text = editor.value;
  if (!text.trim()) return;

  if (!harmonyLocked) {
    const harmony = deriveTextHarmony(text); // sets currentScale + currentMood, locked until cleared
    harmonyLocked = true;
    status('key: ' + harmony.mood);
  }

  // reset the seeded RNG from this exact text every time — guarantees the
  // entire melody, voice choices, timing, and ambient pattern are identical
  // on every replay of the same text
  seedRng(hashText(text));

  playing = true; setStopping(false);
  resetReverb();
  setAmbientDensity(1);
  bPlay.disabled = true; bStop.disabled = false; bSave.disabled = true;
  editor.style.display = 'none';
  render.style.display = 'block';
  render.innerHTML = esc(text);
  viz.classList.add('on');
  prog.classList.add('on');
  pf.style.width = '0%';
  chunks = []; audioBlob = null;

  const c = ac();
  await c.resume();
  const sd = c.createMediaStreamDestination();
  const dests = [c.destination, sd];
  ensureReverb(dests);

  rec = new MediaRecorder(sd.stream);
  rec.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  rec.onstop = () => {
    audioBlob = new Blob(chunks, { type: 'audio/webm' });
    bSave.disabled = false;
    status('done — press write to continue, or play again');
  };
  rec.start();
  startAmbient(dests);

  const tokens = tokenize(text); // tokenize the FULL text — always read from the very beginning
  const playable = tokens.filter(t => t.type === 'word' || t.type === 'punct');
  const totalWords = tokens.filter(t => t.type === 'word').length;

  // voice groups by sentence type — question/exclaim lean toward brighter/plucked/percussive
  // voices, statements lean toward warmer pads/sustained/breathy voices. Indices map to the
  // VOICES array: 0 pad, 1 pluck, 2 breath, 3 bell, 4 ghost-chord, 5 piano, 6 warm-pad,
  // 7 string, 8 marimba, 9 glass-bell, 10 vibraphone, 11 music-box, 12 choir, 13 organ,
  // 14 sub-thump, 15 reed, 16 cello, 17 kalimba, 18 brass-swell, 19 celeste, 20 granular, 21 gong
  const VOICE_GROUPS = {
    statement: [0, 2, 5, 6, 10, 12, 13, 15, 16, 20, 21],
    question:  [1, 4, 7, 9, 11, 17, 19, 20],
    exclaim:   [1, 3, 5, 8, 9, 11, 14, 17, 18],
  };

  let voiceIdx = pick(VOICE_GROUPS.statement);
  let wordsSeen = 0;
  const totalWordsSafe = Math.max(1, totalWords); // guard against text with no words (e.g. "!!!") → no NaN%

  for (let i = 0; i < playable.length; i++) {
    if (isStopping()) break;
    const tok = playable[i];

    render.innerHTML = buildRender(text, tok.start, tok.end);

    if (tok.type === 'punct') {
      const intensity = 0.7 + getAmbientDensity() * 0.3;
      playPunctuation(tok.text, dests, intensity);
      animBars(0.2 * intensity);
      const pause = tok.text === '.' ? 420 : tok.text === '?' ? 380 : tok.text === '!' ? 340 : tok.text === ',' ? 200 : 150;
      await sleep(pause);
      continue;
    }

    // word token
    wordsSeen++;
    const wlen = tok.text.replace(/\W/g, '').length || 1;
    const group = VOICE_GROUPS[tok.sentenceType] || VOICE_GROUPS.statement;

    // update ambient density by paragraph position: sparser at start, denser toward end
    setAmbientDensity(tok.paraPos === 'start' ? 0.55 : tok.paraPos === 'end' ? 1.35 : 1);

    const freq = pick(wordNoteScale());
    let vol    = rnd(0.18, 0.52);
    const dur  = rnd(0.22, 0.45);

    // (6) breathing dynamics — a slow volume swell/ebb across the sentence so the
    // reading rises and falls like a spoken phrase instead of staying flat. A gentle
    // sine over the words, plus a small lift toward the denser end of the text.
    const phraseWave = 0.82 + 0.18 * Math.sin(wordsSeen * 0.5);
    vol *= phraseWave;

    // (3) stereo drift — successive words wander slowly across the stereo field
    // (a slow sine), giving spatial depth. Kept within ±0.6 so it never feels
    // hard-panned, just "wide". Deterministic (position-based).
    const pan = Math.sin(wordsSeen * 0.37) * 0.6;

    // shift voice within the sentence's appropriate group for variety
    if (randUnit() < 0.4) voiceIdx = pick(group);
    playPannedVoice(voiceIdx, freq, vol, dur, dests, pan);
    animBars(vol);

    // reading pace: longer words get more time
    const base = 300 + wlen * 28;
    const spd  = Math.min(600, base) + rnd(-30, 50);
    pf.style.width = Math.round((wordsSeen / totalWordsSafe) * 100) + '%';
    status(Math.round((wordsSeen / totalWordsSafe) * 100) + '%');
    await sleep(spd);
  }

  setStopping(true);
  clearAmb();
  pf.style.width = '100%';
  if (rec.state !== 'inactive') rec.stop();
  render.innerHTML = esc(text);
  viz.classList.remove('on');
  bars.forEach(b => b.style.height = '1.5px');
  playing = false;
  bPlay.disabled = false; bStop.disabled = true;
  setTimeout(() => prog.classList.remove('on'), 900);
  showContinuePrompt();
}

// After playback ends naturally, let the person resume writing — the
// textarea becomes editable again, pre-filled with what was just read,
// caret placed at the end so they can keep going.
function showContinuePrompt() {
  editor.style.display = '';
  render.style.display = 'none';
  editor.focus();
  editor.setSelectionRange(editor.value.length, editor.value.length);
  status('continue writing — same key carries on');
}

function stop() {
  setStopping(true);
  clearAmb();
  if (rec && rec.state !== 'inactive') rec.stop();
  editor.style.display = '';
  render.style.display = 'none';
  viz.classList.remove('on');
  prog.classList.remove('on');
  bars.forEach(b => b.style.height = '1.5px');
  playing = false;
  bPlay.disabled = false; bStop.disabled = true;
  status('stopped');
}

bPlay.addEventListener('click', play);
bStop.addEventListener('click', stop);
bSave.addEventListener('click', () => {
  if (!audioBlob) return;
  const url = URL.createObjectURL(audioBlob);
  const a = document.createElement('a');
  a.href = url; a.download = 'reading.webm'; a.click();
  URL.revokeObjectURL(url);
});
bClear.addEventListener('click', () => {
  if (playing) stop();
  editor.value = '';
  editor.style.display = '';
  render.style.display = 'none';
  bPlay.disabled = true; bSave.disabled = true;
  audioBlob = null; chunks = [];
  wcEl.textContent = '0 words';
  pf.style.width = '0%';
  prog.classList.remove('on');
  harmonyLocked = false; // clearing the text means the NEXT play should derive a fresh scale
  status('ready');
});

editor.addEventListener('input', () => {
  const v = editor.value;
  bPlay.disabled = !v.trim();
  const w = v.trim().split(/\s+/).filter(Boolean).length;
  wcEl.textContent = w + (w === 1 ? ' word' : ' words');
});

// bar is always visible — flashBar no longer needed

document.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;

  if (e.key === 'Enter' && e.shiftKey) {
    e.preventDefault();
    if (!playing && !bPlay.disabled) play();
    return;
  }
  if (e.key === 'Escape') {
    if (playing) { e.preventDefault(); stop(); }
    return;
  }
  if (meta && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    if (!bSave.disabled) bSave.click();
    return;
  }
});
