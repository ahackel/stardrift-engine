# Stardrift song format

A song is one JSON file. The engine plays it endlessly: it walks a graph of **sections**, picks a chord **progression** for each, and on every **track** one of the track's short **blocks** (clips) at a time; blocks vary as they loop. A game steers the music with **moods** and plays **stingers** on events. This page is the whole format, written to be handed to a person or to an AI that writes songs.

Check a song with `validateSong(song)` (`import { validateSong } from 'stardrift-engine'`): it lists every mistake, saying where and what. `dist/song.schema.json` is the format as a JSON Schema: with `"$schema": "./node_modules/stardrift-engine/dist/song.schema.json"` in a song, your editor checks it as you type.

## A complete song

```json
{
  "format": 2,
  "name": "Small Hours",
  "bpm": 96,
  "key": "D",
  "scale": "dorian",
  "instruments": {
    "pad": { "type": "wave", "wave": "warm", "smooth": true, "poly": 4, "env": { "a": 0.4, "d": 1, "s": 0.8, "r": 1.2 }, "cutoff": 2500 },
    "bass": { "type": "triangle", "env": { "a": 0.005, "d": 0.3, "s": 0.7, "r": 0.1 } },
    "lead": { "type": "pulse", "duty": 0.25, "env": { "a": 0.01, "d": 0.2, "s": 0.6, "r": 0.3 }, "vibrato": { "depth": 0.1, "rate": 5, "delay": 0.2 } },
    "drums": { "type": "drums", "kit": "chip" }
  },
  "tracks": [
    { "id": "pad", "instrument": "pad", "octave": 4, "volume": 0.18, "reverb": 0.5, "follow": true, "clips": ["pad_hold"] },
    { "id": "bass", "instrument": "bass", "octave": 2, "volume": 0.3, "clips": ["bass_root", "bass_walk"] },
    { "id": "lead", "instrument": "lead", "octave": 5, "volume": 0.2, "echo": 0.3, "clips": ["theme", "theme_echo"] },
    { "id": "drums", "instrument": "drums", "volume": 0.35, "clips": ["beat_soft", "beat_drive", "fill"] }
  ],
  "blocks": [
    { "id": "pad_hold", "beats": 8, "pattern": "* -*31" },
    { "id": "bass_root", "beats": 4, "pattern": "0 - - - . . 0 . 0 - - - . . 2, ." },
    { "id": "bass_walk", "beats": 4, "sections": { "calm": 0 }, "pattern": "0 . 2 . 1 . 2 . 0 . 2 . 3 . 2 ." },
    { "id": "theme", "beats": 16, "mode": "key", "fit": true,
      "pattern": "4 - - 3 2 - 0 - 2 - - - . . . . | 4 - - 3 2 - 4 - 5 - - - . . . . | 7 - - 6 5 - 4 - 3 - 2 - 4 - - - | 2 - - 1 0 -*7 . . . ." },
    { "id": "theme_echo", "beats": 16, "from": "theme", "forms": ["head", "sequence", "answer"], "sections": { "calm": 0 } },
    { "id": "beat_soft", "beats": 4, "sections": { "action": 0.25 }, "pattern": "k . h . . . h . s . h . . . h ." },
    { "id": "beat_drive", "beats": 4, "sections": { "calm": 0, "explore": 0.5 }, "pattern": "k . h k s . h . k . h k s . h h" },
    { "id": "fill", "beats": 4, "fill": true, "pattern": "k . s . s . s s s . s s s! s! s! s!" }
  ],
  "sections": [
    { "id": "calm", "bars": [8, 16], "tracks": { "drums": 0.25, "lead": 0.5 }, "next": { "calm": 0.5, "explore": 1 } },
    { "id": "explore", "bars": [8], "next": { "calm": 0.5, "explore": 0.5, "tension": 0.5 } },
    { "id": "tension", "bars": [8], "tracks": { "pad": 0.5 }, "next": { "explore": 0.5, "tension": 0.5, "action": 0.5 } },
    { "id": "action", "bars": [8, 16], "next": { "tension": 0.5, "explore": 0.5 } }
  ],
  "progressions": [
    { "id": "home", "chords": "i:8 VII:4 IV:4", "sections": { "tension": 0 } },
    { "id": "drift", "chords": "i:4 III:4 VII:4 IV:4", "sections": { "tension": 0, "action": 0.5 } },
    { "id": "dark", "chords": "i:4 II:4 i:4 VII:4", "scale": "phrygian", "sections": { "calm": 0, "explore": 0, "action": 0.5 } }
  ],
  "moods": {
    "relaxed": { "sections": { "calm": 1 } },
    "wonder": { "sections": { "calm": 0.5, "explore": 0.5 } },
    "exploring": { "sections": { "explore": 1 } },
    "tension": { "sections": { "tension": 1 } },
    "danger": { "sections": { "tension": 0.5, "action": 0.5 } },
    "action": { "sections": { "action": 1 } }
  },
  "stingers": [
    { "id": "discovery", "at": "beat", "beats": 4, "chords": "IV:2 V:2", "duck": 0.5, "parts": [{ "track": "lead", "pattern": "0 1 2 3 4 -*11" }] },
    { "id": "alert", "at": "step", "beats": 2, "duck": 0.6, "parts": [{ "track": "drums", "pattern": "k! . s . k! . s! ." }] },
    { "id": "jump", "at": "step", "beats": 1, "parts": [{ "track": "lead", "pattern": "0 1 2 3" }] },
    { "id": "reward", "at": "beat", "beats": 2, "chords": "i:2", "parts": [{ "track": "lead", "pattern": "3 2 3 4 -*4" }] }
  ],
  "breath": { "every": 32, "bars": [4, 8], "keep": ["pad"] },
  "startSection": "calm"
}
```

