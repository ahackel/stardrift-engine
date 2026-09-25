// Sample-by-sample chip synth: pulse (with PWM), NES-style 4-bit triangle, 32-step wavetable,
// synthesized drum kits (drums.js), per-track state-variable lowpass, ping-pong echo and a small Freeverb.
// Deliberately plain code (no Web Audio nodes) so it ports 1:1 to C# OnAudioFilterRead.

import { DrumVoice, compileKit } from './drums.js';

const TWO_PI = Math.PI * 2;
const IDLE = 0, ATT = 1, DEC = 2, REL = 3;

const TRI_TABLE = new Float32Array(32);
for (let i = 0; i < 32; i++) TRI_TABLE[i] = (i < 16 ? 15 - i : i - 16) / 7.5 - 1;


// 32 steps of 4-bit values (0..15): a preset name or a custom array (editor-drawable).
export const WAVE_PRESETS = ['soft', 'sine', 'saw', 'organ', 'hollow'];
export function waveSteps(spec) {
  if (Array.isArray(spec) && spec.length) {
    return Array.from({ length: 32 }, (_, i) => Math.max(0, Math.min(15, Math.round(+spec[i % spec.length] || 0))));
  }
  const t = new Float64Array(32);
  for (let i = 0; i < 32; i++) {
    const x = (i / 32) * TWO_PI;
    switch (spec) {
      case 'sine': t[i] = Math.sin(x); break;
      case 'saw': t[i] = 1 - (2 * i) / 32; break;
      case 'organ': t[i] = Math.sin(x) + 0.5 * Math.sin(2 * x) + 0.3 * Math.sin(3 * x); break;
      case 'hollow': t[i] = Math.sin(x) + 0.4 * Math.sin(3 * x); break;
      default: t[i] = Math.sin(x) + 0.35 * Math.sin(2 * x) + 0.12 * Math.sin(3 * x); // 'soft'
    }
  }
  let mx = 0;
  for (const v of t) mx = Math.max(mx, Math.abs(v));
  return Array.from(t, (v) => Math.round((v / mx + 1) * 7.5));
}

function makeWave(spec) {
  const t = new Float32Array(waveSteps(spec).map((v) => v / 7.5 - 1));
  let mean = 0;
  for (const v of t) mean += v / 32;
  for (let i = 0; i < 32; i++) t[i] -= mean;
  return t;
}

const TYPES = ['pulse', 'triangle', 'wave', 'drums'];

export function compileInst(def = {}, sr) {
  const env = def.env || {};
  const a = Math.max(0.001, env.a ?? 0.01), d = Math.max(0.001, env.d ?? 0.2), r = Math.max(0.001, env.r ?? 0.2);
  const U = Math.max(1, Math.min(4, def.unison | 0 || 1));
  const detuneMul = new Float64Array(U);
  for (let u = 0; u < U; u++) detuneMul[u] = Math.pow(2, (U === 1 ? 0 : (def.detune || 0) * (u / (U - 1) - 0.5)) / 1200);
  return {
    type: TYPES.includes(def.type) ? def.type : 'pulse',
    sr, invSr: 1 / sr,
    attInc: 1 / (a * sr), decCoef: Math.exp(-4.6 / (d * sr)), relCoef: Math.exp(-4.6 / (r * sr)),
    sus: Math.max(0, Math.min(1, env.s ?? 0.7)),
    U, uniNorm: 1 / Math.sqrt(U), detuneMul,
    duty: def.duty ?? 0.5, pwmDepth: def.pwm?.depth || 0, pwmRate: def.pwm?.rate || 0,
    vibDepth: def.vibrato?.depth || 0, vibRate: def.vibrato?.rate || 5, vibDelay: def.vibrato?.delay || 0,
    glideCoef: def.glide ? Math.exp(-4.6 / (def.glide * sr)) : 0,
    arpPeriod: def.arp ? 1 / def.arp : 0,
    table: def.type === 'wave' ? makeWave(def.wave || 'soft') : null,
    cutoff: def.cutoff ?? 16000, cutoffIntensity: def.cutoffIntensity || 0, cutoffTension: def.cutoffTension || 0,
    q: def.resonance ?? 0.707,
    gain: def.gain ?? 1,
    kit: def.type === 'drums' ? compileKit(def, sr) : null,
  };
}

function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

