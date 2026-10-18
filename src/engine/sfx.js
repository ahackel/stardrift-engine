// Game sounds (song.sounds): short sound effects made by synthesis, so a game ships no audio files: a jump, a coin, a
// hit, an explosion. One oscillator (or noise) whose pitch slides and jumps, a low pass, an envelope; each play varies
// a little (vary), can be tuned to the chord playing (key) and can wait for the beat (at). SfxVoice plays one;
// renderSound puts one into a buffer (the editor's picture of it, a WAV for another engine).
import { blep, svfSet, svf, LP, TWO_PI } from './dsp.js';
import { Rng } from './rng.js';

export const SFX_WAVES = ['square', 'triangle', 'saw', 'sine', 'noise'];
// every setting, and what it is when a sound leaves it out
export const SFX_DEFAULTS = {
  wave: 'square',
  pitch: 440, // Hz at the start
  slide: 0, // semitones the pitch moves over the sound (−: down)
  length: 0.25, // seconds
  noise: 0, // 0–1: noise mixed in (pitched: it follows the pitch)
  punch: 0.5, // 0–1: 0 holds on and fades at the end, 1 hits and dies away at once
  tone: 1, // 0–1: the low pass, dark to open
  sweep: 0, // −1–1: the low pass moves over the sound (by up to 5 octaves)
  attack: 0, // 0–1 of the length: how slowly it comes in
  duty: 0.5, // the square's width, 0.05–0.5 (thinner: nasal)
  jump: 0, // semitones the pitch jumps by, at jumpAt (a coin: up a fourth)
  jumpAt: 0.3, // 0–1 of the length
  vibrato: 0, // 0–1: up to a semitone
  vibRate: 12, // Hz
  repeat: 0, // seconds: the pitch starts over this often, its slide and jump over each repeat (an alarm, a ratchet); 0: once
  crush: 0, // 0–1: fewer bits, a lower rate
  echo: 0, // 0–1: send to the song's echo
  reverb: 0.1, // 0–1: send to the song's reverb
  volume: 0.7,
  vary: 0.15, // 0–1: how much each play differs (pitch, length, tone)
  key: false, // tuned to the nearest note of the chord playing (and a jump to the next one)
  at: 'now', // 'now' | 'step' | 'beat': when it starts
  duck: 0, // 0–1: the music gets this much quieter while it sounds
};
const KEYS = Object.keys(SFX_DEFAULTS);
export const SFX_AT = ['now', 'step', 'beat'];
// the numbers' ranges: [key, min, max]
export const SFX_RANGES = [['pitch', 20, 8000], ['slide', -72, 72], ['length', 0.01, 4], ['noise', 0, 1], ['punch', 0, 1], ['tone', 0, 1], ['sweep', -1, 1],
  ['attack', 0, 1], ['duty', 0.05, 0.5], ['jump', -36, 36], ['jumpAt', 0, 1], ['vibrato', 0, 1], ['vibRate', 0.5, 40], ['repeat', 0, 4], ['crush', 0, 1],
  ['echo', 0, 1], ['reverb', 0, 1], ['volume', 0, 1], ['vary', 0, 1], ['duck', 0, 1]];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

// a sound with every setting there, in range
export function soundOf(def = {}) {
  const d = SFX_DEFAULTS, s = {};
  for (const k of KEYS) s[k] = def[k] ?? d[k];
  s.wave = SFX_WAVES.includes(s.wave) ? s.wave : d.wave;
  s.pitch = clamp(num(s.pitch, d.pitch), 20, 8000);
  s.slide = clamp(num(s.slide, 0), -72, 72);
  s.length = clamp(num(s.length, d.length), 0.01, 4);
  for (const k of ['noise', 'punch', 'tone', 'attack', 'vibrato', 'crush', 'echo', 'reverb', 'volume', 'vary', 'duck', 'jumpAt']) s[k] = clamp(num(s[k], d[k]), 0, 1);
  s.sweep = clamp(num(s.sweep, 0), -1, 1);
  s.duty = clamp(num(s.duty, d.duty), 0.05, 0.5);
  s.jump = clamp(num(s.jump, 0), -36, 36);
  s.vibRate = clamp(num(s.vibRate, d.vibRate), 0.5, 40);
  s.repeat = clamp(num(s.repeat, 0), 0, 4);
  s.key = !!s.key;
  return s;
}

// One play's settings, worked out once: the sound, varied by rng, opts ({ pitch: × , volume, pan }), and tuned
// by snap (midi → the chord tone to play, or null)
export function playOf(def, rng, opts = {}, snap = null) {
  const s = soundOf(def), v = s.vary;
  const r = () => rng.next() * 2 - 1;
  let pitch = s.pitch * num(opts.pitch, 1) * Math.pow(2, (r() * v * 3) / 12), jump = s.jump;
  if (snap && s.key) {
    const m = 69 + 12 * Math.log2(pitch / 440), m0 = snap(m, 0);
    if (m0 != null) {
      pitch = 440 * Math.pow(2, (m0 - 69) / 12);
      if (jump) { const mj = snap(m0 + jump, Math.sign(jump)); if (mj != null && mj !== m0) jump = mj - m0; }
    }
  }
  return {
    ...s, pitch, jump,
    length: s.length * (1 + r() * v * 0.3),
    tone: clamp(s.tone + r() * v * 0.15, 0, 1),
    gain: s.volume * s.volume * clamp(num(opts.volume, 1), 0, 2),
    pan: clamp(num(opts.pan, 0), -1, 1),
    seed: (rng.next() * 4294967296) >>> 0,
  };
}

