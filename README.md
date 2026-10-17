# Stardrift engine

A procedural music engine for games. The music is endless, varies itself and follows the game's mood with smooth transitions. Listen: `demo/stardrift-demo.mp3` (2:40, auto → *tension* → *action* → *relaxed*).

- **JavaScript**, for web games: no dependencies, TypeScript types included.
- **Editor**: songs are written in the [Stardrift editor](https://github.com/ahackel/stardrift), or by an AI from [SONG_FORMAT.md](SONG_FORMAT.md).
- **Unity**: plain per-sample code, written to be ported 1:1 to C# (see *Porting to Unity*).

```bash
npm run dev        # a static server at http://localhost:8322 (AudioWorklet needs http://, not file://)
npm run build      # dist/: the worklet with the engine inlined, and the song format's JSON Schema
npm run render     # offline render + conductor log: node tools/render.mjs song secs seed out.wav --mood 30:tension --sting 45:discovery
npm test
npm run bench      # CPU per song and mood: node tools/bench.mjs [songs] --sr 22050 --breakdown
```

## In a game

```bash
npm install stardrift-engine
```

```js
import { StardriftPlayer } from 'stardrift-engine';

const music = new StardriftPlayer();
button.onclick = async () => {               // browsers start audio only from a click or a key
  await music.init();
  await music.loadUrl('music/song.zip');     // the editor's Export for a game (or a song's .json)
  music.play();
};
music.setMood('tension');
music.sting('alert');
```

Without a bundler, an import map points the name at the package (the worklet and the sample library are found next to it):

```html
<script type="importmap">{ "imports": { "stardrift-engine": "./node_modules/stardrift-engine/src/index.js" } }</script>
```

With a bundler, load songs as zips (*A song in one zip*): the bundler copies the worklet (`dist/worklet.js`) but not the sample library, so the recordings come from the zip. Vite's dev server needs `optimizeDeps: { exclude: ['stardrift-engine'] }`; elsewhere `init({ worklet: url })` says where `dist/worklet.js` is.

Besides the player, the package exports `Engine` (for offline rendering or another audio host), `validateSong`, the sample library and zip helpers (all in `src/index.d.ts`); single modules are there by path, e.g. `stardrift-engine/engine/theory.js`.

### The example game

[Lop Hop](https://github.com/ahackel/lop-hop) ([play it](https://andreashackel.de/lop-hop/)), a small endless runner, uses every mood and stinger the way a game would and shows its calls to the music as it makes them.

**Why not something existing?** Adaptive-music middleware (FMOD, Wwise, Unreal's Harmonix) re-sequences and layers music written out in full, recorded or MIDI; trackers and BeepBox play linear songs; Reactional generates, but is closed and commercial. Stardrift generates the notes: parts written relative to the chord, picked, varied and steered by mood as it plays, as Microsoft's DirectMusic Styles once did, open and for the web.

## How it works

```
 game ── setMood('tension') ──►  CONDUCTOR (every bar)                SEQUENCER (every 16th)     SYNTH (every sample)
                                  • section graph walk  ──► blocks ──►  • pattern steps     ──►   voices, effects
                                  • progression pick                    • chord resolution        filter, drums
                                  • tracks on/off (chance)              • holds, follow chords    echo + reverb → out
                                  • block pick, fills, mutations
```

- **Blocks** (clips in the editor) are short patterns. Notes are relative to the chord or the key, so every block fits every progression.
- **Sections** are linked by weighted `next` links: a graph the conductor walks. A mood leads it, the shortest way along the links, to the mood's sections.
- **What plays in a section** is weights: how likely each track plays there, how often each block and progression is picked.
- **Themes**: one melody, quoted by blocks on several tracks in varied forms, gives the endless music a tune you remember.
- **Variation over time**: blocks mutate when they loop, tracks come and go, fills and drops mark transitions, and now and then the music thins to a breather. The same seed gives the same music.
- **Stingers** react to game events: a short phrase from the next beat that borrows tracks and ducks the rest.

## Game API

```js
await music.init({ library, worklet });     // from a click or a key; both optional (where library/ and dist/worklet.js are)
await music.loadUrl(url);                   // a song's .zip or .json; music.loadZip(arrayBuffer), music.load(song)
music.load(song, { restart: true, seed });  // switch songs (seed: the same seed, the same music)
music.play();
await music.pause(2);                       // fade out over 2 s, then stop; play() goes on from there
music.setVolume(0.5, 1);                    // 0–1, over 1 s
music.dispose();                            // close the audio; init() builds it again

music.setMood('relaxed');                   // one of the song's moods; 'auto' walks on its own again
music.setMood('danger', { within: 0 });     // start moving at the next bar line (default: within 2 bars)
music.sting('alert');                       // a stinger, from the next beat
music.sting('jump', { at: 'step' });        // … or 'step', 'half', 'bar'
```

A mood change never cuts: the section ends at a bar line with a fill (going up) or a drop (going down), and the conductor takes the shortest way along the links to the mood's sections, with shortened bridge sections the first time. All songs share the mood names (`relaxed wonder exploring tension danger action`) and stinger names (`discovery alert jump reward`), so a game can switch songs without changing its calls. A mood or stinger the song doesn't have does nothing and says so in the console; a mood set before `init` applies once there is audio.

**Events**: `music.on(type, fn)` (returns a function that unsubscribes; `'*'` gets every event):

| Type | When, and what it carries |
|---|---|
| `state` | a section starts, the mood or a lock changes: `section`, `next`, `prog`, `chords`, `scale`, `mood`, `heading` (the section the mood leads to), `energy` 0–1, `tracks` `{ id: { active, block } }` |
| `step` | every step (16th): `step`, `bar` and `bars` of the section, `pos` |
| `chord` | a new chord: `label` (`Am7`), `degree`, `scale`, `shape` |
| `note` | a track plays a note: `track`, `midi` |
| `sting` | a stinger starts (`on: true`) and ends: `id` |
| `log` | the conductor's decisions, as text |
| `transport` | playing or not: `playing` |
| `error` | `text`: the audio device would not start, the sample library didn't load, the audio thread failed |

Events arrive a few milliseconds late and before the sound leaves the speakers (the output latency): right for visuals and game logic, not for sample-exact timing.

Also there, for tools such as the editor: `preview`, `keyOn` / `keyOff`, `audition`, `stopPreview`, `lockBlock`, `lockProgression`, `lockSection`, `forceSection`, `seek`, `forceProgression`, `playChord`, `setMute`, `setSolo`, `setMeters` (`levels` events), `requestState`, `restart`.

The player loads the sample library (`library/`) in the background, only the recordings the song plays (and the sounds the editor previews); `init({ library: url })` points it elsewhere, other hosts call `engine.setSamples()` (`songSamples(song)` names what a song needs).

### A song in one zip

The editor's **Export for a game** writes a song and everything it plays into one `.zip` (`songZip(song)`): `song.json`, the recordings it uses (`library/`: `samples.json` with only those, their WAVs, their license) and a README with the song's moods and stingers. A game drops it in and loads it as it is, the recordings come from the zip:

```js
await music.loadUrl('music/iron-comet.zip');   // or music.loadZip(arrayBuffer)
```

Unzipped, the folder works too: `init({ library: 'music/iron-comet/library/' })`, `loadUrl('music/iron-comet/song.json')`. Other hosts: `openSongZip(buffer)` gives `{ song, read }`, `loadSamples(read, songSamples(song))` the recordings.

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
| `src/index.js`, `src/index.d.ts` | what the package exports, and its types; `samples.js`, `disk-samples.js`, `wav.js`, `phrase.js` |
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
