// Loads the sample library (library/samples.json and its WAVs) into what Engine.setSamples takes:
// { name: [{ data: Float32Array, rate, root, loopStart, loopEnd }] }.
// read(path) → ArrayBuffer, for a path relative to the library folder: fetch in a browser, readFileSync in node.
// names: only these (what a song uses: songSamples), or all of them.
import { decodeWav } from './wav.js';
import { KITS, kitParts } from './engine/drums.js';

export async function loadSamples(read, names) {
  const index = JSON.parse(new TextDecoder().decode(await read('samples.json')));
  const out = {};
  await Promise.all(Object.entries(index.samples).filter(([name]) => !names || names.includes(name)).map(async ([name, zones]) => {
    out[name] = await Promise.all(zones.map(async (z) => {
      const { data, rate } = decodeWav(await read(z.file));
      return { data, rate, root: z.root ?? 60, loopStart: z.loop?.[0] ?? 0, loopEnd: z.loop?.[1] ?? 0 };
    }));
  }));
  return out;
}

// the sample library that ships with the engine (library/, next to src/): file:// in node, http(s):// in a browser
export const LIBRARY_URL = new URL(/* @vite-ignore */ '../library/', import.meta.url);

// in a browser: the library that ships with the engine, or at libraryUrl (relative to the page)
export function fetchSamples(libraryUrl = LIBRARY_URL, names) {
  const base = new URL(libraryUrl, globalThis.location?.href);
  return loadSamples(async (path) => {
    const res = await fetch(new URL(path, base));
    if (!res.ok) throw new Error(`${res.url}: ${res.status} ${res.statusText}`);
    return res.arrayBuffer();
  }, names);
}

// the recordings a sound plays: its own (a sample sound), its kit's (drums: the preset's hits and the ones it changes)
export function soundSamples(def) {
  if (def?.type === 'sample') return def.sample ? [def.sample] : [];
  if (def?.type !== 'drums') return [];
  const { preset, over } = kitParts(def), kit = KITS[preset] || KITS.clean;
  return [...new Set(Object.keys({ ...kit, ...over }).map((k) => ({ ...kit[k], ...over[k] }).sample).filter(Boolean))];
}
// … and all of a song's
export const songSamples = (song) => [...new Set(Object.values(song?.instruments || {}).flatMap(soundSamples))];
