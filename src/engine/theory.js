// Music theory helpers: scales, diatonic chords, song preparation.
import { migrateSong } from './plays.js';
import { notesOf } from './pattern.js';

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  minor: [0, 2, 3, 5, 7, 8, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
};

// Chord shapes as scale-degree offsets from the chord root (diatonic stacking).
export const SHAPES = {
  triad: [0, 2, 4],
  sus2: [0, 1, 4],
  sus4: [0, 3, 4],
  power: [0, 4],
  '7': [0, 2, 4, 6],
  add9: [0, 2, 4, 8],
  six: [0, 2, 4, 5],
};

// a song's steps per beat, beats per bar and steps per bar
export const songSteps = (s) => { const spb = s.stepsPerBeat || 4, bpb = s.beatsPerBar || 4; return { spb, bpb, stepsPerBar: spb * bpb }; };
// the first of these scales that exists (a progression's, then the song's …), else minor
export const scaleOf = (...names) => SCALES[names.find((n) => SCALES[n])] || SCALES.minor;

export const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const NOTE_INDEX = { C: 0, 'C#': 1, DB: 1, D: 2, 'D#': 3, EB: 3, E: 4, F: 5, 'F#': 6, GB: 6, G: 7, 'G#': 8, AB: 8, A: 9, 'A#': 10, BB: 10, B: 11 };
const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii'];

// small helpers the engine and the editor share: a value kept in lo..hi, and the remainder that is never negative
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const mod = (d, n) => ((d % n) + n) % n;

export function parseKey(k) {
  if (typeof k === 'number') return mod(k, 12);
  return NOTE_INDEX[String(k || 'C').trim().toUpperCase()] ?? 0;
}

// Scale degree (any integer, may be negative / beyond one octave) -> semitones from tonic.
export function degSemis(scale, deg) {
  const n = scale.length;
  const o = Math.floor(deg / n);
  return scale[deg - o * n] + 12 * o;
}

// Keep chord roots near the tonic: in a 7-note scale V, VI, VII sit *below* the tonic.
export function foldDegree(deg, n) {
  let r = mod(deg, n);
  if (r > n / 2) r -= n;
  return r;
}

// "i:8 IV(sus2):4 .:4 VII" -> [{degree, shape, shapeName, beats}]  (roman numerals or 1-based numbers). "." is no
// chord (N.C., nc: true): tracks rest their whole chords and play the rest over the home chord (degree 0).
export const parseChords = (str) => String(str || '').trim().split(/\s+/).filter(Boolean).map(parseChord).filter(Boolean);
// one chord of those, or null; a shape it doesn't know is a triad
export function parseChord(tok) {
  const nc = /^\.(?::(\d+(?:\.\d+)?))?$/.exec(tok);
  if (nc) return { nc: true, degree: 0, shapeName: 'triad', shape: SHAPES.triad, beats: nc[1] ? Math.max(0.25, +nc[1]) : 4 };
  const m = /^([ivIV]+|\d+)(?:\((\w+)\))?(?::(\d+(?:\.\d+)?))?$/.exec(tok);
  if (!m) return null;
  const degree = /^\d+$/.test(m[1]) ? +m[1] - 1 : ROMAN.indexOf(m[1].toLowerCase());
  if (degree < 0) return null;
  const shapeName = SHAPES[m[2]] ? m[2] : 'triad';
  return { degree, shapeName, shape: SHAPES[shapeName], beats: m[3] ? Math.max(0.25, +m[3]) : 4 };
}

// Spell a scale degree so a 7-note scale uses every letter once (G# in D lydian, not Ab).
const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
export function noteName(keyRoot, scale, deg) {
  const pc = mod(keyRoot + degSemis(scale, deg), 12);
  if (scale.length !== 7) return NOTE_NAMES[pc];
  const li = (LETTERS.indexOf(NOTE_NAMES[keyRoot][0]) + mod(deg, 7)) % 7;
  let acc = pc - LETTER_PC[li];
  if (acc > 6) acc -= 12;
  if (acc < -6) acc += 12;
  if (Math.abs(acc) > 1) return NOTE_NAMES[pc]; // avoid double sharps/flats
  return LETTERS[li] + (acc > 0 ? '#' : acc < 0 ? 'b' : '');
}

// Quality of the diatonic triad on a scale degree: maj / min / dim / aug
export function chordQuality(scale, deg) {
  const r = degSemis(scale, deg), third = degSemis(scale, deg + 2) - r, fifth = degSemis(scale, deg + 4) - r;
  if (third === 3) return fifth === 6 ? 'dim' : 'min';
  return fifth === 8 ? 'aug' : 'maj';
}

