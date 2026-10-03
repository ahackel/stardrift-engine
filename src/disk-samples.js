// node only: the sample library from disk, for offline rendering and tests (import 'stardrift-engine/disk-samples.js')
import { readFileSync } from 'node:fs';
import { loadSamples, LIBRARY_URL } from './samples.js';

export const diskSamples = () => loadSamples(async (path) => {
  const b = readFileSync(new URL(path, LIBRARY_URL));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
});
