// Sample-by-sample chip synth: pulse (with PWM), NES-style 4-bit triangle, 32-step wavetable, plucked string
// (Karplus-Strong: guitars, harp, pizzicato), synthesized drum kits (drums.js), instrument bodies (fixed resonances),
// section ensembles, per-track drive with an amp (EQ, clipper, speaker cabinet), double tracking, state-variable lowpass, ping-pong echo and a small Freeverb.
// Deliberately plain code (no Web Audio nodes) so it ports 1:1 to C# OnAudioFilterRead.

import { DrumVoice, compileKit } from './drums.js';
import { TABLE_SIZE, stairHarmonics, sampledHarmonics, formulaHarmonics, buildTables, levelLimits, cachedTables } from './wavetable.js';

const TWO_PI = Math.PI * 2;
const IDLE = 0, ATT = 1, DEC = 2, REL = 3;

const TRI_TABLE = new Float32Array(32);
for (let i = 0; i < 32; i++) TRI_TABLE[i] = (i < 16 ? 15 - i : i - 16) / 7.5 - 1;


// 32 steps of 4-bit values (0..15): a preset name or a custom array (editor-drawable).
export const WAVE_PRESETS = ['soft', 'sine', 'saw', 'warm', 'organ', 'hollow'];
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
        : buildTables(stairHarmonics(TRI_TABLE));
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

