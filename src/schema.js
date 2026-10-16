// The song format as a JSON Schema (dist/song.schema.json, written by tools/build.mjs): for editors that check a file
// as you type ("$schema" in the song) and for AI tools that take a schema. It holds the shapes and ranges; that ids name
// something, that patterns and chords read, validateSong checks.
import { SCALES, SHAPES } from './engine/theory.js';
import { FORMS } from './engine/pattern.js';
import { SOUND_PARAMS, TRACK_PARAMS, SONG_PARAMS } from './engine/params.js';
import { KITS } from './engine/drums.js';
import { AMPS, BODIES, WAVE_PRESETS } from './engine/synth.js';
import { KEYS, TYPES, MODES, STING_AT, FIELDS } from './validate.js';

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
    instruments: { type: 'object', additionalProperties: ref('instrument'), description: '{ id: instrument }' },
    tracks: { type: 'array', items: ref('track') },
    blocks: { type: 'array', items: ref('block'), description: 'the clips: short patterns that tracks play' },
    sections: { type: 'array', items: ref('section') },
    progressions: { type: 'array', items: ref('progression') },
    moods: { type: 'object', additionalProperties: ref('mood'), description: '{ relaxed, wonder, exploring, tension, danger, action: { sections } }' },
    stingers: { type: 'array', items: ref('stinger'), description: 'discovery, alert, jump, reward' },
  }, ['tracks', 'blocks']),
  definitions: {
    instrument: obj('instrument', {
      ...sound,
      name: { type: 'string' },
      type: { enum: TYPES },
      poly: { type: 'integer', minimum: 1, maximum: 16, description: 'notes at once (chords); 1: a new note ends the last' },
      arp: num(1, 60, 'runs chords as a chip arpeggio, notes per second'),
      arpChord: { type: 'boolean' },
      smooth: { type: 'boolean', description: 'no 4-bit staircase' },
      wave: { oneOf: [{ enum: WAVE_PRESETS }, { type: 'array', items: num(0, 15), minItems: 32, maxItems: 32 }] },
      sample: { type: 'string', description: 'a recording in the library, e.g. cello, flute, violins' },
      kit: { oneOf: [{ enum: Object.keys(KITS) }, { type: 'object', description: 'per-pad overrides { k: { pitch, decay, level } }' }] },
      preset: { enum: Object.keys(KITS) },
      body: { oneOf: [{ enum: Object.keys(BODIES) }, { type: 'array' }] },
      amp: { enum: Object.keys(AMPS) },
      filter: { enum: ['low', 'high'] },
      wah: { ...sound.wah, properties: { ...sound.wah.properties, mode: { enum: ['note'] } } },
      chorus: { ...sound.chorus, properties: { ...sound.chorus.properties, mode: { enum: ['flanger'] } } },
    }, ['type']),
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
    }, ['id', 'beats']),
    section: obj('section', {
      id: id('unique'), name: { type: 'string' }, color: { type: 'string' },
      bars: { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'array', items: { type: 'integer', minimum: 1 } }], description: 'its length, or lengths to pick from' },
      tracks: weights('track'),
      next: weights('section'),
    }, ['id', 'bars']),
    progression: obj('progression', {
      id: id('unique'), name: { type: 'string' }, color: { type: 'string' },
      chords: CHORDS,
      scale: { enum: Object.keys(SCALES) },
      sections: weights('section'),
    }, ['id', 'chords']),
    mood: obj('mood', { sections: weights('section') }, ['sections']),
    stinger: obj('stinger', {
      id: id('discovery, alert, jump, reward, or your own'), name: { type: 'string' },
      at: { enum: STING_AT },
      beats: num(0.25, 16),
      chords: CHORDS,
      duck: num(0, 1, 'how far the music ducks under it'),
      parts: { type: 'array', items: ref('part'), minItems: 1 },
    }, ['id', 'beats', 'parts']),
    part: obj('part', { track: id('the track it borrows'), pattern: PATTERN, mode: { enum: MODES } }, ['track', 'pattern']),
    breath: obj('breath', {
      every: { type: 'number', minimum: 1, description: 'about every this many bars the music thins out' },
      bars: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 2, maxItems: 2 },
      keep: { type: 'array', items: id('a track id') },
    }),
  },
});
