// Loads the sample library (library/samples.json and its WAVs) into what Engine.setSamples takes:
// { name: [{ data: Float32Array, rate, root, loopStart, loopEnd }] }.
// read(path) → ArrayBuffer, for a path relative to the library folder: fetch in a browser, readFileSync in node.
import { decodeWav } from './wav.js';

export async function loadSamples(read) {
  const index = JSON.parse(new TextDecoder().decode(await read('samples.json')));
  const out = {};
  await Promise.all(Object.entries(index.samples).map(async ([name, zones]) => {
    out[name] = await Promise.all(zones.map(async (z) => {
      const { data, rate } = decodeWav(await read(z.file));
      return { data, rate, root: z.root ?? 60, loopStart: z.loop?.[0] ?? 0, loopEnd: z.loop?.[1] ?? 0 };
    }));
  }));
  return out;
}

// in a browser: the library next to this file's folder (../library/), or at libraryUrl
export const fetchSamples = (libraryUrl = new URL('../library/', import.meta.url)) =>
  loadSamples(async (path) => (await fetch(new URL(path, libraryUrl))).arrayBuffer());
