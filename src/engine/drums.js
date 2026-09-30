// Synthesized drum kits. Each hit is a sum of components:
//   tones  – up to 2 oscillators with an exponential pitch drop (drum bodies)
//   noise  – white or LFSR noise through a state-variable filter (snare wires, hats, wash)
//   metal  – six detuned squares at TR-808 ratios through a filter (hats, cymbals, ticks), band-limited
//   click  – a very short noise transient (beater attack)
//   sample – a recording from the sample library (cymbals); when it is loaded the hit plays only the recording,
//            without it the hit falls back to its synthesized parts
//   drive  – soft saturation for punch
// All times are exponential time constants in seconds, frequencies in Hz.
// Simple per-hit knobs on top of that (all multipliers, default 1): pitch, decay, level.

import { TWO_PI, TRI4, blep, svfSet, svf, LP, BP, HP } from './dsp.js';

const METAL_HZ = [205.3, 304.4, 369.6, 522.7, 540, 800];

export const KITS = {
  // Default: clean analog-style kit that sits well under chip melodies.
  clean: {
    k: { tones: [{ amp: 0.8, f0: 150, f1: 47, sweep: 0.03, decay: 0.15 }], noise: { amp: 0.06, decay: 0.01, filter: 'lp', freq: 3000 }, click: 0.3, drive: 1.8, len: 0.8 },
    s: {
      tones: [{ amp: 0.42, f0: 215, f1: 185, sweep: 0.012, decay: 0.05 }, { amp: 0.22, f0: 340, f1: 330, sweep: 0.01, decay: 0.035 }],
      noise: { amp: 0.8, decay: 0.1, filter: 'bp', freq: 2600, q: 0.4 },
      click: 0.12, drive: 1.3, len: 0.6,
    },
    h: { metal: { amp: 0.7, decay: 0.03, filter: 'hp', freq: 7500 }, noise: { amp: 0.3, decay: 0.022, filter: 'hp', freq: 9000 }, len: 0.3 },
    o: { metal: { amp: 0.6, decay: 0.2, filter: 'hp', freq: 7000 }, noise: { amp: 0.28, decay: 0.17, filter: 'hp', freq: 8500 }, len: 1.2 },
    c: { metal: { amp: 0.3, decay: 0.9, filter: 'hp', freq: 4500 }, noise: { amp: 0.36, decay: 1.0, attack: 0.004, filter: 'hp', freq: 3500 }, len: 4 },
    t: { tones: [{ amp: 0.65, f0: 190, f1: 105, sweep: 0.07, decay: 0.14 }], noise: { amp: 0.1, decay: 0.02, filter: 'bp', freq: 1200, q: 0.8 }, click: 0.1, drive: 1.3, len: 0.8 },
    m: { metal: { amp: 0.9, decay: 0.035, filter: 'bp', freq: 3200, q: 1.5, tune: 1.6 }, len: 0.25 },
  },
  // Orchestral percussion: timpani (k low, t lower), concert snare, shaker, suspended and crash cymbals, woodblock.
  orchestra: {
    k: { tones: [{ amp: 0.85, f0: 112, f1: 100, sweep: 0.08, decay: 0.7 }, { amp: 0.3, f0: 168, f1: 152, sweep: 0.08, decay: 0.45 }], noise: { amp: 0.08, decay: 0.02, filter: 'lp', freq: 1500 }, click: 0.1, len: 2.5 },
    s: { tones: [{ amp: 0.22, f0: 240, f1: 205, sweep: 0.01, decay: 0.04 }], noise: { amp: 0.7, decay: 0.15, filter: 'bp', freq: 3600, q: 0.5 }, click: 0.08, len: 0.8 },
    h: { noise: { amp: 0.22, decay: 0.035, attack: 0.008, filter: 'bp', freq: 6500, q: 0.8 }, len: 0.2 },
    o: { sample: 'cymbal_swell', level: 0.85, metal: { amp: 6.5, decay: 0.7, filter: 'hp', freq: 5000 }, noise: { amp: 1.86, decay: 0.3, attack: 0.04, filter: 'hp', freq: 4000 }, len: 2.5 },
    c: { sample: 'clash', level: 3.8, metal: { amp: 0.64, decay: 1.4, filter: 'hp', freq: 3500 }, noise: { amp: 0.28, decay: 0.5, attack: 0.002, filter: 'hp', freq: 3000 }, len: 5 },
    t: { tones: [{ amp: 0.9, f0: 74, f1: 66, sweep: 0.1, decay: 0.8 }, { amp: 0.25, f0: 111, f1: 100, sweep: 0.1, decay: 0.5 }], noise: { amp: 0.12, decay: 0.04, filter: 'lp', freq: 900 }, len: 2.5 },
    m: { tones: [{ amp: 0.5, f0: 1250, f1: 1180, sweep: 0.004, decay: 0.03 }], click: 0.2, len: 0.15 },
  },
  // Rock kit: punchy driven kick, fat snare, bright hats, ride bell on m.
  rock: {
    k: { tones: [{ amp: 0.9, f0: 125, f1: 50, sweep: 0.025, decay: 0.18 }], noise: { amp: 0.1, decay: 0.008, filter: 'lp', freq: 5000 }, click: 0.45, drive: 2.2, len: 0.7 },
    s: {
      tones: [{ amp: 0.5, f0: 200, f1: 180, sweep: 0.015, decay: 0.07 }, { amp: 0.25, f0: 320, f1: 300, sweep: 0.01, decay: 0.05 }],
      noise: { amp: 0.95, decay: 0.16, filter: 'bp', freq: 2200, q: 0.45 }, click: 0.15, drive: 1.8, len: 0.8,
    },
    h: { sample: 'hat_closed', level: 1.16, metal: { amp: 13, decay: 0.04, filter: 'hp', freq: 7000 }, noise: { amp: 2.8, decay: 0.03, filter: 'hp', freq: 8000 }, len: 0.3 },
    o: { sample: 'hat_open', level: 0.73, metal: { amp: 6.7, decay: 0.35, filter: 'hp', freq: 6500 }, noise: { amp: 1.35, decay: 0.12, filter: 'hp', freq: 8000 }, len: 1.5 },
    c: { sample: 'crash', level: 2.67, metal: { amp: 0.63, decay: 1.3, filter: 'hp', freq: 4000 }, noise: { amp: 0.24, decay: 0.35, attack: 0.002, filter: 'hp', freq: 3000 }, len: 5 },
    t: { tones: [{ amp: 0.8, f0: 150, f1: 90, sweep: 0.06, decay: 0.22 }], noise: { amp: 0.12, decay: 0.03, filter: 'bp', freq: 1000, q: 0.8 }, click: 0.15, drive: 1.6, len: 1 },
    m: { metal: { amp: 0.6, decay: 0.5, filter: 'bp', freq: 3000, q: 1.2, tune: 1.3 }, len: 1.2 },
  },
  // The original raw NES-style kit: quantized triangle bodies + unfiltered LFSR noise.
  chip: {
    k: { tones: [{ amp: 1, f0: 170, f1: 45, sweep: 0.03, decay: 0.12, wave: 'tri4' }], noise: { amp: 0.25, decay: 0.006, source: 'lfsr', rate: 9000 }, len: 0.6 },
    s: { tones: [{ amp: 0.45, f0: 230, f1: 175, sweep: 0.02, decay: 0.05, wave: 'tri4' }], noise: { amp: 0.7, decay: 0.07, source: 'lfsr', rate: 14000 }, len: 0.5 },
    h: { noise: { amp: 0.32, decay: 0.014, source: 'lfsr', rate: 30000 }, len: 0.15 },
    o: { noise: { amp: 0.28, decay: 0.09, source: 'lfsr', rate: 30000 }, len: 0.6 },
    c: { noise: { amp: 0.3, decay: 0.5, source: 'lfsr', rate: 18000 }, len: 3 },
    t: { tones: [{ amp: 0.8, f0: 260, f1: 110, sweep: 0.06, decay: 0.1, wave: 'tri4' }], noise: { amp: 0.08, decay: 0.015, source: 'lfsr', rate: 6000 }, len: 0.5 },
    m: { noise: { amp: 0.22, decay: 0.03, source: 'lfsr', rate: 11000, short: true }, len: 0.2 },
  },
};