## How the parts fit

- `tracks[].instrument` names a key of `instruments`; `tracks[].clips` lists ids from `blocks`. Several tracks may play one instrument or one block.
- Notes are **relative**: to the chord that plays (`mode: "chord"`, the default), to the chord root in the scale (`"scale"`) or to the key (`"key"`). So every block fits every progression, and changing `key` or `scale` changes the whole song.
- A block's pattern has `beats × 4` steps (`stepsPerBeat` is 4): a 4-beat block has 16 steps, a 16-beat block 64. Longer is cut, shorter padded with rests.
- **What plays where** is weights in steps of 0, 0.25, 0.5, 0.75, 1:
  - `section.tracks` `{ trackId: chance }`: how likely the track plays in the section. Not listed: 1.
  - `block.sections`, `progression.sections` `{ sectionId: weight }`: how often it is picked there, against the track's other blocks (or the other progressions). Not listed: 1. A track whose blocks all weigh 0 in a section rests there.
  - `section.next` `{ sectionId: weight }`: the sections that may follow. Not listed: 0; none listed: any.
  - `mood.sections` `{ sectionId: weight }`: where the mood leads the music. Not listed: 0.
- Use the shared names, so a game can switch songs without changing its calls: moods `relaxed wonder exploring tension danger action`, stingers `discovery alert jump reward`.

## The song

| Key | What |
|---|---|
| `name`, `bpm` 30–300, `key` | `C`, `F#`, `Bb` … |
| `scale` | `major minor dorian phrygian lydian mixolydian locrian harmonicMinor` |
| `stepsPerBeat`, `beatsPerBar` | 4 and 4 |
| `swing` 0–0.6 (0), `humanize` 0–0.3 (0.1) | the feel: late off-beats; timing and loudness spread |
| `leadIn` | beats of a lead-in chord into the next section: 0, 1, 2 (default) or 4 |
| `breath` | `{ every: bars, bars: [min, max], keep: [trackIds] }`: about every so many bars the music thins to the kept tracks |
| `startSection` | where it starts (default: the first section) |
| `master.glue` 0–1 (0.5) | the bus compressor |
| `fx.echo`, `fx.reverb` | `{ beats, feedback, damp, level }`, `{ size, damp, level }`: the shared effects tracks send to |
| `variation` (0.3), `blockChange` (0.15), `fillChance` (0.5), `layerChurn` (0.1), `progStickiness` (1.5), `transitBars` (2) | how often blocks mutate, change and fill, and tracks that play sometimes come and go; how long a progression stays; the bars of a bridge section on the way to a mood |

