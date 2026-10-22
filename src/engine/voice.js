// One instrument playing a note (inst.js): up to three layers, each a source with its own envelope: a pulse (with
// PWM), an NES-style 4-bit triangle, a 32-step wavetable, a plucked string (Karplus-Strong: guitars, harp,
// pizzicato), FM, a bowed string, a recording, or chip noise. The note's own effects (glide, scoop, vibrato, an arp,
// unison and ensemble, breath) move all of them. The tracks (synth.js) and the game sounds (sfx.js) play these voices.
// Deliberately plain code (no Web Audio nodes) so it ports 1:1 to C# OnAudioFilterRead.

import { compileKit } from './drums.js';
import { TABLE_SIZE, stairHarmonics, sampledHarmonics, formulaHarmonics, buildTables, levelLimits, cachedTables } from './wavetable.js';
import { TWO_PI, TRI4, blep } from './dsp.js';
import { clamp, clamp01 } from './theory.js';
import { movesOf, valueAt } from './fx.js';
import { migrateInstrument, MAX_LAYERS, LAYER_TYPES, LAYER_MOVE_PARAMS } from './inst.js';

export const IDLE = 0, ATT = 1, DEC = 2, REL = 3;

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

// A tonewheel organ's drawbars: 16′ 5⅓′ 8′ 4′ 2⅔′ 2′ 1⅗′ 1⅓′ 1′, each a sine at this many times the 8′ note, 0–8 loud
// (a step is 3 dB). Written as Hammond players write a registration: '888000000' (a jazz organ), '008080800' …
export const DRAWBAR_FEET = ['16′', '5⅓′', '8′', '4′', '2⅔′', '2′', '1⅗′', '1⅓′', '1′'];
export const DRAWBAR_RATIOS = [0.5, 1.5, 1, 2, 3, 4, 5, 6, 8];
export function drawbarLevels(spec) {
  const a = Array.isArray(spec) ? spec : String(spec ?? '').replace(/[^0-8]/g, '').split('');
  return DRAWBAR_RATIOS.map((_, i) => clamp(Math.round(+a[i] || 0), 0, 8));
}
export const hasDrawbars = (l) => l?.type === 'wave' && l.drawbars !== undefined && l.drawbars !== null;
// the drawbars as harmonics of the 16′ (so the 16′ and 5⅓′ fit): the table plays an octave below the note
function drawbarHarmonics(spec) {
  const amp = new Map();
  drawbarLevels(spec).forEach((n, i) => { if (n) amp.set(DRAWBAR_RATIOS[i] * 2, Math.pow(10, (-3 * (8 - n)) / 20)); });
  return formulaHarmonics(null, (k) => amp.get(k) || 0);
}

// Smooth (analog-style) versions of the presets: the functions the 4-bit steps are sampled from.
const SMOOTH = {
  sine: [1], organ: [1, 0.5, 0.3], hollow: [1, 0, 0.4], soft: [1, 0.35, 0.12],
};

