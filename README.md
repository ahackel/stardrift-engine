# Stardrift

A procedural, block-based chiptune music engine for (space) games: atmospheric and relaxing by default, with tension when the game wants it. Endless, it varies itself over time, and you can steer the mood at runtime with smooth transitions.

- **JavaScript player and editor**: this repo, no build step, no dependencies.
- **Unity**: the engine is written so it can be ported 1:1 to C# (see *Porting to Unity*).

```bash
npm run dev        # → http://localhost:8321  (any static server works; AudioWorklet needs http://, not file://)
npm run render     # offline render + conductor log (node tools/render.mjs song secs seed out.wav --mood 30:tension)
node tools/test.mjs
```

`demo/stardrift-demo.mp3` is 2:40 rendered with mood changes: auto → *tension* at 0:40 → *action* at 1:15 → *relaxed* at 1:55.

## Why build it instead of using something existing?

Research (Sep 2026). Nothing covers *web editor + Unity runtime + block/mood based + synthesized chiptune*:

| Option | What it is | Why not (alone) |
|---|---|---|
| FMOD / Wwise / Elias | Adaptive-music middleware (horizontal re-sequencing, vertical layers, stingers) | Plays **pre-rendered audio**, so a composer has to produce all the stems. Not procedural, license cost, heavy for WebGL |
| AutoMusic, Procedural Music Generator (Unity Asset Store) | Procedural generators | Unity only, closed, no shared web editor, little control over "blocks" |
| dingvald/ProceduralMusicGenerator | C++ chiptune engine, JSON patterns, "danger" parameter | Closest in spirit, but native C++, early stage, no editor, no web |
| Strudel / Tidal | Pattern live-coding in the browser | Great pattern language, but AGPL, JS only, not a game runtime |
| ZzFXM, webaudio-tinysynth | Tiny JS trackers / synths | Fixed songs, not adaptive |

So Stardrift **borrows the proven ideas** instead of the code: horizontal re-sequencing plus vertical layering (FMOD/Elias), a weighted section graph (Markov-style), tracker-style patterns (MOD/ZzFXM), and NES/Game Boy voices. The whole engine is about 1,200 lines of dependency-free JS, so a C# port is realistic.

## How it works

```
 game ── setMood('tension') ──►  CONDUCTOR (every bar)                SEQUENCER (every 16th)     SYNTH (every sample)
                                  • section graph walk  ──► blocks ──►  • pattern steps     ──►   pulse / triangle / wave
                                  • progression pick                    • chord resolution        LFSR drums, SVF filter
                                  • layer on/off (intensity)            • holds / follow chords   echo + reverb → out
                                  • block pick (tags, ranges, weights)
                                  • fills, drops, mutations, generators
```

- **Blocks** are 1–32 beats of pattern for one track, e.g. `{ "id": "bass_pulse", "track": "bass", "beats": 4, "tags": ["drift","calm"], "intensity": [0.3, 0.7], "pattern": "0 - - . 0 - . . 0 - - . -1 - . ." }`. Notes are relative to the current chord or scale, so every block works over every progression.
- **Generator blocks** (`gen`) produce new melodies: a rhythm plus a constrained random walk that is pulled toward chord tones, re-rolled from time to time.
- **Sections** (intro, calm, wonder, drift, tension, build, peak, release) carry an intensity, a tension, tags, a length and weighted `next` links. Together they form a graph the conductor walks.
- **Progressions** are roman numerals diatonic to a scale, which can be switched per progression (lydian for *wonder*, phrygian or harmonic minor for *tension*).
- **Variation over time**: blocks mutate slightly when they loop, blocks are occasionally swapped mid-section, layers enter and leave every 4 bars, drum fills and drops mark transitions, and generators re-roll. Everything is seeded, so the same seed gives the same music.

### Runtime mood changes (always smooth)

```js
music.setMood('relaxed');                 // named moods live in song.moods
music.setMood('tension', { within: 0 });  // start transitioning at the next bar line
music.setMood({ intensity: 0.7, tension: 0.9 });
music.setMood('auto');                    // autonomous drift again
music.setParams({ intensity, tension, influence, urgent }); // continuous control
```

A mood change never cuts: the current section ends at a bar line within `within` bars, with a drum fill (going up) or a wash/drop (going down). The conductor then walks the section graph toward the mood, and bridge sections are shortened to `transitBars`, e.g. calm → drift → build → peak in about 18 s. Pads crossfade on chord changes, and intensity, tension and filter cutoffs glide over several bars (`moodGlide`).

## Files

| Path | |
|---|---|
| `src/engine/engine.js` | conductor + sequencer (the brain) |
| `src/engine/synth.js` | voices, filters, echo, reverb |
| `src/engine/drums.js` | drum kits: `clean` (default: sine bodies, filtered noise, 808-style metal) and `chip` (raw NES-style) — pick with `"kit"` on a drums instrument, override single hits with an object |
| `src/engine/pattern.js` | pattern language, generators, mutations |
| `src/engine/theory.js` | scales, chords, song normalisation |
| `src/engine/rng.js` | seeded RNG (mulberry32) |
| `src/worklet.js` / `src/player.js` | AudioWorklet host / main-thread API for web games |
| `src/editor/*` | editor UI (live lanes, mood pads, block grid editor, structure, JSON) |
| `songs/deep-space.json` | default song |

## Pattern language

`.` rest · `-` hold · `0 1 2` note · `*` whole chord (or a chip arpeggio on mono tracks with `arp`) · `0+4+8` stack · `k s h o c t m` drums · `'` `,` octave up/down · `#` `b` semitone · `!` accent · `?` / `?30` chance · `T*n` repeat · `|` visual bar line.

Block `mode`: `chord` (numbers are chord tones: 0 root, 1 third, 2 fifth, 3 root an octave up…), `scale` (steps above the chord root) or `key` (absolute degrees of the key).

## Porting to Unity (next step)

The engine was written with the port in mind:

- No Web Audio nodes: everything is per-sample math in `Engine.process(outL, outR, n)`. In Unity it maps to `OnAudioFilterRead(float[] data, int channels)` on a MonoBehaviour with an AudioSource.
- The song format is plain JSON (load with Newtonsoft/JsonUtility), so the same file drives both players and the web editor becomes the authoring tool for Unity.
- The RNG is integer mulberry32 (`Math.imul` → `uint` multiply in C#), so a port can be verified against `tools/test.mjs` / `tools/render.mjs` output with the same seed.
- Mood/parameter calls from the game thread just set target values; the audio thread applies them on the next bar, so no locking is needed beyond a small message queue.
- Only non-deterministic detail: initial unison oscillator phases (`Math.random`), which is inaudible and fine to replace.

Alternative for WebGL builds: run this JS engine via a `.jslib` plugin.