class Voice {
  constructor() {
    this.stage = IDLE; this.level = 0; this.gate = false;
    this.ph = new Float64Array(4); this.cur = 60; this.target = 60; this.vel = 1; this.age = 0;
    this.arp = null; this.arpIdx = 0; this.arpT = 0;
    for (let i = 0; i < 4; i++) this.ph[i] = Math.random();
  }
  start(p, midi, vel, arp) {
    const legato = this.stage !== IDLE && p.glideCoef > 0;
    this.target = midi;
    if (!legato) this.cur = midi;
    this.vel = vel; this.stage = ATT; this.gate = true; this.age = 0;
    this.arp = arp; this.arpIdx = 0; this.arpT = 0;
  }
  release() { if (this.stage !== IDLE) this.stage = REL; this.gate = false; }
  render(p) {
    let lv = this.level;
    switch (this.stage) {
      case IDLE: return 0;
      case ATT: lv += p.attInc; if (lv >= 1) { lv = 1; this.stage = DEC; } break;
      case DEC: lv = p.sus + (lv - p.sus) * p.decCoef; if (p.sus <= 0 && lv < 1e-4) this.stage = IDLE; break;
      case REL: lv *= p.relCoef; if (lv < 1e-4) this.stage = IDLE; break;
    }
    this.level = lv;
    if (this.stage === IDLE) { this.level = 0; return 0; }
    this.age += p.invSr;

    let m;
    if (this.arp) {
      this.arpT += p.invSr;
      if (this.arpT >= p.arpPeriod) { this.arpT -= p.arpPeriod; this.arpIdx = (this.arpIdx + 1) % this.arp.length; }
      m = this.arp[this.arpIdx];
    } else {
      this.cur = p.glideCoef ? this.target + (this.cur - this.target) * p.glideCoef : this.target;
      m = this.cur;
    }
    if (p.vibDepth && this.age > p.vibDelay) {
      const ramp = Math.min(1, (this.age - p.vibDelay) / 0.4);
      m += p.vibDepth * ramp * Math.sin(TWO_PI * p.vibRate * this.age);
    }
    const f = 440 * Math.pow(2, (m - 69) / 12);
    const sr = p.sr;
    let out = 0;
    let duty = p.duty;
    if (p.pwmDepth) duty += p.pwmDepth * Math.sin(TWO_PI * p.pwmRate * this.age);
    duty = duty < 0.05 ? 0.05 : duty > 0.95 ? 0.95 : duty;
    for (let u = 0; u < p.U; u++) {
      const dt = (f * p.detuneMul[u]) / sr;
      let ph = this.ph[u] + dt;
      if (ph >= 1) ph -= 1;
      this.ph[u] = ph;
      if (p.type === 'pulse') {
        let v = ph < duty ? 1 : -1;
        v += blep(ph, dt);
        let t2 = ph - duty;
        if (t2 < 0) t2 += 1;
        v -= blep(t2, dt);
        out += v - (2 * duty - 1); // remove DC of narrow pulses
      } else if (p.type === 'triangle') {
        out += TRI_TABLE[(ph * 32) | 0];
      } else {
        out += p.table[(ph * 32) | 0];
      }
    }
    return out * p.uniNorm * lv * this.vel;
  }
}

