# Stardrift

A procedural, block-based chiptune music engine for (space) games: atmospheric by default, tense when the game asks for it. The music is endless, varies itself over time and follows the game's mood with smooth transitions.

- **JavaScript player and editor**: this repo, no build step, no dependencies.
- **Unity**: the engine is plain per-sample code, written to be ported 1:1 to C# (see *Porting to Unity*).

```bash
npm run dev        # the editor at http://localhost:8321 (AudioWorklet needs http://, not file://)
npm run render     # offline render + conductor log: node tools/render.mjs song secs seed out.wav --mood 30:tension --sting 45:discovery
node tools/test.mjs
npm run bench      # CPU per song and mood: node tools/bench.mjs [songs] --sr 22050 --breakdown
```

`demo/stardrift-demo.mp3` is 2:40 with mood changes (auto → *tension* → *action* → *relaxed*). The sound lab (`/tools/lab/`) plays versions of a sound side by side to compare by ear.

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
- **Sections** (intro, calm, drift, tension, peak …) carry an intensity, a tension, a length and weighted `next` links: a graph the conductor walks. A mood leads it to one of the mood's sections, picked by weight, or, if the mood lists none, to the section nearest its intensity and tension.
- **What plays in a section** is set in steps of 0, 25, 50, 75 and 100 %: how likely each track plays there, and how often it picks each of its blocks, against its others (the progressions likewise). The editor's *Plays in* view shows it all as a grid.
- **Progressions** are roman numerals, each in its own scale if it likes (lydian for wonder, phrygian for tension). The last beats of a section play a lead-in chord into the next. A `.` is no chord (N.C., e.g. `i:4 .:4`): whole chords rest and single lines play on over the home chord, for a break.
- **The theme** is one melody in key degrees. Theme blocks play it in a form picked each time (whole, head, sequence, slow, shift, answer), fitted to the chord, so the endless music has a tune you remember.
- **Variation over time**: blocks mutate when they loop, tracks that play sometimes come and go, fills and drops mark transitions, and every so often the music thins to a breather. Everything is seeded: the same seed gives the same music.
- **Stingers** react to game events: a short phrase from the next beat that borrows tracks, can bring its own chord and ducks the rest.

## Game API

```js
music.setMood('relaxed');                 // named moods live in song.moods
music.setMood('tension', { within: 0 });  // start moving at the next bar line
music.setMood({ intensity: 0.7, tension: 0.9 });
music.setMood('auto');                    // drift on its own again
music.setParams({ intensity, tension, influence, urgent });
music.sting('alert');                     // a stinger, from the next beat
music.sting('reward', { at: 'step' });    // … or right away
```

A mood change never cuts: the section ends at a bar line with a fill (going up) or a drop (going down), the conductor walks the graph toward the mood with shortened bridge sections, and cutoffs and levels glide over a few bars. All songs share the mood names (`relaxed wonder exploring tension danger action`) and stinger names (`discovery alert jump reward`), so a game can switch songs without changing its calls.

The player loads the sample library (`library/`) in the background; `init({ library: url })` points it elsewhere, other hosts call `engine.setSamples()`.

## Song format

A song is plain JSON (`songs/*.json`). The parts:

```json
{ "bpm": 92, "key": "D", "scale": "dorian",
  "instruments": { "lead": { "type": "pulse", "duty": 0.25, "env": { "a": 0.01, "d": 0.3, "s": 0.6, "r": 0.3 } } },
  "tracks": [{ "id": "lead", "name": "Lead", "instrument": "lead", "octave": 5, "clips": ["pulse"] }],
  "blocks": [{ "id": "pulse", "beats": 4, "sections": { "drift": 0.25, "peak": 0 }, "pattern": "0 - - . 0 - . . 0 - - . -1 - . ." }],
  "sections": [{ "id": "calm", "intensity": 0.3, "tension": 0.1, "bars": [8], "tracks": { "lead": 0.5 }, "next": { "drift": 2 } }],
  "progressions": [{ "id": "home", "chords": "i:8 IV:4 VII:4" }],
  "theme": { "beats": 16, "pattern": "4 -*5 3 - 2 -*7 …" },
  "stingers": [{ "id": "discovery", "at": "beat", "beats": 4, "chords": "IV", "duck": 0.45,
                 "parts": [{ "track": "arp", "pattern": "* -*15" }] }] }
```

Song-wide: `swing`, `humanize` (timing and loudness spread), `leadIn`, `breath` (breathers), `master.glue` (the compressor), `fx.echo` and `fx.reverb`. A track has `volume pan echo reverb`, `double` (a second take either side), `pump` (sidechain on the kick) and `fade` (bars to join or leave).

