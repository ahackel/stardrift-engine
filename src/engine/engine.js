// The engine = conductor (decides WHAT plays) + sequencer (WHEN) + synth (HOW it sounds).
// It is a pure function of (song, seed, parameter calls) -> audio samples.

import { Rng } from './rng.js';
import { prepareSong, chordLabel, chordQuality, degSemis, foldDegree, SHAPES, mod } from './theory.js';
import { expandTokens, parseTokens, mutateTokens, nearestTone, fitLength, formTokens, formsOf, variesForm, notesOf, REST, HOLD, NOTE } from './pattern.js';
import { Synth } from './synth.js';
import { FX_KINDS, fxAt, fxJoin, onMix } from './moves.js';
import { playOf, resolveSound } from './sfx.js';
import { autoFade } from './params.js';
import { weightIn, chanceIn } from './plays.js';
import { chordNotes, guitarStrings } from './guitar.js';

const DEFAULT_CHORD = { degree: 0, shape: SHAPES.triad, shapeName: 'triad', beats: 4 };
// an arpeggio that runs the chord on single notes (sound.arpChord), in one voice
const chordArp = (tr) => !!(tr.inst.arpChord && tr.inst.arp && (tr.poly || 1) <= 1);
// the chord that sounds `beat` beats into a list of chords (the last one past its end)
function chordIn(list, beat) {
  for (const c of list) {
    if (beat < c.beats) return c;
    beat -= c.beats;
  }
  return list[list.length - 1];
}
const isFill = (b) => !!b.fill;
const notesKey = (b) => (b ? `${b.beats || 4}:${b.pattern}:${b.mode || ''}` : '');
// how many notes a clip plays per beat (at most 4; a clip playing another's notes: that one's)
const densities = new Map();
function density(b, spb, blocks) {
  const n = notesOf(b, blocks);
  if (!n) return 0;
  const k = `${spb}|${n.pattern}`;
  if (!densities.has(k)) {
    const st = parseTokens(expandTokens(n.pattern));
    densities.set(k, st.length ? Math.min(4, (st.filter((x) => x.t === NOTE).length / st.length) * spb) : 0);
  }
  return densities.get(k);
}
// the same notes (a copy or a renamed clip), whatever its name or colour
const sameNotes = (a, b) => a.pattern === b.pattern && (a.beats || 4) === (b.beats || 4) && (a.mode || '') === (b.mode || '') && (a.from || '') === (b.from || '')
  && formsOf(a).join() === formsOf(b).join();

export class Engine {
  constructor(sampleRate, song, seed = 1) {
    this.sr = sampleRate;
    this.moodName = 'auto';
    this.moodSec = null; // the section a named mood heads for (aimMood)
    this.arrived = false; // the music got to one of the mood's sections since it was asked for
    this.locks = {};
    this.progLock = null;
    this.secLock = null;
    this.meterLen = 0; this.meterT = 0; // setMeters
    this.events = [];
    this.synth = new Synth(sampleRate);
    this.reset(song, seed);
  }

  // ---------------------------------------------------------------- public API
  reset(song, seed) {
    if (seed !== undefined) this.seed = seed >>> 0;
    this.rng = new Rng(this.seed);
    this.vrng = new Rng(this.seed ^ 0x9e3779b9); // velocity humanizing has its own stream: it never changes the arrangement
    this.srng = new Rng(this.seed ^ 0x51ed270b); // so has the game sounds' variation
    this.sfxQ = []; // game sounds waiting for their step or beat: {def, opts, q}
    this.step = 0;
    this.stepTimer = 0;
    this.clock = 0; this.later = []; // samples played; notes waiting to start (lagOf)
    this.section = null;
    this.sectionBar = 0;
    this.sectionBars = 0;
    this.nextSection = null;
    this.forced = null;
    this.forcedProg = null;
    this.prog = null;
    this.progStart = 0;
    this.chord = DEFAULT_CHORD;
    this.liveChord = null;
    this.livePending = null;
    this.leadIn = null; // {sec, start, chord}: the chord that leads into the next section
    this.upcoming = null; // {sec, prog}: next section and its progression, picked one bar early
    this.barsSinceBreath = 0;
    this.breathAt = 0;
    this.flowPos = null; // {mood, i, rep, sec}: where the music is in a mood's flow (or {mood, stop: true})
    this.flowPlan = null; // the same for the section coming next
    this.entered = {}; // the moods whose flow has played: the next time they come in at their loop point
    this.switching = false; // a mood change is on its way: the bar before it ends in a fill
    this.instant = false; // the next section starts afresh: no block carries over (a stinger's mood change)
    this.curSting = null; // {id, pos, len, parts: {trackId: {mode, steps}}, chords, then}
    this.nextSting = null; // {def, q}: starts on the next step divisible by q
    this.chordKey = '';
    this.tracks = {};
    this.history = {};
    this.synth.allOff();
    this.synth.setDuck(null);
    this.synth.stopMoves(); this.moved = null;
    this.setSong(song || this.song.raw);
  }

  // The sample library (src/samples.js: { name: [zones] }) for sample sounds and drum hits; they are silent (or
  // synthesized) until it arrives, so a host can load it in the background.
  setSamples(samples) {
    this.synth.samples = samples || {};
    this.synth.configure(this.song);
  }

  // Hot-swap the song (editor edits) without losing the musical position.
  setSong(raw) {
    this.song = prepareSong(raw);
    this.synth.configure(this.song);
    this.stepLen = (this.sr * 60) / this.song.bpm / this.song.spb;
    if (this.section) this.refresh();
  }

  // "Now make it relaxed" / "now there is tension": a name from song.moods, or 'auto'. The change is always musical:
  // the current section finishes within `within` bars (at a bar line, with a fill), then the music follows the
  // sections' links the shortest way to one of the mood's sections (mood.sections, by weight) and stays among them
  // while the mood holds. A mood without sections leads nowhere: the music walks on.
  setMood(mood, { within = 2 } = {}) {
    if (mood === 'auto' || mood == null) {
      this.moodName = 'auto';
      this.moodSec = null;
      this.log('mood → auto (the music walks on its own)');
      this.emitState();
      return;
    }
    if (!this.song.moods[mood]) return;
    const flow = this.song.flows[mood];
    if (flow) {
      if (mood === this.moodName && this.flowPos?.mood === mood) return;
      this.moodName = mood;
      this.moodSec = null;
      this.switchTo(flow);
      this.emitState();
      return;
    }
    const again = mood === this.moodName;
    this.moodName = mood;
    if (!(again && this.moodSec)) { this.aimMood(); this.arrived = !!this.section && this.inMood(this.section); } // asked again: keep where it heads
    this.log(`mood → ${mood} (${this.moodSec || 'leads nowhere'})`);
    if (this.moodSec) this.hurry(within);
    this.emitState();
  }

  // The section a named mood heads for, picked by its weights (mood.sections; not listed: 0), again each time a section
  // ends while the mood holds
  aimMood() {
    const w = this.song.moods[this.moodName]?.sections, list = w ? this.song.sections.filter((x) => (w[x.id] ?? 0) > 0) : [];
    this.moodSec = list.length ? this.rng.weighted(list, list.map((x) => w[x.id])).id : null;
  }

  // is this one of the sections the mood leads to?
  inMood(sec) {
    return (this.song.moods[this.moodName]?.sections?.[sec.id] ?? 0) > 0;
  }

  // ---------------------------------------------------------------- flows (moods that play sections in order)
  // the flow that leads now: the mood's, or with no mood asked for, the song's first (startMood)
  activeFlow() {
    const f = this.song.flows;
    return f[this.moodName] || (this.moodName === 'auto' ? f[this.song.startMood] : null) || null;
  }

  // where a mood's flow comes in: at its start the first time, at its loop point after that
  entryOf(flow) {
    const i = this.entered[flow.name] ? flow.loopFrom : 0;
    return { mood: flow.name, i, rep: 0, sec: flow.list[i].sec };
  }