const coef = (tc, sr) => Math.exp(-1 / (Math.max(0.0005, tc) * sr));

const filterSpec = (type, freq, q, sr) => (type ? svfSet({ mode: type === 'lp' ? LP : type === 'bp' ? BP : HP }, freq || 1000, 1 / Math.max(0.1, q || 0.707), sr) : null);

// instrument def: { type: 'drums', kit: 'clean' | 'chip' | { s: {...override}, ... }, preset: 'clean' }
// e.g. { type: 'drums', preset: 'clean', kit: { s: { pitch: 1.1, decay: 0.8 }, h: { level: 0.7 } } }
// kitParts reads a kit as its preset and the hits it changes (the sound's own object), setKitParts writes it back
export const kitParts = (def) => ({ preset: typeof def.kit === 'string' ? def.kit : def.preset || 'clean', over: def.kit && typeof def.kit === 'object' ? def.kit : {} });
export function setKitParts(def, preset, over) {
  if (Object.keys(over).length) { def.preset = preset; def.kit = over; } else { delete def.preset; def.kit = preset; }
}
export function compileKit(def, sr, samples = {}) {
  const parts = kitParts(def), preset = KITS[parts.preset] || KITS.clean, over = parts.over;
  const out = {};
  for (const name of new Set([...Object.keys(preset), ...Object.keys(over)])) {
    const h = { ...(preset[name] || {}), ...(over[name] || {}) };
    const pitch = h.pitch ?? 1, dec = h.decay ?? 1;
    const z = h.sample && samples[h.sample]?.[0];
    if (z) {
      out[name] = { level: h.level ?? 1, sample: z.data, inc: (z.rate / sr) * pitch, len: z.data.length / z.rate / pitch, tones: [], noise: null, metal: null, click: 0 };
      continue;
    }
    out[name] = {
      level: h.level ?? 1,
      len: (h.len ?? 1) * Math.max(1, dec),
      drive: h.drive && h.drive > 1 ? h.drive : 0,
      driveNorm: h.drive && h.drive > 1 ? 1 / Math.tanh(h.drive) : 1,
      click: h.click || 0,
      clickCoef: coef(0.0015, sr),
      tones: (h.tones || []).slice(0, 2).map((c) => ({
        amp: c.amp ?? 1, f0: (c.f0 ?? 150) * pitch, f1: (c.f1 ?? c.f0 ?? 150) * pitch,
        sweepCoef: coef(c.sweep ?? 0.03, sr), decayCoef: coef((c.decay ?? 0.1) * dec, sr), tri4: c.wave === 'tri4',
      })),
      noise: h.noise ? {
        amp: h.noise.amp ?? 0.5, decayCoef: coef((h.noise.decay ?? 0.05) * dec, sr), attack: h.noise.attack || 0,
        lfsr: h.noise.source === 'lfsr', rate: (h.noise.rate || 10000) * pitch, short: !!h.noise.short,
        filter: filterSpec(h.noise.filter, (h.noise.freq || 1000) * pitch, h.noise.q, sr),
      } : null,
      metal: h.metal ? {
        amp: h.metal.amp ?? 0.5, decayCoef: coef((h.metal.decay ?? 0.05) * dec, sr),
        inc: METAL_HZ.map((f) => (f * (h.metal.tune || 1) * pitch) / sr),
        filter: filterSpec(h.metal.filter || 'hp', (h.metal.freq || 7000) * pitch, h.metal.q, sr),
      } : null,
    };
  }
  return out;
}

