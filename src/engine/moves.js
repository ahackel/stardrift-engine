// Effect rows (the grid). An effect track places effect blocks on a section's bars like any track, and each one moves
// one setting of the tracks the row targets (or of the whole mix) across the bars it plays: a filter sweep, a fade,
// an echo throw. Here: the kinds, their curves (fxAt, which the editor draws with too) and Moves, which plays them
// on a bus. The engine works out each row's value once a step; Moves ramps there over the step.
import { svfSet, svf, LP, HP } from './dsp.js';
import { MOVE_SHAPES } from './fx.js';

// each kind: its range, the value that changes nothing (off), its default from and to; log: moves in octaves (Hz)
export const FX_KINDS = {
  filter: { min: 60, max: 16000, off: 16000, log: true, def: [16000, 400] }, // a low pass
  highpass: { min: 20, max: 8000, off: 20, log: true, def: [20, 2000] },
  volume: { min: 0, max: 1, off: 1, def: [1, 0] }, // as a fader: 0.5 is about −12 dB
  echo: { min: 0, max: 1, off: 0, def: [0, 0.6] }, // more send to the song's echo
  reverb: { min: 0, max: 1, off: 0, def: [0, 0.8] }, // more send to the reverb
  pan: { min: -1, max: 1, off: 0, def: [-0.8, 0.8] },
  gate: { min: 0, max: 1, off: 0, def: [0, 1] }, // chops the sound in time: depth (rate: beats, 0.25)
  crush: { min: 0, max: 1, off: 0, def: [0, 0.8] }, // fewer bits, a lower rate
};
export const FX_SHAPES = MOVE_SHAPES; // the same shapes as the moves of an instrument's or a sound's knobs
// the kinds the whole mix takes on the master; the rest are each track's (its pan, its sends)
const MIX_KINDS = new Set(['filter', 'highpass', 'volume', 'gate', 'crush']);
export const onMix = (kind) => MIX_KINDS.has(kind);

const clampTo = (k, v) => Math.min(k.max, Math.max(k.min, +v));
// fx's value u (0–1) of the way through the bars it plays on, b beats in: ramp from → to, hump from → to → from,
// wave between them every `beats` (4), step from → to at `at` of the way (0: at to all along; older songs: hold)
export function fxAt(fx, u, b) {
  const k = FX_KINDS[fx?.kind];
  if (!k) return null;
  const from = clampTo(k, fx.from ?? k.def[0]), to = clampTo(k, fx.to ?? k.def[1]);
  let t;
  if (fx.shape === 'hump') t = 0.5 - 0.5 * Math.cos(2 * Math.PI * u);
  else if (fx.shape === 'wave') t = 0.5 - 0.5 * Math.cos((2 * Math.PI * b) / Math.max(0.25, fx.beats || 4));
  else if (fx.shape === 'step' || fx.shape === 'hold') t = u >= (fx.shape === 'hold' ? 0 : +fx.at || 0) ? 1 : 0;
  else t = Math.min(1, Math.max(0, u));
  return k.log ? from * Math.pow(to / from, t) : from + (to - from) * t;
}
// two rows moving the same setting of one bus: the lower low pass, the higher high pass, the faders multiply, the rest add
export function fxJoin(kind, a, b) {
  if (a === undefined) return b;
  if (kind === 'filter') return Math.min(a, b);
  if (kind === 'highpass' || kind === 'gate' || kind === 'crush') return Math.max(a, b);
  if (kind === 'volume') return a * b;
  return Math.max(-1, Math.min(1, a + b));
}