// Roman numeral of a scale degree, upper case for major; display adds ° / + for dim / aug.
export function romanNumeral(scale, deg, display = false) {
  const q = chordQuality(scale, deg), n = ROMAN[mod(deg, 7)];
  const base = q === 'maj' || q === 'aug' ? n.toUpperCase() : n;
  return display ? base + (q === 'dim' ? '°' : q === 'aug' ? '+' : '') : base;
}

// [{degree, shapeName, beats}] -> "i:8 IV(sus2):4 .:4" (the inverse of parseChords)
export function formatChords(scale, list) {
  return list.map((c) => (c.nc ? `.:${c.beats}` : `${romanNumeral(scale, c.degree)}${c.shapeName !== 'triad' ? `(${c.shapeName})` : ''}:${c.beats}`)).join(' ');
}

// chord = {degree, shapeName}
export function chordLabel(keyRoot, scale, chord) {
  if (!chord) return '–';
  if (chord.nc) return 'N.C.';
  const d = chord.degree, name = noteName(keyRoot, scale, d);
  const q = { maj: '', min: 'm', dim: 'dim', aug: 'aug' }[chordQuality(scale, d)];
  switch (chord.shapeName) {
    case 'sus2': case 'sus4': return name + chord.shapeName;
    case 'power': return name + '5';
    case '7': return name + (q === 'dim' ? 'm7b5' : q + (degSemis(scale, d + 6) - degSemis(scale, d) === 11 ? 'maj7' : '7'));
    case 'add9': return name + q + 'add9';
    case 'six': return name + q + '6';
    default: return name + q;
  }
}

