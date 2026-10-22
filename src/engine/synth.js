// The mix, sample by sample: a bus per track (its voices, voice.js, or a drum kit, drums.js; its effects, fx.js; its
// pan, double tracking and the effect rows' moves), the game sounds (sfx.js), a ping-pong echo, a small Freeverb and the
// master bus.
// Deliberately plain code (no Web Audio nodes) so it ports 1:1 to C# OnAudioFilterRead.

import { DrumVoice } from './drums.js';
import { TWO_PI } from './dsp.js';
import { clamp, clamp01 } from './theory.js';
import { Moves } from './moves.js';
import { SfxVoice } from './sfx.js';
import { FxChain } from './fx.js';
import { compileInst, timeMoves, Voice, IDLE } from './voice.js';

class TrackBus {
  constructor(poly, isDrum) {
    this.isDrum = isDrum;
    this.voices = Array.from({ length: poly }, () => (isDrum ? new DrumVoice() : new Voice()));
    this.g = 0; this.gTarget = 1; this.rr = 0;
    this.fade = 1; this.fadeTo = 1; this.fadeStep = 0; // a track joining or leaving: a linear ramp (Synth.fade)
    this.loud = 0; // the loudest voice's envelope level (a filter's swell, a wah that follows the notes)
    this.fx = null; // its effects (fx.js), in their order
    this.peak = 0; // the loudest sample since the meters last looked (Synth.takePeaks)
    this.apT = 0; // the auto-pan's countdown to new pan gains
    this.mvT = 0; // countdown to the next pan gains while an effect row moves it
  }
  // bps: the song's beats per second (the effects that go in time go with them)
  set(tr, p, sr, bps = 2) {
    this.p = p; this.sr = sr; this.bps = bps;
    this.mv ||= new Moves(sr); // the effect rows' moves on this track
    this.apOff = 0;
    this.vol = (tr.volume ?? 0.3) * p.gain;
    this.pan = clamp(tr.pan || 0, -1, 1);
    this.echo = tr.echo || 0; this.rev = tr.reverb || 0;
    this.pump = clamp01(tr.pump || 0); // sidechain: dips on every kick
    (this.fx ||= new FxChain(sr)).set(p.fx, { music: true, bps, drums: this.isDrum });
    timeMoves(p, { music: true, bps }); // its layers' moves, in beats: each note starts them again
    // double tracking: a second take, a few ms late with a slowly wandering delay, on the other side;
    // the two sit at pan ± double
    this.dbl = clamp01(tr.double || 0);
    if (this.dbl && !this.dBuf) { this.dBuf = new Float32Array(Math.ceil(sr * 0.03)); this.dI = 0; this.dT = 0; }
    this.place(0);
  }
  // the gains that put the track at its pan moved by off (auto-pan), and the double's two takes either side of it
  place(off) {
    const pan = clamp(this.pan + off, -1, 1);
    if (this.dbl) {
      const a = ((clamp(pan - this.dbl, -1, 1) + 1) * Math.PI) / 4, b = ((clamp(pan + this.dbl, -1, 1) + 1) * Math.PI) / 4;
      this.pl = Math.cos(a); this.pr = Math.sin(a); this.ql = Math.cos(b); this.qr = Math.sin(b);
    } else {
      this.pl = Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
      this.pr = Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
    }
  }
  // the second take: 14 ms late, the delay drifting by about a millisecond (a few cents of pitch, like a player)
  double(x) {
    const buf = this.dBuf, n = buf.length;
    buf[this.dI] = x;
    this.dT += this.p.invSr;
    const d = this.sr * (0.014 + 0.0012 * Math.sin(TWO_PI * 0.23 * this.dT) + 0.0007 * Math.sin(TWO_PI * 0.61 * this.dT));
    let r = this.dI - d;
    if (r < 0) r += n;
    const i = Math.floor(r), f = r - i, y = buf[i] + (buf[i + 1 === n ? 0 : i + 1] - buf[i]) * f;
    if (++this.dI >= n) this.dI = 0;
    return y;
  }
  noteOn(midis, vel, short) {
    const p = this.p, vs = this.voices;
    this.fx.noteOn(vel); // each note starts the effects' moves (and a filter's envelope) again
    if (vs.length === 1) {
      const arp = midis.length > 1 && p.arpPeriod ? midis.slice().sort((a, b) => a - b) : null;
      vs[0].start(p, arp ? arp[0] : midis[0], vel, arp, short);
      return;
    }
    for (const v of vs) if (v.gate) v.release();
    for (const m of midis) { const v = this.alloc(); v.str = -1; v.start(p, m, vel, null, short); }
  }
  // A guitar's string s (0 = low E; 6 and up: other notes) plays m: on a guitar (p.ring) it ends only what that
  // string played, the others ring on; else, as a chord does, every note before. first: the stroke's first string.
  // short: palm-muted, 2: dead (Osc.start)
  strike(m, s, vel, short, first) {
    const p = this.p, vs = this.voices;
    if (first) {
      this.fx.noteOn(vel);
      if (!p.ring) for (const v of vs) if (v.gate) v.release();
    }
    let v = p.ring ? vs.find((x) => x.str === s && x.stage !== IDLE) : null;
    if (!v) v = this.alloc();
    v.str = s;
    v.start(p, m, vel, null, short);
  }
  // a downstroke damps the strings it doesn't play (keep: the ones it does)
  damp(keep) { if (!this.isDrum) for (const v of this.voices) if (v.gate && !keep.includes(v.str)) v.release(); }
  alloc() {
    let best = null, score = Infinity;
    for (const v of this.voices) {
      if (v.stage === IDLE) return v;
      const s = (v.gate ? 10 : 0) + v.level - v.age * 0.001;
      if (s < score) { score = s; best = v; }
    }
    return best; // restarts from its current level: no click
  }
  release() { if (!this.isDrum) for (const v of this.voices) if (v.gate) v.release(); }
  drum(hits, vel) {
    if (hits.length) this.fx.noteOn(vel); // a hit starts the effects' moves again, as a note does
    for (const h of hits) {
      const d = this.p.kit[h];
      if (!d) continue;
      if (h === 'h') for (const v of this.voices) if (v.active && v.kind === 'o') v.choke(this.sr);
      let v = this.voices.find((x) => !x.active);
      if (!v) { v = this.voices[this.rr]; this.rr = (this.rr + 1) % this.voices.length; }
      v.start(d, h, vel);
    }
  }
  allOff() {
    for (const v of this.voices) { if (this.isDrum) v.active = false; else v.stop(); }
  }
  idle() {
    for (const v of this.voices) if (this.isDrum ? v.active : v.stage !== IDLE) return false;
    return true;
  }
  render() {
    let x = 0;
    const p = this.p;
    if (this.isDrum) { for (const v of this.voices) if (v.active) x += v.render(this.sr, p.invSr); }
    else {
      let loud = 0;
      for (const v of this.voices) if (v.stage !== IDLE) { x += v.render(p); if (v.level > loud) loud = v.level; }
      this.loud = loud;
    }
    let y = this.fx.run(x, this.loud); // the effects, in their order
    if (this.fx.panning && --this.apT <= 0) { // an auto-pan: the pan gains move every 16 samples
      this.apT = 16;
      this.apOff = this.fx.pan;
      if (!this.mv.on) this.place(this.apOff);
    }
    const mv = this.mv;
    mv.tick();
    if (mv.on) {
      y = mv.run(y);
      if (--this.mvT <= 0) { this.mvT = 16; this.place(this.apOff + mv.pan); } // an effect row's pan
    }
    this.g += (this.gTarget - this.g) * 0.0015;
    if (this.fadeStep) {
      this.fade += this.fadeStep;
      if (this.fadeStep > 0 ? this.fade >= this.fadeTo : this.fade <= this.fadeTo) {
        this.fade = this.fadeTo; this.fadeStep = 0;
        if (this.fade === 0) { this.allOff(); this.fade = this.fadeTo = 1; } // faded out: its notes stop, silently
      }
    }
    return y * this.vol * this.g * this.fade;
  }
}

