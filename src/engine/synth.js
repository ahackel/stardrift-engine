// Sample-by-sample chip synth: pulse (with PWM), NES-style 4-bit triangle, 32-step wavetable, plucked string
// (Karplus-Strong: guitars, harp, pizzicato), synthesized drum kits (drums.js), instrument bodies (fixed resonances),
// section ensembles, per-track drive with an amp (EQ, clipper, speaker cabinet), double tracking, a wah, state-variable filter (low or high pass), a bitcrush, a 3-band EQ, phaser, chorus or flanger, tremolo, auto-pan, ping-pong echo and a small Freeverb.
// Deliberately plain code (no Web Audio nodes) so it ports 1:1 to C# OnAudioFilterRead.

import { DrumVoice, compileKit } from './drums.js';
import { TABLE_SIZE, stairHarmonics, sampledHarmonics, formulaHarmonics, buildTables, levelLimits, cachedTables } from './wavetable.js';
import { TWO_PI, TRI4, blep, svfSet, svf, LP, BP, HP } from './dsp.js';
import { clamp, clamp01 } from './theory.js';
import { Moves } from './moves.js';
import { SfxVoice } from './sfx.js';
import { FxChain, migrateInstrument } from './fx.js';

const IDLE = 0, ATT = 1, DEC = 2, REL = 3;

// 32 steps of 4-bit values (0..15): a preset name or a custom array (editor-drawable).
export const WAVE_PRESETS = ['soft', 'sine', 'saw', 'warm', 'organ', 'hollow'];
export function waveSteps(spec) {
  if (Array.isArray(spec) && spec.length) {
    return Array.from({ length: 32 }, (_, i) => clamp(Math.round(+spec[i % spec.length] || 0), 0, 15));
  }
  const t = new Float64Array(32);
  for (let i = 0; i < 32; i++) {
    const x = (i / 32) * TWO_PI;
    switch (spec) {
      case 'sine': t[i] = Math.sin(x); break;
      case 'saw': t[i] = 1 - (2 * i) / 32; break;
      case 'warm': for (let k = 1; k <= 12; k++) t[i] += Math.sin(k * x) / Math.pow(k, 1.6); break;
      case 'organ': t[i] = Math.sin(x) + 0.5 * Math.sin(2 * x) + 0.3 * Math.sin(3 * x); break;
      case 'hollow': t[i] = Math.sin(x) + 0.4 * Math.sin(3 * x); break;
      default: t[i] = Math.sin(x) + 0.35 * Math.sin(2 * x) + 0.12 * Math.sin(3 * x); // 'soft'
    }
  }
  let mx = 0;
  for (const v of t) mx = Math.max(mx, Math.abs(v));
  return Array.from(t, (v) => Math.round((v / mx + 1) * 7.5));
}

// the 32 steps of a wave as -1..1 without DC
function stepValues(spec) {
  const t = waveSteps(spec).map((v) => v / 7.5 - 1);
  const mean = t.reduce((a, v) => a + v, 0) / 32;
  return t.map((v) => v - mean);
}

// Smooth (analog-style) versions of the presets: the functions the 4-bit steps are sampled from.
const SMOOTH = {
  sine: [1], organ: [1, 0.5, 0.3], hollow: [1, 0, 0.4], soft: [1, 0.35, 0.12],
};

// Band-limited tables for the triangle and wave voices. smooth: no 4-bit staircase (a clean saw, sine…).
function waveTables(def) {
  const smooth = !!def.smooth, tri = def.type === 'triangle';
  const key = `${tri ? 'tri' : JSON.stringify(def.wave ?? 'soft')}:${smooth}`;
  return cachedTables(key, () => {
    if (tri) {
      return smooth
        ? buildTables(formulaHarmonics((k) => (k % 2 ? 8 / (Math.PI * Math.PI * k * k) : 0), null))
        : buildTables(stairHarmonics(TRI4));
    }
    const spec = def.wave ?? 'soft';
    if (!smooth) return buildTables(stairHarmonics(stepValues(spec)));
    if (Array.isArray(spec)) return buildTables(sampledHarmonics(stepValues(spec)));
    if (spec === 'saw') return buildTables(formulaHarmonics(null, (k) => 2 / (Math.PI * k)), 1);
    // warm: a saw whose harmonics fall off faster (1/k^1.6), relative to the note: bowed and blown sounds without the buzz
    if (spec === 'warm') return buildTables(formulaHarmonics(null, (k) => 2 / (Math.PI * Math.pow(k, 1.6))), 1);
    const amps = SMOOTH[spec] || SMOOTH.soft;
    return buildTables(formulaHarmonics(null, (k) => amps[k - 1] || 0), 1);
  });
}

// the effects (a body, a drive, the filter, an EQ …) are fx.js's, a chain in any order, shared with the game sounds

// the coefficient that takes a level down 40 dB (×0.01) in t seconds, sample by sample
const t60 = (t, sr) => Math.exp(-4.6 / (t * sr));

const TYPES = ['pulse', 'triangle', 'wave', 'string', 'fm', 'bowed', 'sample', 'drums'];
const STRING_BUF = 4096; // ring buffer per string voice: a period of up to 4096 samples (~12 Hz at 48 kHz)
const WG_BUF = 4096, WG_MASK = WG_BUF - 1; // waveguides of the bowed string

