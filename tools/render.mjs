// Offline render: node tools/render.mjs [song.json] [seconds] [seed] [out.wav] [--mood t:name ...]
// Renders the engine without a browser (useful for tests, and to bake loops for other engines).
import { readFileSync, writeFileSync } from 'node:fs';
import { Engine } from '../src/engine/engine.js';

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
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 46 + i * 4);
  }
  writeFileSync(out, buf);
  console.log(`wrote ${out}`);
}
