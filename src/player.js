import { fetchSamples, soundSamples, songSamples } from './samples.js';

// Main-thread API. This is what a (web) game uses:
//
//   const music = new StardriftPlayer();
//   await music.init();                       // must follow a user gesture (init({ library: url }) if library/ is elsewhere)
//   await music.loadUrl('songs/deep-space.json');
//   music.play();
//   music.setMood('relaxed');                 // or 'tension', 'danger', 'wonder' … (the song's moods), 'auto'
//   music.sting('discovery');                 // a short phrase for a game event, in key and on the beat
//
export class StardriftPlayer {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.listeners = {};
    this.song = null;
    this.seed = 1;
    this.holding = false; // editor preview while "paused": the song stands still, previews sound
  }

  async init({ library } = {}) {
    if (this.ctx) return;
    // Default latency on purpose: latencyHint 'playback' makes WebKit request a buffer size
    // some macOS devices refuse ("InvalidStateError: Failed to start the audio device").
    const ctx = (this.ctx = new AudioContext());
    ctx.resume().catch(() => {}); // still inside the user gesture; failures are handled in play()
    try {
      await ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
    } catch (err) {
      this.dispose();
      throw err;
    }
    this.node = new AudioWorkletNode(this.ctx, 'stardrift', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.gain = this.ctx.createGain();
    this.node.connect(this.gain).connect(this.ctx.destination);
    this.ctx.onstatechange = () => this.emit('transport', { type: 'transport', playing: this.playing });
    this.node.onprocessorerror = (e) => this.emit('error', { type: 'error', text: `audio processor crashed: ${e.message || e}` });
    this.node.port.onmessage = (e) => {
      for (const ev of e.data) this.emit(ev.type, ev);
    };
    this.send({ type: 'hold', on: this.holding });
    if (this.meters) this.send({ type: 'meters', on: true });
    if (this.song) this.send({ type: 'load', song: this.song, seed: this.seed, restart: true });
    this.library = library;
    this.requested = new Set();
    if (this.song) this.need(songSamples(this.song));
  }

  // Recorded sounds load in the background, only the ones the song (or a preview) plays: sample sounds join when they
  // arrive, cymbals are synthesized until then. The promise is there for whoever wants to wait for them.
  need(names) {
    if (!this.node) return;
    names = names.filter((n) => !this.requested.has(n));
    if (!names.length) return;
    for (const n of names) this.requested.add(n);
    this.samples = Promise.all([this.samples, fetchSamples(this.library, names).then((samples) => {
      const buffers = Object.values(samples).flat().map((z) => z.data.buffer);
      this.node?.port.postMessage({ type: 'samples', samples }, buffers);
    }).catch((err) => {
      for (const n of names) this.requested.delete(n);
      this.emit('error', { type: 'error', text: `could not load the sample library: ${err.message}` });
    })]);
  }

  on(type, fn) { (this.listeners[type] ||= []).push(fn); return () => this.off(type, fn); }
  off(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  emit(type, ev) { for (const fn of this.listeners[type] || []) fn(ev); for (const fn of this.listeners['*'] || []) fn(ev); }
  send(msg) { if (this.node) this.node.port.postMessage(msg); }

  async loadUrl(url, opts) {
    const song = await (await fetch(url)).json();
    this.load(song, opts);
    return song;
  }

  // restart=false hot-swaps the song and keeps playing from the same position (used by the editor)
  load(song, { seed, restart = false } = {}) {
    if (seed !== undefined) this.seed = seed;
    const fresh = !this.song || restart;
    this.song = JSON.parse(JSON.stringify(song));
    this.send({ type: 'load', song: this.song, seed: this.seed, restart: fresh });
    this.need(songSamples(this.song));
  }

  restart(seed = this.seed) {
    this.seed = seed;
    this.send({ type: 'load', song: this.song, seed, restart: true });
  }

  // Safari can refuse to start the audio device; a refused context never recovers,
  // so throw it away and let the next user gesture build a fresh one.
  async play() {
    if (!this.ctx) return;
    this.setHold(false);
    if (this.fading) { this.fading = null; this.setVolume(this.volume ?? 1, 0.03); } // played again while fading out
    try {
      await this.ctx.resume();
    } catch (err) {
      this.dispose();
      this.emit('error', { type: 'error', text: `the browser could not start the audio device (${err.message}). Press ▶ Play again to retry with a fresh audio context.` });
      throw err;
    }
  }
  // fade: seconds the music fades out over before it stops (0: at once)
  async pause(fade = 0) {
    this.setHold(false);
    if (!this.ctx) return;
    if (fade > 0 && this.ctx.state === 'running') {
      const g = this.gain.gain, t = this.ctx.currentTime, token = (this.fading = {});
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(0, t + fade);
      await new Promise((r) => setTimeout(r, fade * 1000));
      if (this.fading !== token) return; // played again meanwhile
      this.fading = null;
    }
    await this.ctx.suspend();
    this.gain.gain.cancelScheduledValues(0);
    this.gain.gain.value = this.volume ?? 1; // at full volume again for the next play
  }
  get playing() { return this.ctx?.state === 'running' && !this.holding && !this.fading; }

  setHold(on) {
    clearTimeout(this.holdTimer);
    if (this.holding === !!on) return;
    this.holding = !!on;
    this.send({ type: 'hold', on: this.holding });
    this.emit('transport', { type: 'transport', playing: this.playing });
  }

  // Audition an instrument definition (editor). While the song is paused only the preview sounds.
  //   events: [{ t: seconds, notes: [midi], dur }] or [{ t, hit: 's' }]   options: { poly, volume }
  async preview(inst, events, options) {
    if (!this.ctx) return;
    const end = Math.max(0, ...events.map((e) => (e.t || 0) + (e.dur || 0)));
    await this.audition(end + (inst.env?.r ?? 0.2) + 2.5); // + release + echo/reverb
    this.need(soundSamples(inst));
    this.send({ type: 'preview', inst, events, options });
  }

  stopPreview() { this.send({ type: 'stopPreview' }); } // and a stinger that plays

  // Live keyboard (editor): a note (midi, or a drum hit like 's') sounds until keyOff. While the song is paused the
  // audio runs until a few seconds after the last key is let go.   options: { volume, vel }
  async keyOn(inst, note, options) {
    if (!this.ctx) return;
    this.keysDown = (this.keysDown || 0) + 1;
    await this.audition(600);
    this.need(soundSamples(inst));
    this.send({ type: 'keyOn', inst, note, options });
  }
  keyOff(note) {
    this.send({ type: 'keyOff', note });
    this.keysDown = Math.max(0, (this.keysDown || 0) - 1);
    if (!this.keysDown) this.audition(4, { exact: true });
  }

  // While the song is paused, let the audio run for `seconds` (the song stands still) so a preview can sound.
  // A later request only ever extends the time, unless `exact` (the keyboard's last key let go).
  async audition(seconds, { exact = false } = {}) {
    if (!this.ctx || this.playing) return;
    this.setHold(true);
    if (this.fading) { this.fading = null; this.setVolume(this.volume ?? 1, 0.03); } // a preview while the song fades out
    await this.ctx.resume().catch(() => {});
    const now = performance.now(), until = exact ? now + seconds * 1000 : Math.max(now + seconds * 1000, this.holdUntil || 0);
    clearTimeout(this.holdTimer);
    this.holdUntil = until;
    this.holdTimer = setTimeout(() => { if (this.holding) this.ctx?.suspend(); }, until - now);
  }

  dispose() {
    try { this.ctx?.close(); } catch { /* already closed */ }
    this.ctx = this.node = this.gain = null;
    this.emit('disposed', { type: 'disposed' });
  }

  setMood(mood, options) { this.send({ type: 'mood', mood, options }); }
  lockBlock(track, block) { this.send({ type: 'lock', track, block: block || null }); }
  lockProgression(id) { this.send({ type: 'lockProg', id: id || null }); } // null = back to automatic
  // 'levels' events about 30 times a second: { tracks: { id: peak }, l, r } (the master before its soft clip)
  setMeters(on) { this.meters = !!on; this.send({ type: 'meters', on: this.meters }); }
  lockSection(id) { this.send({ type: 'lockSec', id: id || null }); } // plays this section again and again; null = the graph walk
  // Play your own chord from the next beat: degree 0-6 of the current scale (null = back to the progression)
  playChord(degree, shape = 'triad') { this.send({ type: 'chord', degree: degree ?? null, shape }); }
  // Stinger for a game event (song.stingers), from the next beat or options.at: 'step' | 'beat' | 'half' | 'bar'
  sting(id, options) { this.send({ type: 'sting', id, options }); }
  setMute(track, on) { this.send({ type: 'mute', track, on }); }
  setSolo(track, on) { this.send({ type: 'solo', track, on }); }
  forceSection(id) { this.send({ type: 'section', id }); }
  forceProgression(id) { this.send({ type: 'prog', id }); } // once, from the next bar line
  requestState() { this.send({ type: 'state' }); }

  setVolume(v, fadeSeconds = 0.5) {
    this.volume = v;
    if (!this.gain) return;
    const t = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setTargetAtTime(v, t, fadeSeconds / 3);
  }
}