// samples: the loaded sample library (see src/samples.js), { name: [zones] }; a sound of type sample plays def.sample
export function compileInst(def = {}, sr, samples = {}) {
  def = migrateInstrument(def);
  const env = def.env || {};
  const a = Math.max(0.001, env.a ?? 0.01), d = Math.max(0.001, env.d ?? 0.2), r = Math.max(0.001, env.r ?? 0.2);
  const U = ['string', 'sample'].includes(def.type) ? 1 : clamp(def.unison | 0 || 1, 1, 4);
  const detuneMul = new Float64Array(U);
  for (let u = 0; u < U; u++) detuneMul[u] = Math.pow(2, (U === 1 ? 0 : (def.detune || 0) * (u / (U - 1) - 0.5)) / 1200);
  return {
    type: TYPES.includes(def.type) ? def.type : 'pulse',
    sr, invSr: 1 / sr,
    attInc: 1 / (a * sr), decCoef: t60(d, sr), relCoef: t60(r, sr),
    sus: clamp01(env.s ?? 0.7),
    U, uniNorm: 1 / Math.sqrt(U), detuneMul,
    duty: def.duty ?? 0.5, pwmDepth: def.pwm?.depth || 0, pwmRate: def.pwm?.rate || 0,
    vibDepth: def.vibrato?.depth || 0, vibRate: def.vibrato?.rate || 5, vibDelay: def.vibrato?.delay || 0,
    glideCoef: def.glide ? t60(def.glide, sr) : 0,
    arpPeriod: def.arp ? 1 / def.arp : 0,
    mips: def.type === 'wave' || def.type === 'triangle' ? waveTables(def) : null,
    mipLimits: levelLimits(sr),
    gain: def.gain ?? 1,
    // breath 0..1: air around the note, as loud relative to the tone as the curve says (0.25 −24 dB, 0.5 −15 dB, 1 −6 dB);
    // songs from before breath have `noise`, white noise at that level, which sounds about like 0.8 × noise
    breath: def.breath > 0 ? 0.5 * Math.min(1, def.breath) ** 1.5 : Math.min(0.5, 0.8 * (def.noise || 0)),
    breathCoef: 1 - Math.exp(-1 / (0.02 * sr)), // how fast breath follows the tone's loudness
    // the effects, in their order (fx.js): the track's chain plays them
    fx: Array.isArray(def.fx) ? def.fx : [],
    // fm: a sine carrier whose phase a sine modulator bends; ratio = modulator / carrier frequency, index = how far
    // (brightness), env 0..1 = how much the index follows the note's loudness (brass brightens as it swells),
    // feedback roughens the modulator
    fmRatio: def.fm?.ratio ?? 1, fmIndex: def.fm?.index ?? 2, fmEnv: clamp01(def.fm?.env ?? 1), fmFb: def.fm?.feedback || 0,
    // ensemble 0..1: each unison voice (a player of the section) drifts and vibrates on its own
    ensemble: U > 1 || def.ensemble ? clamp01(def.ensemble || 0) : 0,
    // scoop: a note starts this many semitones flat and slides up within about 70 ms (brass, voices)
    scoop: clamp(def.scoop || 0, 0, 2), scoopCoef: def.scoop ? t60(0.07, sr) : 0,
    // string: T60 decay in seconds and brightness 0..1 (how much of the high end the loop keeps and the pluck has)
    sDecay: Math.max(0.05, def.string?.decay ?? 2), sBright: clamp01(def.string?.bright ?? 0.5),
    sMute: clamp01(def.string?.mute || 0), // palm mute: how damped and dull short notes are
    // bowed: pressure 0..1 (light and airy … scratchy), position 0..1 (near the bridge … towards the fingerboard)
    bowSlope: 5 - 4 * clamp01(def.bow?.pressure ?? 0.8), bowBeta: 0.04 + 0.2 * clamp01(def.bow?.position ?? 0.4),
    // sample: recorded notes (zones), each played from the one whose root is nearest; empty until the library is loaded
    zones: def.type === 'sample' ? samples[def.sample] || [] : null,
    kit: def.type === 'drums' ? compileKit(def, sr, samples) : null,
  };
}

