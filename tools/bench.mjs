// CPU benchmark: node tools/bench.mjs [song.json ...] [--sr 48000] [--secs 60] [--warm 30] [--block 128] [--breakdown]
// Runs the engine as the audio thread would (fixed-size blocks) in a calm and a busy mood and reports the share of
// one CPU core it needs, the slowest blocks against their deadline, how many voices sound and the load time.
// The first --warm seconds are measured apart: while the JIT compiles the first section changes, blocks are slower
// ("cold"); an ahead-of-time build (Unity IL2CPP) doesn't have that. Run it on the machine you care about.
import { readFileSync, readdirSync } from 'node:fs';
import { Engine } from '../src/engine/engine.js';
import { diskSamples } from './load-samples.mjs';

const SAMPLES = await diskSamples();

const args = process.argv.slice(2);
const opt = { sr: 48000, secs: 60, warm: 30, block: 128, breakdown: false };
const files = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--breakdown') opt.breakdown = true;
  else if (a.startsWith('--')) opt[a.slice(2)] = +args[++i];
  else files.push(a);
}
if (!files.length) for (const f of readdirSync('songs').sort()) if (f.endsWith('.json')) files.push(`songs/${f}`);

const { sr, secs, warm, block } = opt;
const budget = (block / sr) * 1000; // ms the audio callback may take per block
const MOODS = ['relaxed', 'action']; // calm and busy; songs without these moods walk on their own

// patch(engine) switches parts off for the breakdown
function run(song, mood, patch) {
  const t0 = performance.now();
  const e = new Engine(sr, song, 7);
  e.setSamples(SAMPLES);
  const load = performance.now() - t0;
  if (song.moods?.[mood]) e.setMood(mood, { within: 0 });
  patch?.(e);
  const L = new Float32Array(block), R = new Float32Array(block);
  let cold = 0; // slowest block while the code is still being compiled
  for (let i = 0, w = Math.round((warm * sr) / block); i < w; i++) {
    const a = performance.now();
    e.process(L, R, block);
    cold = Math.max(cold, performance.now() - a);
    e.drainEvents();
  }
  const n = Math.round((secs * sr) / block), times = new Float64Array(n);
  let voiceSum = 0, voiceMax = 0, samples = 0;
  const t1 = performance.now();
  for (let i = 0; i < n; i++) {
    const a = performance.now();
    e.process(L, R, block);
    times[i] = performance.now() - a;
    e.drainEvents();
    if ((i & 63) === 0) {
      let v = 0;
      for (const b of e.synth.list) for (const x of b.voices) if (b.isDrum ? x.active : x.stage !== 0) v++;
      voiceSum += v; voiceMax = Math.max(voiceMax, v); samples++;
    }
  }
  const total = performance.now() - t1;
  times.sort();
  return {
    load, cold, cpu: (total / (secs * 1000)) * 100, rt: (secs * 1000) / total,
    p99: times[Math.floor(n * 0.99)], max: times[n - 1], voices: voiceSum / samples, voiceMax,
  };
}

const f = (x, d = 1) => x.toFixed(d);
const pad = (s, w) => String(s).padStart(w);
console.log(`${warm} s warm-up + ${secs} s measured per run · blocks of ${block} samples at ${sr} Hz · deadline ${f(budget, 2)} ms per block\n`);
console.log('song                mood       CPU (1 core)  realtime   p99 block   worst block   worst (cold)   voices avg/max   load');
let worst = 0, worstCold = 0;
for (const file of files) {
  const song = JSON.parse(readFileSync(file, 'utf8'));
  const name = file.split('/').pop().replace(/\.json$/, '');
  for (const mood of MOODS) {
    const r = run(song, mood);
    worst = Math.max(worst, r.max); worstCold = Math.max(worstCold, r.cold);
    console.log(`${name.padEnd(19)} ${mood.padEnd(9)} ${pad(f(r.cpu, 2), 7)} %     ${pad(f(r.rt, 0), 4)}×    ${f(r.p99, 3)} ms    ${f(r.max, 3)} ms     ${f(r.cold, 3)} ms       ${pad(f(r.voices, 1), 5)} / ${pad(r.voiceMax, 2)}     ${f(r.load, 0)} ms`);
  }
}
const share = (x) => `${f((x / budget) * 100, 0)} % of its deadline${x > budget ? ' (late: only safe if the audio buffer is larger than one block)' : ''}`;
console.log(`\nworst block after warm-up used ${share(worst)}; during warm-up ${share(worstCold)}`);

// what the time is spent on: switch one part off at a time and see how much it saves
if (opt.breakdown) {
  const file = files.at(-1), song = JSON.parse(readFileSync(file, 'utf8'));
  const base = run(song, 'action');
  const noBus = run(song, 'action', (e) => { for (const b of e.synth.list) b.render = () => 0; });
  const noRev = run(song, 'action', (e) => { e.synth.reverb.process = function () { this.outL = this.outR = 0; }; });
  const noEcho = run(song, 'action', (e) => { e.synth.echo.process = function () { this.outL = this.outR = 0; }; });
  const voices = base.cpu - noBus.cpu, rev = base.cpu - noRev.cpu, echo = base.cpu - noEcho.cpu;
  console.log(`\nbreakdown (${file}, action), % of one core:`);
  console.log(`  voices + filters  ${pad(f(voices, 2), 6)}   (${f(voices / Math.max(1, base.voices), 2)} per sounding voice)`);
  console.log(`  reverb            ${pad(f(rev, 2), 6)}`);
  console.log(`  echo              ${pad(f(echo, 2), 6)}`);
  console.log(`  conductor + mix   ${pad(f(base.cpu - voices - rev - echo, 2), 6)}`);
  console.log(`  total             ${pad(f(base.cpu, 2), 6)}   (parts measured in separate runs, so they add up only roughly)`);
}
