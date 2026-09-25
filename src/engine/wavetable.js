// Band-limited wavetables: alias-free oscillators for the triangle and wave voices.
//
// A waveform is described by its harmonics. For every octave of pitch there is a table that holds only the
// harmonics that fit below Nyquist ("mipmaps"); the voice reads the table for its pitch with linear interpolation.
// Stepped 4-bit waves keep their staircase (that grit is the chip sound), just without the aliasing.
// Plain math and arrays only, so it ports 1:1 to C#.

const TWO_PI = Math.PI * 2;
export const TABLE_SIZE = 2048;
const LEVELS = 10; // level j holds up to 512 >> j harmonics
const MAX_HARM = 512;

// in-place radix-2 FFT (inverse when inv), re/im of length n (power of two)
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? TWO_PI : -TWO_PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

// Harmonics (complex: re = cosine part, im = sine part, k = 1..MAX_HARM) of a 32-step staircase:
// each step holds its value for 1/32 of the period (zero-order hold).
export function stairHarmonics(steps) {
  const n = steps.length, re = new Float64Array(MAX_HARM + 1), im = new Float64Array(MAX_HARM + 1);
  for (let k = 1; k <= MAX_HARM; k++) {
    let sr = 0, si = 0;
    for (let i = 0; i < n; i++) {
      // ∫ v e^{-i2πkt} dt over [i/n, (i+1)/n] = v (e^{-i2πk i/n} − e^{-i2πk(i+1)/n}) / (i2πk)
      const a0 = (-TWO_PI * k * i) / n, a1 = (-TWO_PI * k * (i + 1)) / n;
      const dr = Math.cos(a0) - Math.cos(a1), di = Math.sin(a0) - Math.sin(a1);
      // divide (dr + i di) by (i 2πk): (di − i dr) / 2πk
      sr += steps[i] * di; si -= steps[i] * dr;
    }
    // c_k = (sr + i si) / 2πk; as a real series: 2 Re(c_k) cos + (−2 Im(c_k)) sin
    re[k] = (2 * sr) / (TWO_PI * k); im[k] = (-2 * si) / (TWO_PI * k);
  }
  return { re, im };
}

// Harmonics of a smooth periodic function given as samples (trigonometric interpolation, no staircase)
export function sampledHarmonics(values) {
  const n = values.length, re = new Float64Array(MAX_HARM + 1), im = new Float64Array(MAX_HARM + 1);
  for (let k = 1; k < n / 2; k++) {
    let a = 0, b = 0;
    for (let i = 0; i < n; i++) { a += values[i] * Math.cos((TWO_PI * k * i) / n); b += values[i] * Math.sin((TWO_PI * k * i) / n); }
    re[k] = (2 * a) / n; im[k] = (2 * b) / n;
  }
  return { re, im };
}

// harmonics from formulas: cos(k) and sin(k) give the amplitude of harmonic k (e.g. a saw: sin = 2 / πk)
export function formulaHarmonics(cos, sin) {
  const re = new Float64Array(MAX_HARM + 1), im = new Float64Array(MAX_HARM + 1);
  for (let k = 1; k <= MAX_HARM; k++) { re[k] = cos ? cos(k) : 0; im[k] = sin ? sin(k) : 0; }
  return { re, im };
}

// One table per level; level j keeps harmonics 1..(MAX_HARM >> j). With `peak`, scaled so the fullest table peaks there.
export function buildTables({ re, im }, peak = 0) {
  const tables = [];
  let scale = 0;
  for (let j = 0; j < LEVELS; j++) {
    const K = MAX_HARM >> j, R = new Float64Array(TABLE_SIZE), I = new Float64Array(TABLE_SIZE);
    for (let k = 1; k <= K; k++) {
      // x(t) = Σ re cos + im sin  ⇒  X[k] = (re − i im)/2, X[N−k] = conj
      R[k] = re[k] / 2; I[k] = -im[k] / 2;
      R[TABLE_SIZE - k] = re[k] / 2; I[TABLE_SIZE - k] = im[k] / 2;
    }
    fft(R, I, true);
    const t = new Float32Array(TABLE_SIZE + 1); // +1 guard sample for interpolation
    for (let i = 0; i < TABLE_SIZE; i++) t[i] = R[i];
    t[TABLE_SIZE] = t[0];
    if (j === 0) { for (let i = 0; i < TABLE_SIZE; i++) scale = Math.max(scale, Math.abs(t[i])); scale = peak && scale > 0 ? peak / scale : 1; }
    for (let i = 0; i <= TABLE_SIZE; i++) t[i] *= scale;
    tables.push(t);
  }
  return tables;
}

// the highest fundamental each level may play without aliasing (harmonics up to 0.45 × sample rate)
export function levelLimits(sr) {
  return Array.from({ length: LEVELS }, (_, j) => (0.45 * sr) / (MAX_HARM >> j));
}

const cache = new Map();
// tables for a key, built once (song edits recompile instruments often; the tables rarely change)
export function cachedTables(key, make) {
  let t = cache.get(key);
  if (!t) {
    if (cache.size > 64) cache.clear();
    cache.set(key, (t = make()));
  }
  return t;
}
