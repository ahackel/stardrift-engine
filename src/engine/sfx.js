// Game sounds (song.sounds): short sound effects made by synthesis, so a game ships no audio files: a jump, a coin, a
// hit, an explosion. A sound is up to three layers (a wave or noise with its own envelope, each starting when it
// likes), summed into a chain of effects in any order. Any setting of a layer or an effect can move over the sound
// (a move: a ramp, a hump, a wave, a step), so a slide is a pitch that ramps, a sweep a filter that ramps, a vibrato
// a pitch on a wave. Each play varies a little (vary), can be tuned to the chord playing (key) and can wait for the
// beat (at). SfxVoice plays one; renderSound puts one into a buffer (the editor's picture of it, a WAV).
import { blep, TWO_PI } from './dsp.js';
import { Rng } from './rng.js';
import { EFFECT_KINDS, FILTER_TYPES, MOVE_SHAPES, MOVE_PARAMS, fxParams, fxList, movesOf, valueAt, FxChain } from './fx.js';

export const SFX_WAVES = ['square', 'triangle', 'saw', 'sine', 'noise'];
export const SFX_AT = ['now', 'step', 'beat'];
export const SFX_SHAPES = MOVE_SHAPES;
export const SFX_MAX_LAYERS = 3;

// a setting: its range, its default, and whether it moves in octaves (log)
const P = (min, max, def, log = false) => ({ min, max, def, log });
// a layer's settings
export const LAYER_PARAMS = {
  pitch: P(20, 8000, 440, true), // Hz
  length: P(0.01, 4, 0.25, true), // seconds
  attack: P(0, 1, 0), // of the length: how slowly it comes in
  punch: P(0, 1, 0.5), // 0 holds on and fades at the end, 1 hits and dies away at once
  noise: P(0, 1, 0), // noise mixed in, pitched by the pitch
  duty: P(0.05, 0.5, 0.5), // the square's width
  level: P(0, 1, 1),
  delay: P(0, 2, 0), // seconds after the sound starts
};
// the settings of a layer that can move over it
export const LAYER_MOVES = ['pitch', 'level', 'noise', 'duty'];
// the effects (fx.js), each with its settings as a sound has them (all of them can move)
export const SFX_FX = Object.fromEntries(Object.keys(EFFECT_KINDS).map((k) => [k, fxParams(k, false)]));
// the sound's own settings
export const SFX_PARAMS = {
  volume: P(0, 1, 0.7),
  echo: P(0, 1, 0), // send to the song's echo
  reverb: P(0, 1, 0.1), // send to the song's reverb
  duck: P(0, 1, 0), // the music gets this much quieter while it sounds
  vary: P(0, 1, 0.15), // how much each play differs (pitch, length, the filter)
};
// a move's own settings in a sound: rate (a wave's, Hz), at (a step's, of the way through), every (seconds: it starts over; 0 once)
export const SFX_MOVE_PARAMS = MOVE_PARAMS.sound;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const inP = (p, v) => clamp(num(v, p.def), p.min, p.max);

// a layer with every setting there; off: muted for now
export function layerOf(def = {}) {
  const l = { wave: SFX_WAVES.includes(def.wave) ? def.wave : 'square', off: !!def.off };
  for (const [k, p] of Object.entries(LAYER_PARAMS)) l[k] = inP(p, def[k]);
  l.moves = (Array.isArray(def.moves) ? def.moves : []).filter((m) => LAYER_MOVES.includes(m?.on));
  return l;
}
// a sound with every setting there, in range: its layers (at least one), its effects, its own settings
export function soundOf(def = {}) {
  const s = {};
  for (const [k, p] of Object.entries(SFX_PARAMS)) s[k] = inP(p, def[k]);
  s.key = !!def.key;
  s.at = SFX_AT.includes(def.at) ? def.at : 'now';
  const layers = Array.isArray(def.layers) && def.layers.length ? def.layers.slice(0, SFX_MAX_LAYERS) : [{}];
  s.layers = layers.map(layerOf);
  s.fx = fxList(def.fx, false);
  return s;
}
// how long it lasts, in seconds: to the end of its last layer, and the tail of its delays
export function soundLength(s) {
  let end = 0;
  for (const l of s.layers) if (!l.off) end = Math.max(end, l.delay + l.length);
  for (const f of s.fx) if (f.kind === 'delay' && !f.off) end += Math.min(1.5, f.time * (1 + 8 * f.feedback * f.feedback) + 0.05 * f.mix); // the echoes ring on
  return Math.max(0.01, end);
}