export class DrumVoice {
  constructor() {
    this.active = false;
    this.kind = '';
    this.seed = 22222;
    this.lfsr = 1;
    this.tone = [{ ph: 0, env: 0, sweep: 0, f0: 0, f1: 0 }, { ph: 0, env: 0, sweep: 0, f0: 0, f1: 0 }];
    this.metalPh = new Float64Array(6);
    this.nf = { ic1: 0, ic2: 0 };
    this.mf = { ic1: 0, ic2: 0 };
  }

  rand() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 2147483648 - 1;
  }

  start(h, kind, vel) {
    this.h = h; this.kind = kind; this.t = 0; this.active = true;
    this.spos = 0; this.sEnv = 1; this.sDecay = 1;
    // tiny per-hit variation so repeated hits don't sound machine-gunned
    const pitch = 1 + this.rand() * 0.015;
    this.vel = vel * (1 + this.rand() * 0.06);
    h.tones.forEach((c, i) => {
      const s = this.tone[i];
      s.ph = 0; s.env = c.amp; s.sweep = 1; s.f0 = c.f0 * pitch; s.f1 = c.f1 * pitch;
    });
    this.nEnv = h.noise ? h.noise.amp : 0;
    this.mEnv = h.metal ? h.metal.amp : 0;
    this.cEnv = h.click;
    this.nDecay = h.noise ? h.noise.decayCoef : 1;
    this.mDecay = h.metal ? h.metal.decayCoef : 1;
    this.tDecay = null;
    this.noisePh = 0;
    this.nf.ic1 = this.nf.ic2 = this.mf.ic1 = this.mf.ic2 = 0;
  }

  // open hat cut off by a closed hat
  choke(sr) { this.nDecay = this.mDecay = this.tDecay = this.sDecay = coef(0.006, sr); }

  render(sr, invSr) {
    const h = this.h;
    this.t += invSr;
    let out = 0, alive = false;

    for (let i = 0; i < h.tones.length; i++) {
      const c = h.tones[i], s = this.tone[i];
      if (s.env < 1e-4) continue;
      alive = true;
      s.sweep *= c.sweepCoef;
      s.ph += (s.f1 + (s.f0 - s.f1) * s.sweep) * invSr;
      if (s.ph >= 1) s.ph -= 1;
      out += (c.tri4 ? TRI4[(s.ph * 32) | 0] : Math.sin(TWO_PI * s.ph)) * s.env;
      s.env *= this.tDecay ?? c.decayCoef;
    }

    const n = h.noise;
    if (n && this.nEnv > 1e-4) {
      alive = true;
      let x;
      if (n.lfsr) {
        this.noisePh += n.rate * invSr;
        while (this.noisePh >= 1) {
          this.noisePh -= 1;
          const bit = (this.lfsr ^ (this.lfsr >> (n.short ? 6 : 1))) & 1;
          this.lfsr = (this.lfsr >> 1) | (bit << 14);
        }
        x = this.lfsr & 1 ? 1 : -1;
      } else x = this.rand();
      if (n.filter) x = svf(n.filter, this.nf, x);
      const a = n.attack && this.t < n.attack ? this.t / n.attack : 1;
      out += x * this.nEnv * a;
      this.nEnv *= this.nDecay;
    }

    const m = h.metal;
    if (m && this.mEnv > 1e-4) {
      alive = true;
      let x = 0;
      for (let i = 0; i < 6; i++) {
        const dt = m.inc[i];
        let ph = this.metalPh[i] + dt;
        if (ph >= 1) ph -= 1;
        this.metalPh[i] = ph;
        x += (ph < 0.5 ? 1 : -1) + blep(ph, dt) - blep(ph < 0.5 ? ph + 0.5 : ph - 0.5, dt);
      }
      out += svf(m.filter, this.mf, x / 6) * this.mEnv;
      this.mEnv *= this.mDecay;
    }

    if (h.sample && this.sEnv > 1e-4) {
      const d = h.sample, i = this.spos | 0;
      if (i + 1 < d.length) {
        alive = true;
        out += (d[i] + (d[i + 1] - d[i]) * (this.spos - i)) * this.sEnv;
        this.spos += h.inc;
        this.sEnv *= this.sDecay;
      }
    }

    if (this.cEnv > 1e-4) {
      alive = true;
      out += this.rand() * this.cEnv;
      this.cEnv *= h.clickCoef;
    }

    if (h.drive) out = Math.tanh(out * h.drive) * h.driveNorm;
    if (!alive || this.t > h.len) this.active = false;
    return out * this.vel * h.level;
  }
}