## Instruments

| `type` | Sound |
|---|---|
| `pulse` | NES square: `duty`, `pwm` |
| `triangle` | NES triangle (`smooth`: a clean one) |
| `wave` | wavetable: `wave` `soft sine saw warm organ hollow`, or 32 values 0–15 |
| `fm` | two-operator FM: bells, e-pianos, basses |
| `string` | plucked: guitars, harps; `mute` palm-mutes short notes |
| `bowed` | a bowed string |
| `sample` | a recording: `sample` `cello trombone flute violins violins_pizz bass_pizz glockenspiel xylophone` |
| `drums` | a kit: `kit` `clean chip rock orchestra`; per pad: `"preset": "rock", "kit": { "s": { "pitch": 1.1, "decay": 0.8, "level": 1 } }` |

How it plays: `poly` (notes at once, for chords; 1: a new note ends the last), `arp` (chords as a chip arpeggio, notes per second, 1–60), `arpChord` (single notes arpeggiate the chord too), `smooth` (no 4-bit staircase).

Every setting, with its range and (default):

| Key | Settings |
|---|---|
| `env` | `a` 0.001–4 (0.01), `d` 0.01–6 (0.2), `s` 0–1 (0.7), `r` 0.01–8 (0.2): attack, decay, sustain level, release in seconds |
| `gain` | 0–2 (1) |
| `duty`, `pwm` | 0.05–0.5 (0.5); `{ depth 0–0.4, rate 0.05–8 (0.3) }` |
| `fm` | `ratio` 0.5–8 (1), `index` 0–10 (2), `env` 0–1 (1), `feedback` 0–1.5 (0) |
| `string` | `decay` 0.1–10 (3), `bright` 0–1 (0.5), `mute` 0–1 (0) |
| `bow` | `pressure` 0–1 (0.8), `position` 0–1 (0.4) |
| `unison`, `detune`, `ensemble` | stacked voices 1–4; cents 0–50; each voice a player who drifts 0–1 |
| `breath` | air in the note 0–1 |
| `glide`, `scoop` | 0–0.5 s; 0–2 |
| `vibrato` | `depth` 0–1, `rate` 0.1–12 (5), `delay` 0–2 (0) |
| `cutoff`, `resonance`, `filter` | 60–16000 Hz (16000); 0.3–6 (0.707); `"high"`: a high pass (default low pass) |
| `swell` | 0–3: the filter follows the note's loudness |
| `filterEnv` | `amount` 0–5, `decay` 0.02–2 (0.2): the filter opens on each note |
| `body` | fixed resonances: `violin cello strings horn brass`, vowels `ah oh oo ee`, or a list of `[kind, Hz, Q, dB]` |
| `wah` | `depth` 0.05–1 (0.7), `beats` 0.25–8 (1), `resonance` 1–10 (4), `mode: "note"` (sweeps with each note) |
| `drive`, `amp` | distortion 0–2; `guitar` or `bass`: through an amp and a cabinet |
| `crush` | `bits` 2–12 (6), `rate` 1000–48000 (11025) |
| `eq` | `low`, `mid`, `high` −12–12 dB, `midHz` 200–5000 (1000) |
| `phaser` | `depth` 0.05–1 (0.7), `beats` 0.25–16 (4), `feedback` 0–0.9 (0.5) |
| `chorus` | `depth` 0.05–1 (0.5), `beats` 0.25–16 (4), `mode: "flanger"` |
| `tremolo`, `autopan` | `depth` 0.05–1, `beats` 0.0625–4 (0.25) / 0.125–16 (2) |

The chain: pitch → source → envelope → breath → body → wah → drive → filter → crush → EQ → phaser → chorus → tremolo → auto-pan.

## Tracks

`{ id, instrument, clips, octave }`, and: `volume` 0–1 (0.3), `pan` −1–1, `echo` and `reverb` 0–1 (sends), `double` 0–1 (a second take either side), `pump` 0–1 (ducks under the kick), `fade` 0–4 (bars to join or leave), `follow` (held notes move to the next chord), `mode` (for blocks that have none), `stickiness` (how much it keeps its block, 1.5). `octave` 4 is middle C: bass 2, pads 3–4, leads 5. Drum tracks need no octave.