// One play's settings, worked out once: the sound, varied by rng, opts ({ pitch: ×, volume, pan }), and tuned by
// snap (midi, dir → the chord tone to play, or null). Every layer's pitch moves with the first, so the intervals stay.
export function playOf(def, rng, opts = {}, snap = null) {
  const s = soundOf(def), v = s.vary;
  const r = () => rng.next() * 2 - 1;
  let k = num(opts.pitch, 1) * Math.pow(2, (r() * v * 3) / 12);
  const stretch = 1 + r() * v * 0.3, cut = Math.pow(2, r() * v * 0.5);
  const first = s.layers.find((l) => !l.off) || s.layers[0], lp = LAYER_PARAMS.pitch;
  if (snap && s.key) {
    const m0 = snap(69 + 12 * Math.log2((first.pitch * k) / 440), 0);
    if (m0 != null) k = (440 * Math.pow(2, (m0 - 69) / 12)) / first.pitch;
  }
  const midi = (f) => 69 + 12 * Math.log2(f / 440);
  const layers = s.layers.filter((l) => !l.off).map((l) => {
    const pitch = clamp(l.pitch * k, lp.min, lp.max), length = l.length * stretch;
    const moves = movesOf(l.moves, LAYER_PARAMS, { len: length }).map((m) => {
      if (m.on !== 'pitch') return m;
      let to = clamp(m.to * k, lp.min, lp.max);
      if (snap && s.key && m.shape === 'step') { // a step goes to the next chord tone that way
        const m0 = Math.round(midi(pitch)), mt = midi(to), ms = snap(mt, Math.sign(mt - m0));
        if (ms != null && ms !== m0) to = 440 * Math.pow(2, (ms - 69) / 12);
      }
      return { ...m, to };
    });
    return { ...l, pitch, moves, length, delay: l.delay * stretch };
  });
  const fx = s.fx.filter((f) => !f.off).map((f) => (f.kind === 'filter' ? { ...f, cutoff: clamp(f.cutoff * cut, 40, 16000) } : f));
  const p = { ...s, layers, fx, gain: s.volume * s.volume * clamp(num(opts.volume, 1), 0, 2), pan: clamp(num(opts.pan, 0), -1, 1), seed: (rng.next() * 4294967296) >>> 0 };
  p.length = soundLength(p);
  return p;
}

const CTL = 32; // samples between control values (the pitches, the envelopes)