const OFF_LP = Math.log2(16000), OFF_HP = Math.log2(20);
// One bus's moves (a track's, mono; the master's, two channels). to() sets where each value goes over n samples;
// tick() moves them once a sample; run() puts a sample through (filters, crush, gate, volume). pan, echo and rev
// are for the bus to read.
export class Moves {
  constructor(sr, ch = 1) {
    this.sr = sr;
    this.lp = OFF_LP; this.hp = OFF_HP; this.vol = 1; this.gate = 0; this.crush = 0; this.pan = 0; this.echo = 0; this.rev = 0;
    this.d = { lp: 0, hp: 0, vol: 0, gate: 0, crush: 0, pan: 0, echo: 0, rev: 0 };
    this.left = 0; // samples the ramps still run
    this.on = false; // anything moved: run() is needed
    this.lpC = { mode: LP, k: 1.2, a1: 0, a2: 0, a3: 0 }; this.hpC = { mode: HP, k: 1.2, a1: 0, a2: 0, a3: 0 };
    this.st = Array.from({ length: ch }, () => ({ l: { ic1: 0, ic2: 0 }, h: { ic1: 0, ic2: 0 }, ph: 1, hold: 0 }));
    this.cT = 0; // countdown to new filter coefficients
    this.gPh = 0; this.gInc = 0; this.gLvl = 1; this.gK = 1 - Math.exp(-1 / (0.003 * sr)); // the gate: its wave, its level (3 ms edges)
    this.setCoefs();
  }
  // v: { filter, highpass, volume, gate, crush, pan, echo, reverb, rate, phase } (missing: off), or null: all off
  to(v, n, bps) {
    n = Math.max(1, n | 0);
    v ||= {};
    const go = (key, target) => { this.d[key] = (target - this[key]) / n; };
    go('lp', Math.log2(v.filter ?? 16000)); go('hp', Math.log2(v.highpass ?? 20)); go('vol', v.volume ?? 1);
    go('gate', v.gate ?? 0); go('crush', v.crush ?? 0); go('pan', v.pan ?? 0); go('echo', v.echo ?? 0); go('rev', v.reverb ?? 0);
    if (v.gate) { this.gPh = v.phase || 0; this.gInc = bps / (Math.max(0.0625, v.rate || 0.25) * this.sr); }
    this.left = n;
    this.on = true;
  }
  tick() {
    if (this.left > 0) {
      const d = this.d;
      this.lp += d.lp; this.hp += d.hp; this.vol += d.vol; this.gate += d.gate; this.crush += d.crush;
      this.pan += d.pan; this.echo += d.echo; this.rev += d.rev;
      if (--this.left === 0) this.on = this.lp < OFF_LP - 0.01 || this.hp > OFF_HP + 0.01 || Math.abs(this.vol - 1) > 1e-4 || this.gate > 1e-3
        || this.crush > 1e-3 || Math.abs(this.pan) > 1e-3 || this.echo > 1e-4 || this.rev > 1e-4;
    }
    if (!this.on) return;
    if (--this.cT <= 0) { this.cT = 16; this.setCoefs(); }
    if (this.gate > 1e-3) {
      if ((this.gPh += this.gInc) >= 1) this.gPh -= 1;
      this.gLvl += ((this.gPh < 0.5 ? 1 : 1 - this.gate) - this.gLvl) * this.gK;
    } else this.gLvl = 1;
  }
  setCoefs() {
    svfSet(this.lpC, Math.pow(2, this.lp), 1.2, this.sr).mode = LP;
    svfSet(this.hpC, Math.pow(2, this.hp), 1.2, this.sr).mode = HP;
    if (this.crush > 1e-3) { this.levels = Math.pow(2, 11 - 9 * this.crush); this.cStep = Math.pow(2, -4 * this.crush); }
  }
  run(x, c = 0) {
    const st = this.st[c];
    if (this.lp < OFF_LP - 0.01) x = svf(this.lpC, st.l, x);
    if (this.hp > OFF_HP + 0.01) x = svf(this.hpC, st.h, x);
    if (this.crush > 1e-3) {
      if ((st.ph += this.cStep) >= 1) { st.ph -= 1; st.hold = Math.round(x * this.levels) / this.levels; }
      x = st.hold;
    }
    return x * this.vol * this.vol * this.gLvl;
  }
}
