// AudioWorklet host: runs the whole engine on the audio thread (like OnAudioFilterRead in Unity).
import { Engine } from './engine/engine.js';

class StardriftProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = null;
    this.hold = false;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    try {
      if (m.type === 'load') {
        if (!this.engine || m.restart) this.engine = new Engine(sampleRate, m.song, m.seed ?? 1);
        else this.engine.setSong(m.song);
        this.engine.setHold(this.hold);
        return;
      }
      if (m.type === 'hold') { this.hold = !!m.on; this.engine?.setHold(this.hold); return; }
      const e = this.engine;
      if (!e) return;
      switch (m.type) {
        case 'params': e.setParams(m.params); break;
        case 'mood': e.setMood(m.mood, m.options); break;
        case 'lock': e.lock(m.track, m.block); break;
        case 'lockProg': e.lockProgression(m.id); break;
        case 'chord': e.playChord(m.degree, m.shape); break;
        case 'sting': e.sting(m.id, m.options); break;
        case 'mute': e.setMute(m.track, m.on); break;
        case 'solo': e.setSolo(m.track, m.on); break;
        case 'section': e.forceSection(m.id); break;
        case 'state': e.emitState(); break;
        case 'preview': e.preview(m.inst, m.events, m.options); break;
      }
    } catch (err) {
      this.port.postMessage([{ type: 'error', text: String(err && err.message || err) }]);
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!this.engine || !out || !out[0]) return true;
    this.engine.process(out[0], out[1] || out[0], out[0].length);
    if (this.engine.events.length) this.port.postMessage(this.engine.drainEvents());
    return true;
  }
}

registerProcessor('stardrift', StardriftProcessor);