// One bowed string (after STK's Bowed): the bow splits the string into a neck part and a bridge part (two delay
// lines). Where the bow touches, it sticks while the string moves with it and slips when the difference grows:
// the bow table. The loop is two samples shorter than the period for the delay of the bridge filter. Pressure 0.8 at position
// 0.4 (the defaults) keeps the string in its normal motion from G1 to E5; much lighter or heavier bowing can make it
// jump an octave.
class BowedString {
  constructor() { this.a = new Float32Array(WG_BUF); this.b = new Float32Array(WG_BUF); this.i = 0; this.w1 = 0; this.f = 0; this.pole = 0; this.len = 0; }
  // a read from a delay line d samples back (linear interpolation)
  tap(buf, d) {
    const r = this.i - d, i = Math.floor(r), fr = r - i;
    return buf[i & WG_MASK] + (buf[(i + 1) & WG_MASK] - buf[i & WG_MASK]) * fr;
  }
  // the loss filter keeps 3.2 kHz, or the first 25 overtones of high notes, so they ring as well as low ones; the
  // loop is shorter than the period by the filter's delay at the note (and a fixed part, found by measuring)
  tune(p, f) {
    this.f = f;
    const w = (TWO_PI * f) / p.sr, a = (this.pole = Math.exp((-TWO_PI * Math.min(0.4 * p.sr, Math.max(3200, 25 * f))) / p.sr));
    this.len = Math.max(4, p.sr / f - Math.atan2(a * Math.sin(w), 1 - a * Math.cos(w)) / w);
  }
  // one sample at frequency f with the bow moving at speed v; returns the bridge's motion
  tick(p, f, v) {
    if (Math.abs(f - this.f) > f * 0.001) this.tune(p, f);
    const a = this.pole, bridgeLen = this.len * p.bowBeta, neckLen = this.len - bridgeLen;
    const bridgeOut = this.tap(this.b, bridgeLen), neckOut = this.tap(this.a, neckLen);
    this.w1 = (1 - a) * 0.95 * bridgeOut + a * this.w1; // string losses at the bridge (one pole)
    const bridgeRefl = -this.w1, nutRefl = -neckOut, stringVel = bridgeRefl + nutRefl;
    const velDiff = v - stringVel;
    const b = Math.abs(velDiff * p.bowSlope) + 0.75, b2 = b * b;
    let k = 1 / (b2 * b2); // the bow table: (|Δv|·slope + 0.75)^-4
    if (k > 1) k = 1;
    const newVel = velDiff * k;
    this.a[this.i & WG_MASK] = bridgeRefl + newVel;
    this.b[this.i & WG_MASK] = nutRefl + newVel;
    this.i++;
    return bridgeOut;
  }
}