const CTL = 32; // samples between control values (pitch, envelope, the low pass)

// One sound playing. start(p) with a play's settings (playOf); render() returns its next (mono) sample; done once over.
export class SfxVoice {
  constructor(sr) {
    this.sr = sr;
    this.done = true;
    this.f = { mode: LP, k: 1.2, a1: 0, a2: 0, a3: 0 };
    this.st = { ic1: 0, ic2: 0 };
  }
  start(p) {
    const sr = this.sr;
    this.p = p;
    this.n = Math.max(CTL, Math.round(p.length * sr));
    this.t = 0;
    this.ph = 0; this.inc = 0; this.nz = 0; this.nzPh = 0;
    this.env = 0; this.envTo = 0; this.envD = 0;
    this.att = Math.max(Math.round(0.001 * sr), Math.round(p.attack * this.n));
    this.pow = 0.5 + 3 * p.punch;
    this.rep = p.repeat > 0 ? Math.max(CTL, Math.round(p.repeat * sr)) : 0;
    this.cut0 = 200 * Math.pow(2, p.tone * 6.7);
    this.filt = p.tone < 0.999 || p.sweep !== 0;
    this.st.ic1 = this.st.ic2 = 0;
    this.rng = new Rng(p.seed || 1);
    this.levels = Math.pow(2, 11 - 9 * p.crush); this.cStep = Math.pow(2, -4 * p.crush); this.cPh = 1; this.hold = 0;
    this.pl = Math.sqrt(0.5 * (1 - p.pan)); this.pr = Math.sqrt(0.5 * (1 + p.pan));
    this.done = false;
    this.control();
  }
  // the next control values: where the pitch, the envelope and the low pass are CTL samples on
  control() {
    const p = this.p, sr = this.sr, t = this.t, n = this.n, u = t / n;
    const up = this.rep ? (t % this.rep) / this.rep : u; // with repeat, the slide and the jump run over each repeat
    let semis = p.slide * up + (p.jump && up >= p.jumpAt ? p.jump : 0);
    if (p.vibrato) semis += p.vibrato * Math.sin((TWO_PI * p.vibRate * t) / sr);
    const f = Math.min(sr * 0.45, p.pitch * Math.pow(2, semis / 12));
    this.inc = f / sr;
    const te = Math.min(n, t + CTL);
    const e = te < this.att ? te / this.att : Math.pow(Math.max(0, 1 - (te - this.att) / Math.max(1, n - this.att)), this.pow);
    this.envD = (e - this.env) / CTL;
    if (this.filt) svfSet(this.f, Math.min(sr * 0.45, this.cut0 * Math.pow(2, p.sweep * 5 * u)), 1.2, sr).mode = LP;
  }
  render() {
    if (this.done) return 0;
    const p = this.p;
    if (this.t % CTL === 0 && this.t) this.control();
    const dt = this.inc;
    let ph = this.ph + dt;
    if (ph >= 1) ph -= 1;
    this.ph = ph;
    let x = 0;
    if (p.noise < 1 && p.wave !== 'noise') {
      if (p.wave === 'square') { x = ph < p.duty ? 1 : -1; x += blep(ph, dt); let q = ph - p.duty; if (q < 0) q += 1; x -= blep(q, dt); }
      else if (p.wave === 'saw') x = 2 * ph - 1 - blep(ph, dt);
      else if (p.wave === 'triangle') x = ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph;
      else x = Math.sin(TWO_PI * ph);
    }
    const nAmt = p.wave === 'noise' ? 1 : p.noise;
    if (nAmt > 0) {
      if ((this.nzPh += dt * 32) >= 1) { this.nzPh -= Math.floor(this.nzPh); this.nz = this.rng.next() * 2 - 1; } // a new value 32 times a period
      x = x * (1 - nAmt) + this.nz * nAmt;
    }
    if (this.filt) x = svf(this.f, this.st, x);
    if (p.crush > 0.001) {
      if ((this.cPh += this.cStep) >= 1) { this.cPh -= 1; this.hold = Math.round(x * this.levels) / this.levels; }
      x = this.hold;
    }
    this.env += this.envD;
    if (++this.t >= this.n) this.done = true;
    return x * (this.env > 0 ? this.env : 0) * p.gain * 0.8;
  }
}

// A sound into a buffer, dry and mono: Float32Array at sr. seed varies it (vary 0: always the same).
export function renderSound(def, { sr = 48000, seed = 1, opts } = {}) {
  const p = playOf(def, new Rng(seed), opts), v = new SfxVoice(sr);
  v.start(p);
  const out = new Float32Array(v.n);
  for (let i = 0; i < out.length; i++) out[i] = v.render();
  return out;
}