// The master bus: a low cut (rumble under 30 Hz only eats headroom), then a gentle compressor that glues the mix
// (glue 0–1: the ratio, from 1:1 to 4:1 above -9 dB, 10 ms attack, 250 ms release, and makeup gain so the quiet
// parts come up). The soft clip after it (Synth.renderSample) is the limiter: peaks round off instead of crackling.
class Master {
  constructor(sr) {
    this.hpK = 1 - Math.exp((-2 * Math.PI * 30) / sr);
    this.att = 1 - Math.exp(-1 / (0.01 * sr));
    this.rel = 1 - Math.exp(-1 / (0.25 * sr));
    this.lpL = 0; this.lpR = 0; this.env = 0;
    this.set(0.5);
  }
  set(glue) {
    const g = clamp01(glue);
    this.slope = 1 - 1 / (1 + 3 * g); // 0 = no compression
    this.makeup = 1 + 0.4 * g;
  }
  process(l, r) {
    this.lpL += this.hpK * (l - this.lpL); l -= this.lpL;
    this.lpR += this.hpK * (r - this.lpR); r -= this.lpR;
    const lvl = Math.max(Math.abs(l), Math.abs(r));
    this.env += (lvl > this.env ? this.att : this.rel) * (lvl - this.env);
    const T = 0.35, g = (this.env > T && this.slope ? Math.pow(T / this.env, this.slope) : 1) * this.makeup;
    this.l = l * g; this.r = r * g;
  }
}