// RBJ cookbook biquads, [kind, Hz, Q, dB] with kind lp | hp | peak, as flat coefficients (b0 b1 b2 a1 a2 per stage)
function biquads(list, sr) {
  const c = new Float64Array(list.length * 5);
  list.forEach(([kind, f, q = 0.707, db = 0], i) => {
    const w = (TWO_PI * Math.min(f, sr * 0.45)) / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q), A = Math.pow(10, db / 40);
    let b0, b1, b2, a0, a1, a2;
    if (kind === 'lp') { b1 = 1 - cs; b0 = b2 = b1 / 2; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
    else if (kind === 'hp') { b1 = -(1 + cs); b0 = b2 = (1 + cs) / 2; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
    else { b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A; }
    c.set([b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0], i * 5);
  });
  return c;
}
// one sample through a chain of biquads (transposed direct form II; z holds two states per stage)
function chain(c, z, x) {
  for (let i = 0, j = 0; i < c.length; i += 5, j += 2) {
    const y = c[i] * x + z[j];
    z[j] = c[i + 1] * x - c[i + 3] * y + z[j + 1];
    z[j + 1] = c[i + 2] * x - c[i + 4] * y;
    x = y;
  }
  return x;
}
// log(cosh(x)), the integral of tanh, without overflow
const logcosh = (x) => { const a = Math.abs(x); return a + Math.log1p(Math.exp(-2 * a)) - Math.LN2; };

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
// of what makes a sound a violin or a horn rather than a synth. [kind, Hz, Q, dB] like the amps; a sound's `body` is
// a name from here or its own list, and is levelled so a sound keeps its loudness with a body.
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

// the gain of a biquad chain at f Hz
function chainMag(c, sr, f) {
  const w = (TWO_PI * f) / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  let m = 1;
  for (let i = 0; i < c.length; i += 5) {
    const nr = c[i] + c[i + 1] * c1 + c[i + 2] * c2, ni = -(c[i + 1] * s1 + c[i + 2] * s2);
    const dr = 1 + c[i + 3] * c1 + c[i + 4] * c2, di = -(c[i + 3] * s1 + c[i + 4] * s2);
    m *= Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  return m;
}
// a body's coefficients and the gain that levels it (its average power from 150 Hz to 5 kHz back to 1)
function compileBody(spec, sr) {
  const list = typeof spec === 'string' ? BODIES[spec] : Array.isArray(spec) ? spec : null;
  if (!list?.length) return null;
  const c = biquads(list, sr);
  let pw = 0;
  for (let i = 0; i < 24; i++) pw += chainMag(c, sr, 150 * Math.pow(5000 / 150, i / 23)) ** 2;
  return { c, gain: 1 / Math.sqrt(pw / 24) };
}

const TYPES = ['pulse', 'triangle', 'wave', 'string', 'fm', 'bowed', 'sample', 'drums'];
const STRING_BUF = 4096; // ring buffer per string voice: a period of up to 4096 samples (~12 Hz at 48 kHz)
const WG_BUF = 4096, WG_MASK = WG_BUF - 1; // waveguides of the bowed string

// samples: the loaded sample library (see src/samples.js), { name: [zones] }; a sound of type sample plays def.sample
export function compileInst(def = {}, sr, samples = {}) {
  const env = def.env || {};
  const a = Math.max(0.001, env.a ?? 0.01), d = Math.max(0.001, env.d ?? 0.2), r = Math.max(0.001, env.r ?? 0.2);
  const U = ['string', 'sample'].includes(def.type) ? 1 : Math.max(1, Math.min(4, def.unison | 0 || 1));
  const amp = AMPS[def.amp], bias = amp?.bias || 0;
  const driveG = def.drive > 0 ? 1 + Math.min(2, def.drive) * 24 : amp ? 1 : 0; // 1 = crunch, 2 = high gain
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
    mips: def.type === 'wave' || def.type === 'triangle' ? waveTables(def) : null,
    mipLimits: levelLimits(sr),
    cutoff: def.cutoff ?? 16000, cutoffIntensity: def.cutoffIntensity || 0, cutoffTension: def.cutoffTension || 0,
    q: def.resonance ?? 0.707,
    // filter envelope: each note opens the filter by `amount` octaves (scaled by velocity), closing over `decay` s
    fenvAmt: def.filterEnv?.amount || 0, fenvCoef: Math.exp(-4.6 / (Math.max(0.005, def.filterEnv?.decay ?? 0.2) * sr)),
    gain: def.gain ?? 1,
    // drive: soft clipping of the track's voices before its filter, inside an amp if the sound names one;
    // scaled so a normal-level note keeps its level while louder ones (chords) saturate
    driveG, driveBias: bias, driveOffset: Math.tanh(bias), driveNorm: driveG ? 0.5 / (Math.tanh(driveG * 0.5 + bias) - Math.tanh(bias)) : 1,
    amp: amp ? { pre: biquads(amp.pre, sr), post: biquads(amp.post, sr), gain: amp.gain } : null,
    noise: Math.max(0, Math.min(1, def.noise || 0)), // breath: white noise under the tone, following its envelope
    body: compileBody(def.body, sr),
    // fm: a sine carrier whose phase a sine modulator bends; ratio = modulator / carrier frequency, index = how far
    // (brightness), env 0..1 = how much the index follows the note's loudness (brass brightens as it swells),
    // feedback roughens the modulator
    fmRatio: def.fm?.ratio ?? 1, fmIndex: def.fm?.index ?? 2, fmEnv: Math.max(0, Math.min(1, def.fm?.env ?? 1)), fmFb: def.fm?.feedback || 0,
    // ensemble 0..1: each unison voice (a player of the section) drifts and vibrates on its own
    ensemble: U > 1 || def.ensemble ? Math.max(0, Math.min(1, def.ensemble || 0)) : 0,
    // swell: the filter opens this many octaves with the note's loudness (brass and bowed strings brighten as they swell)
    swell: Math.max(0, Math.min(4, def.swell || 0)),
    // scoop: a note starts this many semitones flat and slides up within about 70 ms (brass, voices)
    scoop: Math.max(0, Math.min(2, def.scoop || 0)), scoopCoef: def.scoop ? Math.exp(-4.6 / (0.07 * sr)) : 0,
    // string: T60 decay in seconds and brightness 0..1 (how much of the high end the loop keeps and the pluck has)
    sDecay: Math.max(0.05, def.string?.decay ?? 2), sBright: Math.max(0, Math.min(1, def.string?.bright ?? 0.5)),
    sMute: Math.max(0, Math.min(1, def.string?.mute || 0)), // palm mute: how damped and dull short notes are
    // bowed: pressure 0..1 (light and airy … scratchy), position 0..1 (near the bridge … towards the fingerboard)
    bowSlope: 5 - 4 * Math.max(0, Math.min(1, def.bow?.pressure ?? 0.8)), bowBeta: 0.04 + 0.2 * Math.max(0, Math.min(1, def.bow?.position ?? 0.4)),
    stringPole: 0.75 - (0.2 * 22050) / sr,
    // sample: recorded notes (zones), each played from the one whose root is nearest; empty until the library is loaded
    zones: def.type === 'sample' ? samples[def.sample] || [] : null,
    kit: def.type === 'drums' ? compileKit(def, sr, samples) : null,
  };
}

function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

// One bowed string (after STK's Bowed): the bow splits the string into a neck part and a bridge part (two delay
// lines). Where the bow touches, it sticks while the string moves with it and slips when the difference grows:
// the bow table. The loop is two samples shorter than the period for the delay of the bridge filter. Pressure 0.8 at position
// 0.4 (the defaults) keeps the string in its normal motion from G1 to E5; much lighter or heavier bowing can make it
// jump an octave.
class BowedString {
  constructor() { this.a = new Float32Array(WG_BUF); this.b = new Float32Array(WG_BUF); this.i = 0; this.w1 = 0; }
  // a read from a delay line d samples back (linear interpolation)
  tap(buf, d) {
    const r = this.i - d, i = Math.floor(r), fr = r - i;
    return buf[i & WG_MASK] + (buf[(i + 1) & WG_MASK] - buf[i & WG_MASK]) * fr;
  }
  // one sample at frequency f with the bow moving at speed v; returns the bridge's motion
  tick(p, f, v) {
    const a = p.stringPole, base = Math.max(4, p.sr / f - 2), bridgeLen = base * p.bowBeta, neckLen = base - bridgeLen;
    const bridgeOut = this.tap(this.b, bridgeLen), neckOut = this.tap(this.a, neckLen);
    this.w1 = (1 - a) * 0.95 * bridgeOut + a * this.w1; // string losses at the bridge (one pole)
    const bridgeRefl = -this.w1, nutRefl = -neckOut, stringVel = bridgeRefl + nutRefl;
    const velDiff = v - stringVel;
    let k = Math.pow(Math.abs(velDiff * p.bowSlope) + 0.75, -4);
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
  }
  start(p, midi, vel, arp, short = false) {
    const legato = this.stage !== IDLE && p.glideCoef > 0;
    this.target = midi;
    if (!legato) this.cur = midi - p.scoop;
    this.vel = vel; this.stage = ATT; this.gate = true; this.age = 0;
    this.arp = arp; this.arpIdx = 0; this.arpT = 0;
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
      const k = p.glideCoef || p.scoopCoef;
      this.cur = k ? this.target + (this.cur - this.target) * k : this.target;
      m = this.cur;
    }
    if (p.vibDepth && this.age > p.vibDelay) {
      const ramp = Math.min(1, (this.age - p.vibDelay) / 0.4);
      m += p.vibDepth * ramp * Math.sin(TWO_PI * p.vibRate * this.age);
    }
    const f = 440 * Math.pow(2, (m - 69) / 12);
    const sr = p.sr;
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
      this.spos += Math.pow(2, (m - z.root) / 12) * z.rate * p.invSr;
      if (z.loopEnd) { if (this.spos >= z.loopEnd) this.spos -= z.loopEnd - z.loopStart; }
      else if (this.spos >= d.length - 1) { this.stage = IDLE; this.level = 0; }
      return (y + (p.noise ? p.noise * (Math.random() * 2 - 1) : 0)) * lv * this.vel * 5; // recordings sit at -16 dB: about as loud as a saw
    }
    if (p.type === 'string') {
      if (!this.kb) this.pluck(p, f); // the sound became a string while this voice was sounding
      return (this.string(p, f) + (p.noise ? p.noise * (Math.random() * 2 - 1) : 0)) * lv * this.vel * 3.5;
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
      if (p.noise) out = out * (1 - 0.5 * p.noise) + p.noise * (Math.random() * 2 - 1) * p.U;
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
    if (p.noise) out = out * (1 - 0.5 * p.noise) + p.noise * (Math.random() * 2 - 1) * p.U;
    return out * p.uniNorm * lv * this.vel;
  }
}

