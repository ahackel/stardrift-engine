// Every setting of an instrument, a track and a song, with the range the editor gives it: what variations change
// (compose.js vary*). The editor's controls use the same ranges (a test checks that every control is listed here).
// [path, min, max, default, opts]
//   log: the range is exponential (times, frequencies); step: values snap to it
//   vary: [lo, hi] the part of the range a variation moves in (the rest is for people who mean it); a value already
//     outside stays reachable
//   off: at 0 the setting is removed (this key: the whole group, e.g. vibrato)
//   when(sound, track): it applies (the oscillator's own settings, the vibrato's rate only with a vibrato …)

const melodic = (s) => s.type !== 'drums';
const is = (...types) => (s) => types.includes(s.type || 'pulse');

export const SOUND_PARAMS = [
  // oscillator
  ['string.decay', 0.1, 10, 3, { log: true, when: is('string') }],
  ['string.bright', 0, 1, 0.5, { when: is('string') }],
  ['string.mute', 0, 1, 0, { vary: [0, 0.6], when: is('string') }],
  ['bow.pressure', 0, 1, 0.8, { vary: [0.6, 0.95], when: is('bowed') }], // far from 80 % / 40 % the string jumps an octave
  ['bow.position', 0, 1, 0.4, { vary: [0.25, 0.55], when: is('bowed') }],
  ['fm.ratio', 0.5, 8, 1, { step: 0.5, vary: [0.5, 4], when: is('fm') }],
  ['fm.index', 0, 10, 2, { vary: [0.5, 6], when: is('fm') }],
  ['fm.env', 0, 1, 1, { when: is('fm') }],
  ['fm.feedback', 0, 1.5, 0, { vary: [0, 0.8], when: is('fm') }],
  ['duty', 0.05, 0.5, 0.5, { vary: [0.1, 0.5], when: is('pulse') }],
  ['pwm.depth', 0, 0.4, 0, { off: 'pwm', vary: [0, 0.25], when: is('pulse') }],
  ['pwm.rate', 0.05, 8, 0.3, { log: true, vary: [0.1, 3], when: (s) => is('pulse')(s) && !!s.pwm }],
  ['unison', 1, 4, 1, { step: 1, off: 'unison', when: melodic }],
  ['detune', 0, 50, 0, { step: 1, vary: [0, 25], when: (s) => melodic(s) && (s.unison || 1) > 1 }],
  ['ensemble', 0, 1, 0, { off: 'ensemble', vary: [0, 0.6], when: melodic }],
  ['breath', 0, 1, 0, { off: 'breath', vary: [0, 0.5], when: melodic }],
  // envelope
  ['env.a', 0.001, 4, 0.01, { log: true, vary: [0.001, 1], when: melodic }],
  ['env.d', 0.01, 6, 0.2, { log: true, vary: [0.03, 3], when: melodic }],
  ['env.s', 0, 1, 0.7, { when: melodic }],
  ['env.r', 0.01, 8, 0.2, { log: true, vary: [0.02, 3], when: melodic }],
  // pitch
  ['vibrato.depth', 0, 1, 0, { off: 'vibrato', vary: [0, 0.35], when: melodic }],
  ['vibrato.rate', 0.1, 12, 5, { log: true, vary: [3, 7.5], when: (s) => melodic(s) && !!s.vibrato }],
  ['vibrato.delay', 0, 2, 0, { vary: [0, 0.6], when: (s) => melodic(s) && !!s.vibrato }],
  ['glide', 0, 0.5, 0, { off: 'glide', vary: [0, 0.12], when: (s) => melodic(s) && (s.poly || 1) <= 1 && !s.arp }],
  ['scoop', 0, 2, 0, { off: 'scoop', vary: [0, 0.8], when: melodic }],
  ['arp', 1, 60, 24, { step: 1, vary: [10, 40], when: (s) => !!s.arp }],
  // filter
  ['cutoff', 60, 16000, 16000, { log: true, vary: [300, 16000] }],
  ['resonance', 0.3, 6, 0.707, { log: true, vary: [0.5, 3] }],
  ['swell', 0, 3, 0, { off: 'swell', vary: [0, 1.5], when: melodic }],
  ['cutoffIntensity', -4000, 8000, 0, { step: 50, vary: [-1000, 4000] }],
  ['cutoffTension', -4000, 4000, 0, { step: 50, vary: [-1500, 1500] }],
  ['filterEnv.amount', 0, 5, 0, { off: 'filterEnv', vary: [0, 3] }],
  ['filterEnv.decay', 0.02, 2, 0.2, { log: true, vary: [0.04, 1], when: (s) => !!s.filterEnv }],
  // drive, level
  ['drive', 0, 2, 0, { off: 'drive', vary: [0, 1], when: melodic }],
  ['gain', 0, 2, 1, { vary: [0.7, 1.3] }],
];
// the settings that are a choice, not a number (compose.js varySound picks among them); the "plays" setting (one
// note, chords, arpeggio) is not varied: it changes what the clips play
export const SOUND_CHOICES = ['type', 'wave', 'smooth', 'amp', 'body', 'sample', 'kit', 'pads'];
// the oscillator types a variation may switch between (the others need their own settings to sound right)
export const SWAP_TYPES = ['pulse', 'triangle', 'wave', 'fm'];
// a drum pad's pitch, decay and level: multipliers on the kit's
export const PAD_PARAMS = [['pitch', 0.5, 2, 1, { log: true, vary: [0.75, 1.35] }], ['decay', 0.25, 4, 1, { log: true, vary: [0.5, 2] }], ['level', 0.05, 2, 1, { log: true, vary: [0.6, 1.4] }]];
export const PAD_NAMES = ['k', 's', 'h', 'o', 'c', 't', 'm'];

