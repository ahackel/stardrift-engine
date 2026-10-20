// An instrument: up to three layers played as one note, each a source (a pulse, a wave, a string, FM, noise …) with
// its own envelope, pitch, level and moves; the note's own effects (unison, vibrato, glide, scoop, breath, arp); and
// a chain of effects in any order (fx.js). A drum kit is an instrument of type 'drums' instead (drums.js).
// A game sound (sfx.js) plays an instrument (one of the song's, or its own `inst`) as one note.
import { migrateFx } from './fx.js';

export const MAX_LAYERS = 3;
export const LAYER_TYPES = ['pulse', 'triangle', 'wave', 'string', 'fm', 'bowed', 'sample', 'noise'];
// what an instrument from before layers had as its one source
const LAYER_KEYS = ['type', 'wave', 'drawbars', 'smooth', 'duty', 'pwm', 'fm', 'string', 'bow', 'sample', 'env'];
// the settings of a layer that can move (each note starts them again): pitch in semitones from the note
const P = (min, max, def) => ({ min, max, def, log: false });
export const LAYER_MOVE_PARAMS = { pitch: P(-48, 48, 0), level: P(0, 1, 1), duty: P(0.05, 0.5, 0.5), noise: P(0, 1, 0) };
export const LAYER_MOVES = Object.keys(LAYER_MOVE_PARAMS);
export const isKit = (d) => d?.type === 'drums';

// An instrument as it is now: its effects a list (fx.js migrateFx), its source in layers. Older ones had one source
// in their own keys (type, wave, env …): that becomes the first layer.
export function migrateInstrument(def) {
  if (!def || typeof def !== 'object') return def;
  let d = migrateFx(def);
  if (isKit(d) || Array.isArray(d.layers)) return d;
  d = { ...d };
  const l = {};
  for (const k of LAYER_KEYS) if (d[k] !== undefined) { l[k] = d[k]; delete d[k]; }
  d.layers = [l];
  return d;
}

// the layers' envelopes and how long the note is held: when the last of it is quiet, in seconds after it starts
export function noteTail(def, gate) {
  let end = 0;
  for (const l of def.layers || []) {
    if (!l || l.off) continue;
    const e = l.env || {}, a = e.a ?? 0.01, d = e.d ?? 0.2, s = e.s ?? 0.7, r = e.r ?? 0.2;
    let t = s > 0 ? Math.max(gate, a) + r : Math.min(Math.max(gate, a) + r, a + d);
    if (l.type === 'string') t = Math.max(t, Math.min(gate + r, l.string?.decay ?? 2));
    end = Math.max(end, (l.delay || 0) + t);
  }
  return end;
}

// ---------------------------------------------------------------- game sounds from before they were instruments
// A layer then: wave (square, triangle, saw, sine, noise), pitch in Hz, length (s), attack (of the length), punch
// (0 holds, 1 dies at once), noise, duty, level, delay, moves (pitch in Hz). Now the sound has the note (its first
// layer's pitch) and the length; each layer its type, its pitch in semitones from the note and an envelope.
const OLD_WAVES = { square: { type: 'pulse' }, triangle: { type: 'triangle', smooth: true }, saw: { type: 'wave', wave: 'saw', smooth: true }, sine: { type: 'wave', wave: 'sine', smooth: true }, noise: { type: 'noise' } };
const st = (f, f0) => Math.round(12 * Math.log2(f / f0) * 100) / 100;
const old = (s) => s.note === undefined && Array.isArray(s.layers) && s.layers.some((l) => l && l.type === undefined && ('length' in l || 'punch' in l || 'attack' in l || l.wave in OLD_WAVES || l.pitch > 48));
function fromHz(def) {
  const layers = def.layers.filter(Boolean), f0 = layers[0].pitch || 440;
  const out = { ...def, note: Math.round((69 + 12 * Math.log2(f0 / 440)) * 100) / 100, length: 0 };
  out.layers = layers.map((l) => {
    const len = l.length ?? 0.25, a = Math.max(0.001, (l.attack || 0) * len), punch = l.punch ?? 0.5, f = l.pitch || 440;
    out.length = Math.max(out.length, (l.delay || 0) + len);
    const n = { ...(OLD_WAVES[l.wave] || OLD_WAVES.square), env: { a: +a.toFixed(3), d: +Math.max(0.01, (len - a) * (1.3 - punch)).toFixed(3), s: 0, r: 0.02 } };
    if (f !== f0) n.pitch = st(f, f0);
    for (const k of ['level', 'delay', 'noise', 'off']) if (l[k] !== undefined) n[k] = l[k];
    if (l.wave === 'square' && l.duty !== undefined) n.duty = l.duty;
    if (Array.isArray(l.moves) && l.moves.length) n.moves = l.moves.map((m) => (m?.on === 'pitch' ? { ...m, to: (n.pitch || 0) + st(m.to || f, f) } : m));
    return n;
  });
  out.length = +out.length.toFixed(3);
  return out;
}

