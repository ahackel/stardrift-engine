// Types for what the package exports (src/index.js). The song format in full: SONG_FORMAT.md.

/** 0, 0.25, 0.5, 0.75 or 1 */
export type Weight = number;
export type Mode = 'chord' | 'scale' | 'key';

export interface Instrument {
  type: 'pulse' | 'triangle' | 'wave' | 'string' | 'fm' | 'bowed' | 'sample' | 'drums';
  name?: string;
  poly?: number;
  arp?: number;
  arpChord?: boolean;
  smooth?: boolean;
  wave?: 'soft' | 'sine' | 'saw' | 'warm' | 'organ' | 'hollow' | number[];
  sample?: string;
  kit?: 'clean' | 'chip' | 'rock' | 'orchestra' | Record<string, { pitch?: number; decay?: number; level?: number; sample?: string }>;
  preset?: 'clean' | 'chip' | 'rock' | 'orchestra';
  env?: { a?: number; d?: number; s?: number; r?: number };
  filter?: 'low' | 'high';
  body?: string | [string, number, number?, number?][];
  amp?: 'guitar' | 'bass';
  /** every other setting (SONG_FORMAT.md, src/engine/params.js) */
  [setting: string]: unknown;
}

export interface Track {
  id: string;
  instrument: string;
  clips: string[];
  name?: string;
  octave?: number;
  volume?: number;
  pan?: number;
  echo?: number;
  reverb?: number;
  double?: number;
  pump?: number;
  fade?: number;
  follow?: boolean;
  mode?: Mode;
  stickiness?: number;
  color?: string;
}

export interface Block {
  id: string;
  beats: number;
  pattern?: string;
  from?: string;
  mode?: Mode;
  fit?: boolean;
  forms?: ('whole' | 'head' | 'sequence' | 'slow' | 'shift' | 'answer')[];
  sections?: Record<string, Weight>;
  fill?: boolean;
  mutate?: number;
  name?: string;
  color?: string;
}

export interface Section {
  id: string;
  bars: number | number[];
  tracks?: Record<string, Weight>;
  next?: Record<string, Weight>;
  name?: string;
  color?: string;
}

export interface Progression {
  id: string;
  chords: string;
  scale?: string;
  sections?: Record<string, Weight>;
  name?: string;
  color?: string;
}

export interface Stinger {
  id: string;
  beats: number;
  parts: { track: string; pattern: string; mode?: Mode }[];
  at?: StingAt;
  chords?: string;
  duck?: number;
  name?: string;
}

export interface Song {
  name?: string;
  format?: number;
  bpm?: number;
  key?: string;
  scale?: string;
  instruments: Record<string, Instrument>;
  tracks: Track[];
  blocks: Block[];
  sections?: Section[];
  progressions?: Progression[];
  moods?: Record<string, { sections: Record<string, Weight> }>;
  stingers?: Stinger[];
  startSection?: string;
  breath?: { every: number; bars: [number, number]; keep?: string[] };
  /** swing, humanize, leadIn, master, fx … (SONG_FORMAT.md) */
  [setting: string]: unknown;
}

export type StingAt = 'step' | 'beat' | 'half' | 'bar';
/** the recordings: name → zones */
export type Samples = Record<string, { data: Float32Array; rate: number; root: number; loopStart: number; loopEnd: number }[]>;
/** path in the sample library (or a song's zip) → its bytes */
export type Read = (path: string) => Promise<ArrayBuffer>;

export interface StardriftEvents {
  state: { type: 'state'; section: string | null; next: string | null; prog: string | null; chords: string[]; scale: string; mood: string; heading: string | null; energy: number; tracks: Record<string, { active: boolean; block?: string | null }> };
  step: { type: 'step'; step: number; bar: number; bars: number; pos: number };
  chord: { type: 'chord'; label: string; degree?: number; scale: string; shape: string };
  note: { type: 'note'; track: string; midi?: number };
  sting: { type: 'sting'; id: string; on: boolean };
  log: { type: 'log'; text: string; step: number };
  transport: { type: 'transport'; playing: boolean };
  error: { type: 'error'; text: string };
  levels: { type: 'levels'; tracks: Record<string, number>; l: number; r: number };
  disposed: { type: 'disposed' };
}