// Band-limited tables for the triangle and wave voices. smooth: no 4-bit staircase (a clean saw, sine…).
function waveTables(def) {
  const smooth = !!def.smooth, tri = def.type === 'triangle';
  if (hasDrawbars(def)) { const bars = drawbarLevels(def.drawbars); return cachedTables(`bars:${bars.join('')}`, () => buildTables(drawbarHarmonics(bars), 1)); }
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

// the coefficient that takes a level down 40 dB (×0.01) in t seconds, sample by sample
const t60 = (t, sr) => Math.exp(-4.6 / (t * sr));

const STRING_BUF = 4096; // ring buffer per string voice: a period of up to 4096 samples (~12 Hz at 48 kHz)
const WG_BUF = 4096, WG_MASK = WG_BUF - 1; // waveguides of the bowed string
const CTL = 32; // samples between a layer's moved settings

// a layer: its source, its envelope, where it sits (pitch in semitones from the note, level, delay in seconds)
function compileLayer(l, def, sr, samples) {
  const type = LAYER_TYPES.includes(l.type) ? l.type : 'pulse';
  const env = l.env || {};
  const a = Math.max(0.001, env.a ?? 0.01), d = Math.max(0.001, env.d ?? 0.2), r = Math.max(0.001, env.r ?? 0.2);
  const U = ['string', 'sample', 'noise'].includes(type) ? 1 : clamp(def.unison | 0 || 1, 1, 4);
  const detuneMul = new Float64Array(U);
  for (let u = 0; u < U; u++) detuneMul[u] = Math.pow(2, (U === 1 ? 0 : (def.detune || 0) * (u / (U - 1) - 0.5)) / 1200);
  return {
    type, sr, invSr: 1 / sr,
    attInc: 1 / (a * sr), decCoef: t60(d, sr), relCoef: t60(r, sr),
    sus: clamp01(env.s ?? 0.7),
    U, uniNorm: 1 / Math.sqrt(U), detuneMul,
    duty: l.duty ?? 0.5, pwmDepth: l.pwm?.depth || 0, pwmRate: l.pwm?.rate || 0,
    mips: type === 'wave' || type === 'triangle' ? waveTables({ ...l, type }) : null,
    level: clamp01(l.level ?? 1), pitch: clamp(+l.pitch || 0, -48, 48), noise: clamp01(l.noise || 0),
    sub: hasDrawbars({ ...l, type }) ? -12 : 0, // drawbars: the table's fundamental is the 16′, an octave below the note
    delay: Math.round(clamp(+l.delay || 0, 0, 2) * sr),
    // its moves as written (in beats or seconds); timeMoves works them out for where it plays (mv)
    moves: Array.isArray(l.moves) ? l.moves : [], mv: [],
    // fm: a sine carrier whose phase a sine modulator bends; ratio = modulator / carrier frequency, index = how far
    // (brightness), env 0..1 = how much the index follows the note's loudness (brass brightens as it swells),
    // feedback roughens the modulator; a high ratio (11–16) is an electric piano's tine
    fmRatio: clamp(l.fm?.ratio ?? 1, 0.5, 16), fmIndex: l.fm?.index ?? 2, fmEnv: clamp01(l.fm?.env ?? 1), fmFb: l.fm?.feedback || 0,
    // string: T60 decay in seconds and brightness 0..1 (how much of the high end the loop keeps and the pluck has)
    sDecay: Math.max(0.05, l.string?.decay ?? 2), sBright: clamp01(l.string?.bright ?? 0.5),
    sMute: clamp01(l.string?.mute || 0), // palm mute: how damped and dull short notes are
    // where it is plucked, 0..0.5 of the string from the bridge (0: not set): near it thin and twangy (a banjo), at
    // the middle round and hollow (no even harmonics)
    sPos: clamp(+l.string?.position || 0, 0, 0.5),
    // where an electric's pickup sits, the same way (0: none): at the bridge thin and biting, at the neck warm and round
    sPickup: clamp(+l.string?.pickup || 0, 0, 0.5),
    sPick: clamp01(+l.string?.pick || 0), // the pick's click on the string: 0 a thumb, 1 a hard plectrum
    // bowed: pressure 0..1 (light and airy … scratchy), position 0..1 (near the bridge … towards the fingerboard)
    bowSlope: 5 - 4 * clamp01(l.bow?.pressure ?? 0.8), bowBeta: 0.04 + 0.2 * clamp01(l.bow?.position ?? 0.4),
    // sample: recorded notes (zones), each played from the one whose root is nearest; empty until the library is loaded
    zones: type === 'sample' ? samples[l.sample] || [] : null,
  };
}

// samples: the loaded sample library (see src/samples.js), { name: [zones] }; a layer of type sample plays its sample
export function compileInst(def = {}, sr, samples = {}) {
  def = migrateInstrument(def);
  const base = { sr, invSr: 1 / sr, gain: def.gain ?? 1, fx: Array.isArray(def.fx) ? def.fx : [] }; // fx: the effects, in their order (fx.js)
  if (def.type === 'drums') return { ...base, type: 'drums', layers: [], kit: compileKit(def, sr, samples) };
  const layers = (def.layers?.length ? def.layers : [{}]).slice(0, MAX_LAYERS).filter((l) => l && !l.off).map((l) => compileLayer(l, def, sr, samples));
  return {
    ...base, type: 'synth', layers,
    U: layers.reduce((a, l) => Math.max(a, l.U), 1),
    vibDepth: def.vibrato?.depth || 0, vibRate: def.vibrato?.rate || 5, vibDelay: def.vibrato?.delay || 0,
    glideCoef: def.glide ? t60(def.glide, sr) : 0,
    arpPeriod: def.arp ? 1 / def.arp : 0,
    mipLimits: levelLimits(sr),
    // breath 0..1: air around the note, as loud relative to the tone as the curve says (0.25 −24 dB, 0.5 −15 dB, 1 −6 dB);
    // songs from before breath have `noise`, white noise at that level, which sounds about like 0.8 × noise
    breath: def.breath > 0 ? 0.5 * Math.min(1, def.breath) ** 1.5 : Math.min(0.5, 0.8 * (def.noise || 0)),
    breathCoef: 1 - Math.exp(-1 / (0.02 * sr)), // how fast breath follows the tone's loudness
    // ensemble 0..1: each unison voice (a player of the section) drifts and vibrates on its own
    ensemble: def.unison > 1 || def.ensemble ? clamp01(def.ensemble || 0) : 0,
    // scoop: a note starts this many semitones flat and slides up within about 70 ms (brass, voices)
    scoop: clamp(def.scoop || 0, 0, 2), scoopCoef: def.scoop ? t60(0.07, sr) : 0,
    legato: !!def.legato, // a note into a held one is a hammer-on or a slide: the string is not picked again
    ring: !!def.guitar, // a guitar: each string rings until it plays again or is damped (TrackBus.strike)
  };
}

// the layers' moves for where they play: in a song (music: each note starts them again, in beats at bps), or over a
// game sound (len: its length, in seconds)
export function timeMoves(p, opts) {
  for (const l of p.layers || []) l.mv = movesOf(l.moves, LAYER_MOVE_PARAMS, opts);
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

// One layer of a note: its envelope and its source. The note (Voice) gives it the pitch (in midi notes, with glide,
// scoop, vibrato), the players' drift (ensemble) and the velocity; the layer adds its own pitch and its moves.
class Osc {
  constructor() {
    this.stage = IDLE; this.level = 0;
    this.ph = new Float64Array(4);
    for (let i = 0; i < 4; i++) this.ph[i] = Math.random();
    this.lvl = 0; // wavetable level for the current pitch
    this.pk = 0; this.pkN = 1; this.pkZ = 0; // string: the pick's click, samples left of it
    this.kb = null; this.kw = 0; this.kPrev = 0; this.kLoss = 0.999; // string: loop buffer, write index
    this.mph = new Float64Array(4); this.mfb = new Float64Array(4); // fm: modulator phases and last outputs
    this.bows = []; // bowed: a string per player
    this.m = NaN; this.f = 440; // the pitch the frequency (and what follows from it) was last worked out for
    this.nz = 0; this.nzPh = 0; // chip noise: the value it holds, and how far to the next
  }
  // short: a palm-muted note (true), or 2: a dead one (the strings damped by the fretting hand). hammer: the string
  // sounds on and only changes its pitch
  start(L, midi, vel, short, legato, seed, hammer = false) {
    this.L = L; this.vel = vel; this.seed = seed;
    this.age = 0; this.ctl = 0; this.m = NaN;
    this.wait = legato ? 0 : L.delay; this.late = false;
    this.stage = ATT;
    this.control();
    const m = midi + this.dp;
    if (L.type === 'string' && !(hammer && this.kb)) { // every note is picked (but a hammer-on); glide still slides into it
      this.pluck(L, 440 * Math.pow(2, (m - 69) / 12), short === 2 ? 1 : short ? L.sMute : 0);
      this.pk = this.pkN = L.sPick > 0 ? Math.round(0.004 * L.sr) : 0; this.pkZ = 0;
    }
    if (L.type === 'bowed') while (this.bows.length < L.U) this.bows.push(new BowedString());
    if (L.type === 'sample' && !legato) {
      this.zone = null; this.spos = 0;
      for (const z of L.zones) if (!this.zone || Math.abs(z.root - m) < Math.abs(this.zone.root - m)) this.zone = z;
    }
  }
  // its moved settings, every CTL samples: the pitch it adds to the note's, its level, the pulse's width, the noise
  control() {
    const L = this.L, mv = L.mv, t = this.age;
    if (!mv.length) { this.dp = L.pitch + L.sub; this.lv = L.level; this.duty = L.duty; this.noise = L.noise; return; }
    const P = LAYER_MOVE_PARAMS;
    this.dp = valueAt(L.pitch, 'pitch', mv, P.pitch, t) + L.sub;
    this.lv = valueAt(L.level, 'level', mv, P.level, t);
    this.duty = valueAt(L.duty, 'duty', mv, P.duty, t);
    this.noise = valueAt(L.noise, 'noise', mv, P.noise, t);
  }
  // a released layer still waiting for its delay plays its attack, then lets go
  release() { if (this.stage === IDLE) return; if (this.wait > 0) this.late = true; else this.stage = REL; }
  // a random value -1..1 (xorshift: a sound's noise is the same every time it is drawn)
  rand() { let s = this.seed; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; this.seed = s >>> 0; return this.seed / 2147483648 - 1; }
  // Karplus-Strong: a period of filtered noise circulates in a delay loop that loses a little each pass.
  // mute 0..1: a palm-muted note, much duller and dying within a few hundredths of a second (through a driven amp,
  // anything above about -35 dB still clips, so the string has to fall fast to sound damped)
  pluck(L, f, mute = 0) {
    const kb = (this.kb ||= new Float32Array(STRING_BUF)), mask = STRING_BUF - 1;
    const n = Math.min(STRING_BUF - 4, Math.ceil(L.sr / f) + 2), c = (0.15 + 0.85 * L.sBright * (0.5 + 0.5 * this.vel)) * (1 - 0.85 * mute);
    let lp = 0, mean = 0;
    for (let i = 1; i <= n; i++) { lp += (Math.random() * 2 - 1 - lp) * c; kb[(this.kw - i) & mask] = lp; mean += lp; }
    mean /= n;
    for (let i = 1; i <= n; i++) kb[(this.kw - i) & mask] -= mean; // no DC in the loop
    for (const at of [L.sPos, L.sPickup]) {
      if (!(at > 0)) continue;
      // the pick position: a comb (the burst less itself a fraction of the period later) takes out the harmonics
      // that have a node where the string is plucked; then back to the burst's loudness
      // over one period of the loop as it will play (its filter adds half a sample). A pickup hears the string the
      // same way (a node there is silent to it), and the loop is linear: so its comb goes into the burst too
      const P = Math.max(2, Math.min(n, Math.round(L.sr / f - 0.5 * (1 - L.sBright)))), d = Math.max(1, Math.round(at * P));
      const tmp = (this.kTmp ||= new Float32Array(STRING_BUF));
      let e0 = 0, e1 = 0;
      for (let i = 0; i < P; i++) { tmp[i] = kb[(this.kw - 1 - i) & mask]; e0 += tmp[i] * tmp[i]; }
      for (let i = 0; i < P; i++) { const y = tmp[i] - tmp[(i + d) % P]; kb[(this.kw - 1 - i) & mask] = y; e1 += y * y; }
      const g = e1 > 0 ? Math.sqrt(e0 / e1) : 1;
      for (let i = 0; i < n; i++) kb[(this.kw - 1 - i) & mask] = i < P ? kb[(this.kw - 1 - i) & mask] * g : kb[(this.kw - 1 - (i % P)) & mask];
    }
    this.kPrev = 0;
    this.kLoss = Math.exp(-6.9 / (Math.pow(L.sDecay, 1 - mute) * Math.pow(0.035, mute) * f)); // -60 dB after sDecay s (35 ms fully muted)
  }
  // one sample of the string at frequency f (glide and vibrato change the loop length)
  string(L, f) {
    const kb = this.kb, mask = STRING_BUF - 1, b = L.sBright;
    const d = Math.min(STRING_BUF - 4, L.sr / f - 0.5 * (1 - b)); // the loop filter adds half a sample of delay
    const r = this.kw - d, i = Math.floor(r), fr = r - i;
    const y = kb[i & mask] + (kb[(i + 1) & mask] - kb[i & mask]) * fr;
    kb[this.kw & mask] = this.kLoss * (b * y + (1 - b) * 0.5 * (y + this.kPrev));
    this.kPrev = y;
    this.kw = (this.kw + 1) | 0;
    return y;
  }
  // one sample at the note's pitch m (midi), with the players' drift ens and the note's limits for the wavetables
  tone(p, m, ens) {
    if (this.wait > 0) { this.wait--; return 0; }
    const L = this.L;
    let lv = this.level;
    switch (this.stage) {
      case IDLE: return 0;
      case ATT: lv += L.attInc; if (lv >= 1) { lv = 1; this.stage = this.late ? REL : DEC; } break;
      case DEC: lv = L.sus + (lv - L.sus) * L.decCoef; if (L.sus <= 0 && lv < 1e-4) this.stage = IDLE; break;
      case REL: lv *= L.relCoef; if (lv < 1e-4) this.stage = IDLE; break;
    }
    this.level = lv;
    if (this.stage === IDLE) { this.level = 0; return 0; }
    this.age += L.invSr;
    if (++this.ctl >= CTL) { this.ctl = 0; this.control(); }
    m += this.dp;
    if (m !== this.m) {
      this.m = m;
      this.f = 440 * Math.pow(2, (m - 69) / 12);
      if (this.zone) this.sInc = Math.pow(2, (m - this.zone.root) / 12) * this.zone.rate * L.invSr;
    }
    const f = this.f, sr = L.sr, g = lv * this.vel * this.lv;
    let out = 0;
    // bowed: the envelope is the bow's speed, so a note swells like a bow stroke; with unison a section of players,
    // and with ensemble each player's pitch wanders and their vibrato is never quite even
    if (L.type === 'bowed') {
      if (this.bows.length < L.U) return 0; // the layer became bowed while this voice was sounding
      const v = (0.03 + 0.2 * this.vel) * lv;
      for (let u = 0; u < L.U; u++) out += this.bows[u].tick(L, f * L.detuneMul[u] * ens[u], v);
      return out * L.uniNorm * this.vel * this.lv;
    }
    if (L.type === 'sample') {
      // the recording, resampled to the note (glide and vibrato too); sustained notes loop, others end
      const z = this.zone;
      if (!z) return 0;
      const d = z.data, i = this.spos | 0, fr = this.spos - i, j = z.loopEnd && i + 1 >= z.loopEnd ? z.loopStart : i + 1;
      const y = d[i] + ((d[j] || 0) - d[i]) * fr;
      this.spos += this.sInc;
      if (z.loopEnd) { if (this.spos >= z.loopEnd) this.spos -= z.loopEnd - z.loopStart; }
      else if (this.spos >= d.length - 1) { this.stage = IDLE; this.level = 0; }
      return y * g * 5; // recordings sit at -16 dB: about as loud as a saw
    }
    if (L.type === 'string') {
      if (!this.kb) this.pluck(L, f); // the layer became a string while this voice was sounding
      let y = this.string(L, f);
      if (this.pk > 0) { // the pick's click: 4 ms of noise, its lows taken out, dying fast
        const e = this.pk-- / this.pkN, r = this.rand();
        y += L.sPick * 0.5 * e * e * (r - this.pkZ);
        this.pkZ = r;
      }
      return y * lv * this.vel * 3.5 * this.lv;
    }
    if (L.type === 'noise') return this.chip(f) * g;
    if (L.type === 'fm') {
      // a modulator near Nyquist would fold its sidebands back down: high ratios fade out on high notes
      const fm = f * L.fmRatio, aa = fm < 0.3 * L.sr ? 1 : clamp01((0.45 * L.sr - fm) / (0.15 * L.sr));
      const I = L.fmIndex * aa * (1 - L.fmEnv + L.fmEnv * lv) * (0.5 + 0.5 * this.vel);
      for (let u = 0; u < L.U; u++) {
        const dt = (f * L.detuneMul[u] * ens[u]) / sr;
        let ph = this.ph[u] + dt;
        if (ph >= 1) ph -= 1;
        this.ph[u] = ph;
        let mp = this.mph[u] + dt * L.fmRatio;
        mp -= Math.floor(mp);
        this.mph[u] = mp;
        const mod = Math.sin(TWO_PI * mp + L.fmFb * this.mfb[u]);
        this.mfb[u] = mod;
        out += Math.sin(TWO_PI * ph + I * mod);
      }
      return this.mix(out * L.uniNorm, f) * g;
    }
    let duty = this.duty, tb = null;
    if (L.mips) {
      // the fullest table whose harmonics stay below Nyquist at this pitch
      const lim = p.mipLimits, fmax = f * 1.03; // headroom for unison detune
      let l = this.lvl;
      while (l > 0 && fmax < lim[l - 1]) l--;
      while (l < lim.length - 1 && fmax > lim[l]) l++;
      this.lvl = l;
      tb = L.mips[l];
    } else if (L.pwmDepth) duty += L.pwmDepth * Math.sin(TWO_PI * L.pwmRate * this.age);
    duty = duty < 0.05 ? 0.05 : duty > 0.95 ? 0.95 : duty;
    for (let u = 0; u < L.U; u++) {
      const dt = (f * L.detuneMul[u] * ens[u]) / sr;
      let ph = this.ph[u] + dt;
      if (ph >= 1) ph -= 1;
      this.ph[u] = ph;
      if (L.type === 'pulse') {
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
    return this.mix(out * L.uniNorm, f) * g;
  }
  // chip noise: a new random value 32 times a period of the pitch, so it is pitched like the NES's
  chip(f) {
    if ((this.nzPh += (f * 32) * this.L.invSr) >= 1) { this.nzPh -= Math.floor(this.nzPh); this.nz = this.rand(); }
    return this.nz;
  }
  // the tone with noise mixed in (a layer's noise)
  mix(x, f) { const n = this.noise; return n > 0 ? x * (1 - n) + this.chip(f) * n : x; }
}

// One note of an instrument: its pitch (glide, scoop, an arp, vibrato), the players of a section (unison, ensemble),
// its layers, and the breath around them. stage is IDLE once every layer is quiet; level the loudest layer's envelope.
export class Voice {
  constructor() {
    this.stage = IDLE; this.level = 0; this.gate = false;
    this.str = -1; // the guitar string it sounds (TrackBus.strike), -1: none
    this.cur = 60; this.target = 60; this.vel = 1; this.age = 0;
    this.arp = null; this.arpIdx = 0; this.arpT = 0;
    this.osc = Array.from({ length: MAX_LAYERS }, () => new Osc());
    this.n = 0; // layers playing
    // ensemble: per player a slow drift rate, a vibrato rate and a phase; ens holds their pitch factors
    this.rnd = Array.from({ length: 4 }, () => [0.13 + Math.random() * 0.25, 4.8 + Math.random() * 1.4, Math.random() * TWO_PI]);
    this.ens = new Float64Array(4).fill(1); this.ensT = 0;
    this.m = NaN; this.f = 440;
    this.bms = 0; this.blo = 0; this.bband = 0; // breath: the tone's power, the band's state
    this.seed = (Math.random() * 4294967296) >>> 0 || 1; // its noise (a game sound sets it, so each play is the same)
  }
  start(p, midi, vel, arp, short = false) {
    const legato = this.stage !== IDLE && p.glideCoef > 0;
    // into a note still held, a step or two away: a hammer-on or a pull-off (further, it is picked and glide slides there)
    const hammer = p.legato && this.gate && this.stage !== IDLE && Math.abs(midi - this.target) <= 2;
    this.target = midi;
    if (!legato && !hammer) this.cur = midi - p.scoop;
    this.vel = vel; this.stage = ATT; this.gate = true; this.age = 0;
    this.arp = arp; this.arpIdx = 0; this.arpT = 0; this.m = NaN;
    const ls = p.layers;
    this.n = ls.length;
    for (let i = 0; i < ls.length; i++) this.osc[i].start(ls[i], midi, vel, short, (legato || hammer) && this.osc[i].stage !== IDLE, (this.seed + i * 0x9e3779b9) >>> 0 || 1, hammer && this.osc[i].stage !== IDLE);
    for (let i = ls.length; i < MAX_LAYERS; i++) this.osc[i].stage = IDLE;
  }
  release() {
    if (this.stage !== IDLE) for (let i = 0; i < this.n; i++) this.osc[i].release();
    this.gate = false;
  }
  stop() { this.stage = IDLE; this.level = 0; this.gate = false; for (const o of this.osc) { o.stage = IDLE; o.level = 0; } }
  // a section's players: each wanders slowly off pitch (up to 5 cents) and has its own vibrato (7 cents), fading in
  drift(p) {
    const a = this.age, k = p.ensemble, fade = Math.min(1, a / 0.4);
    for (let u = 0; u < p.U; u++) {
      const r = this.rnd[u];
      this.ens[u] = Math.pow(2, (k * (5 * Math.sin(TWO_PI * r[0] * a + r[2]) + 7 * fade * Math.sin(TWO_PI * r[1] * a + 3 * r[2]))) / 1200);
    }
  }
  // one sample: the layers, and the breath around them
  render(p) {
    if (this.stage === IDLE) return 0;
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
    if (p.ensemble && (this.ensT = (this.ensT + 1) & 31) === 1) this.drift(p);
    let y = 0, lv = 0, on = false;
    for (let i = 0; i < this.n; i++) {
      const o = this.osc[i];
      if (o.stage === IDLE) continue;
      y += o.tone(p, m, this.ens);
      if (o.stage !== IDLE) on = true;
      if (o.level > lv) lv = o.level;
    }
    this.level = lv;
    if (!on) { this.stage = IDLE; this.level = 0; return y; }
    if (!p.breath) return y;
    if (m !== this.m) { this.m = m; this.f = 440 * Math.pow(2, (m - 69) / 12); this.breathBand(p); }
    return y + this.breathe(p, y);
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
}