  // the place in the flow after pos: the section again (times), the next one, then loop, drift among them, or stop
  flowAfter(pos) {
    const flow = this.song.flows[pos.mood];
    if (!flow || pos.stop) return pos.stop ? pos : null;
    const e = flow.list[pos.i];
    if (e && pos.rep + 1 < e.times) return { ...pos, rep: pos.rep + 1 };
    const i = pos.i + 1;
    if (i < flow.list.length && !pos.drift) return { mood: pos.mood, i, rep: 0, sec: flow.list[i].sec };
    if (flow.then === 'stop') return { mood: pos.mood, stop: true, sec: this.restSection() };
    if (flow.then === 'loop') return { mood: pos.mood, i: flow.loopFrom, rep: 0, sec: flow.list[flow.loopFrom].sec };
    const others = flow.list.map((x, j) => j).filter((j) => flow.list[j].sec !== pos.sec);
    const j = others.length ? this.rng.pick(others) : 0;
    return { mood: pos.mood, i: j, rep: 0, sec: flow.list[j].sec, drift: true };
  }

  // the silence a flow that stops ends in, until another mood is asked for
  restSection() {
    return (this.rest ||= { id: 'end', bars: [1], arranged: true, rest: true, place: {}, chordPlace: [] });
  }

  // A change to a mood with a flow, as soon as it sounds natural: at the next bar line (the bar after, when less than
  // a beat is left), at the next phrase of 4 bars, or when the section ends (flow.switch). The drums fill the bar
  // before it; blocks both sections play carry over (startSection).
  switchTo(flow) {
    const s = this.song, pos = this.entryOf(flow);
    this.flowPlan = pos;
    this.log(`mood → ${flow.name} (${pos.sec.id})`);
    if (!this.section) { this.nextSection = pos.sec; return; }
    if (this.secLock) return; // the editor holds a section: the mood takes over when it lets go
    const spbar = s.stepsPerBar, inBar = this.step % spbar, rem = inBar ? spbar - inBar : 0;
    let k = this.sectionBar + 1 + (rem < s.spb ? 1 : 0); // the bar the new section starts on, counted in this one
    if (flow.switch === 'phrase') k = Math.ceil(k / 4) * 4;
    if (flow.switch === 'section') k = this.sectionBars;
    if (k > this.sectionBars) k = this.sectionBars;
    const line = this.step + rem + (k - this.sectionBar - 1) * spbar; // the step it starts on
    this.sectionBars = k;
    this.nextSection = pos.sec;
    this.switching = true;
    this.seamFill(Math.max(this.step, line - spbar), line);
    if (this.sectionBar === k - 1) this.prepareLeadIn(pos.sec);
  }

  // the drums fill the steps from start to the bar line at end: the tail of a fill block (one the track plays)
  seamFill(start, end) {
    if (end <= start) return;
    const s = this.song;
    for (const tr of s.tracks) {
      const ts = this.tracks[tr.id];
      if (tr.inst.type !== 'drums' || !ts?.active || this.locks[tr.id]) continue;
      const fills = (s.blocksByTrack[tr.id] || []).filter(isFill);
      if (!fills.length) continue;
      const b = this.rng.pick(fills), all = expandTokens(b.pattern, s.stepsPerBar), n = Math.min(end - start, all.length);
      ts.fill = { start: end - n, end, steps: parseTokens(all.slice(all.length - n)) };
      this.log(`fill ${b.id}`);
    }
  }

  // A stinger that changes the mood (then) ends: the music moves its bar line here and starts the mood's section at
  // once, with no fill (the stinger was the way in)
  stingThen(sg) {
    const s = this.song, flow = s.flows[sg.then];
    this.endSting(false);
    const r = this.step % s.stepsPerBar;
    if (r) { // a bar line now: everything counted in steps moves on with it
      const d = s.stepsPerBar - r;
      this.step += d;
      this.progStart += d;
      for (const ts of Object.values(this.tracks)) { ts.start += d; ts.fill = null; }
      this.leadIn = null;
    }
    if (!flow || !this.section) return;
    this.moodName = flow.name;
    this.moodSec = null;
    const pos = this.entryOf(flow);
    this.flowPlan = pos;
    this.nextSection = pos.sec;
    this.forced = null;
    this.sectionBars = this.sectionBar + 1;
    this.instant = true;
    this.log(`mood → ${flow.name} (${pos.sec.id}, at once)`);
  }

  // The editor's playhead, dropped on the grid: the music jumps there at once, to bar `bar` of the section at place i
  // of the mood's flow (the mood leads from then on). Blocks and chords placed before that bar play on from where they
  // would be by then.
  seek(mood, i, bar = 0) {
    const s = this.song, e = s.flows[mood]?.list[i];
    if (!e) return;
    if (this.curSting) this.endSting(false);
    this.moodName = mood;
    this.moodSec = null;
    const r = this.step % s.stepsPerBar;
    if (r) this.step += s.stepsPerBar - r; // it lands on a bar line, now
    for (const tr of s.tracks) {
      const ts = this.tracks[tr.id];
      if (!ts) continue;
      ts.fill = null;
      if (ts.sounding) { this.synth.release(tr.id); ts.sounding = null; }
    }
    this.leadIn = null;
    this.upcoming = null;
    this.switching = false;
    this.flowPlan = { mood, i, rep: 0, sec: e.sec };
    this.forced = e.sec;
    this.nextSection = null;
    this.seekBar = Math.max(0, bar | 0);
    this.instant = true;
    if (this.section) this.sectionBars = this.sectionBar + 1; // onBar starts it
    this.log(`seek → ${mood} · ${e.sec.id} · bar ${this.seekBar + 1}`);
  }

  forceSection(id) {
    const sec = this.song.sectionMap[id];
    if (!sec) return;
    this.forced = sec;
    if (this.section) {
      this.sectionBars = Math.min(this.sectionBars, this.sectionBar + 2);
      if (this.sectionBar >= this.sectionBars - 1) this.nextSection = sec;
    }
    this.log(`forced → ${id} (next bar line)`);
  }

  // Live chord (jamming, or a game moment): replaces the progression's chord from the next beat until
  // released with playChord(null). degree 0-6 in the current scale; shape: triad sus2 sus4 7 add9 six power.
  playChord(degree, shapeName = 'triad') {
    this.livePending = degree === null || degree === undefined
      ? { off: true }
      : { degree: degree | 0, shapeName: SHAPES[shapeName] ? shapeName : 'triad', shape: SHAPES[shapeName] || SHAPES.triad, beats: 4 };
    this.emitState();
  }

  // Switch to a chord progression at the next bar line, once: the next section picks its own again. A held one wins.
  forceProgression(id) {
    this.forcedProg = this.song.progMap[id] || null;
    if (this.forcedProg) this.log(`forced → ${id} (next bar line)`);
  }

  // Hold one chord progression (editor audition / game override). It takes over at the next bar line.
  lockProgression(id) {
    this.progLock = id && this.song.progMap[id] ? id : null;
    this.emitState();
  }

  // Hold one section (editor: stay in the part being worked on). The music moves there at the next bar line, then
  // plays it again each time it ends, whatever mood is asked for. null = back to walking the section graph.
  lockSection(id) {
    this.secLock = id && this.song.sectionMap[id] ? id : null;
    const sec = this.secLock && this.song.sectionMap[this.secLock];
    if (sec && this.section !== sec) this.forceSection(sec.id);
    else if (sec && this.nextSection && this.nextSection !== sec) { this.nextSection = sec; this.prepareLeadIn(sec); }
    this.emitState();
  }

  lock(trackId, blockId) {
    if (blockId) this.locks[trackId] = blockId;
    else delete this.locks[trackId];
    const tr = this.song.trackMap[trackId];
    if (!tr || !this.section) return;
    const ts = this.trackState(tr);
    const b = blockId && this.song.blockMap[blockId];
    if (b) {
      ts.active = true;
      this.startBlock(tr, ts, b);
      ts.start = this.step - (this.step % this.song.stepsPerBar); // keep aligned to the bar
    }
    this.emitState();
  }

