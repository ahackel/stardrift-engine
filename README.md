# Stardrift

A procedural, block-based chiptune music engine for (space) games: atmospheric and relaxing by default, with tension when the game wants it. Endless, it varies itself over time, and you can steer the mood at runtime with smooth transitions.

- **JavaScript player and editor**: this repo, no build step, no dependencies.
- **Unity**: the engine is written so it can be ported 1:1 to C# (see *Porting to Unity*).

```bash
npm run dev        # → http://localhost:8321  (no-cache static server; AudioWorklet needs http://, not file://)
npm run render     # offline render + conductor log (node tools/render.mjs song secs seed out.wav --mood 30:tension --sting 45:discovery)
node tools/test.mjs
npm run bench      # CPU per song and mood, slowest audio blocks, voices (node tools/bench.mjs [songs] --sr 22050 --breakdown)
```

The **sound lab** (`npm run dev`, then http://localhost:8321/tools/lab/) plays versions of a sound in the same phrase at the same loudness, to pick the better one by ear. `tools/lab/experiments.js` lists what to compare.

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
                                  • fills, drops, mutations
```

- **Blocks** (clips in the editor) are 1–32 beats of pattern, e.g. `{ "id": "pulse", "beats": 4, "tags": ["drift","calm"], "intensity": [0.3, 0.7], "pattern": "0 - - . 0 - . . 0 - - . -1 - . ." }`; the id is the clip's name. A track lists the blocks it plays (`"clips": ["pulse", …]`), and one block can be on several tracks: it sounds with each track's instrument and octave (song `"format": 2`). Notes are relative to the current chord or scale, so every block works over every progression. (Older songs name the track on the block, `"track": "bass"`; the engine still reads them.)
- **Melodies come from the song theme** (below), not from random walks: a tune you remember repeats. The editor turns generator blocks from older songs (`gen`) into plain patterns when it opens them.
- **Sections** (intro, calm, wonder, drift, tension, build, peak, danger, release) carry an intensity, a tension, tags, a length and weighted `next` links. Together they form a graph the conductor walks.
- **Progressions** are roman numerals diatonic to a scale, which can be switched per progression (lydian for *wonder*, phrygian or harmonic minor for *tension*).
- **Variation over time**: blocks mutate slightly when they loop, blocks are occasionally swapped mid-section, layers enter and leave every 4 bars, drum fills and drops mark transitions, and theme blocks pick a new form. Everything is seeded, so the same seed gives the same music.
- **Phrasing**: the last beats of a section play a **lead-in chord** into the next section's first chord (its V when that is major, else the major chord a step below, e.g. C → Dm in D dorian; `leadIn`: beats, 0 = off). Notes get **dynamics**: bar downbeats a little louder, off-16ths softer, plus a small random spread (`humanize`, on its own RNG stream so it never changes the arrangement). `swing` delays every second 16th.
- **Breathers** (`"breath": { "every": 64, "bars": [4, 8] }`): every ~64 bars, while things are calm, the drums drop out and the music thins to its ambient tracks (those whose `layer.min` is 0, or `breath.keep`) for a few bars, then grows back. Endless music needs room to breathe; a mood change ends a breather like any other section. A passage that is already that sparse (no drums, at most one track beyond the ambient ones, e.g. a breakdown) counts as a breather.
- **The song theme** gives endless music an identity, like a melody you would hum after playing. `"theme": { "beats": 16, "pattern": "4 -*5 3 - 2 -*7 | …" }` is one melody in key degrees. Blocks with `"theme": true` (or a list of forms) play it instead of a pattern, in a form picked each time: `whole`, `head` (first half, then space), `sequence` (first half, then again a step or two higher or lower), `slow` (first half at half speed), `shift` (the whole theme moved up or down) or `answer` (space, then the first half, which forms a canon against a track playing the whole theme). Notes on the beat move to the nearest chord tone, so the theme fits every chord; chromatic notes (`4#`) stay as written (`"fit": true` does the same for any key or scale block). In the default song the lead states it in calm and drift sections, the stars answer it, and it returns as an anthem at the peak. A new theme is built the way tunes are: a one-bar motif, the motif again (a step higher or with a new ending), a busier bar that climbs, and an answer that lands on the tonic.
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

The player loads the sample library (`library/`, next to `src/`) in the background when it starts; `init({ library: url })` points it elsewhere. Sample sounds are silent and sampled drum hits synthesized until it has arrived. Other hosts call `engine.setSamples(samples)` (see `src/samples.js`).

A mood change never cuts: the current section ends at a bar line within `within` bars, with a drum fill (going up) or a wash/drop (going down). The conductor then walks the section graph toward the mood, and bridge sections are shortened to `transitBars`, e.g. calm → drift → build → peak in about 18 s. Pads crossfade on chord changes, and intensity, tension and filter cutoffs glide over several bars (`moodGlide`).

## Files

| Path | |
|---|---|
| `src/engine/engine.js` | conductor + sequencer (the brain) |
| `src/engine/synth.js` | voices, filters, echo, reverb |
| `src/engine/wavetable.js` | band-limited wavetables (FFT-built, one per octave) |
| `src/engine/drums.js` | drum kits: `clean` (default: sine bodies, filtered noise, 808-style metal), `chip` (raw NES-style), `orchestra` (timpani on `k` and `t`, concert snare, shaker, recorded suspended and clash cymbals, woodblock) and `rock` (with recorded hi-hats and crash) — pick with `"kit"` on a drums instrument, override single hits with an object, e.g. `"preset": "clean", "kit": { "s": { "pitch": 1.1, "decay": 0.8, "level": 0.9 } }`. A hit can play a recording from the sample library (`"c": { "sample": "crash" }`); without the library it falls back to its synthesized parts |
| `src/engine/pattern.js` | pattern language, mutations, theme forms |
| `src/engine/theory.js` | scales, chords, song normalisation |
| `src/engine/rng.js` | seeded RNG (mulberry32) |
| `src/engine/params.js` | every setting of an instrument, a track and the song's feel, with its range: what variations change and what the editor's knobs and sliders show; reading and writing a setting (`getAt`, `putParam`) |
| `src/engine/compose.js` | variations of clips, progressions, sounds and the theme (`vary*`: as big as asked), new themes (seeded, no DOM: portable to the Unity runtime) |
| `src/worklet.js` / `src/player.js` | AudioWorklet host / main-thread API for web games |
| `src/wav.js` | WAV encoder (offline render and the editor's audio export) |
| `src/editor/*` | editor UI (game input, song rows, tracks, detail panel with block, progression, section, track, stinger and song editors, live chords, JSON; `knob.js` dials, `icons.js` pixel icons); the panels are Lit components: `panel.js` (the base: a panel draws from the song and the selection, again on each change), `controls.js` (the controls every panel is built from: slider, knob, choice, dropdown, fields, colour, track picker, plays in …), then one file per panel: `game.js` (game input: moods, intensity and tension, stingers, the calls made), `arrangement.js` (the rows and chips; while playing it moves the progress bars and flashes the dots directly), `vary.js`, `instruments.js` (track and instrument), `song.js`, `clip.js`, `chords.js` (sequence), `section.js`, `stingers.js`, `libpanel.js` (the library); `render-worker.js` exports audio |
| `src/vendor/lit.js` | Lit 3.3.3 (BSD-3-Clause), the all-in-one bundle, kept here so the editor needs no build step and no network |
| `songs/deep-space.json` | default song: ambient space, D dorian, 92 bpm |
| `songs/night-transit.json` | dark synth-pop in the spirit of Depeche Mode: F minor, 116 bpm, four-on-the-floor, sequenced octave bass, 16th sequences, saw strings, metal hits, dotted-8th echo |
| `songs/hop-hop-hooray.json` | playful platformer music in the spirit of Super Mario: C major, 138 bpm with a shuffle, NES voices (square lead, off-beat square stabs, triangle oom-pah bass, chip noise drums), a bouncy theme with a chromatic step, and worlds as sections: meadow, bonus (lydian), overworld, underground, castle (diminished 7th), run, star (mixolydian I–bVII) and a flagpole fanfare (bVI–bVII–I) |
| `songs/last-frontier.json` | orchestral adventure: D minor, 96 bpm. A staccato string ostinato drives it, cellos double the roots in octaves, horns hold open chords and take the theme at the peak, the violin plays the theme, harp arpeggios and glissandi in the calm, timpani (tuned to D and A) instead of a backbeat |
| `songs/iron-comet.json` | rock: E minor, 138 bpm. Palm-muted power chord chugs in the verse, a riff the bass doubles, ringing chords and organ in the chorus, a clean guitar in the quiet parts, backbeat drums with ride, crash and tom fills, and the overdrive guitar playing the theme |

All songs use the same mood names (`relaxed wonder exploring tension danger action`) and stinger names (`discovery alert jump reward`), so a game can switch songs (e.g. per level) without changing its calls.

## Instruments

Each track names an instrument (`"instrument": "lead"`) and has a name of its own (`"name": "Lead"`); instruments live in `song.instruments`, and several tracks can play the same one. Types: `pulse` (NES square, `duty`, `pwm`), `triangle` (NES 4-bit triangle), `wave` (32-step 4-bit wavetable: `soft sine saw warm organ hollow` or your own array of 32 values 0–15; `warm` is a saw whose harmonics fall off faster, for bowed and blown sounds without the buzz), `string` (a plucked string, Karplus-Strong: `string { decay, bright, mute }`, for guitars, harp, pizzicato and piano; with `mute` short notes, those not held into the next step, are palm-muted while held notes ring open) `fm` (two sine operators as in the Sega Genesis and the DX7: `fm { ratio, index, env, feedback }`; `env` makes the brightness follow the note's loudness, the way brass brightens as it swells) `bowed` (a bowed string, a physical model after the Synthesis ToolKit: `bow { pressure, position }`; the envelope is the bow's speed; with `unison` each note is a section of players, and `ensemble` makes each player's pitch and vibrato wander), `sample` (recorded notes from the sample library: `"sample": "cello"`, each note played from the nearest recorded pitch, held notes loop) and `drums`. How many notes an instrument plays at once is its own: `"poly": 8` plays chords (up to 8 voices); without it an instrument plays one note at a time (a new note ends the last, notes that start together play only the first), and with `"arp": 24` that one voice runs through them as a chip arpeggio (24 notes a second). Older songs had `poly` on the track, and still play. All melodic types share `env {a d s r}`, `unison`/`detune`, `vibrato {depth rate delay}`, `glide`, `arp`, `cutoff`/`resonance`, `cutoffIntensity`/`cutoffTension` (the filter follows the mood), `filterEnv {amount decay}` (each note opens the filter by `amount` octaves, more for louder notes, then it closes over `decay` seconds: plucks and analog-style basses), `drive` (0–2: 1 is crunch, 2 high gain; soft clipping before the filter, anti-aliased so high gain doesn't fizz: overdrive guitars, a gritty organ), `amp` (`guitar` or `bass`: the drive inside an amp, with EQ into the clipper and a speaker cabinet after it), `breath` (0–1, air in the note: noise in a band around its pitch, at a level that follows the tone, the same for every type: 0.25 is a hint, 1 a breathy pan flute; flute, choir, bowed strings. Older songs' `noise` still plays, and the editor turns it into `breath`), `body` (the fixed resonances of an instrument's box, bell or mouth: `violin`, `cello`, `strings`, `horn`, `brass`, the vowels `ah`, `oh`, `oo` and `ee` (on a rich source such as a saw), or your own list of `[kind, Hz, Q, dB]` filters), `ensemble` (0–1: each unison voice is a player who drifts and vibrates on their own), `swell` (octaves the filter opens with the note's loudness: brass and bows brighten as they swell), `scoop` (semitones a note starts flat before sliding up) and `gain`. Triangle and wave voices play from band-limited wavetables (one per octave, so high notes don't alias) and keep their 4-bit staircase; `"smooth": true` drops the steps for an analog-style saw, sine or triangle. On a track, `"pump": 0.3` makes it dip on every kick and swell back (sidechain pumping), `"fade": 2` makes it fade in and out over two bars when it joins or leaves (pads and other sustained sounds fade over a bar by default, the rest start and stop on the beat), and `"double": 0.7` double-tracks it: a second take, slightly late with a wandering delay, the two at pan ± 0.7 (wide rock guitars). Notes land a few milliseconds late at random, never early (drums on the beat almost exact, hats and chords looser), scaled by `humanize` (0–1, 0.1 by default, which also spreads the loudness). The master bus has a low cut at 30 Hz and a gentle compressor that glues the mix, `master.glue` (0–1, 0.5 by default, 0 turns it off), before the soft clip. The reverb is a Freeverb with a pre-delay and a low cut on its input (`fx.reverb.predelay`, `fx.reverb.lowcut`), and the echo has a low cut too (`fx.echo.lowcut`), so bass never muddies the tails.

In the editor, the top bar holds the transport and a **display**: on top the song's name (click it for the song settings), the **song picker**, key and tempo; below it what the music does right now (section → next section, chord, bar and beat). The left column is the **game input**: everything a game sends, to try it out. It glows "live" while the music plays, and a small console at its bottom shows each action as the call your game code would make (`music.setMood('tension')`, `music.sting('alert')`). The mood buttons call `setMood`; the **stingers** play a stinger the way the game would and open it for editing: when it starts, how long it is, its chord, how much the music ducks, and one pattern grid per part. While the song is paused, only the stinger sounds. On the right, the **Song** panel holds the song-wide rows, like Logic's global tracks: **sections** (the playing one lights up, the next one is outlined; click to edit its mood, length, tags, which sections may follow and which tracks play; the lock holds it: the music moves there at the next bar line and stays, whatever the mood, `player.lockSection(id)`) and **progressions**, the chord sequences (click one to edit it as a strip of chords with a palette of the chords that fit the scale; the lock holds it in the song from the next bar line, `player.lockProgression(id)`). Below, **Tracks** has one row per track: its name (a track is its instrument, so the row shows the instrument's name), mute/solo, a volume knob, a level meter along the bottom of its head, and the track's blocks as chips (the playing one glows, the lock holds a block on its track). The display has the master's meter (left, right) at its right edge; it shows red when the mix is louder than the output takes and the soft clip squashes it (`player.setMeters(true)`, then `levels` events: each track's and the master's peak, about 30 a second). Clicking a chip opens the block editor. The **keyboard** (the keys button in the editor's title bar; hidden at first, so the note grid gets the room) plays the selected track with the mouse, the computer keys (musical typing) or a **MIDI keyboard** (Web MIDI: the MIDI button connects it, notes play at their own pitch and as loud as they are struck, drum pads play the hits by General MIDI), and **step record** writes what you play into the open clip. **＋ track** under the rows adds a track: pick its sound from the **instrument library**, and it starts with one simple block. Clicking a track name opens the **track** in one panel: its name, a sound picker with every library sound that fits (melodic or drums), "Browse library", octave, previews that work even while the song is paused (`player.preview(inst, events)`), "Save to library", knobs for pan and sends, the sound itself (type, knobs for the envelope, cutoff, drive, breath and gain, drawable wavetables) and "Delete track" (with its blocks; undo brings it back). Several tracks can play one instrument (a change to it changes them all); a track has its own name, and its mix (pan, echo, reverb, double, pump) stays on the track. Knobs turn by dragging up or down (shift for fine steps, double-click for the default) and take the keyboard arrows. Every panel folds to its title bar. Each colour means one thing: cyan is state (active, selected, live, progress), amber is harmony (chords and progressions), red is delete and errors, and a track's own colour marks what belongs to that track; sections and moods are neutral. The **Advanced** switch shows the power-user controls: seed, Log and Song JSON, "change within", intensity/tension sliders (`setParams`, with a mark where the music is now), **Play chords** (keys 1–7 play your own chord from the next beat, of a chord type: triad, sus2, sus4, 7th, add9; 0 or Esc hands back to the progression, `player.playChord(degree, shape)` / `playChord(null)`), the raw pattern text, block weights and ranges, and the finer sound settings. The song settings hold the **theme** (a grid in key degrees, hear it), key, scale, tempo, feel (swing, dynamics, lead-in chord), breathers and **Export audio** (a WAV rendered from the start with the current seed and mood). Undo and redo (⌘Z / ⇧⌘Z, Ctrl+Z / Ctrl+Y) cover every edit in the open song. A block **plays** a pattern or the song theme (a note icon on its chip; pick its forms in the block editor). Turning a theme block back into a pattern keeps the theme's notes, ready to vary by hand. Drum tracks can only switch to drum kits and melodic tracks only to melodic instruments, because their patterns differ.

**Songs and the instrument library.** The editor keeps any number of songs in the browser (localStorage). The song picker lists them and offers **New song…**: a **quick start** (see below), the *starter* (pad, bass and drums from the library, sections for all six game moods, simple progressions and blocks, in a key, scale and tempo you pick), a copy of an example, or a copy of the current song. Import a song file there too; the song settings have Duplicate and **Export file** (the `.json` your game loads, and your backup: browser storage stays on one computer). **All songs…** (in the picker and the song settings) opens the song browser: every song in this browser with Open, Duplicate, Export and Delete. The **instrument library** has 44 built-in sounds in six groups (lead, bass, pad, pluck & arp, bell & sparkle, drums) and four kinds (chip, synth, orchestra, rock: strings, choir, brass, horns, piano, violin, trumpet, flute, cello, pizzicato, harp, marimba, glockenspiel, guitars, bass guitar, organ, orchestral and rock kits), each with ▶ to hear it, plus **Mine**: sounds saved with "Save to library", available in every song. Using a library sound *copies* it into the song, so a song file is always complete on its own and later library changes don't alter existing songs. A new track takes the sound's suggested octave, mix and layer range and a starter block for its group.

**Quick start: styles are example songs.** New song… makes up a song in a style: *Ambient space*, *Synth-pop*, *Platformer*, *Orchestral* or *Rock*, or **Surprise me** (any style). It starts playing right away. Each style is one hand-written example song (`library/examples.json` lists them), because a genre lives in its arrangement: which parts play, their rhythms and how chords are voiced, far more than in its sounds. A new song in a style is the example with:
- a new key, and a tempo a few percent off
- a new theme, so it has its own tune (the theme blocks play it)
- about a third of the progressions varied (related chords, colours, or new chords of the same pace)
- about a third of the blocks varied in ways that keep their role: kicks move but snare and hats stay, chord tones may change, lines in scale or key degrees keep their notes and get a new rhythm, held chords get another voicing
- about a third of the sounds swapped for another the style lists for that track (a violin for a flute or trumpet, horns for brass)

**Variations.** The **Variations** panel (right side) changes what is selected: the song, a track (its clips), a clip, a sequence or an instrument. **how different** says how much, and **Vary** does it. Hit it again for another version: each press is an undo step. While the music plays, a clip or sequence is held so you hear it; while paused, it plays on its own. The change picked is the one whose size is nearest the slider (with a little luck, so it differs each time):
- **Clips:** a few notes changed, a new voicing, new notes on the same rhythm (from the same first note), a new rhythm with the same notes, busier (splits and passing notes), calmer (off-beats go), or both new. Drum clips: new hats, new kicks, busier, calmer. Held pad chords: pulsing, swells, off-beat stabs or another voicing.
- **Sequences:** new colours (sus, 7th, add9), chords swapped for relatives that share two notes, more or fewer changes, or new chords of the same length and pace.
- **Instruments:** every setting of the synth: oscillator, voices, envelope, pitch, filter, drive, level, and a drum kit's pads. The slider sets how many move and how far, within a musical part of each range; from about half, choices change too: the wave, the amp, the body, the kit, another recording, and (near the top) the oscillator type.
- **Track:** its clips (one at least, then each with the slider's chance), its mix (volume, pan, echo, reverb, double, pump), when it plays (plays from / until, chance), its fade and octave, and its instrument (on every track that plays it). **changes** turns any of these off.
- **Song:** the key (a little: a fifth away; a lot: maybe another mode, dorian for minor), the tempo, the feel (swing, humanize, glue, lead-in chord), the theme (a little: the first half stays; a lot: a new one), and the chords, clips, instruments and the tracks' mix, each with that chance. **changes** turns any of these off. Clips keep their role: kicks move but snare and hats stay, lines in scale or key degrees keep their notes.

Every setting and its range is listed once, in `src/engine/params.js`: the variations read it, and the instrument and track editors take each control's range from it (a test checks that every setting they name is listed). Names, colours and how an instrument plays notes (one at a time, chords, arpeggio) are never varied. `songLike(song, lib, rng, { ex })` (a song in a style, with the sounds the style lists) and `varySong(song, lib, rng, { change })` are in `library.js`; `varyBlock`, `varyProgression`, `varySound`, `varyTrack` and `varyFeel` in `compose.js`. "Add a theme" makes up a new theme.

| File | What |
|---|---|
| `library/instruments.json` | the built-in instrument library: groups (label, colour, track defaults), starter blocks per group, the sounds |
| `library/examples.json` | the styles: an example song each, its name words, and per track the library sounds it may swap to |
| `library/starter-song.json` | the starter for new songs; its `trackInstruments` names the library sounds its tracks play |
| `src/editor/library.js` | adding tracks from the library, swapping a track's sound, removing tracks, the starter song, new songs like a given one (`songLike`, `varySong`), upgrading older songs (no DOM, tested) |
| `src/editor/storage.js` | the browser's songs and the user's own instruments |
| `library/samples.json`, `library/samples/` | the sample library: CC0 recordings (VSCO 2 Community Edition and VCSL by Versilian Studios) of a cello section, tenor trombones, hi-hats and cymbals, mono 16-bit WAV. Each entry lists zones: a file, its root note (measured) and for sustained notes a loop with a baked crossfade. `tools/samples.mjs` builds it from the downloaded sources |
| `src/samples.js`, `tools/load-samples.mjs` | loading the sample library in a browser (`fetchSamples`) and in node (`diskSamples`) for `Engine.setSamples` |
| `tools/lab/` | the sound lab: `phrase.js` renders a short phrase for one sound with the engine (browser and node), `experiments.js` the comparisons |

## Pattern language

`.` rest · `-` hold · `0 1 2` note · `*` whole chord (or a chip arpeggio on an instrument with `arp`) · `0+4+8` stack · `k s h o c t m` drums · `'` `,` octave up/down · `#` `b` semitone · `!` accent · `?` / `?30` chance · `T*n` repeat · `|` visual bar line.

Block `mode`: `chord` (numbers are chord tones: 0 root, 1 third, 2 fifth, 3 root an octave up…), `scale` (steps above the chord root) or `key` (absolute degrees of the key).

## Porting to Unity (next step)

The engine was written with the port in mind:

- No Web Audio nodes: everything is per-sample math in `Engine.process(outL, outR, n)`. In Unity it maps to `OnAudioFilterRead(float[] data, int channels)` on a MonoBehaviour with an AudioSource.
- The song format is plain JSON (load with Newtonsoft/JsonUtility), so the same file drives both players and the web editor becomes the authoring tool for Unity.
- The RNG is integer mulberry32 (`Math.imul` → `uint` multiply in C#), so a port can be verified against `tools/test.mjs` / `tools/render.mjs` output with the same seed.
- Mood/parameter calls from the game thread just set target values; the audio thread applies them on the next bar, so no locking is needed beyond a small message queue.
- Only non-deterministic detail: initial unison oscillator phases (`Math.random`), which is inaudible and fine to replace.

Alternative for WebGL builds: run this JS engine via a `.jslib` plugin.
