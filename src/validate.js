// Checks a song before it plays. What the engine would quietly skip (a chord or a note it can't read, an id that names
// nothing) is an error; what it would quietly change or ignore (a value out of range, a key it doesn't know) a warning.
// Each is one line saying where and what, for a person or for the AI that wrote the song.
//   validateSong(song, { samples }) → { errors: [text], warnings: [text] }   samples: the library's names, to check those
import { SCALES, SHAPES, parseChord } from './engine/theory.js';
import { expandTokens, parseToken, FORMS } from './engine/pattern.js';
import { SOUND_PARAMS, TRACK_PARAMS, SONG_PARAMS, PAD_NAMES, getAt } from './engine/params.js';
import { migrateSong } from './engine/plays.js';
import { KITS } from './engine/drums.js';
import { WAVE_PRESETS } from './engine/synth.js';
import { FX_KINDS, FX_SHAPES } from './engine/moves.js';
import { SFX_WAVES, SFX_AT, SFX_PARAMS, LAYER_PARAMS, LAYER_MOVES, SFX_MAX_LAYERS } from './engine/sfx.js';
import { EFFECT_KINDS, FX_OPTIONS, MOVE_SHAPES, MOVE_PARAMS, fxParams } from './engine/fx.js';

export const KEYS = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B'];
export const TYPES = ['pulse', 'triangle', 'wave', 'string', 'fm', 'bowed', 'sample', 'drums'];
export const MODES = ['chord', 'scale', 'key'];
export const STING_AT = ['step', 'beat', 'half', 'bar'];
export const FLOW_THEN = ['loop', 'drift', 'stop'];
export const SWITCH = ['bar', 'phrase', 'section'];
// the keys each part of a song may have (the editor adds name and color)
export const FIELDS = {
  song: ['$schema', 'format', 'name', 'bpm', 'key', 'scale', 'stepsPerBeat', 'beatsPerBar', 'swing', 'humanize', 'variation', 'blockChange', 'fillChance',
    'layerChurn', 'progStickiness', 'transitBars', 'leadIn', 'breath', 'startSection', 'startMood', 'master', 'fx', 'instruments', 'tracks', 'effectTracks', 'blocks', 'sections',
    'progressions', 'moods', 'stingers', 'sounds'],
  instrument: ['name', 'type', 'poly', 'arp', 'arpChord', 'wave', 'smooth', 'duty', 'pwm', 'string', 'fm', 'bow', 'sample', 'kit', 'preset', 'unison',
    'detune', 'ensemble', 'breath', 'env', 'gain', 'glide', 'scoop', 'vibrato', 'fx'],
  track: ['id', 'name', 'color', 'instrument', 'octave', 'clips', 'mode', 'follow', 'stickiness', 'volume', 'pan', 'echo', 'reverb', 'double', 'pump', 'fade'],
  effectTrack: ['id', 'name', 'color', 'target', 'except', 'clips'],
  block: ['id', 'name', 'color', 'beats', 'pattern', 'mode', 'fit', 'from', 'forms', 'sections', 'fill', 'mutate', 'track', 'fx'],
  section: ['id', 'name', 'color', 'bars', 'tracks', 'next', 'blocks', 'chords'],
  progression: ['id', 'name', 'color', 'chords', 'scale', 'sections'],
  mood: ['sections', 'flow', 'loopFrom', 'then', 'switch'],
  stinger: ['id', 'name', 'at', 'beats', 'chords', 'duck', 'parts', 'then'],
  part: ['track', 'pattern', 'block', 'mode'],
  breath: ['every', 'bars', 'keep'],
  fx: ['kind', 'from', 'to', 'shape', 'beats', 'rate', 'at'],
  sound: ['id', 'name', 'color', ...Object.keys(SFX_PARAMS), 'key', 'at', 'layers', 'fx'],
  layer: ['wave', 'off', ...Object.keys(LAYER_PARAMS), 'moves'],
  effect: ['kind', 'off', ...new Set(Object.values(EFFECT_KINDS).flatMap((k) => [...Object.keys(k.params), ...(k.beats ? ['beats'] : []), ...(k.rate ? ['rate'] : []), ...(k.opts || [])])), 'moves'],
  move: ['on', 'shape', 'to', 'beats', 'rate', 'at', 'every'],
};

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const list = (xs) => xs.map((x) => `"${x}"`).join(', ');

