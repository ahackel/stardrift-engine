// Types for what the package exports (src/index.js). The song format in full: SONG_FORMAT.md.

/** 0, 0.25, 0.5, 0.75 or 1 */
export type Weight = number;
export type Mode = 'chord' | 'scale' | 'key';

export interface Instrument {
  /** 'drums': a drum kit; left out, the instrument plays its layers */
  type?: 'drums';
  name?: string;
  poly?: number;
  arp?: number;
  arpChord?: boolean;
  /** the sources, played together as one note (1–3) */
  layers?: Layer[];
  kit?: 'clean' | 'chip' | 'rock' | 'orchestra' | Record<string, { pitch?: number; decay?: number; level?: number; sample?: string }>;
  preset?: 'clean' | 'chip' | 'rock' | 'orchestra';
  /** its effects, in the order the sound goes through them */
  fx?: Effect[];
  /** the note's effects: unison, detune, ensemble, breath, vibrato, glide, scoop; gain (SONG_FORMAT.md, src/engine/params.js) */
  [setting: string]: unknown;
}
/** one source of an instrument or a sound, with its own envelope */
export interface Layer {
  type?: 'pulse' | 'triangle' | 'wave' | 'string' | 'fm' | 'bowed' | 'sample' | 'noise';
  smooth?: boolean;
  wave?: 'soft' | 'sine' | 'saw' | 'warm' | 'organ' | 'hollow' | number[];
  /** a wave's tonewheel organ (in place of `wave`): drawbars 16′ 5⅓′ 8′ 4′ 2⅔′ 2′ 1⅗′ 1⅓′ 1′, each 0–8, e.g. '888000000' */
  drawbars?: string;
  sample?: string;
  env?: { a?: number; d?: number; s?: number; r?: number };
  /** semitones from the note */
  pitch?: number;
  level?: number;
  /** seconds after the note starts */
  delay?: number;
  /** chip noise mixed in, 0–1 */
  noise?: number;
  duty?: number;
  /** muted for now */
  off?: boolean;
  /** on: pitch (semitones), level, duty, noise; each note starts them again */
  moves?: SoundMove[];
  /** the source's own settings: pwm, fm, string, bow */
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

/** a row of effect blocks on the grid */
export interface EffectTrack {
  id: string;
  /** the tracks its effect blocks move, '*' for all (the whole mix) */
  target: '*' | string | string[];
  /** with target '*': the tracks it leaves alone */
  except?: string[];
  clips: string[];
  name?: string;
  color?: string;
}

export type FxKind = 'filter' | 'highpass' | 'volume' | 'echo' | 'reverb' | 'pan' | 'gate' | 'crush';
/** an effect block: one setting moved across the bars it is placed on */
export interface Fx {
  kind: FxKind;
  from?: number;
  to?: number;
  shape?: 'ramp' | 'hump' | 'wave' | 'step';
  /** a step: where it steps, 0–1 of the way (0) */
  at?: number;
  /** a wave: beats per cycle (4) */
  beats?: number;
  /** a gate: beats per chop (0.25) */
  rate?: number;
}

export interface Block {
  id: string;
  /** not on an effect block, which lasts as long as it is placed */
  beats?: number;
  fx?: Fx;
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

/** A game sound: a short sound effect made by synthesis (SONG_FORMAT.md, "Game sounds"). Every setting is optional. */
/** a game sound: an instrument and the note it plays */
export interface Sound {
  id: string;
  name?: string;
  /** the instrument it plays: a key of the song's instruments (not a drum kit) */
  instrument?: string;
  /** an instrument of its own, for music.sound({ … }) and renderSound (a song's sounds name one of its instruments) */
  inst?: Omit<Instrument, 'type' | 'kit' | 'preset'>;
  /** the note it plays, in midi notes (69: A4) */
  note?: number;
  /** seconds the note is held */
  length?: number;
  echo?: number; reverb?: number; volume?: number;
  /** how much each play differs, 0–1 */
  vary?: number;
  /** tuned to the chord playing */
  key?: boolean;
  at?: SoundAt;
  /** how much quieter the music gets under it, 0–1 */
  duck?: number;
}
/** an effect of an instrument's chain or a sound's (the same kinds in both) */
export interface Effect {
  kind: 'body' | 'wah' | 'drive' | 'filter' | 'crush' | 'eq' | 'ring' | 'vowel' | 'delay' | 'phaser' | 'chorus' | 'tremolo' | 'autopan' | 'leslie';
  /** bypassed for now */
  off?: boolean;
  /** a filter's: low, high, band; a body's: violin, cello, strings, horn, brass, ah, oh, oo, ee */
  type?: string;
  bands?: [string, number, number?, number?][];
  amp?: 'guitar' | 'bass';
  /** a wah that follows the notes ('note'); a chorus as a flanger ('flanger') or a string machine's ensemble ('ensemble') */
  mode?: 'note' | 'flanger' | 'ensemble';
  /** a tremolo that chops */
  square?: boolean;
  /** in music: how long one sweep takes, in beats */
  beats?: number;
  /** in a sound: how fast it goes, Hz (a crush: its sample rate) */
  rate?: number;
  amount?: number; cutoff?: number; resonance?: number; env?: number; decay?: number; swell?: number; bite?: number; bits?: number;
  low?: number; mid?: number; midHz?: number; high?: number; depth?: number; feedback?: number;
  freq?: number; mix?: number; vowel?: number; time?: number;
  moves?: SoundMove[];
}
/** a setting that moves: from its own value to `to`; in music from each note, in beats; in a sound over it, in seconds */
export interface SoundMove {
  on: string;
  to: number;
  shape?: 'ramp' | 'hump' | 'wave' | 'step';
  /** in music: how long it takes (a wave: its period), in beats */
  beats?: number;
  /** in a sound: a wave's, Hz */
  rate?: number;
  /** a step's, 0–1 of the way through */
  at?: number;
  /** it starts over this often (beats in music, seconds in a sound); 0 once */
  every?: number;
}
export type SoundAt = 'now' | 'step' | 'beat';
export interface SoundOptions { pitch?: number; volume?: number; pan?: number; at?: SoundAt }

export interface Song {
  name?: string;
  format?: number;
  bpm?: number;
  key?: string;
  scale?: string;
  instruments: Record<string, Instrument>;
  tracks: Track[];
  effectTracks?: EffectTrack[];
  blocks: Block[];
  sections?: Section[];
  progressions?: Progression[];
  moods?: Record<string, { sections: Record<string, Weight> }>;
  stingers?: Stinger[];
  sounds?: Sound[];
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
  /** a game sound: one of the song's (its id) or a sound's own settings; it sounds with the music paused too */
  sound(sound: string | Omit<Sound, 'id'>, options?: SoundOptions): Promise<void>;
  stopSounds(): void;
  /** the sounds' own volume (setVolume: everything) */
  setSoundVolume(volume: number): void;
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
  sound(sound: string | Omit<Sound, 'id'>, options?: SoundOptions): boolean;
  stopSounds(): void;
  setSoundVolume(volume: number): void;
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

/** a sound into a buffer, dry and mono (seed: which take, when it varies) */
export function renderSound(sound: Omit<Sound, 'id'>, options?: { sr?: number; seed?: number; opts?: SoundOptions }): Float32Array;
/** a sound with every setting there, in range */
export function soundOf(sound: Partial<Sound>): Required<Omit<Sound, 'id' | 'name'>>;
export function soundLength(sound: Partial<Sound>): number;
/** what an instrument costs to play: 1 is a plain pulse note */
export function costOf(inst: Instrument, poly?: number): { note: number; notes: number; fx: number; total: number };
export function migrateInstrument(inst: object): Instrument;
export function migrateSound(sound: object): Sound;
/** a sound with the song's instrument it names in inst */
export function resolveSound(song: Song, sound: Partial<Sound>): Partial<Sound>;