## Blocks

`{ id, beats, pattern }`, or `{ id, beats, from }` to play another block's notes. Also `mode`, `fit`, `forms`, `sections`, `fill`, `mutate`.

**Pattern**: one token per step, separated by spaces.

| Token | |
|---|---|
| `.` | rest (ends a held note) |
| `-` | hold the note before |
| `0` `1` `-1` `7` | a note: see `mode` |
| `*` | the whole chord (needs `poly` > 1, or `arp`) |
| `0+2+4` | notes together |
| `k s h o c t m` | drum hits: kick, snare, hat, open hat, crash, tom, tick. Only on drum tracks, and drum tracks play only these |
| `'` `,` after a note | an octave up, down (`0'`, `2,,`) |
| `#` `b` after a note | a semitone up, down |
| `!` | accent |
| `?`, `?30` | plays half the time, 30 % of the time |
| `T*n` | the token n times: `-*15` |
| `\|` | a bar line, ignored |

**`mode`**: `chord` (default): `0` the root, `1` the third, `2` the fifth, `3` the root an octave up. `scale`: steps of the scale above the chord root. `key`: degrees of the key (`0` the tonic … `7` the tonic an octave up), for melodies; with `"fit": true`, notes on the beat move to the nearest chord tone.

**Themes**: one melody (a block in `key` mode with `fit`) that other blocks quote with `from` gives the endless music a tune you remember. The block named by `from` must have a pattern of its own. `forms`, one picked each time the block starts: `whole` (as written), `head` (first half, then space), `sequence` (first half, then again a step or two up or down), `slow` (first half at half speed), `shift` (all of it a step or two up or down), `answer` (space, then the first half).

`"fill": true`: a drum fill for the bar before a section change (list it in the drum track's clips). `mutate` 0–2 (1): how much it changes when it loops; 0 never.

## Sections

`{ id, bars, tracks, next }`. `bars`: a length, or lengths to pick from: `[8, 16]`. How lively a section is (for fills, drops and crashes) follows from what plays there.

## Progressions

`{ id, chords, scale, sections }`. `chords`: roman numerals in the scale, each `numeral(shape):beats`, e.g. `"i:8 VI:4 IV(sus2):2 V(7):2"`. Case doesn't matter (the scale decides major or minor); `1`–`7` work too. Shapes: `triad` (default) `sus2 sus4 power 7 add9 six`. Beats default to 4. `.` is no chord (`.:4`): chords rest, single lines play on. `scale`: a progression in its own mode (`phrygian` for tension, `lydian` for wonder).

## Moods

`{ moodName: { sections: { sectionId: weight } } }`, or a `flow` (the grid, below). A mood change never cuts: the section ends at a bar line with a fill (going up) or a drop (going down), and the music takes the shortest way along `next` to one of the mood's sections.

## The grid: sections in order

A song can also be laid out like a sequencer's arrangement: each section holds blocks placed on its bars, and each mood plays its sections in order. Songs on the grid play the same way every time, as written; the blocks still vary as they loop (`mutate`, `forms`).

```json
"sections": [
  { "id": "intro", "bars": 4, "blocks": { "pad": [{ "at": 0, "block": "pad_hold" }] }, "chords": [{ "at": 0, "prog": "home" }] },
  { "id": "verse", "bars": 8, "blocks": { "drums": [{ "at": 0, "block": "beat_soft" }, { "at": 7, "block": "fill" }], "lead": [{ "at": 4, "block": "theme" }] } }
],
"moods": {
  "relaxed": { "flow": [["intro", 1], ["verse", 2]], "loopFrom": "verse" },
  "action": { "flow": [["verse", 1], ["fight", 2]], "then": "drift", "switch": "bar" }
},
"startMood": "relaxed"
```

- `section.blocks` `{ trackId: [{ at, block }] }`: a block plays from bar `at` (0 is the first) until the next block on its track or the section's end, looping. A track with nothing placed rests, and a track rests until its first block. The block should be on the track's `clips`. `section.chords` `[{ at, prog }]`: the progression from that bar on; with none, the one that plays goes on. A section with `blocks` has one length (`bars`), and its `tracks` and `next`, and the blocks' and progressions' `sections`, are not used.
- `mood.flow`: its sections in order, each `[id, times]` (or just the id, once). One section can be in several flows. After its flow the mood does what `then` says: `loop` (default) from `loopFrom` (default: its first section), `drift` (picks among its sections at random) or `stop` (silence until another mood). The first time a mood plays it starts at its flow's start, later at `loopFrom`.
- A change to a mood with a flow comes as soon as it sounds natural, by `switch`: at the next bar line (`bar`, the default; the bar after when less than a beat is left), the next phrase of 4 bars (`phrase`) or the section's end (`section`). The drums play the end of a fill (a block with `fill`, on their `clips`) up to the change; a block that both sections play carries on.

### Effect tracks

`effectTracks` lists the song's effect tracks: rows of effect blocks on the grid, each moving one setting across the bars it is placed on (until the next block on its row or the section's end), then back. Only sections with `blocks` play them.

