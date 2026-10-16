# Stardrift engine

A procedural, block-based chiptune music engine for games: atmospheric by default, tense when the game asks for it. The music is endless, varies itself over time and follows the game's mood with smooth transitions.

- **JavaScript**: this repo, for web games. No build step, no dependencies.
- **Editor**: songs are written in the [Stardrift editor](https://github.com/ahackel/stardrift), a separate repo that uses this one.
- **Unity**: the engine is plain per-sample code, written to be ported 1:1 to C# (see *Porting to Unity*).

```bash
npm run dev        # a static server at http://localhost:8322 (AudioWorklet needs http://, not file://)
npm run build      # dist/: the worklet with the engine inlined, and the song format's JSON Schema
npm run render     # offline render + conductor log: node tools/render.mjs song secs seed out.wav --mood 30:tension --sting 45:discovery
npm test
npm run bench      # CPU per song and mood: node tools/bench.mjs [songs] --sr 22050 --breakdown
```

`demo/stardrift-demo.mp3` is 2:40 with mood changes (auto → *tension* → *action* → *relaxed*).

## In a game

```bash
npm install github:ahackel/stardrift-engine
```

```js
import { StardriftPlayer } from 'stardrift-engine';
```

Without a bundler, an import map points the name at the package (the worklet and the sample library are found next to it):

```html
<script type="importmap">{ "imports": { "stardrift-engine": "./node_modules/stardrift-engine/src/index.js" } }</script>
```

With a bundler, load songs as zips (*A song in one zip*): the bundler copies the worklet (`dist/worklet.js`, one file) but not the sample library, so the recordings come from the zip. Vite's dev server needs `optimizeDeps: { exclude: ['stardrift-engine'] }`, or its pre-bundling loses the worklet's path. Elsewhere, `init({ worklet: url })` says where `dist/worklet.js` is.

The package exports `StardriftPlayer` (the web player), `Engine` (the engine itself, for offline rendering or another audio host), `validateSong` (see *Song format*), `loadSamples` / `fetchSamples` / `soundSamples` / `songSamples` / `LIBRARY_URL` (the sample library), `encodeWav` / `decodeWav`, `renderPhrase` / `phraseSong` (one sound in a short phrase, offline), `songZip` / `openSongZip` (a song and its recordings in one zip) and `zip` / `unzip` / `isZip`. Single modules are there by path too, e.g. `stardrift-engine/engine/theory.js`; in node, `stardrift-engine/disk-samples.js` loads the sample library from disk.

### The example game

[Lop Hop](https://github.com/ahackel/lop-hop) ([play it](https://andreashackel.de/lop-hop/)) is a small endless runner made with the engine: a lop-eared rabbit and fourteen other animals jump cacti and duck under branches, with its own song. It uses every mood and every stinger the way a game would (a mood for each state of play, stingers for jumps, food, bumps, an escape and the knock-out), shows its calls to the music as it makes them, and carries a copy of the engine, so GitHub Pages serves it as plain files.

**Why not something existing?** Adaptive-music middleware (FMOD, Wwise, Elias) plays pre-rendered stems; procedural generators on the Asset Store are Unity-only and closed; pattern tools (Strudel, ZzFXM) aren't game runtimes. Stardrift borrows their ideas instead: horizontal re-sequencing and vertical layers, a weighted section graph, tracker patterns and NES/Game Boy voices.

## How it works

```
 game ── setMood('tension') ──►  CONDUCTOR (every bar)                SEQUENCER (every 16th)     SYNTH (every sample)
                                  • section graph walk  ──► blocks ──►  • pattern steps     ──►   voices, effects
                                  • progression pick                    • chord resolution        filter, drums
                                  • tracks on/off (chance)              • holds, follow chords    echo + reverb → out
                                  • block pick, fills, mutations
```

- **Blocks** (clips in the editor) are 1–32 beats of pattern. A track lists the blocks it plays; notes are relative to the chord or scale, so every block fits every progression.
- **Sections** (intro, calm, drift, tension, peak …) carry a length and weighted `next` links (0–100 % like the rest; none: any section may follow): a graph the conductor walks. A mood leads it to one of the mood's sections, picked by weight, the shortest way along the links. How lively a section is (for fills, drops and crashes) follows from what plays there.
- **What plays in a section** is set in steps of 0, 25, 50, 75 and 100 %: how likely each track plays there, and how often it picks each of its blocks, against its others (the progressions likewise). The editor's *Plays in* view shows it all as a grid.
- **Progressions** are roman numerals, each in its own scale if it likes (lydian for wonder, phrygian for tension). The last beats of a section play a lead-in chord into the next. A `.` is no chord (N.C., e.g. `i:4 .:4`): whole chords rest and single lines play on over the home chord, for a break.
- **Themes**: a block can play another block's notes (`from`), at its own length, and any block can restate its notes in **forms** picked each time it starts (as written, head, sequence, slow, shift, answer). One melody in key degrees, fitted to the chord and quoted by blocks on several tracks, gives the endless music a tune you remember.
- **Variation over time**: blocks mutate when they loop, tracks that play sometimes come and go, fills and drops mark transitions, and every so often the music thins to a breather. Everything is seeded: the same seed gives the same music.
- **Stingers** react to game events: a short phrase from the next beat that borrows tracks, can bring its own chord and ducks the rest.

## Game API

```js
music.setMood('relaxed');                 // named moods live in song.moods
music.setMood('tension', { within: 0 });  // start moving at the next bar line
music.setMood('auto');                    // walk on its own again
music.sting('alert');                     // a stinger, from the next beat
music.sting('reward', { at: 'step' });    // … or right away
```

A mood change never cuts: the section ends at a bar line with a fill (going up) or a drop (going down), and the conductor takes the shortest way along the links to the mood's sections, with shortened bridge sections the first time. All songs share the mood names (`relaxed wonder exploring tension danger action`) and stinger names (`discovery alert jump reward`), so a game can switch songs without changing its calls.

The player loads the sample library (`library/`) in the background, only the recordings the song plays (and the sounds the editor previews); `init({ library: url })` points it elsewhere, other hosts call `engine.setSamples()` (`songSamples(song)` names what a song needs).

### A song in one zip

The editor's **Export for a game** writes a song and everything it plays into one `.zip` (`songZip(song)`): `song.json`, the recordings it uses (`library/`: `samples.json` with only those, their WAVs, their license) and a README with the song's moods and stingers. A game drops it in and loads it as it is, the recordings come from the zip:

```js
await music.loadUrl('music/iron-comet.zip');   // or music.loadZip(arrayBuffer)
```

Unzipped, the folder works too: `init({ library: 'music/iron-comet/library/' })`, `loadUrl('music/iron-comet/song.json')`. The zip stores its files uncompressed, so every browser reads it (Safari 15 too); zipped again by hand (compressed), browsers that can inflate (`DecompressionStream`) read it as well. Other hosts: `openSongZip(buffer)` gives `{ song, read }`, `loadSamples(read, songSamples(song))` the recordings.

## Song format

A song is plain JSON: **[SONG_FORMAT.md](SONG_FORMAT.md)** is the whole format, with a complete example, written to be handed to a person or to an AI that writes songs. `validateSong(song)` lists every mistake in a song (`{ errors, warnings }`, each a line saying where and what); the player warns about errors in the console when it loads a song. `dist/song.schema.json` is the format as a JSON Schema.

## Files

| Path | |
|---|---|
| `src/engine/engine.js` | conductor and sequencer |
| `src/engine/synth.js`, `drums.js`, `dsp.js`, `wavetable.js` | voices, effects, drum kits, shared filters, band-limited wavetables |
| `src/engine/pattern.js`, `theory.js`, `rng.js` | patterns and their forms, scales and chords, seeded RNG |
| `src/engine/params.js` | every setting with its range |
| `src/player.js`, `src/worklet.js` | the web player: main-thread API and AudioWorklet host |
| `src/validate.js`, `src/schema.js` | the song check, the JSON Schema |
| `src/bundle.js`, `src/zip.js` | a song and its recordings in one zip |
| `src/index.js` | what the package exports; `samples.js`, `disk-samples.js`, `wav.js`, `phrase.js` |
| `dist/` | built from `src/` (`npm run build`; the tests check it is current): `worklet.js`, `song.schema.json` |
| `songs/` | the reference song (tests, render, bench); more are in the editor repo |
| `library/` | the sample library (CC0 recordings) |
| `tools/` | build, offline render, tests, benchmark, sample builder, dev server |
| `demo/` | a 2:40 recording |

## Porting to Unity

- No Web Audio nodes: everything is per-sample math in `Engine.process(outL, outR, n)`, which maps to `OnAudioFilterRead`.
- The song format is plain JSON, so the web editor is the authoring tool for Unity too.
- Songs the editor saves are in the current format; a port needs `migrateSong` (`src/engine/plays.js`) only to load older files (e.g. a song-wide `theme`).
- The RNG is integer mulberry32 (`Math.imul` → `uint` multiply), so a port can be checked against `tools/render.mjs` with the same seed.
- Game calls only set targets; the audio thread applies them at the next bar, so a small message queue is all the locking needed.
- `Math.random` is used only for sound detail (voice start phases, string plucks, breath noise), which is inaudible to replace.

For WebGL builds the JS engine can also run through a `.jslib` plugin.

## License

MIT (see `LICENSE`). The sample library in `library/samples/` is CC0 (public domain) recordings by Versilian Studios (`library/LICENSE`).