  // Stinger: a short phrase for a game event ("discovery", "alert"), played over the music from the next
  // step / beat / half bar / bar (options.at, else the stinger's own `at`). Its parts borrow tracks for a moment
  // and are written like blocks, so a stinger is always in key and in time. While held (editor), it plays at once.
  sting(id, { at } = {}) {
    const s = this.song, def = s.stingMap[id];
    if (!def) return false;
    if (this.nextSting?.def === def) return true; // already waiting for its beat
    const q = { step: 1, beat: s.spb, half: Math.max(1, (s.stepsPerBar / 2) | 0), bar: s.stepsPerBar }[at || def.at] || s.spb;
    this.nextSting = { def, q };
    return true;
  }

  // A game sound (song.sounds, by id; or a sound's own settings): at once, or from the next step or beat (opts.at, else
  // the sound's `at`). opts: { pitch: × (1.2: higher), volume, pan, at }. While held (editor) it plays at once.
  sound(ref, opts = {}) {
    const def = resolveSound(this.song, typeof ref === 'string' ? this.song.soundMap[ref] : ref);
    if (!def || typeof def !== 'object') return false;
    const q = { step: 1, beat: this.song.spb }[opts.at || def.at];
    if (q && !this.hold) this.sfxQ.push({ def, opts, q });
    else this.playSound(def, opts);
    return true;
  }
  playSound(def, opts) { this.synth.sound(playOf(def, this.srng, { bps: this.song.bpm / 60, ...opts }, (m, dir) => this.snap(m, dir))); }
  stopSounds() { this.sfxQ = []; this.synth.stopSounds(); }
  setSoundVolume(v) { this.synth.sfxGain = Math.max(0, +v || 0); }
  // midi m (a fraction too) → the nearest tone of the chord playing (with no chord: of the scale); dir 1: the nearest
  // above m, −1: below
  snap(m, dir = 0) {
    const scale = this.scaleNow(), chord = this.chord, L = scale.length, kr = this.song.keyRoot;
    const pcs = chord.nc ? Array.from({ length: L }, (_, i) => mod(kr + degSemis(scale, i), 12))
      : chord.shape.map((o) => mod(kr + degSemis(scale, foldDegree(chord.degree, L) + o), 12));
    let best = null;
    for (let k = Math.floor(m) - 12; k <= Math.ceil(m) + 12; k++) {
      if (!pcs.includes(mod(k, 12)) || (dir > 0 && k <= m) || (dir < 0 && k >= m)) continue;
      if (best === null || Math.abs(k - m) < Math.abs(best - m)) best = k;
    }
    return best;
  }

  setMute(id, on) { this.synth.setMute(id, on); }
  setSolo(id, on) { this.synth.setSolo(id, on); }

  // hold = the sequencer stands still and song voices fade out, but previews still sound (editor)
  setHold(on) {
    on = !!on;
    if (on && !this.hold) { this.later = []; this.synth.releaseAll(); } // no late notes after the pause
    if (on && this.sfxQ.length) { for (const x of this.sfxQ) this.playSound(x.def, x.opts); this.sfxQ = []; } // the beat they waited for won't come
    this.hold = on;
  }

  preview(inst, events, opts) { this.synth.preview(inst, events, opts); }
  // stop what the editor auditions: the preview phrase and a stinger
  stopPreview() {
    const syn = this.synth;
    syn.pv?.allOff();
    syn.pvQ = [];
    syn.pvI = 0;
    this.nextSting = null;
    this.stopSounds();
    if (this.curSting) this.endSting(this.hold);
  }
  keyOn(inst, note, opts) { this.synth.keyOn(inst, note, opts); }
  keyOff(note) { this.synth.keyOff(note); }

  process(outL, outR, n) {
    const syn = this.synth, later = this.later;
    for (let i = 0; i < n; i++) {
      this.clock++;
      if (later.length) for (let j = 0; j < later.length;) if (later[j].t <= this.clock) later.splice(j, 1)[0].fn(); else j++; // humanized notes, strums: in order
      if (this.hold) {
        if (this.curSting || this.nextSting) { // a stinger still sounds while the song stands still
          if (this.stepTimer <= 0) { this.heldTick(); this.stepTimer += this.stepLen; }
          this.stepTimer -= 1;
        }
      } else {
        if (this.stepTimer <= 0) {
          this.tick();
          const sw = this.song.swing;
          this.stepTimer += this.stepLen * ((this.step - 1) % 2 === 0 ? 1 + sw : 1 - sw);
        }
        this.stepTimer -= 1;
      }
      syn.renderSample();
      outL[i] = syn.outL;
      outR[i] = syn.outR;
    }
    if (this.meterLen && (this.meterT += n) >= this.meterLen) { this.meterT -= this.meterLen; this.emit({ type: 'levels', ...syn.takePeaks() }); }
  }

  // levels events (the loudest sample of each track and of the master) about 30 times a second: the editor's meters
  setMeters(on) { this.meterLen = on ? Math.round(this.sr / 30) : 0; this.meterT = 0; }

  // ---------------------------------------------------------------- sequencer
  tick() {
    const s = this.song;
    if (this.curSting?.then && this.curSting.pos >= this.curSting.len) this.stingThen(this.curSting);
    if (this.step % s.stepsPerBar === 0) this.onBar();

    this.updateSting(false);
    if (this.livePending && this.step % s.spb === 0) {
      this.liveChord = this.livePending.off ? null : this.livePending;
      this.livePending = null;
      this.emitState();
    }
    const li = this.leadIn; // only while its section is still the one coming next (a mood change may have re-routed)
    const chordChanged = this.setChord(this.stingChord() || this.liveChord
      || (li && this.step >= li.start && this.nextSection === li.sec ? li.chord : this.chordAt(this.step)));
    if (this.sfxQ.length) this.sfxQ = this.sfxQ.filter((x) => (this.step % x.q ? true : (this.playSound(x.def, x.opts), false)));

    const pos = {}, sg = this.curSting;
    for (const tr of s.tracks) {
      const part = sg && sg.parts[tr.id];
      if (part) { this.playStep(tr, this.trackState(tr), part.steps[sg.pos], part, chordChanged); continue; }
      const ts = this.tracks[tr.id];
      if (!ts || !ts.active || !ts.steps) continue;
      let steps = ts.steps, p, fill = false;
      if (ts.fill && this.step >= ts.fill.start && this.step < ts.fill.end) {
        steps = ts.fill.steps;
        p = this.step - ts.fill.start;
        fill = true;
      } else {
        if (ts.fill && this.step >= ts.fill.end) ts.fill = null;
        const rel = this.step - ts.start;
        p = mod(rel, steps.length);
        if (p === 0 && rel > 0) {
          this.onBlockLoop(tr, ts);
          steps = ts.steps;
        }
      }
      pos[tr.id] = fill ? -1 - p : p;
      this.playStep(tr, ts, steps[p], ts.block, chordChanged);
    }
    if (sg) sg.pos++;
    this.moveFx();
    const progBeat = this.prog ? (((this.step - this.progStart) / s.spb) % this.prog.totalBeats) : 0;
    this.emit({ type: 'step', step: this.step, bar: this.sectionBar, bars: this.sectionBars, spbar: s.stepsPerBar, pos, progBeat });
    this.step++;
  }