What plays where, in steps of 0 · 0.25 · 0.5 · 0.75 · 1: a section's `tracks` (`{ id: chance }`) and a block's or progression's `sections` (`{ id: weight }`: picked by weight against the others in that section). Anything not listed is 1, so a new section, track, block or progression plays everywhere. A track whose blocks all weigh 0 in a section rests there; a section with no progression picks any. `"fill": true` marks a drum fill for the bar before a section change. A mood's `sections` (`{ id: weight }`) are where it leads the music, picked again each time a section ends; here anything not listed is 0, and a mood without them heads for the section nearest its `intensity` and `tension`. Older songs (tags, weights, intensity and tension ranges, track layers) are turned into these steps when they load.

### Instruments

Several tracks can play one instrument. Every setting and its range is listed once, in `src/engine/params.js`.

| Key | What |
|---|---|
| `type` | `pulse` (`duty`, `pwm`), `triangle`, `wave` (a preset or 32 values 0–15), `string` (plucked: `string { decay bright mute }`), `fm` (`fm { ratio index env feedback }`), `bowed` (`bow { pressure position }`), `sample` (`"sample": "cello"`), `drums` (`kit`) |
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
| `cutoffIntensity`, `cutoffTension`, `swell`, `filterEnv { amount decay }` | the filter follows the mood, the note's loudness, or opens on each note |
| `crush { bits rate }` | bitcrush |
| `eq { low mid midHz high }` | 3-band EQ in dB |
| `phaser`, `chorus` (`mode: flanger`), `tremolo`, `autopan` | `{ beats depth }` in time with the song (phaser: `feedback`) |

The chain runs in that order: pitch → source → envelope → breath → body → wah → drive → filter → crush → EQ → phaser → chorus → tremolo → auto-pan. Drum kits (`clean`, `chip`, `orchestra`, `rock`) take per-hit overrides, e.g. `"preset": "clean", "kit": { "s": { "pitch": 1.1, "decay": 0.8 } }`, and the effects that suit drums.

## Pattern language

`.` rest · `-` hold · `0 1 2` note · `*` whole chord (or arpeggio) · `0+4+8` stack · `k s h o c t m` drums · `'` `,` octave up/down · `#` `b` semitone · `!` accent · `?` / `?30` chance · `T*n` repeat · `|` bar line.

Block `mode`: `chord` (0 root, 1 third, 2 fifth, 3 root an octave up …), `scale` (steps above the chord root) or `key` (degrees of the key).

## The editor

Open a song, click a chip, track, section or sequence to edit it; the **Info** panel explains whatever the pointer is on. The **Plays in** view, shown instead of the arrangement, is a grid of what plays in every section: how often each mood leads there, how likely each track plays and how often each block and progression is picked. The game input on the right sends moods and stingers the way a game would and shows the calls. The editor keeps songs in the browser and exports the `.json` your game loads (and a WAV). New songs start empty, from the starter, or in a style (a hand-written example song with a new key, theme and variations). **Vary** makes a variation of what is selected, by a little or a lot.

## Files

| Path | |
|---|---|
| `src/engine/engine.js` | conductor and sequencer |
| `src/engine/synth.js`, `drums.js`, `dsp.js`, `wavetable.js` | voices, effects, drum kits, shared filters, band-limited wavetables |
| `src/engine/pattern.js`, `theory.js`, `rng.js` | patterns and theme forms, scales and chords, seeded RNG |
| `src/engine/params.js`, `compose.js` | every setting with its range; variations and new themes |
| `src/player.js`, `src/worklet.js` | the web player: main-thread API and AudioWorklet host |
| `src/editor/` | the editor: Lit panels (`vendor/lit.js`, no build step), one file per panel |
| `songs/` | example songs: ambient space, dark synth-pop, platformer, orchestral, rock |
| `library/` | built-in instruments, styles, the starter song, the sample library (CC0 recordings) |
| `tools/` | offline render, tests, benchmark, sample builder, sound lab |

## Porting to Unity

- No Web Audio nodes: everything is per-sample math in `Engine.process(outL, outR, n)`, which maps to `OnAudioFilterRead`.
- The song format is plain JSON, so the web editor is the authoring tool for Unity too.
- The RNG is integer mulberry32 (`Math.imul` → `uint` multiply), so a port can be checked against `tools/render.mjs` with the same seed.
- Game calls only set targets; the audio thread applies them at the next bar, so a small message queue is all the locking needed.
- `Math.random` is used only for sound detail (voice start phases, string plucks, breath noise), which is inaudible to replace.

For WebGL builds the JS engine can also run through a `.jslib` plugin.