class TrackBus {
  constructor(poly, isDrum) {
    this.isDrum = isDrum;
    this.voices = Array.from({ length: poly }, () => (isDrum ? new DrumVoice() : new Voice()));
    this.ic1 = 0; this.ic2 = 0; this.cut = 1000; this.cutTarget = 1000; this.coefTimer = 0;
    this.g = 0; this.gTarget = 1; this.rr = 0;
  }
  set(tr, p, sr) {
    this.p = p; this.sr = sr;
    this.vol = (tr.volume ?? 0.3) * p.gain;
    const pan = Math.max(-1, Math.min(1, tr.pan || 0));
    this.pl = Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
    this.pr = Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
    this.echo = tr.echo || 0; this.rev = tr.reverb || 0;
    this.updateCoefs();
  }
  setMood(intensity, tension) {
    const p = this.p;
    this.cutTarget = Math.min(this.sr * 0.45, Math.max(40, p.cutoff + p.cutoffIntensity * intensity + p.cutoffTension * tension));
  }
  updateCoefs() {
    const g = Math.tan((Math.PI * Math.min(this.cut, this.sr * 0.45)) / this.sr);
    const k = 1 / Math.max(0.3, this.p.q);
    this.a1 = 1 / (1 + g * (g + k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
  }
  noteOn(midis, vel) {
    const p = this.p, vs = this.voices;
    if (vs.length === 1) {
      const arp = midis.length > 1 && p.arpPeriod ? midis.slice().sort((a, b) => a - b) : null;
      vs[0].start(p, arp ? arp[0] : midis[0], vel, arp);
      return;
    }
    for (const v of vs) if (v.gate) v.release();
    for (const m of midis) this.alloc().start(p, m, vel, null);
  }
  alloc() {
    let best = null, score = Infinity;
    for (const v of this.voices) {
      if (v.stage === IDLE) return v;
      const s = (v.gate ? 10 : 0) + v.level - v.age * 0.001;
      if (s < score) { score = s; best = v; }
    }
    best.stage = IDLE; best.level = 0;
    return best;
  }
  release() { if (!this.isDrum) for (const v of this.voices) if (v.gate) v.release(); }
  drum(hits, vel) {
    for (const h of hits) {
      const d = this.p.kit[h];
      if (!d) continue;
      if (h === 'h') for (const v of this.voices) if (v.active && v.kind === 'o') v.choke(this.sr);
      let v = this.voices.find((x) => !x.active);
      if (!v) { v = this.voices[this.rr]; this.rr = (this.rr + 1) % this.voices.length; }
      v.start(d, h, vel);
    }
  }
  allOff() {
    for (const v of this.voices) { if (this.isDrum) v.active = false; else { v.stage = IDLE; v.level = 0; v.gate = false; } }
  }
  idle() {
    for (const v of this.voices) if (this.isDrum ? v.active : v.stage !== IDLE) return false;
    return true;
  }
  render() {
    let x = 0;
    const p = this.p;
    if (this.isDrum) { for (const v of this.voices) if (v.active) x += v.render(this.sr, p.invSr); }
    else for (const v of this.voices) if (v.stage !== IDLE) x += v.render(p);

    if (--this.coefTimer <= 0) {
      this.coefTimer = 64;
      if (Math.abs(this.cut - this.cutTarget) > 0.5) {
        this.cut += (this.cutTarget - this.cut) * 0.006; // ~0.25 s glide
        this.updateCoefs();
      }
    }
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.g += (this.gTarget - this.g) * 0.0015;
    return v2 * this.vol * this.g;
  }
}

class Echo {
  constructor(sr) {
    this.sr = sr; this.max = Math.ceil(sr * 4);
    this.bl = new Float32Array(this.max); this.br = new Float32Array(this.max);
    this.i = 0; this.d = sr / 2; this.dTarget = this.d; this.fb = 0.4; this.k = 0.5; this.ll = 0; this.lr = 0;
  }
  set(sec, fb, damp) {
    this.dTarget = Math.max(1, Math.min(this.max - 2, Math.round(sec * this.sr)));
    this.fb = Math.min(0.95, fb); this.k = 1 - Math.min(0.95, damp);
  }
  process(x) {
    if (this.d !== this.dTarget) this.d += this.d < this.dTarget ? 1 : -1; // tape-style glide, no clicks
    let j = this.i - this.d;
    if (j < 0) j += this.max;
    const rl = this.bl[j], rr = this.br[j];
    this.ll += (rl - this.ll) * this.k;
    this.lr += (rr - this.lr) * this.k;
    this.bl[this.i] = x + this.lr * this.fb;
    this.br[this.i] = this.ll * this.fb;
    if (++this.i >= this.max) this.i = 0;
    this.outL = rl; this.outR = rr;
  }
}

class Reverb {
  constructor(sr) {
    const s = sr / 44100;
    const combs = [1116, 1188, 1277, 1356, 1422, 1491];
    const aps = [556, 441, 341];
    const mk = (n) => ({ buf: new Float32Array(Math.max(8, Math.round(n * s))), i: 0, f: 0 });
    this.cl = combs.map(mk); this.cr = combs.map((n) => mk(n + 23));
    this.al = aps.map(mk); this.ar = aps.map((n) => mk(n + 23));
    this.fb = 0.86; this.damp = 0.4;
  }
  set(size, damp) { this.fb = Math.min(0.97, size); this.damp = Math.min(0.95, damp); }
  run(combs, aps, x) {
    let o = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.f = y * (1 - this.damp) + c.f * this.damp;
      c.buf[c.i] = x + c.f * this.fb;
      if (++c.i >= c.buf.length) c.i = 0;
      o += y;
    }
    for (const a of aps) {
      const b = a.buf[a.i];
      a.buf[a.i] = o + b * 0.5;
      if (++a.i >= a.buf.length) a.i = 0;
      o = b - o;
    }
    return o;
  }
  process(x) {
    x *= 0.02;
    this.outL = this.run(this.cl, this.al, x);
    this.outR = this.run(this.cr, this.ar, x);
  }
}

export class Synth {
  constructor(sr) {
    this.sr = sr;
    this.tracks = {}; this.list = [];
    this.echo = new Echo(sr); this.reverb = new Reverb(sr);
    this.outL = 0; this.outR = 0;
    this.mutes = {}; this.solos = {};
    this.mood = [0.2, 0.1];
    this.pv = null; this.pvQ = []; this.pvI = 0; this.pvT = 0;
    this.duck = null;
  }
  configure(song) {
    const next = {};
    for (const tr of song.tracks) {
      const p = compileInst(tr.inst, this.sr);
      const isDrum = p.type === 'drums';
      const poly = isDrum ? 6 : Math.max(1, Math.min(16, tr.poly || 1));
      let bus = this.tracks[tr.id];
      if (!bus || bus.voices.length !== poly || bus.isDrum !== isDrum) bus = new TrackBus(poly, isDrum);
      bus.set(tr, p, this.sr);
      next[tr.id] = bus;
    }
    this.tracks = next;
    this.list = Object.values(next);
    const fx = song.fx;
    this.echo.set((fx.echo.beats * 60) / song.bpm, fx.echo.feedback, fx.echo.damp);
    this.echoLevel = fx.echo.level;
    this.reverb.set(fx.reverb.size, fx.reverb.damp);
    this.revLevel = fx.reverb.level;
    this.echoToRev = fx.echoToReverb;
    this.master = song.master.gain;
    this.updateGains();
  }
  setMood(intensity, tension) {
    this.mood = [intensity, tension];
    for (const b of this.list) b.setMood(intensity, tension);
    this.pv?.setMood(intensity, tension);
  }
  setMute(id, on) { this.mutes[id] = !!on; this.updateGains(); }
  setSolo(id, on) { this.solos[id] = !!on; this.updateGains(); }
  // stinger: every track except `keep` (ids) gets quieter by `amount`; null ends the ducking
  setDuck(keep, amount = 0) { this.duck = keep && amount > 0 ? { keep, amount } : null; this.updateGains(); }
  updateGains() {
    const anySolo = Object.keys(this.tracks).some((id) => this.solos[id]), d = this.duck;
    for (const id in this.tracks) {
      const g = anySolo ? (this.solos[id] ? 1 : 0) : this.mutes[id] ? 0 : 1;
      this.tracks[id].gTarget = d && !d.keep.includes(id) ? g * (1 - d.amount) : g;
    }
  }
  noteOn(id, midis, vel) { this.tracks[id]?.noteOn(midis, vel); }
  release(id) { this.tracks[id]?.release(); }
  drum(id, hits, vel) { this.tracks[id]?.drum(hits, vel); }
  allOff() { for (const b of this.list) b.allOff(); }
  releaseAll() { for (const b of this.list) b.release(); }

