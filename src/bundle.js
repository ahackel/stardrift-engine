// A song and everything it plays, in one zip, for a game: song.json, the recordings it uses (library/: samples.json with
// only those, their WAVs, the recordings' license) and a README. The player loads the zip as it is
// (music.loadUrl('music/song.zip')); unzipped, the folder works too (init({ library: '…/library/' }), loadUrl('…/song.json')).
//   songZip(song, read?) → Uint8Array    read(path) → ArrayBuffer, a path in the sample library (default: the engine's, fetched)
//   openSongZip(buffer) → { song, read } read: the zip's recordings, for loadSamples (or the player's load)
import { zip, unzip } from './zip.js';
import { songSamples, LIBRARY_URL } from './samples.js';

const fetchLibrary = async (path) => {
  const res = await fetch(new URL(path, LIBRARY_URL));
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.arrayBuffer();
};

export async function songZip(song, read = fetchLibrary) {
  const text = (b) => new TextDecoder().decode(b);
  const index = JSON.parse(text(await read('samples.json'))), names = songSamples(song);
  const missing = names.filter((n) => !index.samples[n]);
  if (missing.length) throw new Error(`not in the sample library: ${missing.join(', ')}`);
  const samples = Object.fromEntries(names.map((n) => [n, index.samples[n]]));
  const files = [...new Set(Object.values(samples).flat().map((z) => z.file))];
  const license = names.length ? await read('LICENSE').then(text, () => index.license) : '';
  const title = song.name || 'song', file = title.toLowerCase().replace(/\W+/g, '-') || 'song';
  return zip([
    { name: 'song.json', data: JSON.stringify(song, null, 2) },
    { name: 'README.txt', data: readme(song, title, file, names) },
    ...(names.length ? [
      { name: 'library/samples.json', data: JSON.stringify({ ...index, samples }, null, 2) },
      { name: 'library/LICENSE', data: license },
      ...(await Promise.all(files.map(async (f) => ({ name: `library/${f}`, data: new Uint8Array(await read(f)) })))),
    ] : []),
  ]);
}

export async function openSongZip(buffer) {
  const z = unzip(buffer);
  if (!z.has('song.json')) throw new Error('no song.json in the zip');
  const song = JSON.parse(new TextDecoder().decode(await z.read('song.json')));
  const read = async (path) => { const b = await z.read(`library/${path}`); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  return { song, read };
}

const readme = (song, title, file, names) => {
  const moods = Object.keys(song.moods || {}), stingers = (song.stingers || []).map((x) => x.id);
  return `${title}: a song for the Stardrift engine (https://github.com/ahackel/stardrift-engine)${names.length ? `,
with the recordings it plays (${names.join(', ')})` : ''}.

In a web game, the zip as it is:

  import { StardriftPlayer } from 'stardrift-engine';
  const music = new StardriftPlayer();
  await music.init();                        // after a click or a key (browsers start audio only then)
  await music.loadUrl('music/${file}.zip');
  music.play();
${moods.length ? `  music.setMood('${moods[0]}');${' '.repeat(Math.max(1, 25 - moods[0].length))}// its moods: ${moods.join(', ')}\n` : ''}${stingers.length ? `  music.sting('${stingers[0]}');${' '.repeat(Math.max(1, 27 - stingers[0].length))}// its stingers: ${stingers.join(', ')}\n` : ''}
Unzipped into music/${file}/, the folder works too:

  await music.init({ library: 'music/${file}/library/' });
  await music.loadUrl('music/${file}/song.json');
${names.length ? `
The recordings (library/) are CC0 (public domain): see library/LICENSE.
` : ''}`;
};