export class StardriftPlayer {
  readonly song: Song | null;
  readonly playing: boolean;
  /** from a click or a key: browsers start audio only then */
  init(options?: { library?: string | URL; worklet?: string | URL }): Promise<void>;
  /** a song's .zip (the editor's Export for a game) or .json */
  loadUrl(url: string | URL, options?: LoadOptions): Promise<Song>;
  loadZip(buffer: ArrayBuffer, options?: LoadOptions): Promise<Song>;
  load(song: Song, options?: LoadOptions): void;
  restart(seed?: number): void;
  play(): Promise<void>;
  /** fade: seconds to fade out over before it stops */
  pause(fade?: number): Promise<void>;
  setVolume(volume: number, fadeSeconds?: number): void;
  dispose(): void;
  /** one of the song's moods, or 'auto'; within: bars until the move starts (default 2) */
  setMood(mood: string, options?: { within?: number }): void;
  sting(id: string, options?: { at?: StingAt }): void;
  on<K extends keyof StardriftEvents>(type: K, fn: (event: StardriftEvents[K]) => void): () => void;
  on(type: '*', fn: (event: StardriftEvents[keyof StardriftEvents]) => void): () => void;
  off(type: string, fn: Function): void;

  // for tools such as the editor
  preview(instrument: Instrument, events: { t: number; notes?: number[]; hit?: string; dur?: number }[], options?: { poly?: number; volume?: number }): Promise<void>;
  stopPreview(): void;
  keyOn(instrument: Instrument, note: number | string, options?: { volume?: number; vel?: number }): Promise<void>;
  keyOff(note: number | string): void;
  audition(seconds: number, options?: { exact?: boolean }): Promise<void>;
  lockBlock(track: string, block: string | null): void;
  lockProgression(id: string | null): void;
  lockSection(id: string | null): void;
  forceSection(id: string): void;
  /** Jump at once to a bar of a section in a mood's flow (i: its place in mood.flow, bar: from 0). */
  seek(mood: string, i: number, bar?: number): void;
  forceProgression(id: string): void;
  playChord(degree: number | null, shape?: string): void;
  setMute(track: string, on: boolean): void;
  setSolo(track: string, on: boolean): void;
  setMeters(on: boolean): void;
  setHold(on: boolean): void;
  requestState(): void;
}
export interface LoadOptions { seed?: number; restart?: boolean; read?: Read }

/** the engine itself, for offline rendering or another audio host */
export class Engine {
  constructor(sampleRate: number, song: Song, seed?: number);
  /** renders n samples into the two channels */
  process(outL: Float32Array, outR: Float32Array, n: number): void;
  setSong(song: Song): void;
  setSamples(samples: Samples): void;
  setMood(mood: string, options?: { within?: number }): void;
  sting(id: string, options?: { at?: StingAt }): boolean;
  /** the events since the last call (StardriftEvents) */
  drainEvents(): StardriftEvents[keyof StardriftEvents][];
}

/** what the engine would skip (errors) or change (warnings) in a song, each a line saying where and what */
export function validateSong(song: unknown, options?: { samples?: string[] }): { errors: string[]; warnings: string[] };

export const LIBRARY_URL: URL;
export function loadSamples(read: Read, names?: string[]): Promise<Samples>;
export function fetchSamples(libraryUrl?: string | URL, names?: string[]): Promise<Samples>;
export function soundSamples(instrument: Instrument): string[];
export function songSamples(song: Song): string[];
export function encodeWav(left: Float32Array, right: Float32Array | null, sampleRate: number): ArrayBuffer;
export function decodeWav(buffer: ArrayBuffer): { data: Float32Array; rate: number };
export function phraseSong(phrase: string, sound: Instrument, track?: Partial<Track>, options?: { band?: boolean }): Song;
export function renderPhrase(phrase: string, sound: Instrument, track?: Partial<Track>, options?: { sr?: number; band?: boolean; raw?: boolean; tail?: number; samples?: Samples | null }): { left: Float32Array; right: Float32Array; rms: number };
/** a song and the recordings it plays, in one zip, for a game */
export function songZip(song: Song, read?: Read): Promise<Uint8Array>;
export function openSongZip(buffer: ArrayBuffer): Promise<{ song: Song; read: Read }>;
export function zip(files: { name: string; data: string | Uint8Array }[], date?: Date): Uint8Array;
export function unzip(buffer: ArrayBuffer | Uint8Array): { names: string[]; has(name: string): boolean; read(name: string): Promise<Uint8Array> };
export function isZip(buffer: ArrayBuffer | Uint8Array): boolean;