  // The effect rows: each effect block placed in the section moves its setting across the bars it plays (until the
  // next block on its row or the section's end), on the tracks its row targets or the whole mix. Worked out for the
  // end of this step, reached over the step; buses no row moves any more go back. A muted row moves nothing.
  moveFx() {
    const s = this.song, sec = this.section, out = {};
    if (sec?.arranged) {
      const spbar = s.stepsPerBar, inBar = this.step % spbar;
      for (const ft of s.fxTracks) {
        const list = sec.place[ft.id];
        if (!list || this.synth.mutes[ft.id]) continue;
        let i = -1;
        for (let j = 0; j < list.length; j++) if (list[j].at <= this.sectionBar) i = j;
        const p = list[i], fx = p?.block.fx;
        if (!fx || !FX_KINDS[fx.kind]) continue;
        const span = ((list[i + 1]?.at ?? this.sectionBars) - p.at) * spbar, pos = (this.sectionBar - p.at) * spbar + inBar;
        const v = fxAt(fx, (pos + 1) / span, (pos + 1) / s.spb);
        const set = (id, key, val) => { const o = (out[id] ||= {}); o[key] = fxJoin(key, o[key], val); if (key === 'gate' && o.gate === val) { o.rate = fx.rate; o.phase = ((pos / s.spb) / Math.max(0.0625, fx.rate || 0.25)) % 1; } };
        if (ft.mix && onMix(fx.kind)) set('*', fx.kind, v);
        else for (const id of ft.ids) set(id, fx.kind, v);
      }
    }
    const was = this.moved || {};
    for (const id in out) this.synth.move(id, out[id], this.stepLen);
    for (const id in was) if (!out[id]) this.synth.move(id, null, this.stepLen);
    this.moved = out;
  }

  // src = the block (or stinger part) the step comes from: it decides how numbers map to notes
  playStep(tr, ts, st, src, chordChanged) {
    if (!st) return;
    if (st.t === REST) {
      if (ts.sounding) { this.synth.release(tr.id); ts.sounding = null; }
    } else if (st.t === HOLD) {
      // a held note follows the new chord (follow, an arpeggio of the chord); a whole chord stops for N.C.
      const stop = this.chord.nc && this.restsNC(tr, src, ts.sounding?.atoms);
      if (chordChanged && ts.sounding && (tr.follow || chordArp(tr) || stop)) this.play(tr, ts, ts.sounding, true, src);
    } else if (st.prob >= 1 || this.rng.next() < st.prob) {
      this.play(tr, ts, st, false, src);
    } else if (ts.sounding) {
      this.synth.release(tr.id);
      ts.sounding = null;
    }
  }

  // returns whether the chord changed
  setChord(chord) {
    const scaleName = this.prog ? this.prog.scaleName : this.song.scaleName;
    const key = chord.nc ? 'nc' : `${scaleName}:${chord.degree}:${chord.shapeName}`;
    if (key === this.chordKey) return false;
    this.chord = chord;
    this.chordKey = key;
    this.emit({ type: 'chord', label: chordLabel(this.song.keyRoot, this.scaleNow(), chord), scale: scaleName, degree: chord.nc ? undefined : chord.degree, shape: chord.shapeName });
    return true;
  }

  // Dynamics: bar downbeats a bit louder, off-16ths a bit softer, plus a small random spread (song.humanize).
  velocity(base) {
    const s = this.song, inBar = this.step % s.stepsPerBar, inBeat = this.step % s.spb;
    const groove = inBar === 0 ? 1.12 : inBeat === 0 ? 1.04 : inBeat * 2 === s.spb ? 1 : 0.92;
    return Math.min(1, base * groove * (1 + (this.vrng.next() * 2 - 1) * s.humanize));
  }

  play(tr, ts, st, isFollow, src) {
    const vel = this.velocity(st.accent ? 1 : 0.78);
    if (tr.inst.type === 'drums') {
      const hits = [];
      for (const a of st.atoms) if (a.kind === 'hit') hits.push(a.value);
      const v = this.velocity(st.accent ? 1 : st.prob < 1 ? 0.5 : 0.78); // chance hits = ghost notes
      this.at(this.lagOf(tr, hits), () => this.synth.drum(tr.id, hits, v));
      this.emit({ type: 'note', track: tr.id });
      return;
    }
    if (st.atoms.some((a) => a.kind === 'gtr')) return this.strum(tr, ts, st, isFollow, src, vel);
    let midis = this.resolve(tr, src, st.atoms);
    if (!midis.length) { // nothing to play: a whole chord under N.C. (held on, it comes back with the next chord)
      if (isFollow) this.synth.release(tr.id);
      return;
    }
    if (midis.length === 1 && chordArp(tr) && !this.chord.nc) midis = this.chordFrom(midis[0]);
    const short = st.short && !isFollow;
    this.at(isFollow ? 0 : this.lagOf(tr), () => this.synth.noteOn(tr.id, midis, vel, short));
    ts.sounding = st;
    if (!isFollow) this.emit({ type: 'note', track: tr.id, midi: midis[0] });
  }

  scaleNow() { return this.prog ? this.prog.scale : this.song.scale; }

  // The chord playing as a guitar fingers it (guitar.js): six notes, null for a string not played, in the voicing the
  // clip asks for (block.voicing), else the instrument's (guitar.shape), else open chords; at the guitar's pitch on
  // octave 3, an octave higher on 4. Null for no chord (N.C.).
  guitarNotes(tr, block) {
    const chord = this.chord;
    if (chord.nc) return null;
    const scale = this.scaleNow(), root = foldDegree(chord.degree, scale.length);
    const pcs = chord.shape.map((o) => mod(this.song.keyRoot + degSemis(scale, root + o), 12));
    const shape = block?.voicing || notesOf(block, this.song.blockMap)?.voicing || tr.inst.guitar?.shape || 'open';
    return chordNotes(pcs[0], pcs, shape, 12 * ((tr.octave ?? 3) - 3));
  }

  // A step with guitar strokes (D U X B A S1…): the strings it plays, each in its turn of the strum (guitar.strum ms
  // apart, a little uneven; an upstroke softer), numbers and chords with them as notes of their own. A downstroke
  // (and a dead one) damps the strings it leaves out; on a guitar the rest ring on (TrackBus.strike).
  strum(tr, ts, st, isFollow, src, vel) {
    const notes = this.guitarNotes(tr, src);
    if (!notes) { if (isFollow) this.synth.release(tr.id); return; }
    const hits = [];
    let dead = false, down = false;
    for (const a of st.atoms) {
      if (a.kind === 'gtr') {
        for (const x of guitarStrings(notes, a.value)) hits.push({ m: x.m + 12 * a.oct + a.semi, s: x.s, order: x.order, up: a.value === 'U' });
        if (a.value === 'X') dead = true;
        if (a.value === 'D' || a.value === 'X') down = true;
      } else this.resolve(tr, src, [a]).forEach((m) => hits.push({ m, s: 6 + hits.length, order: 0 }));
    }
    if (!hits.length) return;
    const g = tr.inst.guitar, ms = g ? Math.min(60, Math.max(0, g.strum ?? 10)) : 0;
    const gap = (ms * this.sr * (0.8 + 0.4 * this.vrng.next())) / 1000, lag = isFollow ? 0 : this.lagOf(tr);
    const short = dead ? 2 : st.short && !isFollow;
    if (down) { const keep = hits.map((h) => h.s); this.at(lag, () => this.synth.damp(tr.id, keep)); }
    hits.sort((a, b) => a.order - b.order).forEach((h, i) => {
      const v = vel * (h.up ? 0.8 : 1) * (1 - 0.03 * h.order) * (dead ? 0.8 : 1);
      this.at(lag + Math.round(h.order * gap), () => this.synth.strike(tr.id, h.m, h.s, v, short, i === 0));
    });
    ts.sounding = st;
    if (!isFollow) this.emit({ type: 'note', track: tr.id, midi: hits[0].m });
  }

  // A single note on an arpeggio that runs the chord (a tracker's 0xy): the note, then the chord's next tones above
  // it, so the arpeggio starts on the melody and follows the harmony (a triad: three notes, a seventh chord: four)
  chordFrom(m) {
    const scale = this.scaleNow(), chord = this.chord, L = scale.length, root = foldDegree(chord.degree, L);
    const pcs = new Set(chord.shape.map((o) => mod(this.song.keyRoot + degSemis(scale, root + o), 12)));
    const out = [m];
    for (let k = m + 1; k < m + 12 && out.length < chord.shape.length; k++) if (pcs.has(k % 12) && k < 128) out.push(k);
    return out;
  }