// Normalises a raw song JSON into the runtime structure the engine uses.
// The raw JSON is never mutated, so the editor can keep editing it.
export function prepareSong(raw) {
  const src = migrateSong(raw); // an older song: its tags, levels and layers as per-section steps
  const s = {
    raw,
    name: raw.name || 'Untitled',
    bpm: clamp(+raw.bpm || 90, 30, 300),
    spb: Math.max(1, raw.stepsPerBeat || 4),
    bpb: Math.max(1, raw.beatsPerBar || 4),
    swing: clamp01(raw.swing || 0) * 0.5,
    keyRoot: parseKey(raw.key),
    scaleName: SCALES[raw.scale] ? raw.scale : 'minor',
    variation: raw.variation ?? 0.3,
    blockChange: raw.blockChange ?? 0.15,
    fillChance: raw.fillChance ?? 0.5,
    layerChurn: raw.layerChurn ?? 0.1,
    progStickiness: raw.progStickiness ?? 1.5,
    humanize: clamp01(raw.humanize ?? 0.1), // random velocity spread
    leadIn: raw.leadIn ?? 2, // beats of lead-in chord before a new section (0 = off)
    breath: src.breath || null, // { every: bars, bars: [min, max], keep?: [trackIds] }
    transitBars: raw.transitBars ?? 2,
    master: { gain: 0.9, ...(raw.master || {}) },
    fx: {
      echo: { beats: 0.75, feedback: 0.4, damp: 0.35, level: 0.5, lowcut: 150, ...(raw.fx?.echo || {}) },
      reverb: { size: 0.86, damp: 0.4, level: 0.4, predelay: 0.02, lowcut: 200, ...(raw.fx?.reverb || {}) },
      echoToReverb: raw.fx?.echoToReverb ?? 0.3,
    },
    instruments: src.instruments || {},
    moods: src.moods || {},
  };
  s.scale = SCALES[s.scaleName];
  s.stepsPerBar = s.spb * s.bpb;

  // how many notes a track plays at once is its instrument's (poly; older songs had it on the track)
  s.tracks = (src.tracks || []).map((t) => {
    const inst = s.instruments[t.instrument] || { type: 'pulse' };
    return { ...t, inst, poly: inst.poly ?? t.poly };
  });
  s.trackMap = Object.fromEntries(s.tracks.map((t) => [t.id, t]));
  // effect tracks (the grid): rows of effect blocks for the tracks they target ("*": all, but `except`; or ids).
  // ids: the tracks each one moves; mix: the whole mix instead (all of them)
  s.fxTracks = (Array.isArray(raw.effectTracks) ? raw.effectTracks : []).filter((t) => t && t.id).map((t) => {
    const all = t.target === '*', except = Array.isArray(t.except) ? t.except : [];
    const ids = all ? s.tracks.map((x) => x.id).filter((id) => !except.includes(id)) : (Array.isArray(t.target) ? t.target : [t.target]).filter((id) => s.trackMap[id]);
    return { ...t, ids, mix: all && !except.some((id) => s.trackMap[id]) };
  });
  s.fxMap = Object.fromEntries(s.fxTracks.map((t) => [t.id, t]));

  s.progressions = (src.progressions || []).map((p) => {
    const chordList = parseChords(p.chords);
    const scaleName = SCALES[p.scale] ? p.scale : s.scaleName;
    return { ...p, chordList, scaleName, scale: SCALES[scaleName], totalBeats: chordList.reduce((a, c) => a + c.beats, 0) };
  }).filter((p) => p.chordList.length);
  s.progMap = Object.fromEntries(s.progressions.map((p) => [p.id, p]));

  s.sections = (src.sections || []).map((x) => ({ ...x, bars: Array.isArray(x.bars) ? x.bars : [x.bars || 8] }));
  if (!s.sections.length) s.sections.push({ id: 'default', bars: [8] });
  s.sectionMap = Object.fromEntries(s.sections.map((x) => [x.id, x]));

  // stingers: short phrases for game events; each part borrows a track for the stinger's length
  s.stingers = (raw.stingers || []).filter((x) => x && x.id).map((x) => ({
    ...x,
    beats: Math.max(0.25, +x.beats || 2),
    at: x.at || 'beat',
    duck: clamp01(x.duck ?? 0.4),
    parts: (x.parts || []).filter((p) => p && s.trackMap[p.track]),
    chordList: parseChords(x.chords),
  }));
  s.stingMap = Object.fromEntries(s.stingers.map((x) => [x.id, x]));

  // blocks (clips) are a pool: a track lists the ones it plays (tracks[].clips), and one block can be on several
  // tracks. Older songs name the track on the block instead.
  s.blocks = (src.blocks || []).filter((b) => b && b.id);
  s.blockMap = Object.fromEntries(s.blocks.map((b) => [b.id, b]));
  s.blocksByTrack = {};
  for (const t of s.tracks) {
    s.blocksByTrack[t.id] = Array.isArray(t.clips) ? t.clips.map((id) => s.blockMap[id]).filter(Boolean) : s.blocks.filter((b) => b.track === t.id);
  }

  // An arranged section (the grid): `blocks` places blocks on its bars, track by track ({ trackId: [{ at, block }] }),
  // `chords` its progressions ([{ at, prog }]). A block plays from its bar until the next one on its track or the
  // section's end, looping; a track with nothing placed rests. Its length is one number of bars.
  for (const x of s.sections) {
    if (!x.blocks || typeof x.blocks !== 'object') continue;
    const n = x.bars[0] || 8, at = (p) => Math.max(0, Math.min(n - 1, p.at | 0));
    x.arranged = true;
    x.bars = [n];
    x.place = {};
    for (const [tid, list] of Object.entries(x.blocks)) {
      if (!(s.trackMap[tid] || s.fxMap[tid]) || !Array.isArray(list)) continue;
      const ps = list.map((p) => p && s.blockMap[p.block] && { at: at(p), block: s.blockMap[p.block] }).filter(Boolean).sort((a, b) => a.at - b.at);
      if (ps.length) x.place[tid] = ps;
    }
    x.chordPlace = (Array.isArray(x.chords) ? x.chords : []).map((p) => p && s.progMap[p.prog] && { at: at(p), prog: s.progMap[p.prog] }).filter(Boolean).sort((a, b) => a.at - b.at);
  }

  // A mood with a flow plays its sections in order ([id, times] or id), then loops from loopFrom (default: the first),
  // drifts among them, or stops. switch: how soon a change to it happens: at the next bar (default), phrase or section.
  s.flows = {};
  for (const [name, m] of Object.entries(s.moods)) {
    if (!m || !Array.isArray(m.flow)) continue;
    const list = m.flow.map((e) => (Array.isArray(e) ? { sec: s.sectionMap[e[0]], times: Math.max(1, e[1] | 0 || 1) } : { sec: s.sectionMap[e], times: 1 })).filter((e) => e.sec);
    if (!list.length) continue;
    const from = list.findIndex((e) => e.sec.id === m.loopFrom);
    s.flows[name] = { name, list, loopFrom: Math.max(0, from), then: ['drift', 'stop'].includes(m.then) ? m.then : 'loop', switch: ['phrase', 'section'].includes(m.switch) ? m.switch : 'bar' };
  }
  s.startMood = s.flows[raw.startMood] ? raw.startMood : Object.keys(s.flows)[0] || null;

  // a stinger part may play a block instead of a pattern of its own; then: the mood it switches to as it ends
  for (const st of s.stingers) {
    st.parts = st.parts.map((p) => {
      if (!p.block) return p.pattern !== undefined ? p : null;
      const b = s.blockMap[p.block], src = b && notesOf(b, s.blockMap);
      return src ? { ...p, pattern: src.pattern, mode: p.mode ?? b.mode ?? src.mode } : null;
    }).filter(Boolean);
    st.then = st.then && s.flows[st.then] ? st.then : null;
  }
  return s;
}
