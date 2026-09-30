// Small building blocks the voices, the drum kits and the track buses share (plain per-sample code, like the rest).

export const TWO_PI = Math.PI * 2;

// the NES triangle: 32 steps of 4 bits, as -1..1
export const TRI4 = new Float32Array(32);
for (let i = 0; i < 32; i++) TRI4[i] = (i < 16 ? 15 - i : i - 16) / 7.5 - 1;

// polyBLEP: smooths a square's jumps so its harmonics above Nyquist don't fold back as digital hash
export function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

// A state-variable filter (trapezoidal, after Cytomic). svfSet puts the coefficients for cutoff f and damping k (1/Q)
// in c; svf runs one sample with the state in st (ic1, ic2) and returns c.mode's output: low pass, band pass or high pass
export const LP = 0, BP = 1, HP = 2;
export function svfSet(c, f, k, sr) {
  const g = Math.tan((Math.PI * Math.min(f, sr * 0.45)) / sr);
  c.k = k; c.a1 = 1 / (1 + g * (g + k)); c.a2 = g * c.a1; c.a3 = g * c.a2;
  return c;
}
export function svf(c, st, x) {
  const v3 = x - st.ic2, v1 = c.a1 * st.ic1 + c.a2 * v3, v2 = st.ic2 + c.a2 * st.ic1 + c.a3 * v3;
  st.ic1 = 2 * v1 - st.ic1; st.ic2 = 2 * v2 - st.ic2;
  return c.mode === LP ? v2 : c.mode === BP ? c.k * v1 : x - c.k * v1 - v2;
}
