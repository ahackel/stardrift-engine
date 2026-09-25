// Sample-by-sample chip synth: pulse (with PWM), NES-style 4-bit triangle, 32-step wavetable,
// LFSR noise drums, per-track state-variable lowpass, ping-pong echo and a small Freeverb.
// Deliberately plain code (no Web Audio nodes) so it ports 1:1 to C# OnAudioFilterRead.

const TWO_PI = Math.PI * 2;
const IDLE = 0, ATT = 1, DEC = 2, REL = 3;

const TRI_TABLE = new Float32Array(32);
for (let i = 0; i < 32; i++) TRI_TABLE[i] = (i < 16 ? 15 - i : i - 16) / 7.5 - 1;

export const DRUMS = {
  k: { tone: 1.0, f0: 170, f1: 45, sweep: 0.03, toneDecay: 0.12, noise: 0.25, rate: 9000, noiseDecay: 0.006, len: 0.6 },
  s: { tone: 0.45, f0: 230, f1: 175, sweep: 0.02, toneDecay: 0.05, noise: 0.7, rate: 14000, noiseDecay: 0.07, len: 0.5 },
  h: { noise: 0.32, rate: 30000, noiseDecay: 0.014, len: 0.15 },
  o: { noise: 0.28, rate: 30000, noiseDecay: 0.09, len: 0.6 },
  c: { noise: 0.3, rate: 18000, noiseDecay: 0.5, len: 3 },
  t: { tone: 0.8, f0: 260, f1: 110, sweep: 0.06, toneDecay: 0.1, noise: 0.08, rate: 6000, noiseDecay: 0.015, len: 0.5 },
  m: { noise: 0.22, rate: 11000, short: true, noiseDecay: 0.03, len: 0.2 },
};

function makeWave(spec) {
  const t = new Float32Array(32);
  if (Array.isArray(spec) && spec.length) {
    for (let i = 0; i < 32; i++) t[i] = (+spec[i % spec.length] || 0) / 7.5 - 1;
  } else {
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
    for (let i = 0; i < 32; i++) t[i] = Math.round(((t[i] / mx + 1) * 7.5)) / 7.5 - 1; // 4-bit
  }
  let mean = 0;
  for (const v of t) mean += v / 32;
  for (let i = 0; i < 32; i++) t[i] -= mean;
  return t;
}

export function compileInst(def = {}, sr) {
  const env = def.env || {};
  const a = Math.max(0.001, env.a ?? 0.01), d = Math.max(0.001, env.d ?? 0.2), r = Math.max(0.001, env.r ?? 0.2);
  const U = Math.max(1, Math.min(4, def.unison | 0 || 1));
  const detuneMul = new Float64Array(U);
  for (let u = 0; u < U; u++) detuneMul[u] = Math.pow(2, (U === 1 ? 0 : (def.detune || 0) * (u / (U - 1) - 0.5)) / 1200);
  const kit = {};
  for (const k in DRUMS) kit[k] = { ...DRUMS[k], ...(def.kit?.[k] || {}) };
  return {
    type: def.type || 'pulse',
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
    kit,
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

class DrumVoice {
  constructor() { this.active = false; this.lfsr = 1; this.tonePh = 0; this.noisePh = 0; this.kind = ''; }
  start(d, kind, vel, sr) {
    this.d = d; this.kind = kind; this.vel = vel; this.t = 0; this.active = true;
    this.toneEnv = d.tone || 0; this.noiseEnv = d.noise || 0;
    this.toneCoef = Math.exp(-1 / ((d.toneDecay || 0.1) * sr));
    this.noiseCoef = Math.exp(-1 / ((d.noiseDecay || 0.05) * sr));
    this.tonePh = 0;
  }
  choke(sr) { this.noiseCoef = Math.exp(-1 / (0.008 * sr)); this.toneCoef = this.noiseCoef; }
  render(sr, invSr) {
    const d = this.d;
    const t = (this.t += invSr);
    let out = 0;
    if (this.toneEnv > 1e-4) {
      const f = d.f1 + (d.f0 - d.f1) * Math.exp(-t / d.sweep);
      this.tonePh += f * invSr;
      if (this.tonePh >= 1) this.tonePh -= 1;
      out += TRI_TABLE[(this.tonePh * 32) | 0] * this.toneEnv;
      this.toneEnv *= this.toneCoef;
    }
    if (this.noiseEnv > 1e-4) {
      this.noisePh += d.rate * invSr;
      while (this.noisePh >= 1) {
        this.noisePh -= 1;
        const bit = (this.lfsr ^ (this.lfsr >> (d.short ? 6 : 1))) & 1;
        this.lfsr = (this.lfsr >> 1) | (bit << 14);
      }
      out += (this.lfsr & 1 ? 1 : -1) * this.noiseEnv;
      this.noiseEnv *= this.noiseCoef;
    }
    if (t > d.len || (this.toneEnv <= 1e-4 && this.noiseEnv <= 1e-4)) this.active = false;
    return out * this.vel;
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
      v.start(d, h, vel, this.sr);
    }
  }
  allOff() {
    for (const v of this.voices) { if (this.isDrum) v.active = false; else { v.stage = IDLE; v.level = 0; v.gate = false; } }
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
  setMood(intensity, tension) { for (const b of this.list) b.setMood(intensity, tension); }
  setMute(id, on) { this.mutes[id] = !!on; this.updateGains(); }
  setSolo(id, on) { this.solos[id] = !!on; this.updateGains(); }
  updateGains() {
    const anySolo = Object.keys(this.tracks).some((id) => this.solos[id]);
    for (const id in this.tracks) this.tracks[id].gTarget = anySolo ? (this.solos[id] ? 1 : 0) : this.mutes[id] ? 0 : 1;
  }
  noteOn(id, midis, vel) { this.tracks[id]?.noteOn(midis, vel); }
  release(id) { this.tracks[id]?.release(); }
  drum(id, hits, vel) { this.tracks[id]?.drum(hits, vel); }
  allOff() { for (const b of this.list) b.allOff(); }
  renderSample() {
    let l = 0, r = 0, e = 0, v = 0;
    for (const b of this.list) {
      const x = b.render();
      l += x * b.pl; r += x * b.pr; e += x * b.echo; v += x * b.rev;
    }
    this.echo.process(e);
    const el = this.echo.outL, er = this.echo.outR;
    this.reverb.process(v + (el + er) * 0.5 * this.echoToRev);
    const m = this.master;
    this.outL = Math.tanh((l + el * this.echoLevel + this.reverb.outL * this.revLevel) * m);
    this.outR = Math.tanh((r + er * this.echoLevel + this.reverb.outR * this.revLevel) * m);
  }
}
