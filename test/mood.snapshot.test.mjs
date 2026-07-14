// Snapshot safety-net for the pure functions in js/mood.js.
// These functions have NO Web Audio dependency, so they run under plain Node.
//
//   npm test            → run tests, compare against locked snapshots
//   npm run test:update → regenerate snapshots (only after an INTENTIONAL change)
//
// The point: freeze the CURRENT behaviour of mood detection so that any future
// edit that shifts the mood/analysis output gets caught immediately.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  detectMood,
  analyzeText,
  hashText,
  buildScale,
  chordFromScale,
  buildVoicing,
  MODE_OFFSETS,
} from '../js/mood.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(__dirname, '__snapshots__');
const SNAP_FILE = join(SNAP_DIR, 'mood.snap.json');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

// Representative inputs — cover the tricky corners the code actually handles.
const SAMPLES = [
  '',
  'hello world',
  'I am so happy today!',
  'I am not happy at all.',
  'not not happy',
  'this is beautiful and calm',
  'everything is falling apart, I feel broken',
  'I remember the old days, the summer of my childhood',
  'خوشحالم',
  'خوشحال نیستم',
  'نمی‌ترسم',
  'دلم برای گذشته تنگ شده',
  'این خیلی زیبا و آرامش‌بخشه',
  'همه‌چیز داره از هم می‌پاشه',
  'why is this happening???',
  'STOP. JUST STOP.',
  '😀😀😀 great vibes',
  'کتاب روی میز است',
];

// Round floats so snapshots are stable across platforms.
const r = (x) => (typeof x === 'number' ? Math.round(x * 1e6) / 1e6 : x);
const roundArr = (a) => a.map(r);

function fingerprint(text) {
  const mood = detectMood(text);
  const analysis = analyzeText(text);
  const roundedAnalysis = Object.fromEntries(
    Object.entries(analysis).map(([k, v]) => [k, typeof v === 'number' ? r(v) : v])
  );
  return {
    text,
    hash: hashText(text),
    mood,
    analysis: roundedAnalysis,
  };
}

// Deterministic music-theory fingerprint (independent of text mood).
function theoryFingerprint() {
  const scale = buildScale(220, 'minor'); // A3 minor
  return {
    modes: Object.keys(MODE_OFFSETS).sort(),
    scale_minor_220: roundArr(scale),
    chord_i: roundArr(chordFromScale(scale, 0)),
    chord_v: roundArr(chordFromScale(scale, 4)),
    voicing_root: roundArr(buildVoicing(scale, [0, 2, 4], 0)),
    voicing_up: roundArr(buildVoicing(scale, [0, 2, 4], 7)),
  };
}

function loadSnap() {
  if (!existsSync(SNAP_FILE)) return null;
  return JSON.parse(readFileSync(SNAP_FILE, 'utf8'));
}

function saveSnap(data) {
  if (!existsSync(SNAP_DIR)) mkdirSync(SNAP_DIR, { recursive: true });
  writeFileSync(SNAP_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function buildCurrent() {
  return {
    theory: theoryFingerprint(),
    moods: SAMPLES.map(fingerprint),
  };
}

test('mood.js output matches locked snapshot', () => {
  const current = buildCurrent();

  if (UPDATE || !existsSync(SNAP_FILE)) {
    saveSnap(current);
    console.log(
      existsSync(SNAP_FILE) && !UPDATE
        ? '  (created initial snapshot)'
        : '  (snapshot updated)'
    );
    return;
  }

  const saved = loadSnap();
  assert.deepEqual(
    current,
    saved,
    'mood.js output changed vs snapshot. If this change was intentional, run: npm run test:update'
  );
});

// A couple of invariants that must ALWAYS hold, snapshot or not.
test('hashText is deterministic and non-negative', () => {
  assert.equal(hashText('hello'), hashText('hello'));
  assert.ok(hashText('some longer text here') >= 0);
});

test('buildScale returns 7 in-octave frequencies', () => {
  const scale = buildScale(220, 'major');
  assert.equal(scale.length, 7);
  assert.ok(scale.every((f) => f >= 220 && f < 440 * 1.01));
});