class Voice {
  constructor() {
    this.stage = IDLE; this.level = 0; this.gate = false;
    this.ph = new Float64Array(4); this.cur = 60; this.target = 60; this.vel = 1; this.age = 0;
    this.arp = null; this.arpIdx = 0; this.arpT = 0;
    this.lvl = 0; // wavetable level for the current pitch
    this.kb = null; this.kw = 0; this.kPrev = 0; this.kLoss = 0.999; // string voices: loop buffer, write index
    for (let i = 0; i < 4; i++) this.ph[i] = Math.random();
    // ensemble: per player a slow drift rate, a vibrato rate and a phase; ens holds their pitch factors
    this.rnd = Array.from({ length: 4 }, () => [0.13 + Math.random() * 0.25, 4.8 + Math.random() * 1.4, Math.random() * TWO_PI]);
    this.ens = new Float64Array(4).fill(1); this.ensT = 0;
    this.mph = new Float64Array(4); this.mfb = new Float64Array(4); // fm: modulator phases and last outputs
    this.bows = []; // bowed: a string per player
    this.m = NaN; this.f = 440; // the pitch the frequency (and what follows from it) was last worked out for
    this.bms = 0; this.blo = 0; this.bband = 0; // breath: the tone's power, the band's state
  }
  start(p, midi, vel, arp, short = false) {
    const legato = this.stage !== IDLE && p.glideCoef > 0;
    this.target = midi;
    if (!legato) this.cur = midi - p.scoop;
    this.vel = vel; this.stage = ATT; this.gate = true; this.age = 0;
    this.arp = arp; this.arpIdx = 0; this.arpT = 0; this.m = NaN;
    if (p.type === 'string') this.pluck(p, 440 * Math.pow(2, (midi - 69) / 12), short ? p.sMute : 0); // every note is picked; glide still slides into it
    if (p.type === 'bowed') while (this.bows.length < p.U) this.bows.push(new BowedString());
    if (p.type === 'sample' && !legato) {
      this.zone = null; this.spos = 0;
      for (const z of p.zones) if (!this.zone || Math.abs(z.root - midi) < Math.abs(this.zone.root - midi)) this.zone = z;
    }
  }
  // Karplus-Strong: a period of filtered noise circulates in a delay loop that loses a little each pass.
  // mute 0..1: a palm-muted note, much duller and dying within a few hundredths of a second (through a driven amp,
  // anything above about -35 dB still clips, so the string has to fall fast to sound damped)
  pluck(p, f, mute = 0) {
    const kb = (this.kb ||= new Float32Array(STRING_BUF)), mask = STRING_BUF - 1;
    const n = Math.min(STRING_BUF - 4, Math.ceil(p.sr / f) + 2), c = (0.15 + 0.85 * p.sBright * (0.5 + 0.5 * this.vel)) * (1 - 0.85 * mute);
    let lp = 0, mean = 0;
    for (let i = 1; i <= n; i++) { lp += (Math.random() * 2 - 1 - lp) * c; kb[(this.kw - i) & mask] = lp; mean += lp; }
    mean /= n;
    for (let i = 1; i <= n; i++) kb[(this.kw - i) & mask] -= mean; // no DC in the loop
    this.kPrev = 0;
    this.kLoss = Math.exp(-6.9 / (Math.pow(p.sDecay, 1 - mute) * Math.pow(0.035, mute) * f)); // -60 dB after sDecay s (35 ms fully muted)
  }
  // one sample of the string at frequency f (glide and vibrato change the loop length)
  string(p, f) {
    const kb = this.kb, mask = STRING_BUF - 1, b = p.sBright;
    const d = Math.min(STRING_BUF - 4, p.sr / f - 0.5 * (1 - b)); // the loop filter adds half a sample of delay
    const r = this.kw - d, i = Math.floor(r), fr = r - i;
    const y = kb[i & mask] + (kb[(i + 1) & mask] - kb[i & mask]) * fr;
    kb[this.kw & mask] = this.kLoss * (b * y + (1 - b) * 0.5 * (y + this.kPrev));
    this.kPrev = y;
    this.kw = (this.kw + 1) | 0;
    return y;
  }
  release() { if (this.stage !== IDLE) this.stage = REL; this.gate = false; }
  // a section's players: each wanders slowly off pitch (up to 5 cents) and has its own vibrato (7 cents), fading in
  drift(p) {
    const a = this.age, k = p.ensemble, fade = Math.min(1, a / 0.4);
    for (let u = 0; u < p.U; u++) {
      const r = this.rnd[u];
      this.ens[u] = Math.pow(2, (k * (5 * Math.sin(TWO_PI * r[0] * a + r[2]) + 7 * fade * Math.sin(TWO_PI * r[1] * a + 3 * r[2]))) / 1200);
    }
  }
  // one sample: the tone, and the breath around it
  render(p) {
    const y = this.tone(p);
    return p.breath && this.stage !== IDLE ? y + this.breathe(p, y) : y;
  }
  // Breath: noise in a band around the note (centred an octave up, about two octaves wide), so it sounds like air in
  // the note rather than hiss beside it. Its level follows the tone's own (over 20 ms), so every type breathes alike,
  // a string as it dies away too.
  breathe(p, y) {
    this.bms += (y * y - this.bms) * p.breathCoef;
    const F = this.bF;
    this.blo += F * this.bband;
    this.bband += F * (Math.random() * 2 - 1 - this.blo - this.bband); // a state-variable band-pass, Q 1
    return this.bband * Math.sqrt(this.bms / this.bP) * p.breath;
  }
  // the breath band's centre (an octave above the note) as the filter's coefficient, and the part of white noise's
  // power it keeps (π·fc/sr of 1/3): breathe scales that back to the power of the tone
  breathBand(p) {
    const fc = Math.min(6000, Math.max(200, 2 * this.f));
    this.bF = 2 * Math.sin(Math.PI * fc * p.invSr);
    this.bP = (Math.PI * fc * p.invSr) / 3;
  }
  tone(p) {
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
      const k = p.glideCoef || p.scoopCoef;
      this.cur = k ? this.target + (this.cur - this.target) * k : this.target;
      m = this.cur;
    }
    if (p.vibDepth && this.age > p.vibDelay) {
      const ramp = Math.min(1, (this.age - p.vibDelay) / 0.4);
      m += p.vibDepth * ramp * Math.sin(TWO_PI * p.vibRate * this.age);
    }
    if (m !== this.m) {
      this.m = m;
      this.f = 440 * Math.pow(2, (m - 69) / 12);
      this.breathBand(p);
      if (this.zone) this.sInc = Math.pow(2, (m - this.zone.root) / 12) * this.zone.rate * p.invSr;
    }
    const f = this.f, sr = p.sr;
    let out = 0;
    if (p.ensemble && (this.ensT = (this.ensT + 1) & 31) === 1) this.drift(p);
    // bowed: the envelope is the bow's speed, so a note swells like a bow stroke; with unison a section of players,
    // and with ensemble each player's pitch wanders and their vibrato is never quite even
    if (p.type === 'bowed') {
      if (this.bows.length < p.U) return 0; // the sound became bowed while this voice was sounding
      const v = (0.03 + 0.2 * this.vel) * lv;
      for (let u = 0; u < p.U; u++) out += this.bows[u].tick(p, f * p.detuneMul[u] * this.ens[u], v);
      return out * p.uniNorm * this.vel;
    }
    if (p.type === 'sample') {
      // the recording, resampled to the note (glide and vibrato too); sustained notes loop, others end
      const z = this.zone;
      if (!z) return 0;
      const d = z.data, i = this.spos | 0, fr = this.spos - i, j = z.loopEnd && i + 1 >= z.loopEnd ? z.loopStart : i + 1;
      const y = d[i] + ((d[j] || 0) - d[i]) * fr;
      this.spos += this.sInc;
      if (z.loopEnd) { if (this.spos >= z.loopEnd) this.spos -= z.loopEnd - z.loopStart; }
      else if (this.spos >= d.length - 1) { this.stage = IDLE; this.level = 0; }
      return y * lv * this.vel * 5; // recordings sit at -16 dB: about as loud as a saw
    }
    if (p.type === 'string') {
      if (!this.kb) this.pluck(p, f); // the sound became a string while this voice was sounding
      return this.string(p, f) * lv * this.vel * 3.5;
    }
    if (p.type === 'fm') {
      const I = p.fmIndex * (1 - p.fmEnv + p.fmEnv * lv) * (0.5 + 0.5 * this.vel);
      for (let u = 0; u < p.U; u++) {
        const dt = (f * p.detuneMul[u] * this.ens[u]) / sr;
        let ph = this.ph[u] + dt;
        if (ph >= 1) ph -= 1;
        this.ph[u] = ph;
        let mp = this.mph[u] + dt * p.fmRatio;
        mp -= Math.floor(mp);
        this.mph[u] = mp;
        const mod = Math.sin(TWO_PI * mp + p.fmFb * this.mfb[u]);
        this.mfb[u] = mod;
        out += Math.sin(TWO_PI * ph + I * mod);
      }
      return out * p.uniNorm * lv * this.vel;
    }
    let duty = p.duty, tb = null;
    if (p.mips) {
      // the fullest table whose harmonics stay below Nyquist at this pitch
      const lim = p.mipLimits, fmax = f * 1.03; // headroom for unison detune
      let l = this.lvl;
      while (l > 0 && fmax < lim[l - 1]) l--;
      while (l < lim.length - 1 && fmax > lim[l]) l++;
      this.lvl = l;
      tb = p.mips[l];
    } else if (p.pwmDepth) duty += p.pwmDepth * Math.sin(TWO_PI * p.pwmRate * this.age);
    duty = duty < 0.05 ? 0.05 : duty > 0.95 ? 0.95 : duty;
    for (let u = 0; u < p.U; u++) {
      const dt = (f * p.detuneMul[u] * this.ens[u]) / sr;
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
      } else {
        const x = ph * TABLE_SIZE, i = x | 0;
        out += tb[i] + (tb[i + 1] - tb[i]) * (x - i);
      }
    }
    return out * p.uniNorm * lv * this.vel;
  }
}