class Echo {
  constructor(sr) {
    this.sr = sr; this.max = Math.ceil(sr * 4);
    this.bl = new Float32Array(this.max); this.br = new Float32Array(this.max);
    this.i = 0; this.d = sr / 2; this.dTarget = this.d; this.fb = 0.4; this.k = 0.5; this.ll = 0; this.lr = 0;
    this.hp = 0; this.hpK = 0;
  }
  set(sec, fb, damp, lowcut = 0) {
    this.dTarget = clamp(Math.round(sec * this.sr), 1, this.max - 2);
    this.fb = Math.min(0.95, fb); this.k = 1 - Math.min(0.95, damp);
    this.hpK = lowcut > 0 ? 1 - Math.exp((-2 * Math.PI * lowcut) / this.sr) : 0; // keeps bass out of the repeats
  }
  process(x) {
    if (this.hpK) { this.hp += (x - this.hp) * this.hpK; x -= this.hp; }
    if (this.d !== this.dTarget) this.d += this.d < this.dTarget ? 1 : -1; // tape-style glide, no clicks
    let j = this.i - this.d;
    if (j < 0) j += this.max;
    const rl = this.bl[j], rr = this.br[j];
    this.ll += (rl - this.ll) * this.k;
    this.lr += (rr - this.lr) * this.k;
    this.bl[this.i] = x + this.lr * this.fb;
    this.br[this.i] = this.ll * this.fb;
    if (++this.i >= this.max) this.i = 0;
    this.outL = rl; this.outR = rr;
  }
}

// Freeverb (8 combs + 4 allpasses per side) with a pre-delay and a low cut on its input:
// the pre-delay keeps notes clear of their tail, the low cut keeps bass out of the tail (no mud).
class Reverb {
  constructor(sr) {
    const s = sr / 44100;
    const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
    const aps = [556, 441, 341, 225];
    const mk = (n) => ({ buf: new Float32Array(Math.max(8, Math.round(n * s))), i: 0, f: 0 });
    this.cl = combs.map(mk); this.cr = combs.map((n) => mk(n + 23));
    this.al = aps.map(mk); this.ar = aps.map((n) => mk(n + 23));
    this.fb = 0.86; this.damp = 0.4;
    this.sr = sr; this.pre = new Float32Array(Math.ceil(sr * 0.2)); this.pi = 0; this.pd = 0;
    this.hp = 0; this.hpK = 0;
  }
  set(size, damp, predelay = 0, lowcut = 0) {
    this.fb = Math.min(0.97, size); this.damp = Math.min(0.95, damp);
    this.pd = clamp(Math.round(predelay * this.sr), 0, this.pre.length - 1);
    this.hpK = lowcut > 0 ? 1 - Math.exp((-2 * Math.PI * lowcut) / this.sr) : 0;
  }
  run(combs, aps, x) {
    const damp = this.damp, keep = 1 - damp, fb = this.fb;
    let o = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.f = y * keep + c.f * damp;
      c.buf[c.i] = x + c.f * fb;
      if (++c.i >= c.buf.length) c.i = 0;
      o += y;
    }
    for (const a of aps) {
      const b = a.buf[a.i];
      a.buf[a.i] = o + b * 0.5;
      if (++a.i >= a.buf.length) a.i = 0;
      o = b - o;
    }
    return o;
  }
  process(x) {
    if (this.hpK) { this.hp += (x - this.hp) * this.hpK; x -= this.hp; }
    if (this.pd) {
      const pre = this.pre, n = pre.length;
      pre[this.pi] = x;
      let j = this.pi - this.pd;
      if (j < 0) j += n;
      x = pre[j];
      if (++this.pi >= n) this.pi = 0;
    }
    x *= 0.015;
    this.outL = this.run(this.cl, this.al, x);
    this.outR = this.run(this.cr, this.ar, x);
  }
}

