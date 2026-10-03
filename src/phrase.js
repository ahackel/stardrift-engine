// A short phrase for one sound, rendered offline with the engine (browser and node). Sound tools (the editor's lab) play
// variants of a sound in the same phrase, level-matched, so the ear compares the sound and not the loudness.
// phrase = { bpm, key, scale, chords, bars, part: { pattern, mode, beats }, band?: [{ id, sound, track, pattern, mode, beats }] }
import { Engine } from './engine/engine.js';

export function phraseSong(phrase, sound, track = {}, { band = false } = {}) {
  const beats = (phrase.bars || 2) * 4;
  const song = {
    name: 'lab', bpm: phrase.bpm || 120, key: phrase.key || 'E', scale: phrase.scale || 'minor', stepsPerBeat: 4, beatsPerBar: 4,
    variation: 0, blockChange: 0, fillChance: 0, layerChurn: 0, leadIn: 0, humanize: 0.06, startSection: 's',
    fx: phrase.fx || { echo: { beats: 0.75, feedback: 0.3, damp: 0.4, level: 0.25 }, reverb: { size: 0.75, damp: 0.5, level: 0.3 }, echoToReverb: 0.2 },
    master: { gain: 1 }, moods: {}, instruments: { x: sound }, tracks: [], blocks: [],
    sections: [{ id: 's', bars: [beats / 4], tags: ['s'], next: { s: 1 } }],
    progressions: [{ id: 'p', tags: ['s'], chords: phrase.chords || 'i:4' }],
  };
  const add = (id, snd, tr, part) => {
    song.instruments[id] = snd;
    song.tracks.push({ volume: 0.25, pan: 0, echo: 0.1, reverb: 0.25, ...tr, id, instrument: id, layer: { min: 0, max: 1, chance: 1 } });
    song.blocks.push({ id: `${id}_b`, track: id, tags: ['s'], beats: part.beats || beats, pattern: part.pattern, ...(part.mode ? { mode: part.mode } : {}) });
  };
  add('x', sound, track, phrase.part);
  if (band) for (const b of phrase.band || []) add(b.id, b.sound, b.track, b);
  return song;
}

// → { left, right } Float32Arrays, scaled to the same loudness (RMS -20 dBFS) unless raw. samples: the sample library
export function renderPhrase(phrase, sound, track, { sr = 44100, band = false, raw = false, tail = 1.5, samples = null } = {}) {
  const song = phraseSong(phrase, sound, track, { band });
  const e = new Engine(sr, song, 3);
  if (samples) e.setSamples(samples);
  const secs = ((phrase.bars || 2) * 4 * 60) / song.bpm + tail, n = Math.round(secs * sr);
  const left = new Float32Array(n), right = new Float32Array(n);
  for (let i = 0; i < n; i += 128) {
    const len = Math.min(128, n - i);
    e.process(left.subarray(i, i + len), right.subarray(i, i + len), len);
  }
  let sum = 0, peak = 0;
  for (let i = 0; i < n; i++) {
    sum += left[i] * left[i] + right[i] * right[i];
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }
  const rms = Math.sqrt(sum / (2 * n));
  if (!raw && rms > 0) {
    const g = Math.min(0.1 / rms, 0.98 / peak);
    for (let i = 0; i < n; i++) { left[i] *= g; right[i] *= g; }
  }
  return { left, right, rms };
}