class TrackBus {
  constructor(poly, isDrum) {
    this.isDrum = isDrum;
    this.voices = Array.from({ length: poly }, () => (isDrum ? new DrumVoice() : new Voice()));
    this.g = 0; this.gTarget = 1; this.rr = 0;
    this.fade = 1; this.fadeTo = 1; this.fadeStep = 0; // a track joining or leaving: a linear ramp (Synth.fade)
    this.loud = 0; // the loudest voice's envelope level (a filter's swell, a wah that follows the notes)
    this.fx = null; // its effects (fx.js), in their order
    this.peak = 0; // the loudest sample since the meters last looked (Synth.takePeaks)
    this.apT = 0; // the auto-pan's countdown to new pan gains
    this.mvT = 0; // countdown to the next pan gains while an effect row moves it
  }
  // bps: the song's beats per second (the effects that go in time go with them)
  set(tr, p, sr, bps = 2) {
    this.p = p; this.sr = sr; this.bps = bps;
    this.mv ||= new Moves(sr); // the effect rows' moves on this track
    this.apOff = 0;
    this.vol = (tr.volume ?? 0.3) * p.gain;
    this.pan = clamp(tr.pan || 0, -1, 1);
    this.echo = tr.echo || 0; this.rev = tr.reverb || 0;
    this.pump = clamp01(tr.pump || 0); // sidechain: dips on every kick
    (this.fx ||= new FxChain(sr)).set(p.fx, { music: true, bps, drums: this.isDrum });
    // double tracking: a second take, a few ms late with a slowly wandering delay, on the other side;
    // the two sit at pan ± double
    this.dbl = clamp01(tr.double || 0);
    if (this.dbl && !this.dBuf) { this.dBuf = new Float32Array(Math.ceil(sr * 0.03)); this.dI = 0; this.dT = 0; }
    this.place(0);
  }
  // the gains that put the track at its pan moved by off (auto-pan), and the double's two takes either side of it
  place(off) {
    const pan = clamp(this.pan + off, -1, 1);
    if (this.dbl) {
      const a = ((clamp(pan - this.dbl, -1, 1) + 1) * Math.PI) / 4, b = ((clamp(pan + this.dbl, -1, 1) + 1) * Math.PI) / 4;
      this.pl = Math.cos(a); this.pr = Math.sin(a); this.ql = Math.cos(b); this.qr = Math.sin(b);
    } else {
      this.pl = Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
      this.pr = Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
    }
  }
  // the second take: 14 ms late, the delay drifting by about a millisecond (a few cents of pitch, like a player)
  double(x) {
    const buf = this.dBuf, n = buf.length;
    buf[this.dI] = x;
    this.dT += this.p.invSr;
    const d = this.sr * (0.014 + 0.0012 * Math.sin(TWO_PI * 0.23 * this.dT) + 0.0007 * Math.sin(TWO_PI * 0.61 * this.dT));
    let r = this.dI - d;
    if (r < 0) r += n;
    const i = Math.floor(r), f = r - i, y = buf[i] + (buf[i + 1 === n ? 0 : i + 1] - buf[i]) * f;
    if (++this.dI >= n) this.dI = 0;
    return y;
  }
  noteOn(midis, vel, short) {
    const p = this.p, vs = this.voices;
    this.fx.noteOn(vel); // each note starts the effects' moves (and a filter's envelope) again
    if (vs.length === 1) {
      const arp = midis.length > 1 && p.arpPeriod ? midis.slice().sort((a, b) => a - b) : null;
      vs[0].start(p, arp ? arp[0] : midis[0], vel, arp, short);
      return;
    }
    for (const v of vs) if (v.gate) v.release();
    for (const m of midis) this.alloc().start(p, m, vel, null, short);
  }
  alloc() {
    let best = null, score = Infinity;
    for (const v of this.voices) {
      if (v.stage === IDLE) return v;
      const s = (v.gate ? 10 : 0) + v.level - v.age * 0.001;
      if (s < score) { score = s; best = v; }
    }
    return best; // restarts from its current level: no click
  }
  release() { if (!this.isDrum) for (const v of this.voices) if (v.gate) v.release(); }
  drum(hits, vel) {
    if (hits.length) this.fx.noteOn(vel); // a hit starts the effects' moves again, as a note does
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
    else {
      let loud = 0;
      for (const v of this.voices) if (v.stage !== IDLE) { x += v.render(p); if (v.level > loud) loud = v.level; }
      this.loud = loud;
    }
    let y = this.fx.run(x, this.loud); // the effects, in their order
    if (this.fx.panning && --this.apT <= 0) { // an auto-pan: the pan gains move every 16 samples
      this.apT = 16;
      this.apOff = this.fx.pan;
      if (!this.mv.on) this.place(this.apOff);
    }
    const mv = this.mv;
    mv.tick();
    if (mv.on) {
      y = mv.run(y);
      if (--this.mvT <= 0) { this.mvT = 16; this.place(this.apOff + mv.pan); } // an effect row's pan
    }
    this.g += (this.gTarget - this.g) * 0.0015;
    if (this.fadeStep) {
      this.fade += this.fadeStep;
      if (this.fadeStep > 0 ? this.fade >= this.fadeTo : this.fade <= this.fadeTo) {
        this.fade = this.fadeTo; this.fadeStep = 0;
        if (this.fade === 0) { this.allOff(); this.fade = this.fadeTo = 1; } // faded out: its notes stop, silently
      }
    }
    return y * this.vol * this.g * this.fade;
  }
}

