# Changelog

## 0.1.0

The first release: the engine, the web player and the song format.

- Bundlers (Vite, webpack) get one worklet file, `dist/worklet.js`, with the engine inlined; `init({ worklet })` points elsewhere.
- `validateSong(song)` lists what the engine would skip or change in a song; the player warns in the console. `SONG_FORMAT.md` is the whole format, `dist/song.schema.json` its JSON Schema.
- A song and the recordings it plays in one zip (`songZip`, `loadUrl('song.zip')`).
- TypeScript types; a mood or stinger the song doesn't have warns in the console; a mood set before `init` applies.