```json
"effectTracks": [{ "id": "sweeps", "target": "*", "except": ["drums"], "clips": ["build", "throw"] }],
"blocks": [
  { "id": "build", "fx": { "kind": "filter", "from": 300, "to": 16000 } },
  { "id": "throw", "fx": { "kind": "echo", "from": 0, "to": 0.7, "shape": "hump" } }
]
```

- An effect track is `{ id, target, clips }` (its id not a track's too), and `section.blocks` places its effect blocks like a track's.
- `target`: the tracks it moves, ids or `"*"` for all; with `"*"`, `except` leaves some out. `"*"` with no `except` moves the whole mix, echo and reverb included (filter, highpass, volume, gate, crush; pan, echo and reverb move every track).
- `fx.kind`: `filter` (a low pass, 60–16000 Hz), `highpass` (20–8000 Hz), `volume` 0–1 (a fader), `echo` and `reverb` 0–1 (more send), `pan` −1–1, `gate` 0–1 (chops the sound every `rate` beats, 0.25), `crush` 0–1 (fewer bits, a lower rate).
- `fx.from`, `fx.to` and `fx.shape`: `ramp` (default) from → to across its bars, `hump` from → to → from, `wave` between them every `beats` (4), `hold` at `to`.
- Two rows moving one setting: the lower low pass and the higher high pass win, faders multiply, the rest add.
- `startMood`: the mood whose flow plays until the game asks for one (default: the first mood with a flow).

## Stingers

`{ id, at, beats, chords, duck, parts, then }`: a short phrase for a game event, from the next `at` (`step beat half bar`). `parts` `[{ track, pattern, mode }]` each borrow a track for the stinger's `beats` (a pattern of `beats × 4` steps), or `[{ track, block }]` play a block's notes. `chords`: its own, like a progression's. `duck` 0–1: how far the rest of the music ducks under it. `then`: a mood with a flow; as the stinger ends the music is there at once, its bar line where the stinger ends, with no fill (the stinger was the way in): `{ "id": "boss_appears", "beats": 4, "then": "action", "parts": [{ "track": "drums", "block": "hit" }] }`.

## Writing a good song

- Give the song its own sounds; the example's are one palette of many. Bells, e-pianos and marimbas: `fm` (`ratio` 3–7, short `env`); strings: `wave` `saw`, `smooth`, `unison` 3, `ensemble`, `body` `strings`; brass: `body` `brass` with a `filterEnv`; plucks and guitars: `string` (rock: `drive` and `amp` `guitar`); choirs: `wave` `saw` with `body` `ah` or `oo`; real instruments: `sample`.
- Give each track 2–4 blocks and each section its own mix (`section.tracks`, `block.sections`): the variety comes from the choices.
- Keep bass and chords simple and repetitive; put the tune in one theme block and quote it with `from` and `forms`.
- Calm sections thin out (fewer tracks, soft drums), action sections fill up; `next` links lead from calm to action and back.
- Every mood names sections; every stinger part names a track and fits its `beats`.
- `validateSong` reports no errors, ideally no warnings.