// The master bus: a low cut (rumble under 30 Hz only eats headroom), then a gentle compressor that glues the mix
// (glue 0–1: the ratio, from 1:1 to 4:1 above -9 dB, 10 ms attack, 250 ms release, and makeup gain so the quiet
// parts come up). The soft clip after it (Synth.renderSample) is the limiter: peaks round off instead of crackling.
class Master {
  constructor(sr) {
    this.hpK = 1 - Math.exp((-2 * Math.PI * 30) / sr);
    this.att = 1 - Math.exp(-1 / (0.01 * sr));
    this.rel = 1 - Math.exp(-1 / (0.25 * sr));
    this.lpL = 0; this.lpR = 0; this.env = 0;
    this.set(0.5);
  }
  set(glue) {
    const g = clamp01(glue);
    this.slope = 1 - 1 / (1 + 3 * g); // 0 = no compression
    this.makeup = 1 + 0.4 * g;
  }
  process(l, r) {
    this.lpL += this.hpK * (l - this.lpL); l -= this.lpL;
    this.lpR += this.hpK * (r - this.lpR); r -= this.lpR;
    const lvl = Math.max(Math.abs(l), Math.abs(r));
    this.env += (lvl > this.env ? this.att : this.rel) * (lvl - this.env);
    const T = 0.35, g = (this.env > T && this.slope ? Math.pow(T / this.env, this.slope) : 1) * this.makeup;
    this.l = l * g; this.r = r * g;
  }
}

