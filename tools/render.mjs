// Offline render: node tools/render.mjs [song.json] [seconds] [seed] [out.wav] [--mood t:name ...]
// Renders the engine without a browser (useful for tests, and to bake loops for other engines).
import { readFileSync, writeFileSync } from 'node:fs';
import { Engine } from '../src/engine/engine.js';
import { encodeWav } from '../src/wav.js';

const args = process.argv.slice(2);
const moods = [];
const pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--mood') { const [t, m] = args[++i].split(':'); moods.push({ t: +t, m }); }
  else pos.push(args[i]);
}
const [songPath = 'songs/deep-space.json', secs = '120', seed = '1', out = ''] = pos;

const SR = 44100;
const song = JSON.parse(readFileSync(songPath, 'utf8'));
const engine = new Engine(SR, song, +seed);
const n = Math.round(+secs * SR);
const L = new Float32Array(n), R = new Float32Array(n);
const BLOCK = 128;
const t0 = performance.now();
let peak = 0, sumSq = 0, nan = 0;
const log = [];
moods.sort((a, b) => a.t - b.t);
for (let i = 0; i < n; i += BLOCK) {
  while (moods.length && moods[0].t * SR <= i) engine.setMood(moods.shift().m);
  const len = Math.min(BLOCK, n - i);
  engine.process(L.subarray(i, i + len), R.subarray(i, i + len), len);
  for (const e of engine.drainEvents()) if (e.type === 'log') log.push(`${(i / SR).toFixed(1).padStart(6)}s  ${e.text}`);
}
const ms = performance.now() - t0;
for (let i = 0; i < n; i++) {
  const a = L[i], b = R[i];
  if (!Number.isFinite(a) || !Number.isFinite(b)) nan++;
  peak = Math.max(peak, Math.abs(a), Math.abs(b));
  sumSq += a * a + b * b;
}
console.log(log.join('\n'));
console.log(`\nrendered ${secs}s in ${ms.toFixed(0)}ms (${((+secs * 1000) / ms).toFixed(1)}x realtime)`);
console.log(`peak ${peak.toFixed(3)}  rms ${Math.sqrt(sumSq / (2 * n)).toFixed(3)}  nan ${nan}`);

if (out) {
  writeFileSync(out, Buffer.from(encodeWav(L, R, SR)));
  console.log(`wrote ${out}`);
}