  // Audition an instrument outside the song (editor). events: [{ t: seconds, notes: [midi] | hit: 'k', dur, vel }]
  // Plays on its own bus that ignores mute/solo, so it works with the song held or playing.
  preview(def, events, { poly = 1, volume = 0.3 } = {}) {
    const p = compileInst(def, this.sr);
    const isDrum = p.type === 'drums';
    const voices = isDrum ? 6 : Math.max(1, Math.min(16, poly));
    if (!this.pv || this.pv.isDrum !== isDrum || this.pv.voices.length !== voices) this.pv = new TrackBus(voices, isDrum);
    this.pv.allOff();
    this.pv.set({ volume, echo: 0.08, reverb: 0.25 }, p, this.sr);
    this.pv.setMood(this.mood[0], this.mood[1]);
    this.pv.g = 1;
    const q = [];
    for (const ev of events || []) {
      const at = Math.round((ev.t || 0) * this.sr), vel = ev.vel ?? 0.8;
      if (ev.hit) q.push({ at, hit: ev.hit, vel });
      else if (ev.notes?.length) {
        q.push({ at, notes: ev.notes, vel });
        q.push({ at: at + Math.max(1, Math.round((ev.dur ?? 0.4) * this.sr)), off: true });
      }
    }
    // a release scheduled at the same sample as the next note must come first
    this.pvQ = q.sort((a, b) => a.at - b.at || (b.off ? 1 : 0) - (a.off ? 1 : 0));
    this.pvI = 0; this.pvT = 0;
  }

  renderSample() {
    let l = 0, r = 0, e = 0, v = 0;
    for (const b of this.list) {
      const x = b.render();
      l += x * b.pl; r += x * b.pr; e += x * b.echo; v += x * b.rev;
    }
    const pv = this.pv;
    if (pv) {
      while (this.pvI < this.pvQ.length && this.pvQ[this.pvI].at <= this.pvT) {
        const ev = this.pvQ[this.pvI++];
        if (ev.off) pv.release();
        else if (ev.hit) pv.drum([ev.hit], ev.vel);
        else pv.noteOn(ev.notes, ev.vel);
      }
      // once the preview has played out, drop its bus so it costs nothing (the echo/reverb tails live on the master)
      if ((++this.pvT & 4095) === 0 && this.pvI === this.pvQ.length && pv.idle()) this.pv = null;
      const x = pv.render();
      l += x; r += x; e += x * pv.echo; v += x * pv.rev;
    }
    this.echo.process(e);
    const el = this.echo.outL, er = this.echo.outR;
    this.reverb.process(v + (el + er) * 0.5 * this.echoToRev);
    const m = this.master;
    this.outL = Math.tanh((l + el * this.echoLevel + this.reverb.outL * this.revLevel) * m);
    this.outR = Math.tanh((r + er * this.echoLevel + this.reverb.outR * this.revLevel) * m);
  }
}