class Echo {
  constructor(sr) {
    this.sr = sr; this.max = Math.ceil(sr * 4);
    this.bl = new Float32Array(this.max); this.br = new Float32Array(this.max);
    this.i = 0; this.d = sr / 2; this.dTarget = this.d; this.fb = 0.4; this.k = 0.5; this.ll = 0; this.lr = 0;
    this.hp = 0; this.hpK = 0;
  }
  set(sec, fb, damp, lowcut = 0) {
    this.dTarget = clamp(Math.round(sec * this.sr), 1, this.max - 2);
    this.fb = Math.min(0.95, fb); this.k = 1 - Math.min(0.95, damp);
    this.hpK = lowcut > 0 ? 1 - Math.exp((-2 * Math.PI * lowcut) / this.sr) : 0; // keeps bass out of the repeats
  }
  process(x) {
    if (this.hpK) { this.hp += (x - this.hp) * this.hpK; x -= this.hp; }
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

// Freeverb (8 combs + 4 allpasses per side) with a pre-delay and a low cut on its input:
// the pre-delay keeps notes clear of their tail, the low cut keeps bass out of the tail (no mud).
class Reverb {
  constructor(sr) {
    const s = sr / 44100;
    const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
    const aps = [556, 441, 341, 225];
    const mk = (n) => ({ buf: new Float32Array(Math.max(8, Math.round(n * s))), i: 0, f: 0 });
    this.cl = combs.map(mk); this.cr = combs.map((n) => mk(n + 23));
    this.al = aps.map(mk); this.ar = aps.map((n) => mk(n + 23));
    this.fb = 0.86; this.damp = 0.4;
    this.sr = sr; this.pre = new Float32Array(Math.ceil(sr * 0.2)); this.pi = 0; this.pd = 0;
    this.hp = 0; this.hpK = 0;
  }
  set(size, damp, predelay = 0, lowcut = 0) {
    this.fb = Math.min(0.97, size); this.damp = Math.min(0.95, damp);
    this.pd = clamp(Math.round(predelay * this.sr), 0, this.pre.length - 1);
    this.hpK = lowcut > 0 ? 1 - Math.exp((-2 * Math.PI * lowcut) / this.sr) : 0;
  }
  run(combs, aps, x) {
    const damp = this.damp, keep = 1 - damp, fb = this.fb;
    let o = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.f = y * keep + c.f * damp;
      c.buf[c.i] = x + c.f * fb;
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
    if (this.hpK) { this.hp += (x - this.hp) * this.hpK; x -= this.hp; }
    if (this.pd) {
      const pre = this.pre, n = pre.length;
      pre[this.pi] = x;
      let j = this.pi - this.pd;
      if (j < 0) j += n;
      x = pre[j];
      if (++this.pi >= n) this.pi = 0;
    }
    x *= 0.015;
    this.outL = this.run(this.cl, this.al, x);
    this.outR = this.run(this.cr, this.ar, x);
  }
}

export class Synth {
  constructor(sr) {
    this.sr = sr;
    this.tracks = {}; this.list = [];
    this.echo = new Echo(sr); this.reverb = new Reverb(sr); this.bus = new Master(sr);
    this.mix = new Moves(sr, 2); // the effect rows' moves on the whole mix
    this.outL = 0; this.outR = 0;
    this.peakL = 0; this.peakR = 0; // the master's loudest samples since the meters last looked (takePeaks)
    this.mutes = {}; this.solos = {};
    this.pv = null; this.pvQ = []; this.pvI = 0; this.pvT = 0;
    this.kb = null; this.kbJson = null; this.kbHeld = new Map(); this.kbT = 0;
    this.duck = null;
    this.kick = 0; this.kickT = 0; this.kickRel = 0.999; // sidechain envelope: jumps on every kick, recovers
    this.samples = {}; // the sample library, once loaded (Engine.setSamples)
    this.sfx = []; this.sfxGain = 1; // game sounds playing (sfx.js), over the music and its effect rows
    this.dk = 0; this.dkAtt = 1 - Math.exp(-1 / (0.005 * sr)); this.dkRel = 1 - Math.exp(-1 / (0.2 * sr)); // a sound's duck on the music
  }
  // a bus for a sound with `poly` voices (a drum kit: 6): the old one while it fits, else a new one
  busFor(bus, def, poly) {
    const p = compileInst(def, this.sr, this.samples), isDrum = p.type === 'drums', n = isDrum ? 6 : clamp(poly || 1, 1, 16);
    if (!bus || bus.voices.length !== n || bus.isDrum !== isDrum) bus = new TrackBus(n, isDrum);
    bus.p = p;
    return bus;
  }
  // the editor's own buses (the keyboard, the preview): centred, a little echo and reverb, heard now
  audition(bus, def, poly, volume) {
    bus = this.busFor(bus, def, poly);
    bus.set({ volume, echo: 0.08, reverb: 0.25 }, bus.p, this.sr, this.bps);
    bus.g = 1;
    return bus;
  }
  configure(song) {
    const next = {};
    for (const tr of song.tracks) {
      const bus = this.busFor(this.tracks[tr.id], tr.inst, tr.poly);
      bus.set(tr, bus.p, this.sr, song.bpm / 60);
      next[tr.id] = bus;
    }
    this.tracks = next;
    this.list = Object.values(next);
    this.bps = song.bpm / 60;
    const fx = song.fx;
    this.echo.set((fx.echo.beats * 60) / song.bpm, fx.echo.feedback, fx.echo.damp, fx.echo.lowcut);
    this.echoLevel = fx.echo.level;
    this.reverb.set(fx.reverb.size, fx.reverb.damp, fx.reverb.predelay, fx.reverb.lowcut);
    this.kickRel = Math.exp(-1 / (0.3 * (60 / song.bpm) * this.sr)); // the pump recovers over ~a beat
    this.revLevel = fx.reverb.level;
    this.echoToRev = fx.echoToReverb;
    this.master = song.master.gain;
    this.bus.set(song.master.glue ?? 0.5);
    this.updateGains();
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
  // a track joins (to 1: from silence) or leaves (to 0: its notes stop once it is silent) over sec seconds
  fade(id, to, sec) {
    const b = this.tracks[id];
    if (!b) return;
    if (to > 0 && !b.fadeStep) b.fade = 0;
    b.fadeTo = to;
    b.fadeStep = (to - b.fade) / Math.max(1, sec * this.sr);
  }
  // an effect row's values for a track (its id) or the whole mix ('*'), reached over n samples (Moves.to); null: off
  move(id, v, n) {
    const mv = id === '*' ? this.mix : this.tracks[id]?.mv;
    if (mv) mv.to(v, n, this.bps);
  }
  stopMoves() {
    this.mix = new Moves(this.sr, 2);
    for (const b of this.list) b.mv = new Moves(this.sr);
  }
  // a game sound (a play's settings, sfx.js playOf): on a free voice of 8, else in place of the one playing longest
  sound(p) {
    let v = this.sfx.find((x) => x.done);
    if (!v) {
      if (this.sfx.length < 8) this.sfx.push((v = new SfxVoice(this.sr)));
      else v = this.sfx.reduce((a, b) => (b.t > a.t ? b : a));
    }
    v.start(p);
  }
  stopSounds() { for (const v of this.sfx) v.done = true; }
  noteOn(id, midis, vel, short) { this.tracks[id]?.noteOn(midis, vel, short); }
  release(id) { this.tracks[id]?.release(); }
  drum(id, hits, vel) {
    this.tracks[id]?.drum(hits, vel);
    if (hits.includes('k') && this.tracks[id]?.gTarget > 0) this.kickT = Math.max(this.kickT, vel);
  }
  allOff() { for (const b of this.list) b.allOff(); }
  releaseAll() { for (const b of this.list) b.release(); }

  // Live keyboard (editor): a note sounds while its key is down, on a bus of its own like the preview.
  // note: a midi number, or a drum hit ('k', 's' …) for a drum kit. The sound is compiled again only when it changed.
  keyOn(def, note, { volume = 0.3, vel = 0.8 } = {}) {
    const json = JSON.stringify(def);
    if (json !== this.kbJson) {
      this.kb = this.audition(this.kb, def, 8, volume);
      this.kbJson = json;
      this.kbHeld = new Map();
    }
    const kb = this.kb;
    kb.g = 1;
    if (kb.isDrum) return void kb.drum([note], vel);
    this.keyOff(note);
    const v = kb.alloc();
    v.start(kb.p, note, vel, null, false);
    this.kbHeld.set(note, v);
  }
  keyOff(note) {
    const v = this.kbHeld?.get(note);
    if (v?.gate) v.release();
    this.kbHeld?.delete(note);
  }

  // Audition an instrument outside the song (editor). events: [{ t: seconds, notes: [midi] | hit: 'k', dur, vel }]
  // Plays on its own bus that ignores mute/solo, so it works with the song held or playing.
  preview(def, events, { poly = 1, volume = 0.3 } = {}) {
    this.pv = this.audition(this.pv, def, poly, volume);
    this.pv.allOff();
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
    this.kickT *= this.kickRel;
    this.kick += (this.kickT - this.kick) * 0.04;
    for (const b of this.list) {
      let x = b.render();
      if (b.pump) x *= 1 - b.pump * this.kick;
      const a = x < 0 ? -x : x;
      if (a > b.peak) b.peak = a;
      if (b.dbl) {
        const c = b.double(x);
        l += x * b.pl + c * b.ql; r += x * b.pr + c * b.qr;
        x = (x + c) * 0.5;
      } else { l += x * b.pl; r += x * b.pr; }
      e += x * (b.echo + b.mv.echo); v += x * (b.rev + b.mv.rev);
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
      l += x * pv.pl; r += x * pv.pr; e += x * pv.echo; v += x * pv.rev; // centred, unless its sound pans itself
    }
    const kb = this.kb;
    if (kb) {
      // idle and no key down: drop the bus so it costs nothing
      if ((++this.kbT & 4095) === 0 && !this.kbHeld.size && kb.idle()) { this.kb = null; this.kbJson = null; }
      const x = kb.render();
      l += x * kb.pl; r += x * kb.pr; e += x * kb.echo; v += x * kb.rev;
    }
    let sl = 0, sr = 0, dk = 0; // the game sounds
    if (this.sfx.length) {
      for (const sv of this.sfx) {
        if (sv.done) continue;
        const x = sv.render() * this.sfxGain;
        sl += x * sv.pl; sr += x * sv.pr; e += x * sv.p.echo; v += x * sv.p.reverb;
        if (sv.p.duck > dk) dk = sv.p.duck;
      }
    }
    this.dk += (dk - this.dk) * (dk > this.dk ? this.dkAtt : this.dkRel);
    this.echo.process(e);
    const el = this.echo.outL, er = this.echo.outR;
    this.reverb.process(v + (el + er) * 0.5 * this.echoToRev);
    const m = this.master, bus = this.bus, mix = this.mix;
    l = (l + el * this.echoLevel + this.reverb.outL * this.revLevel) * m;
    r = (r + er * this.echoLevel + this.reverb.outR * this.revLevel) * m;
    mix.tick();
    if (mix.on) { l = mix.run(l, 0); r = mix.run(r, 1); }
    if (this.dk > 1e-4) { l *= 1 - this.dk; r *= 1 - this.dk; }
    l += sl; r += sr;
    bus.process(l, r);
    const al = bus.l < 0 ? -bus.l : bus.l, ar = bus.r < 0 ? -bus.r : bus.r; // before the soft clip: above 1 it squashes
    if (al > this.peakL) this.peakL = al;
    if (ar > this.peakR) this.peakR = ar;
    this.outL = Math.tanh(bus.l);
    this.outR = Math.tanh(bus.r);
  }

  // the loudest sample of each track and of the master (left, right) since the last call: the editor's meters
  takePeaks() {
    const tracks = {};
    for (const id in this.tracks) { tracks[id] = this.tracks[id].peak; this.tracks[id].peak = 0; }
    const out = { tracks, l: this.peakL, r: this.peakR };
    this.peakL = this.peakR = 0;
    return out;
  }
}