// the fade a track gets unless it sets one (as Engine.fadeSec decides): sustained sounds fade over a bar
export const autoFade = (sound) => (sound?.type !== 'drums' && ((sound?.poly || 1) > 1 || (sound?.env?.a ?? 0) >= 0.15) ? 1 : 0);

const trackMelodic = (s) => s?.type !== 'drums';
export const TRACK_PARAMS = [
  ['volume', 0, 1, 0.3, { vary: [0.08, 0.6] }],
  ['pan', -1, 1, 0, { vary: [-0.8, 0.8] }],
  ['echo', 0, 1, 0, { vary: [0, 0.5] }],
  ['reverb', 0, 1, 0, { vary: [0, 0.7] }],
  ['double', 0, 1, 0, { off: 'double', vary: [0, 0.6], when: trackMelodic }],
  ['pump', 0, 1, 0, { off: 'pump', vary: [0, 0.7], when: trackMelodic }],
  ['layer.min', 0, 1, 0, { vary: [0, 0.7] }],
  ['layer.max', 0, 1, 1, { vary: [0.4, 1] }],
  ['layer.chance', 0, 1, 1, { vary: [0.4, 1] }],
  ['fade', 0, 4, autoFade, { step: 0.5, vary: [0, 2] }], // the default depends on the sound
];
// a choice: the octave (melodic tracks), one up or down

export const SONG_PARAMS = [
  ['swing', 0, 0.6, 0, { vary: [0, 0.35] }],
  ['humanize', 0, 0.3, 0.1, { vary: [0.03, 0.2] }],
  ['master.glue', 0, 1, 0.5, { vary: [0.2, 0.8] }],
];
// choices: the lead-in chord, and (with the key) the scale: another mode of the same colour (harmonic minor and
// locrian are not picked: their odd chords would stand out)
export const LEAD_INS = [0, 1, 2, 4];
export const MODE_FAMILIES = [['minor', 'dorian', 'phrygian'], ['major', 'lydian', 'mixolydian']];
export const MODE_ALIAS = { aeolian: 'minor', ionian: 'major' };

// ---------------------------------------------------------------- reading and writing a setting (a path: 'env.a')
export const getAt = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
export function setAt(o, path, v) {
  const ks = path.split('.');
  let x = o;
  for (const k of ks.slice(0, -1)) x = x[k] && typeof x[k] === 'object' ? x[k] : (x[k] = {});
  x[ks.at(-1)] = v;
}
// removes the key, and its group when that is left empty
export function unsetAt(o, path) {
  const ks = path.split('.'), parent = ks.length > 1 ? getAt(o, ks.slice(0, -1).join('.')) : o;
  if (!parent) return;
  delete parent[ks.at(-1)];
  if (ks.length > 1 && !Object.keys(parent).length) unsetAt(o, ks.slice(0, -1).join('.'));
}
// a setting as the editor sets it: one that switches off is removed at its minimum (with its group: vibrato …)
export function putParam(obj, [path, min, , , o], v) {
  if (o.off && v <= min) unsetAt(obj, o.off);
  else setAt(obj, path, v);
}
// the lists by path: SOUND['env.a'] → its entry
const byPath = (list) => Object.fromEntries(list.map((p) => [p[0], p]));
export const SOUND = byPath(SOUND_PARAMS), TRACK = byPath(TRACK_PARAMS), SONG = byPath(SONG_PARAMS);