  // how a clip's notes follow the harmony: the mode of the clip whose notes it plays, else its own, else the track's
  modeOf(tr, block) { return (block && (notesOf(block, this.song.blockMap)?.mode || block.mode)) || tr.mode || 'chord'; }
  // fit: notes on the beat move to the nearest chord tone (the clip's own setting, else the one whose notes it plays)
  fitOf(block) { return !!block && !!(block.fit ?? notesOf(block, this.song.blockMap)?.fit); }
  // With no chord (N.C.) a whole chord rests, and so does a stack built on the chord (chord or scale mode: a voicing);
  // single notes and stacks in the key play on, over the home chord
  restsNC(tr, block, atoms = []) {
    return atoms.some((a) => a.kind === 'chord' || a.kind === 'gtr') || (this.modeOf(tr, block) !== 'key' && atoms.filter((a) => a.kind === 'num').length > 1);
  }

  resolve(tr, block, atoms) {
    const s = this.song, scale = this.scaleNow(), L = scale.length;
    const chord = this.chord, shape = chord.shape, S = shape.length;
    if (chord.nc && this.restsNC(tr, block, atoms)) return [];
    const base = 12 * ((tr.octave ?? 4) + 1) + s.keyRoot;
    const mode = this.modeOf(tr, block);
    const root = foldDegree(chord.degree, L);
    // fit: notes on a beat move to the nearest chord tone, so a melody in key degrees suits any chord
    const tones = mode !== 'chord' && this.fitOf(block) && this.step % s.spb === 0
      ? shape.map((o) => mod(root + o, L)) : null;
    const out = [];
    for (const a of atoms) {
      let degs;
      if (a.kind === 'chord') degs = shape.map((o) => root + o);
      else if (a.kind === 'num') {
        const n = a.value;
        if (mode === 'chord') {
          const o = Math.floor(n / S);
          degs = [root + shape[n - o * S] + o * L];
        } else {
          const d = mode === 'scale' ? root + n : n;
          degs = [tones && !a.semi ? nearestTone(d, tones, L) : d]; // chromatic notes (# b) stay as written
        }
      } else continue;
      for (const d of degs) {
        const m = base + degSemis(scale, d) + 12 * a.oct + a.semi;
        if (m > 0 && m < 128) out.push(m);
      }
    }
    return out;
  }

  chordAt(step) {
    const p = this.prog;
    if (!p) return DEFAULT_CHORD;
    return chordIn(p.chordList, ((step - this.progStart) / this.song.spb) % p.totalBeats);
  }

  // ---------------------------------------------------------------- conductor
  onBar() {
    if (this.section) this.sectionBar++;
    if (this.section && !this.section.breath) this.barsSinceBreath = this.isThin() ? 0 : this.barsSinceBreath + 1;
    if (!this.section || this.sectionBar >= this.sectionBars) {
      const next = this.forced || this.nextSection || (this.section || (this.activeFlow() && !this.secLock) ? this.chooseNext() : this.song.sectionMap[this.secLock] || this.song.sectionMap[this.song.raw.startSection] || this.song.sections[0]);
      this.forced = null;
      this.startSection(next);
    } else {
      this.midSectionBar();
    }
    if (this.sectionBar === this.sectionBars - 1) this.prepareTransition();
    // a held progression takes over at the next bar line (a new section already picked it)
    if (this.progLock && this.prog?.id !== this.progLock) {
      this.prog = this.song.progMap[this.progLock];
      this.progStart = this.step;
      this.emitState();
    } else if (this.forcedProg && !this.progLock) {
      if (this.prog !== this.forcedProg) { this.prog = this.forcedProg; this.progStart = this.step; }
      this.emitState();
    }
    this.forcedProg = null;
  }

  startSection(sec) {
    const s = this.song, rng = this.rng;
    const prev = this.section, first = !prev;
    this.section = sec;
    this.sectionBar = 0;
    this.sectionBars = Math.max(1, rng.pick(sec.bars) | 0);
    this.nextSection = null;
    this.switching = false;
    // where it is in the flow: as planned, else the section's first place in the flow that leads
    if (this.flowPlan && this.flowPlan.sec === sec) this.flowPos = this.flowPlan;
    else {
      const f = this.activeFlow(), i = f ? f.list.findIndex((e) => e.sec === sec) : -1;
      this.flowPos = i >= 0 ? { mood: f.name, i, rep: 0, sec } : null;
    }
    this.flowPlan = null;
    if (this.flowPos) this.entered[this.flowPos.mood] = true;
    // on the way to a mood's sections, the first time: keep the ones in between short
    if (this.moodSec && this.inMood(sec)) this.arrived = true;
    if (!sec.arranged && !this.secLock && this.moodSec && !this.arrived) {
      this.sectionBars = Math.min(this.sectionBars, Math.max(1, this.song.transitBars));
    }

    const placed = sec.arranged && sec.chordPlace.find((p) => p.at === 0);
    if (placed || !sec.arranged || !this.prog) {
      this.prog = this.upcoming?.sec === sec && this.upcoming.prog ? this.upcoming.prog : this.pickProgression();
      this.progStart = this.step;
    }
    this.upcoming = null;
    this.leadIn = null;
    if (sec.breath) { this.barsSinceBreath = 0; this.breathAt = 0; }

    const at = sec.arranged ? Math.min(this.seekBar || 0, this.sectionBars - 1) : 0, spbar = s.stepsPerBar;
    this.seekBar = 0;
    if (at) { // a seek into the middle: the chords placed last before the bar, from where they would be
      this.sectionBar = at;
      let cp = null;
      for (const x of sec.chordPlace) if (x.at <= at) cp = x;
      if (cp && !this.progLock) { this.prog = cp.prog; this.progStart = this.step - (at - cp.at) * spbar; }
    }
    for (const tr of s.tracks) if (sec.arranged) this.arrangeTrack(tr, true); else this.setupTrack(tr);
    if (at) for (const tr of s.tracks) {
      const ts = this.tracks[tr.id], p = this.placeAt(sec, tr.id, at);
      if (ts?.active && p && ts.block === p.block && !this.locks[tr.id]) ts.start = this.step - (at - p.at) * spbar;
    }
    this.instant = false;

    if (!first && !sec.arranged && this.energy(sec) >= 0.7 && this.energy(sec) >= this.energy(prev)) { // into a lively section: a crash
      for (const tr of s.tracks) if (tr.inst.type === 'drums' && this.tracks[tr.id]?.active) this.synth.drum(tr.id, ['c'], 0.7);
    }
    this.log(`▶ ${sec.id} · ${this.sectionBars} bars · ${this.prog ? this.prog.id : '—'}`);
    this.emitState();
  }

  trackState(tr) {
    return (this.tracks[tr.id] ||= { active: false, block: null, steps: null, sounding: null, fill: null, loop: 0, start: 0 });
  }

  setupTrack(tr) {
    const ts = this.trackState(tr), was = ts.active;
    ts.fill = null;
    const lock = this.locks[tr.id] && this.song.blockMap[this.locks[tr.id]];
    let active = lock ? true : this.decideActive(tr);
    if (active) {
      const b = lock || this.pickBlock(tr, ts);
      if (b) this.startBlock(tr, ts, b);
      else active = false;
    }
    const fade = this.fadeSec(tr);
    if (active && !was) this.synth.fade(tr.id, 1, fade); // joins: fades in (or, at 0, stops a fade out)
    if (!active && ts.sounding && !this.curSting?.parts[tr.id]) { // a stinger's note plays on
      if (fade) this.synth.fade(tr.id, 0, fade); else this.synth.release(tr.id);
      ts.sounding = null;
    }
    ts.active = active;
  }

