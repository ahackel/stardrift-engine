// Builds the sample library (library/samples/*.wav + library/samples.json) from downloaded CC0 source recordings.
// node tools/samples.mjs <folder with the source WAVs>   (needs ffmpeg for the format conversion)
// Sustained notes are trimmed, looped with a baked crossfade (so a note can be held for ever) and levelled by the
// loudness of their loop; hits are trimmed, faded out and levelled by their peak. Everything is mono 16-bit.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { encodeWav } from '../src/wav.js';

const VSCO = 'https://github.com/sgossner/VSCO-2-CE', VCSL = 'https://github.com/sgossner/VCSL';
// name → zones: [source file, source path, root (midi: the median pitch over the loop, by autocorrelation)];
// hits: { secs } instead of a root
const SOURCES = {
  cello: { from: VSCO, what: 'Cello Section, sustain with vibrato (v1)', rate: 32000, zones: [
    ['cello_C1.wav', 'Strings/Cello Section/susvib/susvib_C1_v1_1.wav', 36.01], ['cello_G1.wav', 'Strings/Cello Section/susvib/susvib_G1_v1_1.wav', 42.98],
    ['cello_D2.wav', 'Strings/Cello Section/susvib/susvib_D2_v1_1.wav', 49.99], ['cello_A2.wav', 'Strings/Cello Section/susvib/susvib_A2_v1_1.wav', 56.94],
    ['cello_E3.wav', 'Strings/Cello Section/susvib/susvib_E3_v1_1.wav', 64.01]] },
  trombone: { from: VSCO, what: 'Tenor Trombone, sustain (v2)', rate: 32000, zones: [
    ['trombone_As1.wav', 'Brass/Tenor Trombone/sus/tenortbn_sus_A#1_v2_1.wav', 45.97], ['trombone_D2.wav', 'Brass/Tenor Trombone/sus/tenortbn_sus_D2_v2_1.wav', 49.99],
    ['trombone_F2.wav', 'Brass/Tenor Trombone/sus/tenortbn_sus_F2_v2_1.wav', 53.02], ['trombone_Cs3.wav', 'Brass/Tenor Trombone/sus/tenortbn_sus_C#3_v2_1.wav', 61.07],
    ['trombone_F3.wav', 'Brass/Tenor Trombone/sus/tenortbn_sus_F3_v2_1.wav', 64.93]] },
  hat_closed: { from: VCSL, what: 'Hi-hat, closed', rate: 44100, secs: 0.45, zones: [['hat_closed.wav', 'Idiophones/Struck Idiophones/Hi-Hat Cymbal/HiHat_HitC_v3_rr1_Mid.wav']] },
  hat_open: { from: VCSL, what: 'Hi-hat, open', rate: 44100, secs: 2, zones: [['hat_open.wav', 'Idiophones/Struck Idiophones/Hi-Hat Cymbal/HiHat_HitO_rr1_Mid.wav']] },
  crash: { from: VCSL, what: 'Suspended cymbal hit with a stick (a crash)', rate: 44100, secs: 4, zones: [['crash_stick.wav', 'Idiophones/Struck Idiophones/Suspended Cymbal 1/susCymb1_hit_stick_f1.wav']] },
  clash: { from: VCSL, what: 'Clash cymbals (orchestral)', rate: 44100, secs: 3.5, zones: [['clash.wav', 'Idiophones/Struck Idiophones/Clash Cymbals 1/cymbal_crash1_mf1.wav']] },
  cymbal_swell: { from: VCSL, what: 'Suspended cymbal crescendo (2 s)', rate: 44100, secs: 3.5, zones: [['sus_swell.wav', 'Idiophones/Struck Idiophones/Suspended Cymbal 1/susCymb1_cresc_2s.wav']] },
};
const SUSTAIN = { secs: 4.6, loop: [1.8, 4.4], fade: 0.2, rms: -16 }; // loop region and crossfade in seconds, loudness in dBFS

function load(file, rate) {
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4).slice();
}
function onset(x) {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  let i = 0;
  while (i < x.length && Math.abs(x[i]) < peak * 0.01) i++;
  return Math.max(0, i - 64);
}
const rising = (x, i) => { while (i < x.length - 1 && !(x[i] <= 0 && x[i + 1] > 0)) i++; return i; };

function sustained(x, rate) {
  x = x.subarray(onset(x));
  const s = rising(x, Math.round(SUSTAIN.loop[0] * rate)), e = rising(x, Math.round(SUSTAIN.loop[1] * rate)), X = Math.round(SUSTAIN.fade * rate);
  const out = x.slice(0, e);
  // the end of the loop fades into what comes just before its start, so the jump back is seamless (equal power)
  for (let i = 0; i < X; i++) {
    const t = (i / X) * (Math.PI / 2);
    out[e - X + i] = x[e - X + i] * Math.cos(t) + x[s - X + i] * Math.sin(t);
  }
  let sum = 0;
  for (let i = s; i < e; i++) sum += out[i] * out[i];
  const g = Math.pow(10, SUSTAIN.rms / 20) / Math.sqrt(sum / (e - s));
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v * g));
  const k = peak > 0.98 ? (g * 0.98) / peak : g;
  for (let i = 0; i < out.length; i++) out[i] *= k;
  return { data: out, loop: [s, e] };
}
function hit(x, rate, secs) {
  x = x.subarray(onset(x));
  const n = Math.min(x.length, Math.round(secs * rate)), out = x.slice(0, n), F = Math.round(0.4 * rate);
  for (let i = 0; i < F && i < n; i++) out[n - 1 - i] *= i / F; // fade out
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < n; i++) out[i] *= 0.9 / peak;
  return { data: out };
}

const src = process.argv[2];
if (!src) { console.error('usage: node tools/samples.mjs <folder with the source WAVs>'); process.exit(1); }
const lib = new URL('../library/', import.meta.url);
mkdirSync(new URL('samples/', lib), { recursive: true });
const json = {
  about: 'Recorded sounds for the sample sound type and drum kits. Each entry is a list of zones: a mono 16-bit WAV, its root (midi, measured) and, for sustained notes, a loop [start, end] in samples. Built by tools/samples.mjs.',
  license: 'CC0 1.0 (public domain) recordings by Versilian Studios: VSCO 2 Community Edition and the Versilian Community Sample Library (VCSL).',
  samples: {},
};
for (const [name, s] of Object.entries(SOURCES)) {
  json.samples[name] = s.zones.map(([file, path, root], i) => {
    const x = load(`${src}/${file}`, s.rate), r = root === undefined ? hit(x, s.rate, s.secs) : sustained(x, s.rate);
    const out = `samples/${name}${s.zones.length > 1 ? `-${Math.round(root)}` : ''}.wav`;
    writeFileSync(new URL(out, lib), Buffer.from(encodeWav(r.data, null, s.rate)));
    console.log(`${out.padEnd(28)} ${(r.data.length / s.rate).toFixed(2)} s  ${Math.round((r.data.length * 2) / 1024)} KB`);
    return { file: out, ...(root !== undefined ? { root, loop: r.loop } : {}), source: `${s.from}/blob/master/${path}` };
  });
}
writeFileSync(new URL('samples.json', lib), JSON.stringify(json, null, 2) + '\n');
