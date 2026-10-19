// Effects: one chain, in the order a list gives, for an instrument's track (instrument.fx) and for a game sound
// (sound.fx). The same kinds and settings in both; a setting that goes in time is in beats in music (`beats`) and
// in Hz in a sound (`rate`). Any setting can move (a move: ramp, hump, wave, step): in music each note starts its
// moves again and they run in beats; in a sound they run over the sound, in seconds. FxChain plays a chain.
import { svfSet, svf, LP, BP, HP, TWO_PI } from './dsp.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clamp01 = (v) => clamp(v, 0, 1);
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

// ---------------------------------------------------------------- the building blocks
// RBJ cookbook biquads, [kind, Hz, Q, dB] with kind lp | hp | peak | ls | hs, as flat coefficients (b0 b1 b2 a1 a2 per stage)
export function biquads(list, sr) {
  const c = new Float64Array(list.length * 5);
  list.forEach(([kind, f, q = 0.707, db = 0], i) => {
    const w = (TWO_PI * Math.min(f, sr * 0.45)) / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q), A = Math.pow(10, db / 40);
    let b0, b1, b2, a0, a1, a2;
    if (kind === 'lp') { b1 = 1 - cs; b0 = b2 = b1 / 2; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
    else if (kind === 'hp') { b1 = -(1 + cs); b0 = b2 = (1 + cs) / 2; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
    else if (kind === 'ls' || kind === 'hs') { // shelves (RBJ): everything below (ls) or above (hs) f raised by db
      const r = 2 * Math.sqrt(A) * al, s = kind === 'ls' ? 1 : -1, p = A + 1, m = A - 1;
      b0 = A * (p - s * m * cs + r); b1 = 2 * s * A * (m - s * p * cs); b2 = A * (p - s * m * cs - r);
      a0 = p + s * m * cs + r; a1 = -2 * s * (m + s * p * cs); a2 = p + s * m * cs - r;
    }
    else { b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A; }
    c.set([b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0], i * 5);
  });
  return c;
}
// one sample through a chain of biquads (transposed direct form II; z holds two states per stage)
export function chain(c, z, x) {
  for (let i = 0, j = 0; i < c.length; i += 5, j += 2) {
    const y = c[i] * x + z[j];
    z[j] = c[i + 1] * x - c[i + 3] * y + z[j + 1];
    z[j + 1] = c[i + 2] * x - c[i + 4] * y;
    x = y;
  }
  return x;
}
// the gain of a biquad chain at f Hz
export function chainMag(c, sr, f) {
  const w = (TWO_PI * f) / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  let m = 1;
  for (let i = 0; i < c.length; i += 5) {
    const nr = c[i] + c[i + 1] * c1 + c[i + 2] * c2, ni = -(c[i + 1] * s1 + c[i + 2] * s2);
    const dr = 1 + c[i + 3] * c1 + c[i + 4] * c2, di = -(c[i + 3] * s1 + c[i + 4] * s2);
    m *= Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  return m;
}
// log(cosh(x)), the integral of tanh, without overflow
const logcosh = (x) => { const a = Math.abs(x); return a + Math.log1p(Math.exp(-2 * a)) - Math.LN2; };
// a wave at phase ph (0..1): a raised cosine, 0 … 1 … 0
const hump = (ph) => 0.5 - 0.5 * Math.cos(TWO_PI * ph);

// Amps around the drive: EQ into the clipper, a speaker cabinet after it, a bias for the even harmonics of a tube
// and a level to match a sound without the amp.
export const AMPS = {
  // tight lows and a mid push into the clipper (a Tube Screamer in front of the amp), then a 4×12 cabinet:
  // lows gone below 75 Hz with a bump at 110, a dip where fizz lives, a steep roll-off from about 4 kHz
  guitar: { bias: 0.25, gain: 0.71, pre: [['hp', 110], ['peak', 850, 0.8, 8]], post: [['hp', 75], ['peak', 110, 1, 3], ['peak', 2600, 1.5, -3], ['lp', 4200], ['lp', 5000, 1.2]] },
  // a bass amp keeps the lows and rounds off the top
  bass: { bias: 0.1, gain: 0.83, pre: [['hp', 35], ['peak', 700, 0.7, 3]], post: [['lp', 2800], ['lp', 3600, 0.9]] },
};

// Bodies: the fixed resonances of an instrument's box, bell or mouth, the same for every note it plays. They are much
// of what makes a sound a violin or a horn rather than a synth. [kind, Hz, Q, dB] like the amps; a body is a name from
// here (type) or its own list (bands), and is levelled so a sound keeps its loudness with a body.
export const BODIES = {
  // a violin: the air in the box near 280 Hz, the wood around 470 Hz, the "bridge hill" near 2.8 kHz, little above 5 kHz
  violin: [['hp', 180], ['peak', 280, 3, 6], ['peak', 470, 3, 5], ['peak', 1300, 1, -4], ['peak', 2800, 1.2, 6], ['lp', 5500, 0.8]],
  // a cello: the air in the box near 126 Hz, then the wood's many sharp resonances, alternately up and down, from 250 Hz
  // to 3.5 kHz. The vibrato moves each overtone across them, so it swells and fades the way a real cello's do
  // (a few dB) instead of keeping a synth's steady colour.
  cello: [['hp', 80, 0.7], ['peak', 126, 4, 6],
    ['peak', 250, 48, 5.8], ['peak', 263, 45, -6.9], ['peak', 276, 45, 7.9], ['peak', 291, 44, -7.4], ['peak', 307, 35, 6.2], ['peak', 319, 44, -4.7], ['peak', 333, 39, 8.7], ['peak', 350, 32, -6.8],
    ['peak', 367, 44, 7.4], ['peak', 379, 48, -8.6], ['peak', 393, 37, 8.3], ['peak', 410, 33, -5.8], ['peak', 430, 36, 8.7], ['peak', 452, 45, -8.5], ['peak', 464, 35, 7], ['peak', 492, 38, -5.4],
    ['peak', 522, 31, 6.1], ['peak', 534, 43, -8.7], ['peak', 562, 33, 6.3], ['peak', 582, 37, -6.4], ['peak', 610, 41, 7.3], ['peak', 635, 48, -6.6], ['peak', 678, 43, 7.4], ['peak', 700, 40, -7.6],
    ['peak', 743, 38, 7.7], ['peak', 757, 42, -6.1], ['peak', 794, 38, 8.1], ['peak', 845, 32, -8.2], ['peak', 859, 38, 5.2], ['peak', 898, 50, -5.5], ['peak', 956, 33, 6.6], ['peak', 998, 33, -8.6],
    ['peak', 1054, 48, 8.5], ['peak', 1102, 45, -5.7], ['peak', 1116, 35, 4.8], ['peak', 1166, 42, -5.5], ['peak', 1250, 40, 7.6], ['peak', 1283, 48, -5.6], ['peak', 1348, 48, 5], ['peak', 1414, 30, -8.6],
    ['peak', 1485, 48, 4.6], ['peak', 1566, 34, -8.9], ['peak', 1618, 44, 5.7], ['peak', 1670, 34, -7], ['peak', 1735, 45, 7.7], ['peak', 1855, 40, -4.6], ['peak', 1898, 48, 5.1], ['peak', 2024, 48, -4.7],
    ['peak', 2130, 47, 9], ['peak', 2231, 45, -6.4], ['peak', 2274, 45, 8.5], ['peak', 2389, 35, -6.3], ['peak', 2540, 41, 6.1], ['peak', 2629, 45, -6], ['peak', 2758, 38, 5.4], ['peak', 2840, 50, -9],
    ['peak', 3001, 47, 8.6], ['peak', 3089, 43, -5.1], ['peak', 3262, 41, 8], ['peak', 3463, 40, -5.3],
    ['lp', 4500, 0.7]],
  // a string section: violins to basses together, their peaks smeared
  strings: [['peak', 300, 1.2, 4], ['peak', 1200, 1, -3], ['peak', 2600, 1, 4], ['lp', 6000, 0.7]],
  // a french horn: the bell faces away from you, full around 180 Hz, warm around 400 Hz, dark above 2 kHz
  horn: [['peak', 180, 0.8, 5], ['peak', 400, 1.2, 6], ['peak', 1200, 1, -3], ['lp', 2200, 0.8]],
  // trumpets and trombones: the brassy band around 1.2 kHz
  brass: [['hp', 120], ['peak', 1200, 1.1, 6], ['peak', 2600, 1.5, 3], ['lp', 7000, 0.7]],
  // voices: the formants of a vowel (on a rich source such as a saw)
  ah: [['lp', 3500, 0.7], ['peak', 750, 5, 16], ['peak', 1200, 6, 13], ['peak', 2600, 7, 9]],
  oh: [['lp', 3500, 0.7], ['peak', 500, 5, 16], ['peak', 850, 6, 13], ['peak', 2500, 7, 8]],
  oo: [['lp', 3000, 0.7], ['peak', 330, 5, 16], ['peak', 800, 6, 12], ['peak', 2300, 7, 6]],
  ee: [['lp', 4000, 0.7], ['peak', 300, 5, 14], ['peak', 2250, 6, 14], ['peak', 3000, 7, 10]],
};
// a body's coefficients and the gain that levels it (its average power from 150 Hz to 5 kHz back to 1)
function compileBody(list, sr) {
  if (!list?.length) return null;
  const c = biquads(list, sr);
  let pw = 0;
  for (let i = 0; i < 24; i++) pw += chainMag(c, sr, 150 * Math.pow(5000 / 150, i / 23)) ** 2;
  return { c, gain: 1 / Math.sqrt(pw / 24) };
}
// The EQ: a low shelf, a bell in the middle (its frequency the sound's own) and a high shelf, in dB; bands at 0 dB are
// left out, so a flat EQ costs nothing.
export const EQ_LOW = 250, EQ_HIGH = 4000, EQ_MID_Q = 0.9;
export const eqBands = (eq) => (eq ? [['ls', EQ_LOW, 0.707, eq.low || 0], ['peak', eq.midHz || 1000, EQ_MID_Q, eq.mid || 0], ['hs', EQ_HIGH, 0.707, eq.high || 0]].filter((b) => Math.abs(b[3]) > 0.01) : []);
const compileEq = (eq, sr) => { const bands = eqBands(eq); return bands.length ? biquads(bands, sr) : null; };
// the EQ's gain in dB at each frequency, for the editor's curve
export function eqResponse(eq, sr = 48000) {
  const c = compileEq(eq, sr);
  return (f) => (c ? 20 * Math.log10(chainMag(c, sr, f)) : 0);
}
// where a filter can go, and its gain in dB at each frequency for a cutoff, for the editor's curve: the state-variable
// filter answers as the analog one at the prewarped frequency (type: low, high or band pass)
export const clampCutoff = (f, sr) => Math.min(sr * 0.45, Math.max(40, f));
export function filterResponse(cut, q, type, sr = 48000) {
  const w = (x) => Math.tan((Math.PI * Math.min(x, sr * 0.45)) / sr), wc = w(cut), k = 1 / Math.max(0.3, q);
  const t = type === true ? 'high' : type || 'low';
  return (f) => {
    const W = w(f) / wc, top = t === 'high' ? W * W : t === 'band' ? k * W : 1, mag = top / Math.hypot(1 - W * W, k * W);
    return 20 * Math.log10(Math.max(mag, 1e-6));
  };
}
export const WAH_LO = 350, WAH_OCT = 3, PHASER_LO = 200;
const WAH_GAIN = 1.3; // the band's level back near the dry sound's
const VOWELS = [[800, 1150, 2800], [400, 1700, 2600], [300, 2200, 3000], [450, 800, 2830], [325, 700, 2530]]; // a e i o u: F1 F2 F3
const VOWEL_GAIN = [1, 0.5, 0.25];
const DELAY_MAX = 1; // seconds

// ---------------------------------------------------------------- the kinds
// a setting: its range, its default, log (it moves in octaves), step (it keeps to steps of that)
const P = (min, max, def, o = {}) => ({ min, max, def, log: !!o.log, step: o.step || 0 });
// each kind: its settings; `beats` (music) and `rate` (sounds, Hz): how fast it goes, for the kinds in time; the
// options that don't move (a filter's type, an amp, a body …)
export const EFFECT_KINDS = {
  body: { params: {}, opts: ['type', 'bands'] },
  wah: { params: { depth: P(0.05, 1, 0.7), resonance: P(1, 10, 4, { log: true }) }, beats: P(0.25, 8, 1, { log: true }), rate: P(0.1, 20, 2, { log: true }), opts: ['mode'] },
  drive: { params: { amount: P(0, 2, 0.6) }, opts: ['amp'] },
  filter: { params: { cutoff: P(40, 16000, 2000, { log: true }), resonance: P(0.3, 6, 0.707, { log: true }), env: P(0, 5, 0), decay: P(0.02, 2, 0.2, { log: true }), swell: P(0, 3, 0) }, opts: ['type'] },
  crush: { params: { bits: P(2, 12, 6, { step: 1 }), rate: P(1000, 48000, 11025, { log: true }) } },
  eq: { params: { low: P(-12, 12, 0, { step: 0.5 }), mid: P(-12, 12, 0, { step: 0.5 }), midHz: P(200, 5000, 1000, { log: true }), high: P(-12, 12, 0, { step: 0.5 }) } },
  ring: { params: { freq: P(20, 4000, 300, { log: true }), mix: P(0, 1, 1) } },
  vowel: { params: { vowel: P(0, 4, 0), mix: P(0, 1, 1) } },
  delay: { params: { time: P(0.001, DELAY_MAX, 0.25, { log: true }), feedback: P(0, 0.95, 0.3), mix: P(0, 1, 0.4) } },
  phaser: { params: { depth: P(0.05, 1, 0.7), feedback: P(0, 0.9, 0.5) }, beats: P(0.25, 16, 4, { log: true }), rate: P(0.05, 20, 1.5, { log: true }) },
  chorus: { params: { depth: P(0.05, 1, 0.5) }, beats: P(0.25, 16, 4, { log: true }), rate: P(0.05, 10, 1, { log: true }), opts: ['mode'] },
  tremolo: { params: { depth: P(0.05, 1, 0.5) }, beats: P(0.0625, 4, 0.25, { log: true }), rate: P(0.5, 60, 8, { log: true }), opts: ['square'] },
  autopan: { params: { depth: P(0.05, 1, 0.7) }, beats: P(0.125, 16, 2, { log: true }), rate: P(0.1, 20, 1, { log: true }) },
};
export const FX_ORDER = Object.keys(EFFECT_KINDS); // the order an older instrument's effects went in
export const FILTER_TYPES = ['low', 'high', 'band'];
export const FX_OPTIONS = { filter: { type: FILTER_TYPES }, drive: { amp: Object.keys(AMPS) }, wah: { mode: ['note'] }, chorus: { mode: ['flanger'] }, body: { type: Object.keys(BODIES) } };
// a kind's settings that can be set and moved, in music (beats) or a sound (rate in Hz)
export function fxParams(kind, music) {
  const k = EFFECT_KINDS[kind];
  if (!k) return null;
  const tempo = music ? k.beats && { beats: k.beats } : k.rate && { rate: k.rate };
  return tempo ? { ...k.params, ...tempo } : k.params;
}

// ---------------------------------------------------------------- moves
export const MOVE_SHAPES = ['ramp', 'hump', 'wave', 'step'];
// a move's own settings. In music: beats (how long a ramp, a hump, a step takes from each note; a wave's period),
// every (beats: it starts over); in a sound: rate (a wave's, Hz), every (seconds); at: where a step steps, 0–1
export const MOVE_PARAMS = {
  music: { beats: P(0.0625, 16, 1, { log: true }), at: P(0, 1, 0.3), every: P(0, 16, 0) },
  sound: { rate: P(0.1, 60, 6, { log: true }), at: P(0, 1, 0.3), every: P(0, 4, 0) },
};
// how far a move has gone (0: the setting's own value, 1: to) t seconds in; m: { shape, rate, at, every, len } in seconds
export function moveT(m, t) {
  let u;
  if (m.every > 0) { const e = Math.max(0.005, m.every); t %= e; u = t / Math.min(e, m.len || e); } else u = m.len > 0 ? t / m.len : 1;
  if (m.shape === 'step') return u >= m.at ? 1 : 0;
  if (m.shape === 'hump') return hump(clamp01(u));
  if (m.shape === 'wave') return hump(m.rate * t);
  return clamp01(u);
}
// a setting t seconds in, with its moves: for a log one in octaves (the moves multiply), else the moves add
export function valueAt(base, key, moves, p, t) {
  let v = base;
  for (const m of moves) {
    if (m.on !== key) continue;
    const k = moveT(m, t);
    if (!k) continue;
    v = p.log ? v * Math.pow(m.to / base, k) : v + (m.to - base) * k;
  }
  return clamp(v, p.min, p.max);
}
const inP = (p, v) => clamp(num(v, p.def), p.min, p.max);
// the moves in a list that move one of params, with every setting there; in seconds: { on, to, shape, rate, at, every, len }.
// music: in beats at bps (len: the move's beats); a sound: len is what it moves over (the sound, a layer), in seconds
export function movesOf(list, params, { music = false, bps = 2, len = 1 } = {}) {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    const p = params[m?.on];
    if (!p) continue;
    const mp = music ? MOVE_PARAMS.music : MOVE_PARAMS.sound, shape = MOVE_SHAPES.includes(m.shape) ? m.shape : 'ramp';
    const at = inP(mp.at, m.at), every = inP(mp.every, m.every);
    if (music) { const beats = inP(mp.beats, m.beats); out.push({ on: m.on, to: inP(p, m.to), shape, at, rate: bps / beats, len: beats / bps, every: every / bps }); }
    else out.push({ on: m.on, to: inP(p, m.to), shape, at, rate: inP(mp.rate, m.rate), len, every });
  }
  return out;
}

// ---------------------------------------------------------------- an effect with every setting there
export function fxOf(def, music) {
  const params = fxParams(def?.kind, music);
  if (!params) return null;
  const f = { kind: def.kind, off: !!def.off };
  for (const [k, p] of Object.entries(params)) f[k] = inP(p, def[k]);
  for (const o of EFFECT_KINDS[def.kind].opts || []) if (def[o] !== undefined) f[o] = def[o];
  if (def.kind === 'filter') f.type = FILTER_TYPES.includes(def.type) ? def.type : 'low';
  f.moves = def.moves;
  return f;
}
// a list with every effect there, each kind once (a second of a kind is left out), the bypassed ones too
export function fxList(list, music) {
  const seen = new Set(), out = [];
  for (const d of Array.isArray(list) ? list : []) {
    const f = fxOf(d, music);
    if (!f || seen.has(f.kind)) continue;
    seen.add(f.kind);
    out.push(f);
  }
  return out;
}

// An older instrument's effects (its keys: body, wah, drive and amp, the filter, crush, eq, phaser, chorus, tremolo,
// autopan) as a list in the order they went in; the instrument without them. One with a list already is as it was.
const OLD_FX = ['body', 'wah', 'drive', 'amp', 'cutoff', 'resonance', 'filter', 'swell', 'filterEnv', 'crush', 'eq', 'phaser', 'chorus', 'tremolo', 'autopan'];
export function migrateInstrument(def) {
  if (!def || typeof def !== 'object' || !OLD_FX.some((k) => def[k] !== undefined)) return def;
  const d = { ...def }, fx = [];
  const take = (k) => { const v = d[k]; delete d[k]; return v; };
  const body = take('body'), wah = take('wah'), drive = take('drive'), amp = take('amp');
  const cutoff = take('cutoff'), resonance = take('resonance'), filter = take('filter'), swell = take('swell'), fenv = take('filterEnv');
  const crush = take('crush'), eq = take('eq'), phaser = take('phaser'), chorus = take('chorus'), tremolo = take('tremolo'), autopan = take('autopan');
  if (body) fx.push(Array.isArray(body) ? { kind: 'body', bands: body } : { kind: 'body', type: body });
  if (wah) fx.push({ kind: 'wah', ...wah });
  if (drive > 0 || amp) fx.push({ kind: 'drive', amount: drive || 0, ...(amp && { amp }) });
  const hasFilter = (cutoff !== undefined && cutoff < 16000) || filter === 'high' || (resonance !== undefined && Math.abs(resonance - 0.707) > 0.01) || swell > 0 || fenv?.amount > 0;
  if (hasFilter) {
    const f = { kind: 'filter', cutoff: cutoff ?? 16000 };
    if (filter === 'high') f.type = 'high';
    if (resonance !== undefined) f.resonance = resonance;
    if (fenv?.amount > 0) { f.env = fenv.amount; if (fenv.decay !== undefined) f.decay = fenv.decay; }
    if (swell > 0) f.swell = swell;
    fx.push(f);
  }
  if (crush) fx.push({ kind: 'crush', ...crush });
  if (eq) fx.push({ kind: 'eq', ...eq });
  for (const [kind, v] of [['phaser', phaser], ['chorus', chorus], ['tremolo', tremolo], ['autopan', autopan]]) if (v) fx.push({ kind, ...v });
  if (fx.length) d.fx = [...fx, ...(Array.isArray(d.fx) ? d.fx : [])];
  return d;
}

// ---------------------------------------------------------------- the chain playing
const CTL = 16; // samples between new settings (moves, sweeps)

// One stage of a chain: an effect's settings (v, moving with its moves), what they come to (c), its state
class Stage {
  constructor(f, sr, ctx) {
    this.kind = f.kind; this.sr = sr;
    this.params = fxParams(f.kind, ctx.music);
    this.ph = 0; this.u1 = 0; this.F1 = 0; this.cPh = 1; this.hold = 0; this.pa = 0; this.pz = new Float64Array(4); this.pLast = 0;
    this.st = [{ ic1: 0, ic2: 0 }, { ic1: 0, ic2: 0 }, { ic1: 0, ic2: 0 }];
    this.svf = [{ mode: LP, k: 1, a1: 0, a2: 0, a3: 0 }, { mode: BP, k: 1, a1: 0, a2: 0, a3: 0 }, { mode: BP, k: 1, a1: 0, a2: 0, a3: 0 }];
    this.cut = 0; this.fenv = 0;
    this.set(f, ctx);
  }
  set(f, { music, bps, drums, len }) {
    this.f = f; this.bps = bps;
    const v = (this.v = {});
    for (const k of Object.keys(this.params)) v[k] = f[k];
    this.moves = movesOf(f.moves, this.params, { music, bps, len });
    this.hz = f.beats !== undefined ? bps / Math.max(0.03, f.beats) : f.rate; // how fast it goes in time, Hz
    const sr = this.sr;
    switch (f.kind) {
      case 'body': this.body = compileBody(Array.isArray(f.bands) ? f.bands : BODIES[f.type] || BODIES.violin, sr); this.zB = new Float64Array(this.body ? this.body.c.length / 2.5 : 0); break;
      case 'drive': {
        const amp = AMPS[f.amp];
        this.amp = amp ? { pre: biquads(amp.pre, sr), post: biquads(amp.post, sr), gain: amp.gain } : null;
        if (this.amp && this.zPre?.length !== this.amp.pre.length / 2.5) { this.zPre = new Float64Array(this.amp.pre.length / 2.5); this.zPost = new Float64Array(this.amp.post.length / 2.5); }
        this.bias = amp?.bias || 0;
        break;
      }
      case 'wah': this.note = f.mode === 'note' && !drums; break;
      case 'filter': {
        const target = clampCutoff(v.cutoff, sr);
        if (!this.cut) this.cut = target;
        this.cutTarget = target; // a new cutoff glides there
        this.svf[0].mode = f.type === 'high' ? HP : f.type === 'band' ? BP : LP;
        this.fenvCoef = Math.exp(-4.6 / (Math.max(0.005, v.decay) * sr));
        this.coefTimer = 0;
        break;
      }
      case 'delay': if (!this.buf) { this.buf = new Float32Array(Math.ceil(DELAY_MAX * sr) + 2); this.w = 0; } this.dl = v.time * sr; this.dlD = 0; break;
      case 'chorus': if (!this.buf) { this.buf = new Float32Array(Math.ceil(sr * 0.03) + 2); this.w = 0; } break;
    }
    this.apply();
  }
  // the settings now (v) as what the stage uses
  apply() {
    const v = this.v, sr = this.sr, f = this.f;
    switch (this.kind) {
      case 'drive': {
        this.g = v.amount > 0 ? 1 + Math.min(2, v.amount) * 24 : this.amp ? 1 : 0; // 1 = crunch, 2 = high gain
        // scaled so a normal-level note keeps its level while louder ones (chords) saturate
        this.off = Math.tanh(this.bias); this.norm = this.g ? 0.5 / (Math.tanh(this.g * 0.5 + this.bias) - this.off) : 1;
        break;
      }
      case 'wah': { const q = clamp(v.resonance, 1, 10); this.span = WAH_OCT * clamp01(v.depth); this.k = 1 / q; this.gain = Math.sqrt(q) * WAH_GAIN; break; }
      case 'crush': this.levels = 2 ** (clamp(Math.round(v.bits), 2, 16) - 1); this.step = Math.min(1, Math.max(500, v.rate) / sr); break;
      case 'eq': { const c = compileEq(v, sr); this.eq = c; if (c && this.zE?.length !== c.length / 2.5) this.zE = new Float64Array(c.length / 2.5); break; }
      case 'filter': this.cutTarget = clampCutoff(v.cutoff, sr); this.q = v.resonance; break;
      case 'vowel': {
        const i = Math.min(3, Math.floor(v.vowel)), u = v.vowel - i, a = VOWELS[i], b = VOWELS[i + 1];
        for (let j = 0; j < 3; j++) svfSet(this.svf[j], a[j] + (b[j] - a[j]) * u, 0.12, sr).mode = BP;
        break;
      }
      case 'delay': this.dlD = (Math.max(1, v.time * sr) - this.dl) / CTL; break;
      case 'phaser': this.span = 4 * clamp01(v.depth); this.fb = clamp(v.feedback, 0, 0.9); break;
      case 'chorus': {
        const depth = clamp01(v.depth);
        Object.assign(this, f.mode === 'flanger' ? { base: 0.001, width: 0.005 * depth, cfb: 0.5, cnorm: 0.5 } : { base: 0.012, width: 0.012 * depth, cfb: 0, cnorm: Math.SQRT1_2 });
        break;
      }
    }
    if (v.beats !== undefined) this.hz = this.bps / Math.max(0.03, v.beats);
    else if (v.rate !== undefined && this.kind !== 'crush') this.hz = v.rate;
  }
  noteOn(vel) { if (this.kind === 'filter' && this.v.env) this.fenv = vel; }
  // every CTL samples: the moves (t seconds since the note or the sound started), the sweeps
  control(t, loud) {
    if (this.moves.length) {
      for (const k in this.params) this.v[k] = valueAt(this.f[k], k, this.moves, this.params[k], t);
      this.apply();
    }
    const sr = this.sr, n = CTL / sr;
    switch (this.kind) {
      case 'wah': {
        let pos;
        if (this.note) pos = loud;
        else { if ((this.ph += this.hz * n) >= 1) this.ph -= Math.floor(this.ph); pos = hump(this.ph); }
        svfSet(this.svf[1], WAH_LO * Math.pow(2, this.span * pos), this.k, sr).mode = BP;
        break;
      }
      case 'phaser': {
        if ((this.ph += this.hz * n) >= 1) this.ph -= Math.floor(this.ph);
        const fq = PHASER_LO * Math.pow(2, this.span * hump(this.ph)), tn = Math.tan((Math.PI * Math.min(fq, sr * 0.45)) / sr);
        this.pa = (tn - 1) / (tn + 1);
        break;
      }
      case 'filter': {
        const v = this.v, env = this.fenv > 0.002;
        if (Math.abs(this.cut - this.cutTarget) > 0.5) this.cut += (this.cutTarget - this.cut) * 0.0015; // ~0.25 s glide
        const c = this.cut * Math.pow(2, v.env * (env ? this.fenv : 0) + v.swell * (loud - 1));
        if (c !== this.lastCut || this.q !== this.lastQ) { svfSet(this.svf[0], c, 1 / Math.max(0.3, this.q), sr); this.lastCut = c; this.lastQ = this.q; }
        break;
      }
      case 'autopan': if ((this.ph += this.hz * n) >= 1) this.ph -= Math.floor(this.ph); this.pan = clamp01(this.v.depth) * Math.sin(TWO_PI * this.ph); break;
    }
  }
  run(x) {
    switch (this.kind) {
      case 'body': return this.body ? chain(this.body.c, this.zB, x) * this.body.gain : x;
      case 'wah': return svf(this.svf[1], this.st[1], x) * this.gain;
      case 'drive': {
        // the amp's EQ, the clipper, the cabinet. The clipper is tanh with first-order antiderivative anti-aliasing:
        // it outputs the average of tanh between two samples (from its integral, log cosh). A plain tanh at high gain
        // folds harmonics above Nyquist back into the audible band, the fizz of cheap distortion.
        if (!this.g) return x;
        const amp = this.amp;
        if (amp) x = chain(amp.pre, this.zPre, x);
        const u = x * this.g + this.bias, d = u - this.u1, F = logcosh(u);
        const y = Math.abs(d) > 1e-6 ? (F - this.F1) / d : Math.tanh(0.5 * (u + this.u1));
        this.u1 = u; this.F1 = F;
        x = (y - this.off) * this.norm;
        return amp ? chain(amp.post, this.zPost, x) * amp.gain : x;
      }
      case 'filter':
        if (this.fenv > 0) this.fenv *= this.fenvCoef;
        return svf(this.svf[0], this.st[0], x);
      case 'crush':
        if ((this.cPh += this.step) >= 1) { this.cPh -= 1; this.hold = Math.round(x * this.levels) / this.levels; }
        return this.hold;
      case 'eq': return this.eq ? chain(this.eq, this.zE, x) : x;
      case 'ring': {
        if ((this.ph += this.v.freq / this.sr) >= 1) this.ph -= 1;
        const m = this.v.mix;
        return x * (1 - m + m * Math.sin(TWO_PI * this.ph));
      }
      case 'vowel': {
        let y = 0;
        for (let j = 0; j < 3; j++) y += svf(this.svf[j], this.st[j], x) * VOWEL_GAIN[j];
        return x * (1 - this.v.mix) + y * 2 * this.v.mix;
      }
      case 'delay': {
        const b = this.buf, n = b.length;
        this.dl += this.dlD;
        let r = this.w - this.dl;
        if (r < 0) r += n;
        const i = r | 0, j = i + 1 < n ? i + 1 : 0, y = b[i] + (b[j] - b[i]) * (r - i);
        b[this.w] = x + y * this.v.feedback;
        if (++this.w >= n) this.w = 0;
        return x * (1 - this.v.mix * 0.5) + y * this.v.mix;
      }
      case 'phaser': {
        const a = this.pa, z = this.pz;
        let y = x + this.fb * this.pLast;
        for (let i = 0; i < 4; i++) { const o = a * y + z[i]; z[i] = y - a * o; y = o; }
        this.pLast = y;
        return (x + y) * Math.SQRT1_2;
      }
      case 'chorus': {
        // a copy from a delay line that wanders, mixed with the dry sound (a flanger: shorter, fed back)
        const buf = this.buf, n = buf.length;
        if ((this.ph += this.hz / this.sr) >= 1) this.ph -= 1;
        let r = this.w - this.sr * (this.base + this.width * hump(this.ph));
        if (r < 0) r += n;
        const i = Math.floor(r), fr = r - i, y = buf[i] + (buf[i + 1 === n ? 0 : i + 1] - buf[i]) * fr;
        buf[this.w] = x + this.cfb * y;
        if (++this.w >= n) this.w = 0;
        return (x + y) * this.cnorm;
      }
      case 'tremolo': {
        if ((this.ph += this.hz / this.sr) >= 1) this.ph -= 1;
        const d = clamp01(this.v.depth);
        return x * (1 - d * (this.f.square ? (this.ph < 0.5 ? 0 : 1) : hump(this.ph)));
      }
    }
    return x; // autopan: the host pans by .pan
  }
}

// A chain of effects playing. set(list, ctx) with ctx { music, bps, drums, len }: the stages, keeping each kind's
// state across a change (no click when a knob turns); noteOn(vel) starts the moves (and a filter's envelope) again;
// run(x, loud) puts a sample through (loud: the loudest note's level, for a swell or a wah that follows notes);
// pan: where an auto-pan has the sound (−1–1), for the host to read.
export class FxChain {
  constructor(sr) {
    this.sr = sr;
    this.stages = []; this.byKind = {};
    this.n = 0; this.t = 0; this.timer = 0; this.pan = 0; this.panning = false; this.moving = false;
  }
  set(list, ctx = {}) {
    const fx = fxList(list, ctx.music).filter((f) => !f.off), by = {};
    this.stages = fx.map((f) => { let s = this.byKind[f.kind]; if (s) s.set(f, ctx); else s = new Stage(f, this.sr, ctx); by[f.kind] = s; return s; });
    this.byKind = by;
    this.n = this.stages.length;
    this.panning = !!by.autopan;
    if (!this.panning) this.pan = 0;
    this.moving = this.stages.some((s) => s.moves.length);
    this.timer = 0;
    return this;
  }
  noteOn(vel = 1) { this.t = 0; for (let i = 0; i < this.n; i++) this.stages[i].noteOn(vel); }
  run(x, loud = 1) {
    const st = this.stages, n = this.n;
    if (!n) return x;
    if (--this.timer <= 0) {
      this.timer = CTL;
      for (let i = 0; i < n; i++) st[i].control(this.t, loud);
      if (this.panning) this.pan = this.byKind.autopan.pan;
    }
    this.t += 1 / this.sr;
    for (let i = 0; i < n; i++) x = st[i].run(x);
    return x;
  }
}