  // A track in an arranged section, at its start (start) or at a bar: the block placed there starts (at the start, one
  // that already plays goes on, unless the section starts afresh); no block placed yet: the track rests.
  arrangeTrack(tr, start) {
    const ts = this.trackState(tr), was = ts.active;
    const lock = this.locks[tr.id] && this.song.blockMap[this.locks[tr.id]];
    if (lock) { if (start) { ts.fill = null; if (ts.block !== lock || !was) this.startBlock(tr, ts, lock); ts.active = true; } return; }
    const p = this.placeAt(this.section, tr.id, this.sectionBar);
    if (!start && (!p || p.at !== this.sectionBar)) return; // nothing new on this bar
    if (start && !this.switching) ts.fill = null;
    let active = !!p;
    if (p && !(start && was && ts.block === p.block && ts.steps && !this.instant)) this.startBlock(tr, ts, p.block);
    const fade = this.fadeSec(tr);
    if (active && !was) this.synth.fade(tr.id, 1, fade);
    if (!active && ts.sounding && !this.curSting?.parts[tr.id]) {
      if (fade) this.synth.fade(tr.id, 0, fade); else this.synth.release(tr.id);
      ts.sounding = null;
    }
    ts.active = active;
  }

  // the block placed on a track that plays at a bar of an arranged section (the last one placed at or before it)
  placeAt(sec, trackId, bar) {
    let p = null;
    for (const x of sec.place?.[trackId] || []) if (x.at <= bar) p = x;
    return p;
  }

  // how long a track takes to join or leave, in seconds: pads and other sustained sounds (chords, a slow attack) fade
  // over a bar, the rest start and stop on the beat; tr.fade (bars) sets it
  fadeSec(tr) {
    const bars = tr.fade ?? autoFade(tr.inst, tr.poly);
    return (bars * this.song.stepsPerBar * this.stepLen) / this.sr;
  }

  // timing humanize: a note a little late, never early (its step is now): drum hits on the beat nearly exact, hats
  // looser, melodic notes and chords more; song.humanize scales it (0: none). In samples.
  lagOf(tr, hits) {
    const h = Math.min(2, this.song.humanize * 10);
    if (!h) return 0;
    const ms = hits ? (hits.every((x) => x === 'h' || x === 'o' || x === 'm') ? 6 : 1.5) : (tr.poly || 1) > 1 ? 10 : 6;
    return Math.round((this.vrng.next() * ms * h * this.sr) / 1000);
  }
  // play now, or `lag` samples from now
  at(lag, fn) { if (lag > 0) this.later.push({ t: this.clock + lag, fn }); else fn(); }

  // the track's chance in the section (section.tracks, else always)
  decideActive(tr) { return this.rng.chance(chanceIn(this.section, tr.id)); }

  blockLen(b) { return Math.max(1, Math.round((b.beats || 4) * this.song.spb)); }

  startBlock(tr, ts, b) {
    ts.block = b;
    ts.start = this.step;
    ts.loop = 0;
    const len = this.blockLen(b);
    ts.base = this.notesFor(tr, b, len);
    ts.tokens = ts.base;
    ts.steps = parseTokens(ts.tokens);
    const h = (this.history[tr.id] ||= []);
    h.push(b.id);
    if (h.length > 4) h.shift();
  }

  // One of the track's clips by its weight in the section (a fill: in either of secs, the sections of a transition).
  // None weighs anything there: null, the track rests.
  pickBlock(tr, ts, { fill = false, secs = [this.section] } = {}) {
    const hist = this.history[tr.id] || [], cands = [], weights = [];
    for (const b of this.song.blocksByTrack[tr.id] || []) {
      if (isFill(b) !== fill) continue;
      let w = Math.max(...secs.map((sec) => weightIn(b, sec)));
      if (!(w > 0)) continue;
      if (ts.block && b.id === ts.block.id) w *= tr.stickiness ?? 1.5;
      else if (hist.includes(b.id)) w *= 0.6;
      cands.push(b); weights.push(w);
    }
    return cands.length ? this.rng.weighted(cands, weights) : null;
  }

  onBlockLoop(tr, ts) {
    ts.loop++;
    const b = ts.block;
    if (variesForm(b) && this.rng.chance(0.5)) ts.base = this.notesFor(tr, b, ts.base.length);
    const v = this.section.variation ?? this.song.variation;
    ts.tokens = (b.mutate ?? 1) > 0 && this.rng.chance(v) ? mutateTokens(ts.base, this.rng, tr.inst.type === 'drums', b.mutate ?? 1) : ts.base;
    ts.steps = parseTokens(ts.tokens);
    this.emit({ type: 'tokens', track: tr.id, tokens: ts.tokens });
  }

  // A clip's notes: its own, or another clip's (b.from), in one of its forms (b.forms), picked anew when the clip
  // starts and, half the time, when it loops. A clip playing them as written plays its pattern as before.
  notesFor(tr, b, len) {
    const src = notesOf(b, this.song.blockMap);
    this.trackState(tr).notesKey = notesKey(src); // an edit of those notes plays them again (refresh)
    if (!src) return fitLength([], len);
    const varies = variesForm(b);
    if (src === b && !varies) return expandTokens(b.pattern, len);
    const forms = formsOf(b), form = varies ? this.rng.pick(forms) : 'whole';
    this.log(`♪ ${form}${src !== b ? ` of ${src.id}` : ''} on ${tr.id}`);
    return fitLength(formTokens(expandTokens(src.pattern, this.blockLen(src)), form, this.rng), len);
  }

  midSectionBar() {
    const s = this.song, rng = this.rng;
    if (this.section.arranged) { // the grid: what is placed on this bar starts
      for (const tr of s.tracks) this.arrangeTrack(tr, false);
      const cp = this.section.chordPlace.find((p) => p.at === this.sectionBar);
      if (cp && !this.progLock) { this.prog = cp.prog; this.progStart = this.step; }
      this.emitState();
      return;
    }
    let changed = false;
    const churn = this.sectionBar % 4 === 0;
    for (const tr of s.tracks) {
      const ts = this.tracks[tr.id];
      if (!ts || this.locks[tr.id]) continue;
      // occasional layer in/out every 4 bars keeps long sections alive
      const c = chanceIn(this.section, tr.id);
      if (churn && c > 0 && c < 1 && rng.chance(s.layerChurn)) { // a track that plays sometimes draws again
        const was = ts.active;
        this.setupTrack(tr);
        if (was !== ts.active) {
          changed = true;
          this.log(`${ts.active ? '+' : '−'} ${tr.id}`);
        }
        continue;
      }
      if (!ts.active || !ts.steps) continue;
      if ((this.step - ts.start) % ts.steps.length !== 0) continue;
      if (rng.chance(this.section.change ?? s.blockChange)) {
        const b = this.pickBlock(tr, ts);
        if (b && b !== ts.block) { this.startBlock(tr, ts, b); changed = true; }
      }
    }
    if (changed) this.emitState();
  }

  // Last bar of a section: choose where to go, and dress the transition (fill / drop).
  prepareTransition() {
    const s = this.song, rng = this.rng;
    let next = this.forced || this.nextSection || this.chooseNext();
    if (this.section.arranged || next.arranged) { // the grid: fills are placed, or come with a mood change (switchTo)
      this.nextSection = next;
      this.prepareLeadIn(next);
      this.log(`next → ${next.id}`);
      this.emitState();
      return;
    }
    if (!this.forced && this.shouldBreathe()) next = this.makeBreath(next);
    this.nextSection = next;
    this.prepareLeadIn(next);
    const up = this.energy(next) - this.energy(this.section);
    for (const tr of s.tracks) {
      const ts = this.tracks[tr.id];
      if (tr.inst.type !== 'drums' || !ts || !ts.active || this.locks[tr.id]) continue;
      if (next.breath || (up < -0.25 && rng.chance(0.4))) { // into a breather the drums always drop out
        ts.fill = { start: this.step, end: this.step + s.stepsPerBar, steps: parseTokens(expandTokens('', s.stepsPerBar)) };
        this.log('drop');
        continue;
      }
      let p = s.fillChance;
      if (next !== this.section) p += 0.3;
      if (up > 0.15) p = 1;
      if (!rng.chance(p)) continue;
      const b = this.pickBlock(tr, ts, { fill: true, secs: up < -0.1 ? [next] : [this.section, next] });
      if (!b) continue;
      const len = Math.min(this.blockLen(b), s.stepsPerBar);
      const end = this.step + s.stepsPerBar;
      ts.fill = { start: end - len, end, steps: parseTokens(expandTokens(b.pattern, len)) };
      this.log(`fill ${b.id}`);
    }
    this.log(`next → ${next.id}`);
    this.emitState();
  }