// one layer playing: its wave, its noise, its envelope
class Layer {
  start(l, sr, rng) {
    this.l = l;
    this.d = Math.round(l.delay * sr);
    this.n = Math.max(CTL, Math.round(l.length * sr));
    this.ph = 0; this.inc = 0; this.nz = 0; this.nzPh = 0; this.duty = l.duty; this.noise = l.noise; this.lvl = l.level;
    this.env = 0; this.envD = 0;
    this.att = Math.max(Math.round(0.001 * sr), Math.round(l.attack * this.n));
    this.pow = 0.5 + 3 * l.punch;
    this.rng = rng;
  }
  // the control values CTL samples on, t samples into the sound
  control(t, sr) {
    const l = this.l, lt = t - this.d, n = this.n;
    if (lt < 0 || lt >= n) { this.envD = -this.env / CTL; return; }
    const ts = lt / sr, mv = l.moves;
    this.inc = Math.min(sr * 0.45, mv.length ? valueAt(l.pitch, 'pitch', mv, LAYER_PARAMS.pitch, ts) : l.pitch) / sr;
    if (mv.length) {
      this.lvl = valueAt(l.level, 'level', mv, LAYER_PARAMS.level, ts);
      this.noise = valueAt(l.noise, 'noise', mv, LAYER_PARAMS.noise, ts);
      this.duty = valueAt(l.duty, 'duty', mv, LAYER_PARAMS.duty, ts);
    }
    const te = Math.min(n, lt + CTL);
    const e = te < this.att ? te / this.att : Math.pow(Math.max(0, 1 - (te - this.att) / Math.max(1, n - this.att)), this.pow);
    this.envD = (e * this.lvl - this.env) / CTL;
  }
  render(t) {
    if (t < this.d) return 0;
    const l = this.l, dt = this.inc;
    let ph = this.ph + dt;
    if (ph >= 1) ph -= 1;
    this.ph = ph;
    let x = 0;
    const nAmt = l.wave === 'noise' ? 1 : this.noise;
    if (nAmt < 1) {
      if (l.wave === 'square') { const w = this.duty; x = ph < w ? 1 : -1; x += blep(ph, dt); let q = ph - w; if (q < 0) q += 1; x -= blep(q, dt); }
      else if (l.wave === 'saw') x = 2 * ph - 1 - blep(ph, dt);
      else if (l.wave === 'triangle') x = ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph;
      else x = Math.sin(TWO_PI * ph);
    }
    if (nAmt > 0) {
      if ((this.nzPh += dt * 32) >= 1) { this.nzPh -= Math.floor(this.nzPh); this.nz = this.rng.next() * 2 - 1; } // a new value 32 times a period
      x = x * (1 - nAmt) + this.nz * nAmt;
    }
    this.env += this.envD;
    return x * (this.env > 0 ? this.env : 0);
  }
}

// One sound playing. start(p) with a play's settings (playOf); render() returns its next (mono) sample, and pl, pr
// are where it sits (an auto-pan moves them); done once over.
export class SfxVoice {
  constructor(sr) {
    this.sr = sr;
    this.done = true;
    this.layers = [];
    for (let i = 0; i < SFX_MAX_LAYERS; i++) this.layers.push(new Layer());
    this.fx = new FxChain(sr); // the effects (fx.js), as the tracks have them
  }
  start(p) {
    const sr = this.sr;
    this.p = p;
    this.n = Math.max(CTL, Math.round(p.length * sr));
    this.t = 0;
    this.rng = new Rng(p.seed || 1);
    this.nl = p.layers.length;
    for (let i = 0; i < this.nl; i++) this.layers[i].start(p.layers[i], sr, this.rng);
    this.fx.set(p.fx, { music: false, len: p.length });
    this.fx.noteOn(1);
    this.place(0);
    this.done = false;
    this.control();
  }
  place(off) { const pan = clamp(this.p.pan + off, -1, 1); this.pl = Math.sqrt(0.5 * (1 - pan)); this.pr = Math.sqrt(0.5 * (1 + pan)); }
  control() {
    let loud = 0;
    for (let i = 0; i < this.nl; i++) { const l = this.layers[i]; l.control(this.t, this.sr); if (l.env > loud) loud = l.env; }
    this.loud = loud;
    if (this.fx.panning) this.place(this.fx.pan);
  }
  render() {
    if (this.done) return 0;
    if (this.t % CTL === 0 && this.t) this.control();
    const t = this.t;
    let x = 0;
    for (let i = 0; i < this.nl; i++) x += this.layers[i].render(t);
    if (this.nl > 1) x *= 0.75;
    x = this.fx.run(x, this.loud);
    if (++this.t >= this.n) this.done = true;
    return x * this.p.gain * 0.8;
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