class TrackBus {
  constructor(poly, isDrum) {
    this.isDrum = isDrum;
    this.voices = Array.from({ length: poly }, () => (isDrum ? new DrumVoice() : new Voice()));
    this.ic1 = 0; this.ic2 = 0; this.cut = 1000; this.cutTarget = 1000; this.coefTimer = 0;
    this.g = 0; this.gTarget = 1; this.rr = 0;
    this.fenv = 0; // filter envelope level (1 at a note's start, decays)
    this.u1 = 0; this.F1 = 0; // the clipper's previous input and its integral
    this.loud = 0; // the loudest voice's envelope level (swell)
  }
  set(tr, p, sr) {
    this.p = p; this.sr = sr;
    this.vol = (tr.volume ?? 0.3) * p.gain;
    const pan = Math.max(-1, Math.min(1, tr.pan || 0));
    this.pl = Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
    this.pr = Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
    this.echo = tr.echo || 0; this.rev = tr.reverb || 0;
    this.pump = Math.max(0, Math.min(1, tr.pump || 0)); // sidechain: dips on every kick
    if (p.body && this.zBody?.length !== p.body.c.length / 2.5) this.zBody = new Float64Array(p.body.c.length / 2.5);
    if (p.amp && this.zPre?.length !== p.amp.pre.length / 2.5) this.zPre = new Float64Array(p.amp.pre.length / 2.5);
    if (p.amp && this.zPost?.length !== p.amp.post.length / 2.5) this.zPost = new Float64Array(p.amp.post.length / 2.5);
    // double tracking: a second take, a few ms late with a slowly wandering delay, on the other side;
    // the two sit at pan ± double
    this.dbl = Math.max(0, Math.min(1, tr.double || 0));
    if (this.dbl) {
      const at = (x) => Math.max(-1, Math.min(1, x)), a = ((at(pan - this.dbl) + 1) * Math.PI) / 4, b = ((at(pan + this.dbl) + 1) * Math.PI) / 4;
      this.pl = Math.cos(a); this.pr = Math.sin(a); this.ql = Math.cos(b); this.qr = Math.sin(b);
      if (!this.dBuf) { this.dBuf = new Float32Array(Math.ceil(sr * 0.03)); this.dI = 0; this.dT = 0; }
    }
    this.updateCoefs();
  }
  // the second take: 14 ms late, the delay drifting by about a millisecond (a few cents of pitch, like a player)
  double(x) {
    const buf = this.dBuf, n = buf.length;
    buf[this.dI] = x;
    this.dT += this.p.invSr;
    const d = this.sr * (0.014 + 0.0012 * Math.sin(TWO_PI * 0.23 * this.dT) + 0.0007 * Math.sin(TWO_PI * 0.61 * this.dT));
    let r = this.dI - d;
    if (r < 0) r += n;
    const i = Math.floor(r), f = r - i, y = buf[i] + (buf[(i + 1) % n] - buf[i]) * f;
    if (++this.dI >= n) this.dI = 0;
    return y;
  }
  // the amp's EQ, the clipper, the cabinet. The clipper is tanh with first-order antiderivative anti-aliasing:
  // it outputs the average of tanh between two samples (from its integral, log cosh). A plain tanh at high gain
  // folds harmonics above Nyquist back into the audible band, the fizz of cheap distortion.
  drive(x) {
    const p = this.p, amp = p.amp;
    if (amp) x = chain(amp.pre, this.zPre, x);
    const u = x * p.driveG + p.driveBias, d = u - this.u1, F = logcosh(u);
    const y = Math.abs(d) > 1e-6 ? (F - this.F1) / d : Math.tanh(0.5 * (u + this.u1));
    this.u1 = u; this.F1 = F;
    x = (y - p.driveOffset) * p.driveNorm;
    return amp ? chain(amp.post, this.zPost, x) * amp.gain : x;
  }
  setMood(intensity, tension) {
    const p = this.p;
    this.cutTarget = Math.min(this.sr * 0.45, Math.max(40, p.cutoff + p.cutoffIntensity * intensity + p.cutoffTension * tension));
  }
  updateCoefs(cut = this.cut) {
    const g = Math.tan((Math.PI * Math.min(cut, this.sr * 0.45)) / this.sr);
    const k = 1 / Math.max(0.3, this.p.q);
    this.a1 = 1 / (1 + g * (g + k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
  }
  noteOn(midis, vel, short) {
    const p = this.p, vs = this.voices;
    if (p.fenvAmt) this.fenv = vel;
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
    if (p.body) x = chain(p.body.c, this.zBody, x) * p.body.gain;
    if (p.driveG) x = this.drive(x);

    if (this.fenv > 0) this.fenv *= p.fenvCoef;
    if (--this.coefTimer <= 0) {
      const env = this.fenv > 0.002, moving = env || p.swell;
      this.coefTimer = moving ? 16 : 64;
      const glide = Math.abs(this.cut - this.cutTarget) > 0.5;
      if (glide) this.cut += (this.cutTarget - this.cut) * (moving ? 0.0015 : 0.006); // ~0.25 s glide
      if (moving) this.updateCoefs(this.cut * Math.pow(2, p.fenvAmt * this.fenv + p.swell * (this.loud - 1)));
      else if (glide || this.fenv > 0) { this.fenv = 0; this.updateCoefs(); }
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
    this.hp = 0; this.hpK = 0;
  }
  set(sec, fb, damp, lowcut = 0) {
    this.dTarget = Math.max(1, Math.min(this.max - 2, Math.round(sec * this.sr)));
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
    this.pd = Math.max(0, Math.min(this.pre.length - 1, Math.round(predelay * this.sr)));
    this.hpK = lowcut > 0 ? 1 - Math.exp((-2 * Math.PI * lowcut) / this.sr) : 0;
  }
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
    this.echo = new Echo(sr); this.reverb = new Reverb(sr);
    this.outL = 0; this.outR = 0;
    this.mutes = {}; this.solos = {};
    this.mood = [0.2, 0.1];
    this.pv = null; this.pvQ = []; this.pvI = 0; this.pvT = 0;
    this.duck = null;
    this.kick = 0; this.kickT = 0; this.kickRel = 0.999; // sidechain envelope: jumps on every kick, recovers
    this.samples = {}; // the sample library, once loaded (Engine.setSamples)
  }
  configure(song) {
    const next = {};
    for (const tr of song.tracks) {
      const p = compileInst(tr.inst, this.sr, this.samples);
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
    this.echo.set((fx.echo.beats * 60) / song.bpm, fx.echo.feedback, fx.echo.damp, fx.echo.lowcut);
    this.echoLevel = fx.echo.level;
    this.reverb.set(fx.reverb.size, fx.reverb.damp, fx.reverb.predelay, fx.reverb.lowcut);
    this.kickRel = Math.exp(-1 / (0.3 * (60 / song.bpm) * this.sr)); // the pump recovers over ~a beat
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
  noteOn(id, midis, vel, short) { this.tracks[id]?.noteOn(midis, vel, short); }
  release(id) { this.tracks[id]?.release(); }
  drum(id, hits, vel) {
    this.tracks[id]?.drum(hits, vel);
    if (hits.includes('k') && this.tracks[id]?.gTarget > 0) this.kickT = Math.max(this.kickT, vel);
  }
  allOff() { for (const b of this.list) b.allOff(); }
  releaseAll() { for (const b of this.list) b.release(); }

  // Audition an instrument outside the song (editor). events: [{ t: seconds, notes: [midi] | hit: 'k', dur, vel }]
  // Plays on its own bus that ignores mute/solo, so it works with the song held or playing.
  preview(def, events, { poly = 1, volume = 0.3 } = {}) {
    const p = compileInst(def, this.sr, this.samples);
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
    this.kickT *= this.kickRel;
    this.kick += (this.kickT - this.kick) * 0.04;
    for (const b of this.list) {
      let x = b.render();
      if (b.pump) x *= 1 - b.pump * this.kick;
      if (b.dbl) {
        const c = b.double(x);
        l += x * b.pl + c * b.ql; r += x * b.pr + c * b.qr;
        x = (x + c) * 0.5;
      } else { l += x * b.pl; r += x * b.pr; }
      e += x * b.echo; v += x * b.rev;
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