  // ---------------------------------------------------------------- stingers
  // start a pending stinger on its beat (held: at once), end a finished one
  updateSting(held) {
    if (this.curSting && this.curSting.pos >= this.curSting.len) this.endSting(held);
    const p = this.nextSting;
    if (!p || !(held || this.step % p.q === 0)) return;
    this.nextSting = null;
    if (this.curSting) this.endSting(held);
    const s = this.song, def = p.def, len = Math.max(1, Math.round(def.beats * s.spb));
    const parts = {};
    for (const pt of def.parts) parts[pt.track] = { mode: pt.mode, steps: parseTokens(expandTokens(pt.pattern, len)) };
    this.curSting = { id: def.id, pos: 0, len, parts, chords: def.chordList.length ? def.chordList : null, then: held ? null : def.then };
    this.synth.setDuck(Object.keys(parts), def.duck);
    this.log(`✦ ${def.id}`);
    this.emit({ type: 'sting', id: def.id, on: true });
  }

  endSting(held) {
    const sg = this.curSting;
    this.curSting = null;
    this.synth.setDuck(null);
    for (const id in sg.parts) {
      const tr = this.song.trackMap[id], ts = this.tracks[id];
      if (!tr || !ts) continue;
      if (ts.sounding) { this.synth.release(id); ts.sounding = null; }
      if (!held && ts.active && ts.steps && !ts.fill) this.resumeBlock(tr, ts);
    }
    this.emit({ type: 'sting', id: sg.id, on: false });
  }

  // A track the stinger borrowed picks its block up again: a note held across the stinger's end sounds again.
  resumeBlock(tr, ts) {
    const n = ts.steps.length, p = mod(this.step - ts.start, n);
    if (ts.steps[p].t !== HOLD) return;
    for (let i = 1; i < n; i++) {
      const st = ts.steps[mod(p - i, n)];
      if (st.t === REST) return;
      if (st.t !== HOLD) { this.play(tr, ts, st, true, ts.block); return; }
    }
  }

  stingChord() {
    const sg = this.curSting;
    if (!sg || !sg.chords) return null;
    return chordIn(sg.chords, sg.pos / this.song.spb);
  }

  // held (editor audition): only the stinger's parts play, over the chord the song stopped on
  heldTick() {
    this.updateSting(true);
    const sg = this.curSting;
    if (!sg) return;
    const c = this.stingChord(), changed = c ? this.setChord(c) : false;
    for (const id in sg.parts) {
      const tr = this.song.trackMap[id];
      if (tr) this.playStep(tr, this.trackState(tr), sg.parts[id].steps[sg.pos], sg.parts[id], changed);
    }
    sg.pos++;
  }

  // Breathers: every so often (song.breath.every bars) the music thins out to its ambient tracks for a few bars, then
  // grows back. Only while things are calm.
  shouldBreathe() {
    const b = this.song.breath;
    if (!b || !(b.every > 0) || this.section.breath || this.section.arranged || this.secLock) return false;
    if (!this.breathAt) this.breathAt = Math.round(b.every * this.rng.range(0.75, 1.25));
    if (this.barsSinceBreath < this.breathAt) return false;
    return this.energy(this.section) < 0.7 && (!this.moodSec || this.inMood(this.section)); // not on the way to a mood
  }

  // How lively a section is, 0–1 (the song's liveliest: 1): the notes per beat its tracks play there, by their chance
  // and their clips' weights, drums counting more. Going up: a fill or a crash; going down, the drums may drop out.
  energy(sec) {
    let e = this.energies;
    if (e?.song !== this.song) {
      const by = new Map(this.song.sections.map((x) => [x, this.notesIn(x)]));
      e = this.energies = { song: this.song, by, max: Math.max(1e-9, ...by.values()) };
    }
    return (e.by.get(sec) ?? this.notesIn(sec)) / e.max;
  }

  notesIn(sec) {
    const s = this.song;
    if (sec.arranged) return s.tracks.reduce((a, tr) => { const b = sec.place[tr.id]?.[0]?.block; return a + (b ? density(b, s.spb, s.blockMap) * (tr.inst.type === 'drums' ? 1.5 : 1) : 0); }, 0);
    return s.tracks.reduce((a, tr) => {
      const loops = (s.blocksByTrack[tr.id] || []).filter((b) => !b.fill && weightIn(b, sec) > 0);
      const w = loops.reduce((q, b) => q + weightIn(b, sec), 0);
      const d = w ? loops.reduce((q, b) => q + weightIn(b, sec) * density(b, s.spb, s.blockMap), 0) / w : 0;
      return a + chanceIn(sec, tr.id) * d * (tr.inst.type === 'drums' ? 1.5 : 1);
    }, 0);
  }

  // a track a breather keeps: breath.keep, else the ones that always play in the calmest section
  breathes(tr) {
    const s = this.song, keep = s.breath?.keep;
    if (keep) return keep.includes(tr.id);
    const calm = s.sections.reduce((a, x) => (this.energy(x) < this.energy(a) ? x : a));
    return chanceIn(calm, tr.id) >= 1;
  }

  // Already about as sparse as a breather (no drums, at most one track beyond those a breather keeps)?
  // Then it counts as one, so a breakdown isn't followed by a breather.
  isThin() {
    let extra = 0;
    for (const tr of this.song.tracks) {
      if (!this.tracks[tr.id]?.active || this.breathes(tr)) continue;
      if (tr.inst.type === 'drums' || ++extra > 1) return false;
    }
    return true;
  }

  makeBreath(resume) {
    const s = this.song, cur = this.section;
    const tracks = {};
    for (const tr of s.tracks) tracks[tr.id] = this.breathes(tr) ? 1 : 0;
    this.log(`breather, then ${resume.id}`);
    return {
      id: 'breather', breath: true, bars: s.breath.bars || [4, 8], base: cur.base ?? cur.id, tracks, // its clips: those of the section it interrupts
      next: { ...(resume.next || {}), [resume.id]: 4 },
    };
  }

  // Pick the next section's progression now, and let the last beats of this section lead into its first chord:
  // V of it when that is a major chord (G → C), otherwise the major chord a step below (C → Dm in D dorian).
  prepareLeadIn(next) {
    const s = this.song;
    const prog = this.pickProgression(next);
    this.upcoming = { sec: next, prog };
    this.leadIn = null;
    const beats = s.leadIn;
    if (!beats || !prog || next.breath || this.section.breath || this.progLock || this.liveChord) return;
    const first = prog.chordList[0];
    if (first.nc) return; // no chord to lead into
    const scale = this.scaleNow(), t = first.degree;
    let a = t + 4;
    if (chordQuality(scale, a) !== 'maj' && chordQuality(scale, t - 1) === 'maj') a = t - 1;
    a = mod(a, scale.length);
    const dominant7 = a === ((t + 4) % scale.length) && degSemis(scale, a + 6) - degSemis(scale, a) === 10;
    const shapeName = dominant7 ? '7' : 'triad';
    const start = this.step - (this.step % s.stepsPerBar) + s.stepsPerBar - Math.round(beats * s.spb);
    if (start <= this.step || this.chordAt(start).degree === a) return;
    this.leadIn = { sec: next, start, chord: { degree: a, shapeName, shape: SHAPES[shapeName], beats } };
  }

  // the links out of a section: [section, weight]; a section with none goes on to any
  linksOf(sec) {
    const s = this.song;
    const list = Object.entries(sec.next || {}).filter(([id, w]) => s.sectionMap[id] && w > 0).map(([id, w]) => [s.sectionMap[id], +w]);
    return list.length ? list : s.sections.map((x) => [x, 1]);
  }