export class Synth {
  constructor(sr) {
    this.sr = sr;
    this.tracks = {}; this.list = [];
    this.echo = new Echo(sr); this.reverb = new Reverb(sr); this.bus = new Master(sr);
    this.mix = new Moves(sr, 2); // the effect rows' moves on the whole mix
    this.outL = 0; this.outR = 0;
    this.peakL = 0; this.peakR = 0; // the master's loudest samples since the meters last looked (takePeaks)
    this.mutes = {}; this.solos = {};
    this.pv = null; this.pvQ = []; this.pvI = 0; this.pvT = 0;
    this.kb = null; this.kbJson = null; this.kbHeld = new Map(); this.kbT = 0;
    this.duck = null;
    this.kick = 0; this.kickT = 0; this.kickRel = 0.999; // sidechain envelope: jumps on every kick, recovers
    this.samples = {}; // the sample library, once loaded (Engine.setSamples)
    this.sfx = []; this.sfxGain = 1; // game sounds playing (sfx.js), over the music and its effect rows
    this.dk = 0; this.dkAtt = 1 - Math.exp(-1 / (0.005 * sr)); this.dkRel = 1 - Math.exp(-1 / (0.2 * sr)); // a sound's duck on the music
  }
  // a bus for a sound with `poly` voices (a drum kit: 6): the old one while it fits, else a new one
  busFor(bus, def, poly) {
    const p = compileInst(def, this.sr, this.samples), isDrum = p.type === 'drums', n = isDrum ? 6 : clamp(poly || 1, 1, 16);
    if (!bus || bus.voices.length !== n || bus.isDrum !== isDrum) bus = new TrackBus(n, isDrum);
    bus.p = p;
    return bus;
  }
  // the editor's own buses (the keyboard, the preview): centred, a little echo and reverb, heard now
  audition(bus, def, poly, volume) {
    bus = this.busFor(bus, def, poly);
    bus.set({ volume, echo: 0.08, reverb: 0.25 }, bus.p, this.sr, this.bps);
    bus.g = 1;
    return bus;
  }
  configure(song) {
    const next = {};
    for (const tr of song.tracks) {
      const bus = this.busFor(this.tracks[tr.id], tr.inst, tr.poly);
      bus.set(tr, bus.p, this.sr, song.bpm / 60);
      next[tr.id] = bus;
    }
    this.tracks = next;
    this.list = Object.values(next);
    this.bps = song.bpm / 60;
    const fx = song.fx;
    this.echo.set((fx.echo.beats * 60) / song.bpm, fx.echo.feedback, fx.echo.damp, fx.echo.lowcut);
    this.echoLevel = fx.echo.level;
    this.reverb.set(fx.reverb.size, fx.reverb.damp, fx.reverb.predelay, fx.reverb.lowcut);
    this.kickRel = Math.exp(-1 / (0.3 * (60 / song.bpm) * this.sr)); // the pump recovers over ~a beat
    this.revLevel = fx.reverb.level;
    this.echoToRev = fx.echoToReverb;
    this.master = song.master.gain;
    this.bus.set(song.master.glue ?? 0.5);
    this.updateGains();
  }
  setMute(id, on) { this.mutes[id] = !!on; this.updateGains(); }
  setSolo(id, on) { this.solos[id] = !!on; this.updateGains(); }
  // stinger: every track except `keep` (ids) gets quieter by `amount`; null ends the ducking
  setDuck(keep, amount = 0) { this.duck = keep && amount > 0 ? { keep, amount } : null; this.updateGains(); }
  updateGains() {
    const anySolo = Object.keys(this.tracks).some((id) => this.solos[id]), d = this.duck;
    for (const id in this.tracks) {
      const g = anySolo ? (this.solos[id] ? 1 : 0) : this.mutes[id] ? 0 : 1;
      this.tracks[id].gTarget = d && !d.keep.includes(id) ? g * (1 - d.amount) : g;
    }
  }
  // a track joins (to 1: from silence) or leaves (to 0: its notes stop once it is silent) over sec seconds
  fade(id, to, sec) {
    const b = this.tracks[id];
    if (!b) return;
    if (to > 0 && !b.fadeStep) b.fade = 0;
    b.fadeTo = to;
    b.fadeStep = (to - b.fade) / Math.max(1, sec * this.sr);
  }
  // an effect row's values for a track (its id) or the whole mix ('*'), reached over n samples (Moves.to); null: off
  move(id, v, n) {
    const mv = id === '*' ? this.mix : this.tracks[id]?.mv;
    if (mv) mv.to(v, n, this.bps);
  }
  stopMoves() {
    this.mix = new Moves(this.sr, 2);
    for (const b of this.list) b.mv = new Moves(this.sr);
  }
  // a game sound (a play's settings, sfx.js playOf): on a free voice of 8, else in place of the one playing longest
  sound(p) {
    let v = this.sfx.find((x) => x.done);
    if (!v) {
      if (this.sfx.length < 8) this.sfx.push((v = new SfxVoice(this.sr)));
      else v = this.sfx.reduce((a, b) => (b.t > a.t ? b : a));
    }
    v.start(p, this.samples);
  }
  stopSounds() { for (const v of this.sfx) v.done = true; }
  noteOn(id, midis, vel, short) { this.tracks[id]?.noteOn(midis, vel, short); }
  strike(id, m, s, vel, short, first) { this.tracks[id]?.strike(m, s, vel, short, first); }
  damp(id, keep) { this.tracks[id]?.damp(keep); }
  release(id) { this.tracks[id]?.release(); }
  drum(id, hits, vel) {
    this.tracks[id]?.drum(hits, vel);
    if (hits.includes('k') && this.tracks[id]?.gTarget > 0) this.kickT = Math.max(this.kickT, vel);
  }
  allOff() { for (const b of this.list) b.allOff(); }
  releaseAll() { for (const b of this.list) b.release(); }

