# Stardrift

A procedural, block-based chiptune music engine for (space) games: atmospheric and relaxing by default, with tension when the game wants it. Endless, it varies itself over time, and you can steer the mood at runtime with smooth transitions.

- **JavaScript player and editor**: this repo, no build step, no dependencies.
- **Unity**: the engine is written so it can be ported 1:1 to C# (see *Porting to Unity*).

```bash
npm run dev        # → http://localhost:8321  (no-cache static server; AudioWorklet needs http://, not file://)
npm run render     # offline render + conductor log (node tools/render.mjs song secs seed out.wav --mood 30:tension --sting 45:discovery)
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

So Stardrift **borrows the proven ideas** instead of the code: horizontal re-sequencing plus vertical layering (FMOD/Elias), a weighted section graph (Markov-style), tracker-style patterns (MOD/ZzFXM), and NES/Game Boy voices. The whole engine is about 1,800 lines of dependency-free JS, so a C# port is realistic.

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
- **Phrasing**: the last beats of a section play a **lead-in chord** into the next section's first chord (its V when that is major, else the major chord a step below, e.g. C → Dm in D dorian; `leadIn`: beats, 0 = off). Notes get **dynamics**: bar downbeats a little louder, off-16ths softer, plus a small random spread (`humanize`, on its own RNG stream so it never changes the arrangement). `swing` delays every second 16th.
- **Breathers** (`"breath": { "every": 64, "bars": [4, 8] }`): every ~64 bars, while things are calm, the drums drop out and the music thins to its ambient tracks (those whose `layer.min` is 0, or `breath.keep`) for a few bars, then grows back. Endless music needs room to breathe; a mood change ends a breather like any other section.
- **The song theme** gives endless music an identity, like a melody you would hum after playing. `"theme": { "beats": 16, "pattern": "4 -*5 3 - 2 -*7 | …" }` is one melody in key degrees. Blocks with `"theme": true` (or a list of forms) play it instead of a pattern, in a form picked each time: `whole`, `head` (first half, then space), `sequence` (first half, then again a step or two higher or lower), `slow` (first half at half speed), `shift` (the whole theme moved up or down) or `answer` (space, then the first half, which forms a canon against a track playing the whole theme). Notes on the beat move to the nearest chord tone, so the theme fits every chord (`"fit": true` does the same for any key or scale block). In the default song the lead states it in calm and drift sections, the stars answer it, and it returns as an anthem at the peak.
- **Stingers** let the music react to game events, not only to moods. `music.sting('discovery')` plays a short phrase from the next beat (`at`: `step`, `beat`, `half` or `bar`). Each part borrows a track for the stinger's length, even one that is resting, and is written like a block, so a stinger is always in key and in time. The stinger can bring its own chord (`"chords": "IV"`), ducks the other tracks (`duck`), and hands the tracks back to their blocks afterwards:
  ```json
  { "id": "discovery", "at": "beat", "beats": 4, "chords": "IV", "duck": 0.45, "parts": [
    { "track": "arp", "pattern": "* -*15" }, { "track": "stars", "pattern": "0 1 2 3 4 -*11" } ] }
  ```
  The default song has `discovery`, `alert`, `jump` and `reward`.

### Runtime mood changes (always smooth)

```js
music.setMood('relaxed');                 // named moods live in song.moods
music.setMood('tension', { within: 0 });  // start transitioning at the next bar line
music.setMood({ intensity: 0.7, tension: 0.9 });
music.setMood('auto');                    // autonomous drift again
music.setParams({ intensity, tension, influence, urgent }); // continuous control
music.sting('alert');                     // a stinger for a game event, from the next beat
music.sting('reward', { at: 'step' });    // … or right away
```

A mood change never cuts: the current section ends at a bar line within `within` bars, with a drum fill (going up) or a wash/drop (going down). The conductor then walks the section graph toward the mood, and bridge sections are shortened to `transitBars`, e.g. calm → drift → build → peak in about 18 s. Pads crossfade on chord changes, and intensity, tension and filter cutoffs glide over several bars (`moodGlide`).

## Files

| Path | |
|---|---|
| `src/engine/engine.js` | conductor + sequencer (the brain) |
| `src/engine/synth.js` | voices, filters, echo, reverb |
| `src/engine/drums.js` | drum kits: `clean` (default: sine bodies, filtered noise, 808-style metal) and `chip` (raw NES-style) — pick with `"kit"` on a drums instrument, override single hits with an object, e.g. `"preset": "clean", "kit": { "s": { "pitch": 1.1, "decay": 0.8, "level": 0.9 } }` |
| `src/engine/pattern.js` | pattern language, generators, mutations |
| `src/engine/theory.js` | scales, chords, song normalisation |
| `src/engine/rng.js` | seeded RNG (mulberry32) |
| `src/worklet.js` / `src/player.js` | AudioWorklet host / main-thread API for web games |
| `src/wav.js` | WAV encoder (offline render and the editor's audio export) |
| `src/editor/*` | editor UI (session grid, detail panel with block, progression, section, track, stinger and song editors, mood map, live chords, JSON); `render-worker.js` exports audio |
| `songs/deep-space.json` | default song |

## Instruments

Each track names an instrument (`"instrument": "lead"`); instruments live in `song.instruments`. Types: `pulse` (NES square, `duty`, `pwm`), `triangle` (NES 4-bit triangle), `wave` (32-step 4-bit wavetable: `soft sine saw organ hollow` or your own array of 32 values 0–15) and `drums`. All melodic types share `env {a d s r}`, `unison`/`detune`, `vibrato {depth rate delay}`, `glide`, `arp`, `cutoff`/`resonance`, `cutoffIntensity`/`cutoffTension` (the filter follows the mood) and `gain`.

In the editor, the **session** shows one row per track: instrument, mute/solo, volume and the track's blocks as chips (the playing one glows, 🔒 holds a block on its track). Clicking a chip opens the block editor below; clicking a track name opens its sound and track settings: octave, pan, sends, when the track may play, sliders for the sound, drawable wavetables, drum hits, and ▶ previews that work even while the song is paused (`player.preview(inst, events)`). The left column is the **mood map**: every section as a dot at its intensity and tension, the music's live position gliding between them, and the target. Click or drag on it to steer (`setParams`), click a dot to edit that section (mood, length, tags, which sections may follow, which tracks play), or use the mood buttons below it. The **stingers** (✦) under them play a stinger the way the game would, and open it for editing: when it starts, how long it is, its chord, how much the music ducks, and one pattern grid per part (＋ part, ✦ play). While the song is paused, only the stinger sounds. Under them, **Play chords** has one pad per chord of the current scale: keys 1–7 play your own chord from the next beat (with a colour: triad, sus2, sus4, 7th, add9), 0 or Esc hands back to the progression (`player.playChord(degree, shape)` / `playChord(null)`). While paused, the pads just let you hear the chord. Log, Song JSON and Help open in the same panel from the top bar. The top row of the session holds the **chord progressions**: click one to edit it as a strip of chords with a palette of the chords that fit the scale (click to hear and add, select a chord to change its length, colour or position), and 🔒 hold it to hear it in the song from the next bar line (`player.lockProgression(id)`). Click the song name in the top bar for the **theme** (a grid in key degrees, ▶ hear it), key, scale, tempo, feel (swing, dynamics, lead-in chord), breathers and **Export audio** (a WAV rendered from the start with the current seed and mood). ↶ ↷ (⌘Z / ⇧⌘Z, Ctrl+Z / Ctrl+Y) undo and redo every edit, including a reset to the default song. A block **plays** a pattern, a generator or the song theme (♪ on its chip; pick its forms in the block editor). Turning a theme block back into a pattern keeps the theme's notes, ready to vary by hand. Drum tracks can only switch to drum kits and melodic tracks only to melodic instruments, because their patterns differ.

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
