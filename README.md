# notebook

A minimalist notepad that turns whatever you write into a piece of generative
ambient music. As the text is read back word by word, a matching piece is
synthesized live in the browser — no recorded audio, everything is generated
from scratch with the **Web Audio API**.

## How it works

- **Mood → key.** A bilingual (English / Persian) emotion lexicon reads the
  text and maps its mood onto one of nine musical modes, from dark (minor,
  locrian, phrygian…) to bright (lydian, major). Punctuation nudges the mood.
- **Deterministic per text.** A seeded PRNG (mulberry32) is re-seeded from a
  hash of the exact text on every play, so **the same text always produces the
  same piece** — same key, melody, voices, and timing — while different text
  yields something different.
- **22 synthesized voices.** Pads, plucks, breath, bells, piano, marimba,
  choir, cello, kalimba, gong and more — each built from oscillators, filters
  and envelopes. Sentence type (statement / question / exclamation) picks the
  voice group.
- **Shared-clock ambient bed.** An Aphex-Twin-inspired ambient layer (pad, sub
  pulse, motif, tape warmth) locked to one slow ~52 BPM clock. Density rises
  from the start of the text toward the end.
- **Record & save.** Playback is captured via `MediaRecorder` and can be saved
  as a `.webm` file.

## Run it

It's a static site — no build step, no dependencies.

- Open `index.html` directly in a modern browser, **or**
- Serve the folder with any static server, e.g.:

```sh
python3 -m http.server
```

then visit the printed local URL.

> Uses ES modules, so serving over `http://` (rather than `file://`) is
> recommended for reliable module loading.

## File structure

```
index.html          – markup + font links; loads styles.css and js/main.js
styles.css          – all styling
js/
  mood.js           – emotion lexicon, mode/scale tables, detectMood, hashing
  audio-engine.js   – seeded RNG, 22 voices, reverb, punctuation, ambient engine
  main.js           – UI wiring, tokenizer, playback loop, save/export, keybindings
```

## Keyboard shortcuts

- `⇧ + Enter` — play
- `Esc` — stop
- `⌘ + S` — save the recording

## License

MIT — see [LICENSE](LICENSE).