// A sound's own settings: what the game calls it, the instrument it plays (a key of song.instruments), the note, how
// it plays in the game. A sound's own instrument is its inst (music.sound({ … }), renderSound); the rest of a sound
// from before it had one (its layers, effects, the note's effects at the top) is that instrument.
export const SOUND_OWN = ['id', 'name', 'color', 'instrument', 'note', 'length', 'volume', 'echo', 'reverb', 'duck', 'vary', 'key', 'at'];
export function migrateSound(def) {
  if (!def || typeof def !== 'object' || typeof def.instrument === 'string') return def;
  if (def.inst && typeof def.inst === 'object' && !Array.isArray(def.inst)) {
    const inst = migrateInstrument(def.inst);
    return inst === def.inst ? def : { ...def, inst };
  }
  const flat = old(def) ? fromHz(def) : def, out = {}, inst = {};
  for (const [k, v] of Object.entries(flat)) (SOUND_OWN.includes(k) ? out : inst)[k] = v;
  out.inst = migrateInstrument(inst);
  return out;
}

// ---------------------------------------------------------------- what an instrument costs to play
// Measured (tools/cost.mjs): the time a sample takes, as parts of a plain pulse note's. A note's own work (its pitch,
// its layers' envelopes), each layer's source (and each further player of a unison), what the note's effects add,
// and the chain's effects, which play once for the track however many notes sound.
const NOTE_COST = 0.75;
const SOURCE_COST = { pulse: [0.25, 0.04], triangle: [0.45, 0.05], wave: [0.5, 0.05], fm: [1.4, 0.8], string: [0.45, 0], bowed: [0.7, 0.5], sample: [0.4, 0], noise: [0.15, 0] };
const FX_COST = { body: 0.9, wah: 0.65, drive: 1.1, filter: 0.4, crush: 0.4, eq: 0.25, ring: 0.7, vowel: 1, delay: 0.5, phaser: 0.65, chorus: 1.6, tremolo: 1, autopan: 0.45, leslie: 1.4 };
const KIT_COST = 2.5; // a drum hit or two at a time
// { note: one note, notes: how many sound at once (a chord: its poly, but four at most, as most chords are),
// fx: the effects, total } (1: a plain pulse note)
export function costOf(def, poly = def?.poly) {
  const d = migrateInstrument(def) || {};
  const fx = (Array.isArray(d.fx) ? d.fx : []).reduce((a, f) => a + (f && !f.off ? FX_COST[f.kind] || 0 : 0), 0);
  if (isKit(d)) return { note: KIT_COST, notes: 1, fx, total: KIT_COST + fx };
  let note = NOTE_COST;
  const U = Math.max(1, Math.min(4, d.unison | 0 || 1));
  for (const l of (d.layers || [{}]).slice(0, MAX_LAYERS)) {
    if (!l || l.off) continue;
    const [base, more] = SOURCE_COST[l.type] || SOURCE_COST.pulse;
    note += base + (['string', 'sample', 'noise'].includes(l.type) ? 0 : more * (U - 1));
    if (l.noise > 0 && l.type !== 'noise') note += 0.2;
    if (Array.isArray(l.moves) && l.moves.length) note += 0.15;
  }
  if (d.vibrato?.depth > 0) note += 0.8;
  if (d.breath > 0 || d.noise > 0) note += 0.5;
  if (d.ensemble > 0 && U > 1) note += 0.15;
  const notes = Math.max(1, Math.min(4, poly | 0 || 1));
  return { note: +note.toFixed(2), notes, fx: +fx.toFixed(2), total: +(note * notes + fx).toFixed(2) };
}
