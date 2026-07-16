# notebook

Type anything. Hear it become music.

**notebook** turns whatever you write into a piece of ambient music, synthesized live in your browser as each word is read. No samples, no recordings — every sound is built from scratch with the **Web Audio API**. Same text always makes the same piece; change a word and you get something completely new.

👉 **[Try it live](https://meelud.github.io/notebook/)**

## How it works

- **Your words set the mood.** A bilingual (English + Persian) emotion lexicon reads your text and maps its feeling onto one of a dozen musical scales — dark (minor, locrian, phrygian…) to bright (lydian, major). Punctuation nudges the vibe, and negation is handled properly (yes, "not happy" and «خوشحال نیستم» both land where they should).
- **Deterministic by design.** A seeded RNG (mulberry32) is re-seeded from a hash of your exact text. So a given text is *always* the same song — same scale, melody, voices, rhythm. It's reproducible, not random.
- **22 hand-built synth voices.** Pads, plucks, breaths, bells, piano, marimba, choir, cello, kalimba, gong and more — each carved out of oscillators, filters and envelopes. The sentence type (statement / question / exclamation) picks which family sings.
- **An ambient bed that breathes.** A slow ~52 BPM Aphex-Twin-ish drone/tape layer runs underneath and thickens toward the end of your text. Notes move stepwise for melodic continuity, silence falls on commas and full stops, and everything sits in a gently panned stereo field through a soft master compressor.
- **Save it.** Records straight to a `.wav` and drops a matching black cover-art `.png` with your text on it.

## Run it locally

Static site. No build, no dependencies, nothing to install.

```sh
python3 -m http.server
```

Then open the local URL it prints. (Serve over `http://` rather than `file://` so the ES modules load cleanly.)

## What's where

```
index.html          – markup + fonts; loads styles.css and js/main.js
styles.css          – all the styling
js/
  mood.js           – emotion detection, scales, hashing (pure, no audio)
  lexicon-fa.js     – the extended Persian emotion lexicon
  audio-engine.js   – seeded RNG, 22 voices, reverb, ambient engine
  main.js           – UI, tokenizer, playback loop, WAV/cover export, shortcuts
```

## Shortcuts

- `⇧ + Enter` — play
- `Esc` — stop
- `⌘ + S` — save recording

## License

MIT — see [LICENSE](LICENSE).
