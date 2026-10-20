// The song format as a JSON Schema (dist/song.schema.json, written by tools/build.mjs): for editors that check a file
// as you type ("$schema" in the song) and for AI tools that take a schema. It holds the shapes and ranges; that ids name
// something, that patterns and chords read, validateSong checks.
import { SCALES, SHAPES } from './engine/theory.js';
import { FORMS } from './engine/pattern.js';
import { SOUND_PARAMS, LAYER_PARAMS, TRACK_PARAMS, SONG_PARAMS } from './engine/params.js';
import { KITS } from './engine/drums.js';
import { WAVE_PRESETS } from './engine/voice.js';
import { FX_KINDS, FX_SHAPES } from './engine/moves.js';
import { SFX_AT, SFX_PARAMS } from './engine/sfx.js';
import { MAX_LAYERS, LAYER_MOVES } from './engine/inst.js';
import { EFFECT_KINDS, FX_OPTIONS, MOVE_SHAPES, MOVE_PARAMS } from './engine/fx.js';
import { KEYS, TYPES, MODES, STING_AT, FIELDS, FLOW_THEN, SWITCH } from './validate.js';

const num = (min, max, description) => ({ type: 'number', minimum: min, maximum: max, ...(description && { description }) });
const id = (description) => ({ type: 'string', description });
const weights = (what) => ({ type: 'object', additionalProperties: num(0, 1), description: `{ ${what} id: 0 | 0.25 | 0.5 | 0.75 | 1 }` });
const ref = (name) => ({ $ref: `#/definitions/${name}` });
// an object with exactly these keys, required ones first
const obj = (kind, properties, required = [], description) => ({
  type: 'object', ...(description && { description }), required, additionalProperties: false,
  properties: Object.fromEntries(FIELDS[kind].map((k) => [k, properties[k] ?? {}])),
});
// params.js ranges as nested properties ('env.a' → env: { properties: { a } })
function ranged(params) {
  const out = {};
  for (const [path, min, max] of params) {
    const ks = path.split('.');
    let o = out;
    for (const k of ks.slice(0, -1)) o = ((o[k] ||= { type: 'object', properties: {} }).properties);
    o[ks[ks.length - 1]] = num(min, max);
  }
  return out;
}

const PATTERN = { type: 'string', description: 'steps, space separated: . rest, - hold, 0 1 2 note, * whole chord, k s h o c t m drum hits, a+b together; suffixes \' , octave, # b semitone, ! accent, ?30 chance; T*n repeats; | is ignored' };
const CHORDS = { type: 'string', description: `roman numerals (i–vii, 1–7) with an optional (shape) and :beats, e.g. "i:4 VI:4 IV(sus2):2 .:2"; . is no chord. Shapes: ${Object.keys(SHAPES).join(' ')}` };
const sound = ranged(SOUND_PARAMS);

