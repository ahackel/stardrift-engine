# Stardrift engine

A procedural, block-based chiptune music engine for games: atmospheric by default, tense when the game asks for it. The music is endless, varies itself over time and follows the game's mood with smooth transitions.

- **JavaScript**: this repo, for web games. No build step, no dependencies.
- **Editor**: songs are written in the [Stardrift editor](https://github.com/ahackel/stardrift), a separate repo that uses this one.
- **Unity**: the engine is plain per-sample code, written to be ported 1:1 to C# (see *Porting to Unity*).

```bash
npm run dev        # a static server at http://localhost:8322 (AudioWorklet needs http://, not file://)
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

With a bundler that is all. Without one, an import map points the name at the package (the worklet and the sample library are found next to it):

```html
<script type="importmap">{ "imports": { "stardrift-engine": "./node_modules/stardrift-engine/src/index.js" } }</script>
```

The package exports `StardriftPlayer` (the web player), `Engine` (the engine itself, for offline rendering or another audio host), `loadSamples` / `fetchSamples` / `LIBRARY_URL` (the sample library), `encodeWav` / `decodeWav` and `renderPhrase` (one sound in a short phrase, offline). Single modules are there by path too, e.g. `stardrift-engine/engine/theory.js`; in node, `stardrift-engine/disk-samples.js` loads the sample library from disk.

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

## Song format

A song is plain JSON (`songs/*.json`). The parts:

```json
{ "bpm": 92, "key": "D", "scale": "dorian",
  "instruments": { "lead": { "type": "pulse", "duty": 0.25, "env": { "a": 0.01, "d": 0.3, "s": 0.6, "r": 0.3 } } },
  "tracks": [{ "id": "lead", "name": "Lead", "instrument": "lead", "octave": 5, "clips": ["pulse"] }],
  "blocks": [{ "id": "pulse", "beats": 4, "sections": { "drift": 0.25, "peak": 0 }, "pattern": "0 - - . 0 - . . 0 - - . -1 - . ." },
             { "id": "theme", "beats": 16, "mode": "key", "fit": true, "pattern": "4 -*5 3 - 2 -*7 …" },
             { "id": "theme_head", "beats": 16, "from": "theme", "forms": ["head", "slow", "answer"] }],
  "sections": [{ "id": "calm", "bars": [8], "tracks": { "lead": 0.5 }, "next": { "drift": 1, "calm": 0.5 } }],
  "moods": { "relaxed": { "sections": { "calm": 1 } } },
  "progressions": [{ "id": "home", "chords": "i:8 IV:4 VII:4" }],
  "stingers": [{ "id": "discovery", "at": "beat", "beats": 4, "chords": "IV", "duck": 0.45,
                 "parts": [{ "track": "arp", "pattern": "* -*15" }] }] }
```

Song-wide: `swing`, `humanize` (timing and loudness spread), `leadIn`, `breath` (breathers), `master.glue` (the compressor), `fx.echo` and `fx.reverb`. A track has `volume pan echo reverb`, `double` (a second take either side), `pump` (sidechain on the kick) and `fade` (bars to join or leave).

What plays where, in steps of 0 · 0.25 · 0.5 · 0.75 · 1: a section's `tracks` (`{ id: chance }`) and a block's or progression's `sections` (`{ id: weight }`: picked by weight against the others in that section). Anything not listed is 1, so a new section, track, block or progression plays everywhere. A track whose blocks all weigh 0 in a section rests there; a section with no progression picks any. `"fill": true` marks a drum fill for the bar before a section change. A mood's `sections` (`{ id: weight }`) are where it leads the music, picked again each time a section ends; here anything not listed is 0, and a mood without them leads nowhere (the music walks on). Older songs (tags, weights, intensity and tension, track layers) are turned into these when they load.

### Instruments

Several tracks can play one instrument. Every setting and its range is listed once, in `src/engine/params.js`.

| Key | What |
|---|---|
| `type` | `pulse` (`duty`, `pwm`), `triangle`, `wave` (a preset or 32 values 0–15), `string` (plucked: `string { decay bright mute }`), `fm` (`fm { ratio index env feedback }`), `bowed` (`bow { pressure position }`), `sample` (`"sample": "cello"`: recordings in `library/`: `cello trombone flute violins violins_pizz bass_pizz glockenspiel xylophone`; kits can also play `timpani bass_drum snare shaker triangle claves`, `cymbal`, the cymbals and hats), `drums` (`kit`) |
| `poly`, `arp`, `arpChord` | chords (voices), or one voice: a new note ends the last; `arp` runs chords as a chip arpeggio, `arpChord` single notes too |
| `env { a d s r }`, `gain` | envelope, level |
| `smooth` | no 4-bit staircase: an analog-style triangle, saw or sine |
| `glide`, `scoop`, `vibrato { depth rate delay }` | pitch |
| `unison`, `detune`, `ensemble` | stacked voices; ensemble makes each a player who drifts |
| `breath` | air in the note, 0–1 |
| `body` | fixed resonances: `violin cello strings horn brass`, vowels `ah oh oo ee`, or your own `[kind, Hz, Q, dB]` list |
| `wah { beats depth resonance mode }` | a sweeping peak, with the tempo or (`note`) with each note |
| `drive`, `amp` | distortion 0–2, inside a `guitar` or `bass` amp |
| `cutoff`, `resonance`, `filter` | low pass, or `high` |
| `swell`, `filterEnv { amount decay }` | the filter follows the note's loudness, or opens on each note |
| `crush { bits rate }` | bitcrush |
| `eq { low mid midHz high }` | 3-band EQ in dB |
| `phaser`, `chorus` (`mode: flanger`), `tremolo`, `autopan` | `{ beats depth }` in time with the song (phaser: `feedback`) |

The chain runs in that order: pitch → source → envelope → breath → body → wah → drive → filter → crush → EQ → phaser → chorus → tremolo → auto-pan. Drum kits (`clean`, `chip`, `orchestra`, `rock`) take per-hit overrides, e.g. `"preset": "clean", "kit": { "s": { "pitch": 1.1, "decay": 0.8 } }`, and the effects that suit drums.

## Pattern language

`.` rest · `-` hold · `0 1 2` note · `*` whole chord (or arpeggio) · `0+4+8` stack · `k s h o c t m` drums · `'` `,` octave up/down · `#` `b` semitone · `!` accent · `?` / `?30` chance · `T*n` repeat · `|` bar line.

Block `mode`: `chord` (0 root, 1 third, 2 fifth, 3 root an octave up …), `scale` (steps above the chord root) or `key` (degrees of the key). `fit`: notes on the beat move to the nearest chord tone (for melodies in `key`).

Block `from`: play that block's notes (its `pattern`, `mode` and `fit`) instead of a pattern of its own, cut or padded to this block's `beats`; the block named must have notes of its own. `forms`: the forms one is picked from when the block starts and, half the time, when it loops — `whole` (as written), `head` (first half, then space), `sequence` (first half, then again a step or two up or down), `slow` (first half at half speed), `shift` (all of it a step or two up or down), `answer` (space, then the first half). None: as written. Songs from before kept one `theme` that `theme` blocks played: it becomes a block they take their notes `from` when the song loads.

## Files

| Path | |
|---|---|
| `src/engine/engine.js` | conductor and sequencer |
| `src/engine/synth.js`, `drums.js`, `dsp.js`, `wavetable.js` | voices, effects, drum kits, shared filters, band-limited wavetables |
| `src/engine/pattern.js`, `theory.js`, `rng.js` | patterns and their forms, scales and chords, seeded RNG |
| `src/engine/params.js` | every setting with its range |
| `src/player.js`, `src/worklet.js` | the web player: main-thread API and AudioWorklet host |
| `src/index.js` | what the package exports; `samples.js`, `disk-samples.js`, `wav.js`, `phrase.js` |
| `songs/` | the reference song (tests, render, bench); more are in the editor repo |
| `library/` | the sample library (CC0 recordings) |
| `tools/` | offline render, tests, benchmark, sample builder, dev server |

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