export function validateSong(raw, { samples } = {}) {
  const errors = [], warnings = [], err = (t) => errors.push(t), warn = (t) => warnings.push(t);
  if (!isObj(raw)) return { errors: ['not a song: a song is a JSON object'], warnings };
  for (const k of ['tracks', 'blocks']) if (!Array.isArray(raw[k])) err(`the song needs "${k}": a list`);
  if (errors.length) return { errors, warnings };
  const s = migrateSong(raw);
  const spb = s.stepsPerBeat || 4;

  const fields = (x, kind, where) => { for (const k of Object.keys(x)) if (!FIELDS[kind].includes(k)) warn(`${where}: unknown key "${k}" (ignored)`); };
  const inRange = (x, params, where) => {
    for (const [path, min, max] of params) {
      const v = getAt(x, path);
      if (v === undefined || typeof v === 'object') continue;
      if (typeof v !== 'number' || !Number.isFinite(v)) err(`${where}: "${path}" must be a number, not ${JSON.stringify(v)}`);
      else if (v < min || v > max) warn(`${where}: "${path}" is ${v}, outside ${min}–${max}`);
    }
  };
  // moves (of a sound's layer, of an effect) and effects (an instrument's, a sound's): music in beats, a sound in Hz
  const ranges = (params) => Object.entries(params).map(([k, p]) => [k, p.min, p.max]);
  const moves = (ms, params, music, where) => {
    if (ms === undefined) return;
    if (!Array.isArray(ms)) return err(`${where}: "moves" must be a list`);
    const mp = music ? MOVE_PARAMS.music : MOVE_PARAMS.sound;
    ms.forEach((m, i) => {
      const at = `${where} move ${i + 1}`;
      if (!isObj(m)) return err(`${at}: must be an object { on, shape, to }`);
      fields(m, 'move', at);
      if (!params[m.on]) return err(`${at}: "on" must be ${list(Object.keys(params))}`);
      if (m.shape !== undefined && !MOVE_SHAPES.includes(m.shape)) err(`${at}: "shape" must be ${list(MOVE_SHAPES)}`);
      if (music ? m.rate !== undefined : m.beats !== undefined) warn(`${at}: "${music ? 'rate' : 'beats'}" is a ${music ? 'sound' : 'track'}'s; ${music ? 'music goes in beats' : 'a sound goes in rate (Hz)'} (ignored)`);
      inRange(m, [['to', params[m.on].min, params[m.on].max], ...ranges(mp)], at);
    });
  };
  const effects = (fx, music, where) => {
    if (fx === undefined) return;
    if (!Array.isArray(fx)) return err(`${where}: "fx" must be a list of effects { kind, … }`);
    const seen = new Set();
    fx.forEach((f, i) => {
      const at = `${where} effect ${i + 1}`;
      if (!isObj(f)) return err(`${at}: must be an object { kind }`);
      const params = fxParams(f.kind, music);
      if (!params) return err(`${at}: "kind" must be ${list(Object.keys(EFFECT_KINDS))}`);
      if (seen.has(f.kind)) warn(`${at}: a second ${f.kind} (only the first plays)`);
      seen.add(f.kind);
      fields(f, 'effect', at);
      for (const [o, vals] of Object.entries(FX_OPTIONS[f.kind] || {})) if (f[o] !== undefined && !vals.includes(f[o]) && !(o === 'type' && f.kind === 'body' && f.bands)) err(`${at}: "${o}" must be ${list(vals)}`);
      if (music ? f.rate !== undefined && f.kind !== 'crush' : f.beats !== undefined) warn(`${at}: "${music ? 'rate' : 'beats'}" is a ${music ? 'sound' : 'track'}'s (ignored)`);
      inRange(f, ranges(params), at);
      moves(f.moves, params, music, at);
    });
  };

  // a list of objects with unique ids, as a map
  const byId = (items, kind) => {
    const out = new Map();
    if (items !== undefined && !Array.isArray(items)) { err(`"${kind}s" must be a list`); return out; }
    (items || []).forEach((x, i) => {
      if (!isObj(x) || typeof x.id !== 'string' || !x.id) return err(`${kind} #${i + 1} needs an "id" (a string)`);
      if (out.has(x.id)) err(`${kind} "${x.id}": two ${kind}s have this id`);
      out.set(x.id, x);
    });
    return out;
  };
  const tracks = byId(s.tracks, 'track'), blocks = byId(s.blocks, 'block'), sections = byId(s.sections, 'section');
  const progressions = byId(s.progressions, 'progression'), stingers = byId(s.stingers, 'stinger');
  const instruments = isObj(s.instruments) ? s.instruments : {};
  if (s.instruments !== undefined && !isObj(s.instruments)) err('"instruments" must be an object: { id: instrument }');
  if (s.moods !== undefined && !isObj(s.moods)) err('"moods" must be an object: { name: { sections } }');

  // { id: weight } maps that name sections or tracks
  const weights = (map, known, what, where) => {
    if (map === undefined) return;
    if (!isObj(map)) return err(`${where}: must be an object { ${what} id: 0–1 }`);
    for (const [id, w] of Object.entries(map)) {
      if (!known.has(id)) err(`${where}: no ${what} "${id}"${known.size ? ` (there are ${list([...known.keys()])})` : ''}`);
      if (typeof w !== 'number' || w < 0 || w > 1) err(`${where}: "${id}" is ${JSON.stringify(w)}, must be 0–1 (0, 0.25, 0.5, 0.75 or 1)`);
    }
  };
  const chords = (str, where) => {
    if (typeof str !== 'string' || !str.trim()) return err(`${where}: "chords" must be a string like "i:4 VI:4 III:4 VII:4"`);
    for (const tok of str.trim().split(/\s+/)) {
      const c = parseChord(tok);
      if (!c) err(`${where}: "${tok}" is not a chord (a roman numeral i–vii or 1–7, then (shape) and :beats, e.g. "IV(sus2):2"; "." is no chord)`);
      else if (/\((\w+)\)/.test(tok) && !SHAPES[/\((\w+)\)/.exec(tok)[1]]) warn(`${where}: "${tok}": no shape "${/\((\w+)\)/.exec(tok)[1]}" (plays a triad; shapes: ${list(Object.keys(SHAPES))})`);
    }
  };
  // drums: hits only; notes: no hits; undefined: either. One error per pattern: its first bad step, and how many more
  const pattern = (str, steps, drums, where) => {
    if (typeof str !== 'string') return err(`${where}: "pattern" must be a string of steps like "0 - . 2"`);
    const tokens = expandTokens(str), bad = [];
    tokens.forEach((t, i) => {
      if (t === '.' || t === '-') return;
      const st = parseToken(t), at = `step ${i + 1} "${t}"`;
      if (!st.atoms) return bad.push(`${at} is not a step (. rest, - hold, a number, * the chord, ${PAD_NAMES.join(' ')} drum hits, joined by +; then ' , # b and ! ?30)`);
      const a = st.atoms.find((x) => (x.kind === 'hit' ? drums === false || !PAD_NAMES.includes(x.value) : drums === true));
      if (!a) return;
      if (a.kind === 'hit' && !PAD_NAMES.includes(a.value)) bad.push(`${at}: no drum hit "${a.value}" (${PAD_NAMES.join(' ')})`);
      else bad.push(drums ? `${at}: a drum track plays hits (${PAD_NAMES.join(' ')}), not notes` : `${at}: "${a.value}" is a drum hit, on a track that plays notes`);
    });
    if (bad.length) err(`${where}: ${bad[0]}${bad.length > 1 ? ` (and ${bad.length - 1} more bad step${bad.length > 2 ? 's' : ''})` : ''}`);
    if (steps && tokens.length !== steps) warn(`${where}: the pattern has ${tokens.length} steps, ${steps} fit (${steps / spb} beats × ${spb}): it is ${tokens.length > steps ? 'cut' : 'padded with rests'}`);
  };
  const mode = (m, where) => { if (m !== undefined && !MODES.includes(m)) err(`${where}: "mode" must be ${list(MODES)}, not ${JSON.stringify(m)}`); };

  // the song
  fields(s, 'song', 'the song');
  inRange(s, SONG_PARAMS, 'the song');
  if (s.bpm !== undefined && !(typeof s.bpm === 'number' && s.bpm >= 30 && s.bpm <= 300)) warn(`the song: "bpm" is ${JSON.stringify(s.bpm)}, outside 30–300`);
  if (s.key !== undefined && !(typeof s.key === 'number' || KEYS.some((k) => k.toLowerCase() === String(s.key).toLowerCase()))) err(`the song: no key ${JSON.stringify(s.key)} (${KEYS.join(' ')})`);
  if (s.scale !== undefined && !SCALES[s.scale]) err(`the song: no scale ${JSON.stringify(s.scale)} (${list(Object.keys(SCALES))})`);
  if (s.startSection !== undefined && !sections.has(s.startSection)) err(`the song: "startSection" names no section "${s.startSection}"`);
  if (s.breath !== undefined) {
    if (!isObj(s.breath)) err('"breath" must be an object { every, bars, keep }');
    else {
      fields(s.breath, 'breath', 'breath');
      for (const id of s.breath.keep || []) if (!tracks.has(id)) err(`breath: "keep" names no track "${id}"`);
    }
  }

  // instruments
  for (const [id, d] of Object.entries(instruments)) {
    const where = `instrument "${id}"`;
    if (!isObj(d)) { err(`${where}: must be an object`); continue; }
    fields(d, 'instrument', where);
    if (d.type !== undefined && !TYPES.includes(d.type)) err(`${where}: no type ${JSON.stringify(d.type)} (${list(TYPES)})`);
    inRange(d, SOUND_PARAMS, where);
    effects(d.fx, true, where);
    if (d.type === 'sample' && typeof d.sample !== 'string') err(`${where}: a sample instrument needs "sample": the recording's name`);
    if (d.type === 'sample' && samples && typeof d.sample === 'string' && !samples.includes(d.sample)) err(`${where}: no recording "${d.sample}" (${list(samples)})`);
    if (d.wave !== undefined && !WAVE_PRESETS.includes(d.wave) && !(Array.isArray(d.wave) && d.wave.length === 32 && d.wave.every((v) => v >= 0 && v <= 15))) err(`${where}: "wave" must be ${list(WAVE_PRESETS)} or 32 numbers 0–15`);
    if (d.filter !== undefined && d.filter !== 'high' && d.filter !== 'low') err(`${where}: "filter" is "high" (a high pass) or left out (low pass)`);
    if (d.type === 'drums') {
      const preset = typeof d.kit === 'string' ? d.kit : d.preset;
      if (preset !== undefined && !KITS[preset]) err(`${where}: no kit "${preset}" (${list(Object.keys(KITS))})`);
      if (isObj(d.kit)) for (const pad of Object.keys(d.kit)) if (!PAD_NAMES.includes(pad)) err(`${where}: "kit" has no pad "${pad}" (${PAD_NAMES.join(' ')})`);
    }
    if (d.poly !== undefined && !(Number.isInteger(d.poly) && d.poly >= 1 && d.poly <= 16)) warn(`${where}: "poly" is ${JSON.stringify(d.poly)}, a whole number 1–16`);
  }

  // tracks, and whether each block is played by drums (true), by notes (false) or both (undefined)
  const playedBy = new Map();
  const drumsOf = (tr) => (tr.instrument in instruments ? instruments[tr.instrument]?.type === 'drums' : undefined);
  const clipsOf = (tr) => (Array.isArray(tr.clips) ? tr.clips : [...blocks.values()].filter((b) => b.track === tr.id).map((b) => b.id));
  // effect tracks: their targets, and effect blocks only
  const fxTracks = byId(s.effectTracks, 'effectTrack');
  for (const tr of fxTracks.values()) {
    const where = `effect track "${tr.id}"`;
    fields(tr, 'effectTrack', where);
    if (tracks.has(tr.id)) err(`${where}: a track has this id too`);
    const ids = tr.target === '*' ? [] : Array.isArray(tr.target) ? tr.target : [tr.target];
    if (tr.target !== '*' && !(ids.length && ids.every((id) => typeof id === 'string'))) err(`${where}: "target" must be "*" (every track) or track ids`);
    for (const id of [...ids, ...(Array.isArray(tr.except) ? tr.except : [])]) if (typeof id === 'string' && !tracks.has(id)) err(`${where}: no track "${id}" to move`);
    if (tr.except !== undefined && (tr.target !== '*' || !Array.isArray(tr.except))) err(`${where}: "except" is a list of track ids, with "target": "*"`);
    if (!Array.isArray(tr.clips)) err(`${where}: needs "clips": a list of effect block ids`);
    for (const id of Array.isArray(tr.clips) ? tr.clips : []) {
      if (!blocks.has(id)) err(`${where}: "clips" names no block "${id}"`);
      else if (!blocks.get(id).fx) err(`${where}: "${id}" plays notes; an effect track plays effect blocks (with "fx")`);
      else playedBy.set(id, 'fx');
    }
  }
  for (const tr of tracks.values()) {
    const where = `track "${tr.id}"`;
    fields(tr, 'track', where);
    inRange(tr, TRACK_PARAMS, where);
    mode(tr.mode, where);
    if (typeof tr.instrument !== 'string') err(`${where}: needs "instrument": an id from "instruments"`);
    else if (!(tr.instrument in instruments)) err(`${where}: no instrument "${tr.instrument}"${Object.keys(instruments).length ? ` (there are ${list(Object.keys(instruments))})` : ''}`);
    if (tr.clips !== undefined && !Array.isArray(tr.clips)) err(`${where}: "clips" must be a list of block ids`);
    const clips = clipsOf(tr);
    if (!clips.length) warn(`${where}: has no clips, so it plays nothing`);
    for (const id of clips) {
      if (!blocks.has(id)) { err(`${where}: "clips" names no block "${id}"`); continue; }
      if (blocks.get(id).fx) { err(`${where}: "${id}" is an effect block; it goes on an effect track ("effectTracks")`); continue; }
      const d = drumsOf(tr);
      playedBy.set(id, playedBy.has(id) && playedBy.get(id) !== d ? undefined : d);
    }
  }

  // blocks
  for (const b of blocks.values()) {
    const where = `block "${b.id}"`;
    fields(b, 'block', where);
    if (b.beats !== undefined && !(typeof b.beats === 'number' && b.beats > 0)) err(`${where}: "beats" must be a number above 0`);
    mode(b.mode, where);
    weights(b.sections, sections, 'section', `${where} "sections"`);
    if (b.forms !== undefined) for (const f of Array.isArray(b.forms) ? b.forms : [b.forms]) if (!FORMS.includes(f)) err(`${where}: no form ${JSON.stringify(f)} (${list(FORMS)})`);
    if (b.fx !== undefined) { // an effect block: one setting moved across the bars it is placed on
      const fx = b.fx, k = isObj(fx) && FX_KINDS[fx.kind];
      if (!isObj(fx)) err(`${where}: "fx" must be an object { kind, from, to, shape }`);
      else {
        fields(fx, 'fx', `${where} "fx"`);
        if (!k) err(`${where}: "fx" "kind" must be ${list(Object.keys(FX_KINDS))}`);
        else for (const key of ['from', 'to']) {
          const v = fx[key];
          if (v === undefined) continue;
          if (typeof v !== 'number' || !Number.isFinite(v)) err(`${where}: "fx" "${key}" must be a number`);
          else if (v < k.min || v > k.max) warn(`${where}: "fx" "${key}" is ${v}, outside ${k.min}–${k.max} for ${fx.kind}`);
        }
        if (fx.shape !== undefined && !FX_SHAPES.includes(fx.shape)) err(`${where}: "fx" "shape" must be ${list(FX_SHAPES)}`);
        for (const key of ['beats', 'rate']) if (fx[key] !== undefined && !(typeof fx[key] === 'number' && fx[key] > 0)) err(`${where}: "fx" "${key}" must be beats, above 0`);
      }
      if (b.pattern !== undefined || b.from !== undefined) warn(`${where}: an effect block plays no notes ("pattern", "from" are ignored)`);
      if (!playedBy.has(b.id)) warn(`${where}: is on no effect track's "clips", so it never plays`);
      continue;
    }
    if (b.from !== undefined) {
      const src = blocks.get(b.from);
      if (!src) err(`${where}: "from" names no block "${b.from}"`);
      else if (src === b || src.from) err(`${where}: "from" must name a block with notes of its own, "${b.from}" plays another's`);
      if (b.pattern !== undefined) warn(`${where}: has "from", so its own "pattern" is not played`);
    } else if (b.pattern === undefined) err(`${where}: needs a "pattern" (or "from": another block's id)`);
    else pattern(b.pattern, Math.max(1, Math.round((b.beats || 4) * spb)), playedBy.get(b.id), where);
    if (!playedBy.has(b.id) && ![...blocks.values()].some((x) => x.from === b.id)) warn(`${where}: is on no track's "clips", so it never plays`);
  }

  // sections, progressions, moods
  for (const x of sections.values()) {
    const where = `section "${x.id}"`;
    fields(x, 'section', where);
    const bars = Array.isArray(x.bars) ? x.bars : [x.bars ?? 8];
    if (!bars.length || !bars.every((n) => Number.isInteger(n) && n > 0)) err(`${where}: "bars" must be a whole number or a list of them, e.g. [8, 16]`);
    weights(x.tracks, tracks, 'track', `${where} "tracks"`);
    weights(x.next, sections, 'section', `${where} "next"`);
    // the grid: blocks and progressions placed on bars
    const placed = (p, i, what, known, at) => {
      if (!isObj(p)) return err(`${at} #${i + 1}: must be an object { at, ${what} }`);
      if (!Number.isInteger(p.at) || p.at < 0) err(`${at} #${i + 1}: "at" must be a bar, 0 or more`);
      else if (p.at >= bars[0]) warn(`${at} #${i + 1}: bar ${p.at} is past the section's end (${bars[0]} bars)`);
      if (!known.has(p[what])) err(`${at} #${i + 1}: no ${what === 'prog' ? 'progression' : 'block'} "${p[what]}"`);
    };
    if (x.blocks !== undefined) {
      if (!isObj(x.blocks)) err(`${where}: "blocks" must be an object { track id: [{ at, block }] }`);
      else for (const [tid, ps] of Object.entries(x.blocks)) {
        const tr = tracks.get(tid) || fxTracks.get(tid);
        if (!tr) { err(`${where} "blocks": no track "${tid}"`); continue; }
        if (!Array.isArray(ps)) { err(`${where} "blocks" "${tid}": must be a list [{ at, block }]`); continue; }
        ps.forEach((p, i) => {
          placed(p, i, 'block', blocks, `${where} "blocks" "${tid}"`);
          if (isObj(p) && blocks.has(p.block) && !clipsOf(tr).includes(p.block)) warn(`${where} "blocks" "${tid}": "${p.block}" is not on the track's "clips"`);
        });
      }
      if (Array.isArray(x.bars) && x.bars.length > 1) warn(`${where}: a section with "blocks" has one length; it plays ${bars[0]} bars`);
    }
    if (x.chords !== undefined) {
      if (!Array.isArray(x.chords)) err(`${where}: "chords" must be a list [{ at, prog }]`);
      else x.chords.forEach((p, i) => placed(p, i, 'prog', progressions, `${where} "chords"`));
    }
  }
  for (const p of progressions.values()) {
    const where = `progression "${p.id}"`;
    fields(p, 'progression', where);
    chords(p.chords, where);
    if (p.scale !== undefined && !SCALES[p.scale]) err(`${where}: no scale ${JSON.stringify(p.scale)} (${list(Object.keys(SCALES))})`);
    weights(p.sections, sections, 'section', `${where} "sections"`);
  }
  if (!progressions.size) warn('the song has no progressions: it plays the home chord only');
  for (const [name, m] of Object.entries(isObj(s.moods) ? s.moods : {})) {
    const where = `mood "${name}"`;
    if (!isObj(m)) { err(`${where}: must be an object { sections: { id: weight } }`); continue; }
    fields(m, 'mood', where);
    weights(m.sections, sections, 'section', `${where} "sections"`);
    if (m.flow !== undefined) {
      if (!Array.isArray(m.flow) || !m.flow.length) err(`${where}: "flow" must be a list of sections: [["intro", 1], ["verse", 2]]`);
      else m.flow.forEach((e, i) => {
        const [id, n] = Array.isArray(e) ? e : [e, 1];
        if (!sections.has(id)) err(`${where} "flow" #${i + 1}: no section ${JSON.stringify(id)}`);
        if (!(Number.isInteger(n) && n >= 1)) err(`${where} "flow" #${i + 1}: times must be a whole number, 1 or more`);
      });
      const ids = Array.isArray(m.flow) ? m.flow.map((e) => (Array.isArray(e) ? e[0] : e)) : [];
      if (m.loopFrom !== undefined && !ids.includes(m.loopFrom)) err(`${where}: "loopFrom" names no section of its flow: "${m.loopFrom}"`);
      if (m.then !== undefined && !FLOW_THEN.includes(m.then)) err(`${where}: "then" must be ${list(FLOW_THEN)}`);
      if (m.switch !== undefined && !SWITCH.includes(m.switch)) err(`${where}: "switch" must be ${list(SWITCH)}`);
    } else if (!Object.values(m.sections || {}).some((w) => w > 0)) warn(`${where}: names no section, so it leads nowhere`);
  }
  if (s.startMood !== undefined && !(isObj(s.moods) && Array.isArray(s.moods[s.startMood]?.flow))) err(`the song: "startMood" names no mood with a flow: "${s.startMood}"`);

  // game sounds
  for (const x of byId(s.sounds, 'sound').values()) {
    const where = `sound "${x.id}"`;
    fields(x, 'sound', where);
    if (x.at !== undefined && !SFX_AT.includes(x.at)) err(`${where}: "at" must be ${list(SFX_AT)}`);
    if (x.key !== undefined && typeof x.key !== 'boolean') err(`${where}: "key" must be true or false`);
    inRange(x, ranges(SFX_PARAMS), where);
    if (!Array.isArray(x.layers) || !x.layers.length) err(`${where}: "layers" must be a list of 1 to ${SFX_MAX_LAYERS} layers`);
    else {
      if (x.layers.length > SFX_MAX_LAYERS) warn(`${where}: has ${x.layers.length} layers; only the first ${SFX_MAX_LAYERS} play`);
      x.layers.forEach((l, i) => {
        const at = `${where} layer ${i + 1}`;
        if (!isObj(l)) return err(`${at}: must be an object { wave, pitch, length }`);
        fields(l, 'layer', at);
        if (l.wave !== undefined && !SFX_WAVES.includes(l.wave)) err(`${at}: "wave" must be ${list(SFX_WAVES)}`);
        inRange(l, ranges(LAYER_PARAMS), at);
        moves(l.moves, Object.fromEntries(LAYER_MOVES.map((k) => [k, LAYER_PARAMS[k]])), false, at);
      });
    }
    effects(x.fx, false, where);
  }

  // stingers
  for (const x of stingers.values()) {
    const where = `stinger "${x.id}"`;
    fields(x, 'stinger', where);
    if (x.at !== undefined && !STING_AT.includes(x.at)) err(`${where}: "at" must be ${list(STING_AT)}`);
    if (x.chords !== undefined) chords(x.chords, where);
    const steps = Math.max(1, Math.round(Math.max(0.25, +x.beats || 2) * spb));
    (Array.isArray(x.parts) ? x.parts : []).forEach((pt, i) => {
      const at = `${where} part ${i + 1}`;
      if (!isObj(pt)) return err(`${at}: must be an object { track, pattern }`);
      fields(pt, 'part', at);
      mode(pt.mode, at);
      const tr = tracks.get(pt.track);
      if (!tr) return err(`${at}: no track "${pt.track}"${fxTracks.has(pt.track) ? ' (effect tracks play no stingers)' : ''}`);
      if (pt.block !== undefined) { if (!blocks.has(pt.block)) err(`${at}: no block "${pt.block}"`); return; }
      pattern(pt.pattern, steps, drumsOf(tr), at);
    });
    if (x.then !== undefined && !(isObj(s.moods) && Array.isArray(s.moods[x.then]?.flow))) err(`${where}: "then" names no mood with a flow: "${x.then}"`);
    if (!Array.isArray(x.parts) || !x.parts.length) err(`${where}: needs "parts": [{ track, pattern }]`);
  }
  return { errors, warnings };
}