export const songSchema = () => ({
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Stardrift song',
  ...obj('song', {
    $schema: { type: 'string' },
    format: { const: 2 },
    name: { type: 'string' },
    bpm: num(30, 300),
    key: { enum: KEYS },
    scale: { enum: Object.keys(SCALES) },
    stepsPerBeat: { type: 'integer', minimum: 1, description: 'default 4' },
    beatsPerBar: { type: 'integer', minimum: 1, description: 'default 4' },
    ...ranged(SONG_PARAMS),
    breath: ref('breath'),
    startSection: id('the section it starts in (default: the first)'),
    startMood: id('the mood whose flow plays while the game asks for none (default: the first mood with a flow)'),
    instruments: { type: 'object', additionalProperties: ref('instrument'), description: '{ id: instrument }' },
    tracks: { type: 'array', items: ref('track') },
    effectTracks: { type: 'array', items: ref('effectTrack'), description: 'the grid: rows of effect blocks (filter sweeps, fades, echo throws) for the tracks they target' },
    blocks: { type: 'array', items: ref('block'), description: 'the clips: short patterns that tracks play' },
    sections: { type: 'array', items: ref('section') },
    progressions: { type: 'array', items: ref('progression') },
    moods: { type: 'object', additionalProperties: ref('mood'), description: '{ relaxed, wonder, exploring, tension, danger, action: { sections } }' },
    stingers: { type: 'array', items: ref('stinger'), description: 'discovery, alert, jump, reward' },
    sounds: { type: 'array', items: ref('sound'), description: 'game sounds made by synthesis: jump, coin, hit, explosion (music.sound(id))' },
  }, ['tracks', 'blocks']),
  definitions: {
    instrument: obj('instrument', {
      ...sound,
      name: { type: 'string' },
      type: { const: 'drums', description: 'a drum kit; left out, the instrument plays its layers' },
      poly: { type: 'integer', minimum: 1, maximum: 16, description: 'notes at once (chords); 1: a new note ends the last' },
      arp: num(1, 60, 'runs chords as a chip arpeggio, notes per second'),
      arpChord: { type: 'boolean' },
      layers: { type: 'array', items: ref('layer'), minItems: 1, maxItems: MAX_LAYERS, description: 'the sources, played together as one note: each with its own envelope, pitch and moves' },
      kit: { oneOf: [{ enum: Object.keys(KITS) }, { type: 'object', description: 'per-pad overrides { k: { pitch, decay, level } }' }] },
      preset: { enum: Object.keys(KITS) },
      noise: num(0, 1, 'older songs: breath as white noise'),
      fx: { type: 'array', items: ref('effect'), description: 'its effects, in the order the sound goes through them' },
    }),
    track: obj('track', {
      ...ranged(TRACK_PARAMS),
      id: id('unique'), name: { type: 'string' }, color: { type: 'string' },
      instrument: id('an id in "instruments"'),
      octave: { type: 'integer', minimum: 0, maximum: 8 },
      clips: { type: 'array', items: id('a block id'), description: 'the blocks it plays' },
      mode: { enum: MODES },
      follow: { type: 'boolean', description: 'held notes move with the chord' },
      stickiness: { type: 'number', minimum: 0, description: 'how much it keeps its block (default 1.5)' },
    }, ['id', 'instrument', 'clips']),
    effectTrack: obj('effectTrack', {
      id: id('unique, among the tracks too'), name: { type: 'string' }, color: { type: 'string' },
      target: { oneOf: [{ const: '*' }, { type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'the tracks its effect blocks move: ids, or "*" for all (the whole mix)' },
      except: { type: 'array', items: id('a track id'), description: 'with "target": "*": the tracks it leaves alone' },
      clips: { type: 'array', items: id('an effect block id'), description: 'the effect blocks it plays' },
    }, ['id', 'target', 'clips'], 'a row of effect blocks on the grid'),
    block: obj('block', {
      id: id('unique'), name: { type: 'string' }, color: { type: 'string' },
      beats: num(0.25, 64, 'its length; the pattern has beats × stepsPerBeat steps'),
      pattern: PATTERN,
      mode: { enum: MODES, description: 'chord (default): 0 root, 1 third, 2 fifth; scale: steps above the chord root; key: degrees of the key' },
      fit: { type: 'boolean', description: 'notes on the beat move to the nearest chord tone (melodies in key)' },
      from: id('plays this block\'s notes instead of a pattern of its own'),
      forms: { type: 'array', items: { enum: FORMS } },
      sections: weights('section'),
      fill: { type: 'boolean', description: 'a drum fill for the bar before a section change' },
      mutate: num(0, 2, 'how much it changes when it loops (default 1)'),
      track: id('older songs: the track it is on'),
      fx: obj('fx', {
        kind: { enum: Object.keys(FX_KINDS), description: 'filter (low pass, Hz), highpass (Hz), volume 0–1, echo and reverb (more send, 0–1), pan −1–1, gate (chop depth 0–1), crush 0–1' },
        from: { type: 'number' }, to: { type: 'number' },
        shape: { enum: FX_SHAPES, description: 'ramp (default): from → to across its bars; hump: from → to → from; wave: between them every "beats"; hold: at to' },
        beats: num(0.25, 64, 'a wave: beats per cycle (4)'),
        rate: num(0.0625, 4, 'a gate: beats per chop (0.25)'),
      }, ['kind'], 'an effect block (on an effect track): one setting moved across the bars it is placed on'),
    }, ['id']),
    section: obj('section', {
      id: id('unique'), name: { type: 'string' }, color: { type: 'string' },
      bars: { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'array', items: { type: 'integer', minimum: 1 } }], description: 'its length, or lengths to pick from' },
      tracks: weights('track'),
      next: weights('section'),
      blocks: { type: 'object', additionalProperties: { type: 'array', items: ref('placed') }, description: 'the grid: { track id: [{ at: bar, block }] }; each block plays from its bar until the next one or the end, looping' },
      chords: { type: 'array', items: ref('placedChords'), description: 'the grid: [{ at: bar, prog }]' },
    }, ['id', 'bars']),
    placed: { type: 'object', required: ['at', 'block'], additionalProperties: false, properties: { at: { type: 'integer', minimum: 0 }, block: id('a block id') } },
    placedChords: { type: 'object', required: ['at', 'prog'], additionalProperties: false, properties: { at: { type: 'integer', minimum: 0 }, prog: id('a progression id') } },
    progression: obj('progression', {
      id: id('unique'), name: { type: 'string' }, color: { type: 'string' },
      chords: CHORDS,
      scale: { enum: Object.keys(SCALES) },
      sections: weights('section'),
    }, ['id', 'chords']),
    mood: obj('mood', {
      sections: weights('section'),
      flow: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'array', items: [{ type: 'string' }, { type: 'integer', minimum: 1 }], minItems: 2, maxItems: 2 }] }, description: 'its sections in order: [["intro", 1], ["verse", 2]]' },
      loopFrom: id('the section of its flow it loops from (default: the first)'),
      then: { enum: FLOW_THEN, description: 'after its flow: loop (default), drift among its sections, or stop' },
      switch: { enum: SWITCH, description: 'how soon a change to it comes: the next bar (default), phrase (4 bars) or section' },
    }),
    stinger: obj('stinger', {
      id: id('discovery, alert, jump, reward, or your own'), name: { type: 'string' },
      at: { enum: STING_AT },
      beats: num(0.25, 16),
      chords: CHORDS,
      duck: num(0, 1, 'how far the music ducks under it'),
      parts: { type: 'array', items: ref('part'), minItems: 1 },
      then: id('a mood with a flow: as the stinger ends, the music is there at once'),
    }, ['id', 'beats', 'parts']),
    sound: obj('sound', {
      id: id('jump, coin, hit, or your own: music.sound(id)'), name: { type: 'string' }, color: { type: 'string' },
      ...Object.fromEntries(Object.entries(SFX_PARAMS).map(([k, p]) => [k, num(p.min, p.max)])),
      note: num(SFX_PARAMS.note.min, SFX_PARAMS.note.max, 'the note it plays, in midi notes (69: A4, 440 Hz)'),
      length: num(SFX_PARAMS.length.min, SFX_PARAMS.length.max, 'seconds the note is held'),
      at: { enum: SFX_AT, description: 'when it starts: now (default), the next step or the next beat' },
      key: { type: 'boolean', description: 'tuned to the nearest note of the chord playing' },
      instrument: id('an id in "instruments" (not a drum kit): the instrument it plays, one note of it'),
    }, ['id', 'instrument']),
    layer: obj('layer', {
      ...ranged(LAYER_PARAMS),
      type: { enum: TYPES, description: 'the source (pulse when left out)' },
      smooth: { type: 'boolean', description: 'no 4-bit staircase' },
      wave: { oneOf: [{ enum: WAVE_PRESETS }, { type: 'array', items: num(0, 15), minItems: 32, maxItems: 32 }] },
      drawbars: { type: 'string', pattern: '^[0-8]{9}$', description: "a wave's tonewheel organ: the drawbars 16′ 5⅓′ 8′ 4′ 2⅔′ 2′ 1⅗′ 1⅓′ 1′, each 0–8, e.g. '888000000' (in place of wave)" },
      sample: { type: 'string', description: 'a recording in the library, e.g. cello, flute, violins' },
      pitch: num(-36, 36, 'semitones from the note'),
      delay: num(0, 1, 'seconds after the note starts'),
      off: { type: 'boolean', description: 'muted for now' },
      moves: { type: 'array', items: { ...ref('move'), description: `on: ${LAYER_MOVES.join(', ')} (pitch in semitones from the note)` } },
    }),
    effect: obj('effect', {
      kind: { enum: Object.keys(EFFECT_KINDS) }, off: { type: 'boolean', description: 'bypassed for now' },
      ...Object.fromEntries(Object.values(EFFECT_KINDS).flatMap((k) => Object.entries(k.params)).map(([k, p]) => [k, num(p.min, p.max)])),
      beats: { type: 'number', description: 'in music: how long one sweep takes, in beats' },
      rate: { type: 'number', description: 'in a sound: how fast it goes, Hz (a crush: its sample rate)' },
      type: { description: `a filter's: ${FX_OPTIONS.filter.type.join(', ')}; a body's: ${FX_OPTIONS.body.type.join(', ')}` },
      bands: { type: 'array', description: 'a body of its own: [kind, Hz, Q, dB] each' },
      amp: { enum: FX_OPTIONS.drive.amp }, mode: { enum: ['note', 'flanger', 'ensemble'], description: 'a wah that follows the notes; a chorus as a flanger or a string machine\'s ensemble' },
      square: { type: 'boolean', description: 'a tremolo that chops' },
      moves: { type: 'array', items: ref('move') },
    }, ['kind']),
    move: obj('move', {
      on: id('the setting it moves'), shape: { enum: MOVE_SHAPES, description: 'ramp (default), hump, wave, or step (at `at`)' },
      to: { type: 'number', description: 'where the setting goes, in its own units' },
      beats: num(MOVE_PARAMS.music.beats.min, MOVE_PARAMS.music.beats.max, 'in music: how long it takes from each note (a wave: its period)'),
      rate: num(MOVE_PARAMS.sound.rate.min, MOVE_PARAMS.sound.rate.max, 'in a sound: a wave\'s, Hz'),
      at: num(0, 1, 'a step: where it steps, of the way through'),
      every: { type: 'number', minimum: 0, description: 'it starts over this often: beats in music, seconds in a sound; 0 once' },
    }, ['on', 'to']),
    part: obj('part', { track: id('the track it borrows'), pattern: PATTERN, block: id('or: a block whose notes it plays'), mode: { enum: MODES } }, ['track']),
    breath: obj('breath', {
      every: { type: 'number', minimum: 1, description: 'about every this many bars the music thins out' },
      bars: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 2, maxItems: 2 },
      keep: { type: 'array', items: id('a track id') },
    }),
  },
});