  // Live keyboard (editor): a note sounds while its key is down, on a bus of its own like the preview.
  // note: a midi number, or a drum hit ('k', 's' …) for a drum kit. The sound is compiled again only when it changed.
  keyOn(def, note, { volume = 0.3, vel = 0.8 } = {}) {
    const json = JSON.stringify(def);
    if (json !== this.kbJson) {
      this.kb = this.audition(this.kb, def, 8, volume);
      this.kbJson = json;
      this.kbHeld = new Map();
    }
    const kb = this.kb;
    kb.g = 1;
    if (kb.isDrum) return void kb.drum([note], vel);
    this.keyOff(note);
    const v = kb.alloc();
    v.start(kb.p, note, vel, null, false);
    this.kbHeld.set(note, v);
  }
  keyOff(note) {
    const v = this.kbHeld?.get(note);
    if (v?.gate) v.release();
    this.kbHeld?.delete(note);
  }

  // Audition an instrument outside the song (editor). events: [{ t: seconds, notes: [midi] | hit: 'k', dur, vel }]
  // Plays on its own bus that ignores mute/solo, so it works with the song held or playing.
  preview(def, events, { poly = 1, volume = 0.3 } = {}) {
    const was = this.pv;
    this.pv = this.audition(this.pv, def, poly, volume);
    // the last preview's notes let go rather than stop: a hard stop mid-wave clicks (a chord after a chord)
    if (this.pv === was) this.pv.release(); else was?.allOff();
    const q = [];
    for (const ev of events || []) {
      const at = Math.round((ev.t || 0) * this.sr), vel = ev.vel ?? 0.8;
      if (ev.hit) q.push({ at, hit: ev.hit, vel });
      else if (ev.notes?.length) {
        q.push({ at, notes: ev.notes, vel });
        q.push({ at: at + Math.max(1, Math.round((ev.dur ?? 0.4) * this.sr)), off: true });
      }
    }
    // a release scheduled at the same sample as the next note must come first
    this.pvQ = q.sort((a, b) => a.at - b.at || (b.off ? 1 : 0) - (a.off ? 1 : 0));
    this.pvI = 0; this.pvT = 0;
  }