  // how many sections it takes from each section to `goal` along the links (goal: 0; no way there: not in the map)
  stepsTo(goal) {
    if (this.routes?.goal === goal) return this.routes.d;
    const d = new Map([[goal, 0]]);
    for (let k = 0, grew = true; grew; k++) {
      grew = false;
      for (const x of this.song.sections) if (!d.has(x) && this.linksOf(x).some(([y]) => d.get(y) === k)) { d.set(x, k + 1); grew = true; }
    }
    this.routes = { goal, d };
    return d;
  }

  chooseNext() {
    const s = this.song, cur = this.section;
    if (this.secLock && s.sectionMap[this.secLock]) return s.sectionMap[this.secLock];
    const flow = this.activeFlow();
    if (flow) { // a flow: the next place in it (a section it doesn't know: its start)
      const pos = (this.flowPos?.mood === flow.name && this.flowAfter(this.flowPos)) || this.entryOf(flow);
      this.flowPlan = pos;
      return pos.sec;
    }
    if (this.moodSec) this.aimMood(); // while a mood holds, it picks again among its sections
    const list = this.linksOf(cur), goal = this.moodSec && s.sectionMap[this.moodSec];
    if (!goal) return this.rng.weighted(list.map((x) => x[0]), list.map((x) => x[1]));
    // on the way to a mood: the links that take the fewest sections to get there (by weight); none gets there: straight there
    const d = this.stepsTo(goal), best = Math.min(...list.map(([x]) => d.get(x) ?? Infinity));
    if (best === Infinity) return goal;
    const near = list.filter(([x]) => d.get(x) === best);
    return this.rng.weighted(near.map((x) => x[0]), near.map((x) => x[1]));
  }

  // A mood asked for while the music is elsewhere: end the current section within `within` bars
  hurry(within) {
    if (!this.section || this.secLock || this.inMood(this.section)) return;
    const end = this.sectionBar + 1 + Math.max(0, within | 0);
    if (end < this.sectionBars) this.sectionBars = end;
    if (this.sectionBar === this.sectionBars - 1) { this.nextSection = this.chooseNext(); this.prepareLeadIn(this.nextSection); }
    this.emitState();
  }

  pickProgression(sec = this.section) {
    const s = this.song;
    if (!s.progressions.length) return null;
    if (this.progLock && s.progMap[this.progLock]) return s.progMap[this.progLock];
    if (sec.arranged) { const p = sec.chordPlace.find((x) => x.at === 0); if (p) return p.prog; }
    // by weight in the section; none weighs anything there: any of them (the chords have to come from somewhere)
    let list = s.progressions.filter((p) => weightIn(p, sec) > 0);
    const any = !list.length;
    if (any) list = s.progressions;
    const w = list.map((p) => (any ? 1 : weightIn(p, sec)) * (this.prog && p.id === this.prog.id ? s.progStickiness : 1));
    return this.rng.weighted(list, w);
  }

  // Re-link runtime state after a hot song edit.
  refresh() {
    const s = this.song;
    const sec = s.sectionMap[this.section.id];
    if (sec) this.section = sec;
    else if (!this.section.breath) { this.section = { ...this.section }; this.sectionBars = this.sectionBar + 1; }
    if (this.nextSection && !this.nextSection.breath) this.nextSection = s.sectionMap[this.nextSection.id] || null;
    this.upcoming = null; // progressions may have changed; startSection picks again
    this.leadIn = null;
    if (this.prog) this.prog = s.progMap[this.prog.id] || this.pickProgression();
    this.chordKey = '';
    for (const id of Object.keys(this.tracks)) {
      const ts = this.tracks[id], tr = s.trackMap[id];
      if (!tr) { delete this.tracks[id]; continue; }
      if (!ts.block) continue;
      let b = s.blockMap[ts.block.id];
      // a clip renamed, or swapped for a copy of its own (make unique), plays on
      if (!b || !s.blocksByTrack[id]?.includes(b)) b = s.blocksByTrack[id]?.find((x) => sameNotes(x, ts.block));
      if (!b) {
        ts.block = null; ts.active = false; ts.steps = null;
        if (ts.sounding) { this.synth.release(id); ts.sounding = null; }
        continue;
      }
      const len = this.blockLen(b);
      ts.block = b;
      if (b.from || variesForm(b)) { if (!ts.base || ts.base.length !== len || ts.notesKey !== notesKey(notesOf(b, s.blockMap))) ts.base = this.notesFor(tr, b, len); }
      else ts.base = expandTokens(b.pattern, len);
      ts.tokens = ts.base;
      ts.steps = parseTokens(ts.tokens);
    }
    for (const [id, b] of Object.entries(this.locks)) if (!s.blockMap[b]) delete this.locks[id];
    const relink = (pos) => { if (!pos || pos.stop) return pos; const f = s.flows[pos.mood], e = f?.list[pos.i]; return e ? { ...pos, sec: e.sec } : null; };
    this.flowPos = relink(this.flowPos);
    this.flowPlan = relink(this.flowPlan);
    if (this.section.arranged) { // a new length counts at once (unless a mood change is on its way)
      if (!this.switching && this.sectionBar < this.sectionBars - 1) this.sectionBars = Math.max(this.sectionBar + 1, this.section.bars[0]);
      this.rearrange();
    }
    if (this.nextSting) this.nextSting.def = s.stingMap[this.nextSting.def.id] || null;
    if (!this.nextSting?.def) this.nextSting = null;
    if (this.progLock && !s.progMap[this.progLock]) this.progLock = null;
    this.emitState();
  }

  // An edit of the arranged section that plays: each track plays what is placed on this bar now, in time with where
  // it was placed (a block dropped here sounds at once)
  rearrange() {
    const s = this.song, sec = this.section, spbar = s.stepsPerBar;
    const bar = this.step % spbar === 0 ? this.sectionBar + 1 : this.sectionBar, lineStep = this.step - (this.step % spbar || spbar);
    if (bar >= this.sectionBars) return;
    for (const tr of s.tracks) {
      if (this.locks[tr.id]) continue;
      const ts = this.trackState(tr), p = this.placeAt(sec, tr.id, bar);
      if (!p) {
        if (ts.active) { ts.active = false; if (ts.sounding) { this.synth.release(tr.id); ts.sounding = null; } }
        continue;
      }
      if (ts.active && ts.block === p.block) continue;
      this.startBlock(tr, ts, p.block);
      ts.start = (this.step % spbar === 0 ? this.step : lineStep) - (bar - p.at) * spbar;
      if (!ts.active) this.synth.fade(tr.id, 1, 0);
      ts.active = true;
    }
  }

  // ---------------------------------------------------------------- events for UIs
  emit(e) { if (this.events.length < 512) this.events.push(e); }
  log(text) { this.emit({ type: 'log', text, step: this.step }); }

  emitState() {
    const s = this.song;
    const tracks = {};
    for (const tr of s.tracks) {
      const ts = this.tracks[tr.id];
      tracks[tr.id] = ts
        ? { active: ts.active, block: ts.block && ts.block.id, tokens: ts.tokens, locked: this.locks[tr.id] || null, fill: !!ts.fill }
        : { active: false };
    }
    this.emit({
      type: 'state',
      section: this.section && this.section.id,
      sectionBar: this.sectionBar,
      sectionBars: this.sectionBars,
      next: this.nextSection && this.nextSection.id,
      prog: this.prog && this.prog.id,
      progLocked: this.progLock,
      secLocked: this.secLock,
      live: this.liveChord && { degree: this.liveChord.degree, shape: this.liveChord.shapeName },
      livePending: this.livePending ? (this.livePending.off ? -1 : this.livePending.degree) : null, // -1 = release pending
      chords: this.prog ? this.prog.chordList.map((c) => chordLabel(s.keyRoot, this.prog.scale, c)) : [],
      scale: this.prog ? this.prog.scaleName : s.scaleName,
      energy: this.section ? this.energy(this.section) : 0,
      mood: this.moodName,
      heading: this.moodSec,
      flow: this.flowPos && { mood: this.flowPos.mood, i: this.flowPos.i ?? -1, rep: this.flowPos.rep ?? 0, stop: !!this.flowPos.stop },
      tracks,
    });
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }
}
