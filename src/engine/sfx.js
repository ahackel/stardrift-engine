// Game sounds (song.sounds): short sound effects made by synthesis, so a game ships no audio files: a jump, a coin, a
// hit, an explosion. A sound plays an instrument (inst.js: up to three layers, the note's effects, a chain of effects
// in any order): one of the song's (instrument: its key), the same one a track can play, or its own (inst). It plays
// one note: its pitch (note, in midi notes) and how long it is held (length, seconds), and how it plays in the game:
// { id, instrument, note, length, volume, echo, reverb, duck, vary, key, at }. Any
// setting of a layer or an effect can move over the sound (a move: a ramp, a hump, a wave, a step), so a slide is a
// pitch that ramps, a sweep a filter that ramps. Each play varies a little (vary), can be tuned to the chord playing
// (key) and can wait for the beat (at). SfxVoice plays one; renderSound puts one into a buffer (a picture, a WAV).
import { Rng } from './rng.js';
import { FxChain } from './fx.js';
import { compileInst, timeMoves, Voice, IDLE } from './voice.js';
import { migrateSound, noteTail, MAX_LAYERS } from './inst.js';

export const SFX_AT = ['now', 'step', 'beat'];

// a setting: its range, its default, and whether it moves in octaves (log)
const P = (min, max, def, log = false) => ({ min, max, def, log });
// the sound's own settings: the note it plays, and how it plays in the game
export const SFX_PARAMS = {
  note: P(24, 108, 69), // midi notes (69: A4, 440 Hz)
  length: P(0.01, 4, 0.25, true), // seconds the note is held (each layer's envelope shapes it)
  volume: P(0, 1, 0.7),
  echo: P(0, 1, 0), // send to the song's echo
  reverb: P(0, 1, 0.1), // send to the song's reverb
  duck: P(0, 1, 0), // the music gets this much quieter while it sounds
  vary: P(0, 1, 0.15), // how much each play differs (pitch, length, the filter)
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const inP = (p, v) => clamp(num(v, p.def), p.min, p.max);

// a sound with its instrument in inst: the song's it names (or its own)
export function resolveSound(song, def) {
  if (!def || typeof def !== 'object' || def.inst || typeof def.instrument !== 'string') return def;
  const inst = song?.instruments?.[def.instrument];
  return inst && inst.type !== 'drums' ? { ...def, inst } : def;
}
// a sound as it is now (inst.js migrateSound), with its own settings there and in range; its instrument (inst, as
// resolveSound puts it there) with at least one layer and a list of effects
export function soundOf(def = {}) {
  const s = migrateSound(def) || {}, i = s.inst && typeof s.inst === 'object' ? s.inst : {};
  const out = { ...s };
  for (const [k, p] of Object.entries(SFX_PARAMS)) out[k] = inP(p, s[k]);
  out.key = !!s.key;
  out.at = SFX_AT.includes(s.at) ? s.at : 'now';
  out.inst = { ...i, layers: Array.isArray(i.layers) && i.layers.length ? i.layers.slice(0, MAX_LAYERS) : [{}], fx: Array.isArray(i.fx) ? i.fx : [] };
  return out;
}
// how long it lasts, in seconds: until its layers are quiet, and the tail of its delays (s: as soundOf has it)
export function soundLength(s) {
  const inst = s.inst || {};
  let end = noteTail(inst, s.length);
  for (const f of inst.fx || []) if (f.kind === 'delay' && !f.off) end += Math.min(1.5, (f.time ?? 0.25) * (1 + 8 * (f.feedback ?? 0.3) ** 2) + 0.05 * (f.mix ?? 0.3)); // the echoes ring on
  return clamp(end, 0.01, 10);
}

// One play: the sound (its instrument in inst: resolveSound) varied by rng, opts ({ pitch: ×, volume, pan, bps: the
// song's beats per second, for moves in beats }), and tuned by snap (midi, dir → the chord tone to play, or null).
// def: the instrument as it plays this time, note, length, the whole length, gain, pan, bps, seed.
export function playOf(def, rng, opts = {}, snap = null) {
  const s = soundOf(def), v = s.vary, i = s.inst;
  const r = () => rng.next() * 2 - 1;
  let note = s.note + 12 * Math.log2(clamp(num(opts.pitch, 1), 0.05, 20)) + r() * v * 3;
  const stretch = 1 + r() * v * 0.3, cut = Math.pow(2, r() * v * 0.5);
  if (snap && s.key) { const m = snap(note, 0); if (m != null) note = m; }
  const layers = i.layers.filter((l) => l && !l.off).map((l) => {
    if (!(snap && s.key) || !Array.isArray(l.moves)) return l;
    // a step of the pitch goes to the chord tone that way
    const at = note + (+l.pitch || 0);
    const moves = l.moves.map((m) => {
      if (m?.on !== 'pitch' || m.shape !== 'step') return m;
      const to = note + (+m.to || 0), ms = snap(to, Math.sign(to - at));
      return ms != null && Math.round(ms) !== Math.round(at) ? { ...m, to: ms - note } : m;
    });
    return { ...l, moves };
  });
  const fx = i.fx.filter((f) => f && !f.off).map((f) => (f.kind === 'filter' ? { ...f, cutoff: clamp((f.cutoff ?? 1000) * cut, 40, 16000) } : f));
  const inst = { ...i, layers: layers.length ? layers : [{ level: 0 }], fx };
  const p = { def: inst, note: clamp(note, 0, 127), gate: s.length * stretch, echo: s.echo, reverb: s.reverb, duck: s.duck, gain: s.volume * s.volume * clamp(num(opts.volume, 1), 0, 2), pan: clamp(num(opts.pan, 0), -1, 1), bps: clamp(num(opts.bps, 2), 0.25, 8), seed: (rng.next() * 4294967296) >>> 0 || 1 };
  p.length = soundLength({ inst, length: p.gate });
  return p;
}

// One sound playing: a voice of its instrument, held for its length, through its effects. start(p) with a play's
// settings (playOf); render() returns its next (mono) sample, and pl, pr are where it sits (an auto-pan moves them).
export class SfxVoice {
  constructor(sr) {
    this.sr = sr;
    this.done = true;
    this.v = new Voice();
    this.fx = new FxChain(sr); // the effects (fx.js), as the tracks have them
  }
  start(p, samples = {}) {
    const sr = this.sr;
    this.p = p;
    this.inst = compileInst(p.def, sr, samples);
    timeMoves(this.inst, { music: false, len: p.gate, bps: p.bps });
    this.n = Math.max(1, Math.round(p.length * sr));
    this.off = Math.max(1, Math.round(p.gate * sr));
    this.t = 0; this.apT = 0;
    this.v.stop();
    this.v.seed = p.seed;
    for (const o of this.v.osc) o.ph.fill(0); // every play starts its waves alike
    this.v.start(this.inst, p.note, 1, null, false);
    this.fx.set(this.inst.fx, { music: false, len: p.gate, bps: p.bps });
    this.fx.noteOn(1);
    this.place(0);
    this.done = false;
  }
  place(off) { const pan = clamp(this.p.pan + off, -1, 1); this.pl = Math.sqrt(0.5 * (1 - pan)); this.pr = Math.sqrt(0.5 * (1 + pan)); }
  render() {
    if (this.done) return 0;
    const v = this.v;
    if (this.t === this.off) v.release();
    const x = v.stage !== IDLE ? v.render(this.inst) : 0;
    if (this.fx.panning && --this.apT <= 0) { this.apT = 16; this.place(this.fx.pan); }
    const y = this.fx.run(x, v.level);
    if (++this.t >= this.n) this.done = true;
    return y * this.inst.gain * this.p.gain * 0.8;
  }
}

// A sound into a buffer, dry and mono: Float32Array at sr. seed varies it (vary 0: always the same).
export function renderSound(def, { sr = 48000, seed = 1, opts, samples } = {}) {
  const p = playOf(def, new Rng(seed), opts), v = new SfxVoice(sr);
  v.start(p, samples);
  const out = new Float32Array(v.n);
  for (let i = 0; i < out.length; i++) out[i] = v.render();
  return out;
}