  renderSample() {
    let l = 0, r = 0, e = 0, v = 0;
    this.kickT *= this.kickRel;
    this.kick += (this.kickT - this.kick) * 0.04;
    for (const b of this.list) {
      let x = b.render();
      if (b.pump) x *= 1 - b.pump * this.kick;
      const a = x < 0 ? -x : x;
      if (a > b.peak) b.peak = a;
      if (b.dbl) {
        const c = b.double(x);
        l += x * b.pl + c * b.ql; r += x * b.pr + c * b.qr;
        x = (x + c) * 0.5;
      } else { l += x * b.pl; r += x * b.pr; }
      e += x * (b.echo + b.mv.echo); v += x * (b.rev + b.mv.rev);
    }
    const pv = this.pv;
    if (pv) {
      while (this.pvI < this.pvQ.length && this.pvQ[this.pvI].at <= this.pvT) {
        const ev = this.pvQ[this.pvI++];
        if (ev.off) pv.release();
        else if (ev.hit) pv.drum([ev.hit], ev.vel);
        else pv.noteOn(ev.notes, ev.vel);
      }
      // once the preview has played out, drop its bus so it costs nothing (the echo/reverb tails live on the master)
      if ((++this.pvT & 4095) === 0 && this.pvI === this.pvQ.length && pv.idle()) this.pv = null;
      const x = pv.render();
      l += x * pv.pl; r += x * pv.pr; e += x * pv.echo; v += x * pv.rev; // centred, unless its sound pans itself
    }
    const kb = this.kb;
    if (kb) {
      // idle and no key down: drop the bus so it costs nothing
      if ((++this.kbT & 4095) === 0 && !this.kbHeld.size && kb.idle()) { this.kb = null; this.kbJson = null; }
      const x = kb.render();
      l += x * kb.pl; r += x * kb.pr; e += x * kb.echo; v += x * kb.rev;
    }
    let sl = 0, sr = 0, dk = 0; // the game sounds
    if (this.sfx.length) {
      for (const sv of this.sfx) {
        if (sv.done) continue;
        const x = sv.render() * this.sfxGain;
        sl += x * sv.pl; sr += x * sv.pr; e += x * sv.p.echo; v += x * sv.p.reverb;
        if (sv.p.duck > dk) dk = sv.p.duck;
      }
    }
    this.dk += (dk - this.dk) * (dk > this.dk ? this.dkAtt : this.dkRel);
    this.echo.process(e);
    const el = this.echo.outL, er = this.echo.outR;
    this.reverb.process(v + (el + er) * 0.5 * this.echoToRev);
    const m = this.master, bus = this.bus, mix = this.mix;
    l = (l + el * this.echoLevel + this.reverb.outL * this.revLevel) * m;
    r = (r + er * this.echoLevel + this.reverb.outR * this.revLevel) * m;
    mix.tick();
    if (mix.on) { l = mix.run(l, 0); r = mix.run(r, 1); }
    if (this.dk > 1e-4) { l *= 1 - this.dk; r *= 1 - this.dk; }
    l += sl; r += sr;
    bus.process(l, r);
    const al = bus.l < 0 ? -bus.l : bus.l, ar = bus.r < 0 ? -bus.r : bus.r; // before the soft clip: above 1 it squashes
    if (al > this.peakL) this.peakL = al;
    if (ar > this.peakR) this.peakR = ar;
    this.outL = Math.tanh(bus.l);
    this.outR = Math.tanh(bus.r);
  }

  // the loudest sample of each track and of the master (left, right) since the last call: the editor's meters
  takePeaks() {
    const tracks = {};
    for (const id in this.tracks) { tracks[id] = this.tracks[id].peak; this.tracks[id].peak = 0; }
    const out = { tracks, l: this.peakL, r: this.peakR };
    this.peakL = this.peakR = 0;
    return out;
  }
}
