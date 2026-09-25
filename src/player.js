// Main-thread API. This is what a (web) game uses:
//
//   const music = new StardriftPlayer();
//   await music.init();                       // must follow a user gesture
//   await music.loadUrl('songs/deep-space.json');
//   music.play();
//   music.setMood('relaxed');                 // or 'tension', 'danger', 'wonder', 'auto', {intensity, tension}
//   music.setParams({ intensity: 0.8 });      // fine-grained continuous control
//
export class StardriftPlayer {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.analyser = null;
    this.listeners = {};
    this.song = null;
    this.seed = 1;
    this.holding = false; // editor preview while "paused": the song stands still, previews sound
  }

  async init() {
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
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.gain = this.ctx.createGain();
    this.node.connect(this.gain).connect(this.analyser).connect(this.ctx.destination);
    this.ctx.onstatechange = () => this.emit('transport', { type: 'transport', playing: this.playing });
    this.node.onprocessorerror = (e) => this.emit('error', { type: 'error', text: `audio processor crashed: ${e.message || e}` });
    this.node.port.onmessage = (e) => {
      for (const ev of e.data) this.emit(ev.type, ev);
    };
    this.send({ type: 'hold', on: this.holding });
    if (this.song) this.send({ type: 'load', song: this.song, seed: this.seed, restart: true });
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
    try {
      await this.ctx.resume();
    } catch (err) {
      this.dispose();
      this.emit('error', { type: 'error', text: `the browser could not start the audio device (${err.message}). Press ▶ Play again to retry with a fresh audio context.` });
      throw err;
    }
  }
  async pause() { this.setHold(false); await this.ctx?.suspend(); }
  get playing() { return this.ctx?.state === 'running' && !this.holding; }

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
    if (!this.playing) {
      this.setHold(true);
      await this.ctx.resume().catch(() => {});
      const end = Math.max(0, ...events.map((e) => (e.t || 0) + (e.dur || 0)));
      const tail = (inst.env?.r ?? 0.2) + 2.5; // release + echo/reverb
      this.holdTimer = setTimeout(() => { if (this.holding) this.ctx?.suspend(); }, (end + tail) * 1000);
    }
    this.send({ type: 'preview', inst, events, options });
  }

  dispose() {
    try { this.ctx?.close(); } catch { /* already closed */ }
    this.ctx = this.node = this.analyser = this.gain = null;
    this.emit('disposed', { type: 'disposed' });
  }

  setMood(mood, options) { this.send({ type: 'mood', mood, options }); }
  setParams(params) { this.send({ type: 'params', params }); }
  lockBlock(track, block) { this.send({ type: 'lock', track, block: block || null }); }
  setMute(track, on) { this.send({ type: 'mute', track, on }); }
  setSolo(track, on) { this.send({ type: 'solo', track, on }); }
  forceSection(id) { this.send({ type: 'section', id }); }
  requestState() { this.send({ type: 'state' }); }

  setVolume(v, fadeSeconds = 0.5) {
    if (!this.gain) return;
    const t = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setTargetAtTime(v, t, fadeSeconds / 3);
  }
}
