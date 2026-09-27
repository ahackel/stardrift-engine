// node: the sample library from disk (for tools/render.mjs, bench.mjs and test.mjs)
import { readFileSync } from 'node:fs';
import { loadSamples } from '../src/samples.js';

export const diskSamples = () => loadSamples(async (path) => {
  const b = readFileSync(new URL(`../library/${path}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
});
