// The engine = conductor (decides WHAT plays) + sequencer (WHEN) + synth (HOW it sounds).
// It is a pure function of (song, seed, parameter calls) -> audio samples.

import { Rng } from './rng.js';
import { prepareSong, chordLabel, degSemis, foldDegree, SHAPES } from './theory.js';
import { expandTokens, parseTokens, generateTokens, mutateTokens, REST, HOLD } from './pattern.js';
import { Synth } from './synth.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const DEFAULT_CHORD = { degree: 0, shape: SHAPES.triad, shapeName: 'triad', beats: 4 };
const isFill = (b) => !!b.tags && b.tags.includes('fill');

function rangeFit(v, r) {
  if (!r) return 1;
  const lo = r[0] ?? 0, hi = r[1] ?? 1;
  if (v >= lo && v <= hi) return 1;
  const d = v < lo ? lo - v : v - hi;
  return Math.max(0.01, Math.exp(-(d * d) / (2 * 0.07 * 0.07)));
}

export class Engine {
  constructor(sampleRate, song, seed = 1) {
    this.sr = sampleRate;
    this.target = { intensity: 0.3, tension: 0.2, influence: 0 };
    this.moodName = 'auto';
    this.locks = {};
    this.progLock = null;
    this.events = [];
    this.synth = new Synth(sampleRate);
    this.reset(song, seed);
  }

  // ---------------------------------------------------------------- public API
  reset(song, seed) {
    if (seed !== undefined) this.seed = seed >>> 0;
    this.rng = new Rng(this.seed);
    this.step = 0;
    this.stepTimer = 0;
    this.section = null;
    this.sectionBar = 0;
    this.sectionBars = 0;
    this.nextSection = null;
    this.forced = null;
    this.prog = null;
    this.progStart = 0;
    this.chord = DEFAULT_CHORD;
    this.chordKey = '';
    this.intensity = 0.2;
    this.tension = 0.1;
    this.goal = { intensity: 0.2, tension: 0.1 };
    this.tracks = {};
    this.history = {};
    this.synth.allOff();
    this.setSong(song || this.song.raw);
  }

  // Hot-swap the song (editor edits) without losing the musical position.
  setSong(raw) {
    this.song = prepareSong(raw);
    this.synth.configure(this.song);
    this.synth.setMood(this.intensity, this.tension);
    this.stepLen = (this.sr * 60) / this.song.bpm / this.song.spb;
    if (this.section) this.refresh();
  }

  // Low-level: continuous game parameters. influence 0 = fully autonomous, 1 = follow target.
  setParams({ intensity, tension, influence, urgent, within } = {}) {
    const t = this.target;
    if (intensity !== undefined) t.intensity = clamp01(+intensity);
    if (tension !== undefined) t.tension = clamp01(+tension);
    if (influence !== undefined) t.influence = clamp01(+influence);
    if (urgent) this.hurry(within ?? 1);
  }

  // High-level: "now make it relaxed" / "now there is tension".
  // mood = name from song.moods, or {intensity, tension}. The change is always musical:
  // the current section finishes within `within` bars (at a bar line, with a fill), the conductor
  // walks the section graph toward the mood, and intensity/tension/filters glide over several bars.
  setMood(mood, { within = 2 } = {}) {
    if (mood === 'auto' || mood == null) {
      this.moodName = 'auto';
      this.target.influence = 0;
      this.log('mood → auto (autonomous drift)');
      return;
    }
    const m = typeof mood === 'string' ? this.song.moods[mood] : mood;
    if (!m) return;
    this.moodName = typeof mood === 'string' ? mood : 'custom';
    this.target.intensity = clamp01(m.intensity ?? this.target.intensity);
    this.target.tension = clamp01(m.tension ?? this.target.tension);
    this.target.influence = clamp01(m.influence ?? 1);
    this.log(`mood → ${this.moodName} (I ${this.target.intensity.toFixed(2)}, T ${this.target.tension.toFixed(2)})`);
    this.hurry(within);
    this.emitState();
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

  // Hold one chord progression (editor audition / game override). It takes over at the next bar line.
  lockProgression(id) {
    this.progLock = id && this.song.progMap[id] ? id : null;
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

  setMute(id, on) { this.synth.setMute(id, on); }
  setSolo(id, on) { this.synth.setSolo(id, on); }

  // hold = the sequencer stands still and song voices fade out, but previews still sound (editor)
  setHold(on) {
    on = !!on;
    if (on && !this.hold) this.synth.releaseAll();
    this.hold = on;
  }

  preview(inst, events, opts) { this.synth.preview(inst, events, opts); }

  process(outL, outR, n) {
    const syn = this.synth;
    for (let i = 0; i < n; i++) {
      if (this.hold) {
        syn.renderSample();
        outL[i] = syn.outL;
        outR[i] = syn.outR;
        continue;
      }
      if (this.stepTimer <= 0) {
        this.tick();
        const sw = this.song.swing;
        this.stepTimer += this.stepLen * ((this.step - 1) % 2 === 0 ? 1 + sw : 1 - sw);
      }
      this.stepTimer -= 1;
      syn.renderSample();
      outL[i] = syn.outL;
      outR[i] = syn.outR;
    }
  }

  // ---------------------------------------------------------------- sequencer
  tick() {
    const s = this.song;
    if (this.step % s.stepsPerBar === 0) {
      this.onBar();
      if (this.progLock && this.prog?.id !== this.progLock && s.progMap[this.progLock]) {
        this.prog = s.progMap[this.progLock];
        this.progStart = this.step;
        this.emitState();
      }
    }

    const chord = this.chordAt(this.step);
    const scaleName = this.prog ? this.prog.scaleName : s.scaleName;
    const key = `${scaleName}:${chord.degree}:${chord.shapeName}`;
    const chordChanged = key !== this.chordKey;
    if (chordChanged) {
      this.chord = chord;
      this.chordKey = key;
      this.emit({ type: 'chord', label: chordLabel(s.keyRoot, this.scaleNow(), chord), scale: scaleName });
    }

    const pos = {};
    for (const tr of s.tracks) {
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
        p = ((rel % steps.length) + steps.length) % steps.length;
        if (p === 0 && rel > 0) {
          this.onBlockLoop(tr, ts);
          steps = ts.steps;
        }
      }
      pos[tr.id] = fill ? -1 - p : p;
      const st = steps[p];
      if (!st) continue;
      if (st.t === REST) {
        if (ts.sounding) { this.synth.release(tr.id); ts.sounding = null; }
      } else if (st.t === HOLD) {
        if (chordChanged && ts.sounding && tr.follow) this.play(tr, ts, ts.sounding, true);
      } else if (st.prob >= 1 || this.rng.next() < st.prob) {
        this.play(tr, ts, st, false);
      } else if (ts.sounding) {
        this.synth.release(tr.id);
        ts.sounding = null;
      }
    }
    const progBeat = this.prog ? (((this.step - this.progStart) / s.spb) % this.prog.totalBeats) : 0;
    this.emit({ type: 'step', step: this.step, bar: this.sectionBar, bars: this.sectionBars, spbar: s.stepsPerBar, pos, progBeat });
    this.step++;
  }

  play(tr, ts, st, isFollow) {
    const vel = st.accent ? 1 : 0.78;
    if (tr.inst.type === 'drums') {
      const hits = [];
      for (const a of st.atoms) if (a.kind === 'hit') hits.push(a.value);
      this.synth.drum(tr.id, hits, st.accent ? 1 : st.prob < 1 ? 0.5 : 0.78); // chance hits = ghost notes
      this.emit({ type: 'note', track: tr.id });
      return;
    }
    const midis = this.resolve(tr, ts.block, st.atoms);
    if (!midis.length) return;
    this.synth.noteOn(tr.id, midis, vel);
    ts.sounding = st;
    if (!isFollow) this.emit({ type: 'note', track: tr.id, midi: midis[0] });
  }

  scaleNow() { return this.prog ? this.prog.scale : this.song.scale; }

  resolve(tr, block, atoms) {
    const s = this.song, scale = this.scaleNow(), L = scale.length;
    const chord = this.chord, shape = chord.shape, S = shape.length;
    const base = 12 * ((tr.octave ?? 4) + 1) + s.keyRoot;
    const mode = (block && block.mode) || tr.mode || 'chord';
    const root = foldDegree(chord.degree, L);
    const out = [];
    for (const a of atoms) {
      let degs;
      if (a.kind === 'chord') degs = shape.map((o) => root + o);
      else if (a.kind === 'num') {
        const n = a.value;
        if (mode === 'chord') {
          const o = Math.floor(n / S);
          degs = [root + shape[n - o * S] + o * L];
        } else degs = [mode === 'scale' ? root + n : n];
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
    let beat = ((step - this.progStart) / this.song.spb) % p.totalBeats;
    for (const c of p.chordList) {
      if (beat < c.beats) return c;
      beat -= c.beats;
    }
    return p.chordList[p.chordList.length - 1];
  }

  // ---------------------------------------------------------------- conductor
  onBar() {
    if (this.section) this.sectionBar++;
    if (!this.section || this.sectionBar >= this.sectionBars) {
      const next = this.forced || this.nextSection || (this.section ? this.chooseNext() : this.song.sectionMap[this.song.raw.startSection] || this.song.sections[0]);
      this.forced = null;
      this.startSection(next);
    } else {
      this.glideMood();
      this.midSectionBar();
    }
    if (this.sectionBar === this.sectionBars - 1) this.prepareTransition();
  }

  // intensity/tension approach the section goal gradually -> smooth brightness & block choices
  glideMood() {
    const k = 1 / Math.max(1, this.song.moodGlide / 4);
    this.intensity += (this.goal.intensity - this.intensity) * k;
    this.tension += (this.goal.tension - this.tension) * k;
    this.synth.setMood(this.intensity, this.tension);
  }

  startSection(sec) {
    const s = this.song, rng = this.rng;
    const first = !this.section;
    this.section = sec;
    this.sectionBar = 0;
    this.sectionBars = Math.max(1, rng.pick(sec.bars) | 0);
    this.nextSection = null;
    // still on the way to a requested mood? keep bridging sections short
    if (this.target.influence > 0.5 && this.distToTarget(sec) > 0.25) {
      this.sectionBars = Math.min(this.sectionBars, Math.max(1, this.song.transitBars));
    }

    const inf = this.target.influence;
    this.goal.intensity = clamp01(sec.intensity + (this.target.intensity - sec.intensity) * inf * 0.5 + rng.range(-0.04, 0.04));
    this.goal.tension = clamp01(sec.tension + (this.target.tension - sec.tension) * inf * 0.5 + rng.range(-0.04, 0.04));
    if (first) { this.intensity = this.goal.intensity; this.tension = this.goal.tension; this.synth.setMood(this.intensity, this.tension); }
    else this.glideMood();

    this.prog = this.pickProgression();
    this.progStart = this.step;

    for (const tr of s.tracks) this.setupTrack(tr);

    if (!first && this.intensity > 0.68) {
      for (const tr of s.tracks) if (tr.inst.type === 'drums' && this.tracks[tr.id]?.active) this.synth.drum(tr.id, ['c'], 0.7);
    }
    this.log(`▶ ${sec.id} · ${this.sectionBars} bars · ${this.prog ? this.prog.id : '—'}`);
    this.emitState();
  }

  trackState(tr) {
    return (this.tracks[tr.id] ||= { active: false, block: null, steps: null, sounding: null, fill: null, loop: 0, start: 0 });
  }

  setupTrack(tr) {
    const ts = this.trackState(tr);
    ts.fill = null;
    const lock = this.locks[tr.id] && this.song.blockMap[this.locks[tr.id]];
    let active = lock ? true : this.decideActive(tr, ts.active);
    if (active) {
      const b = lock || this.pickBlock(tr, ts);
      if (b) this.startBlock(tr, ts, b);
      else active = false;
    }
    if (!active && ts.sounding) { this.synth.release(tr.id); ts.sounding = null; }
    ts.active = active;
  }

  decideActive(tr, wasActive) {
    const o = this.section.tracks && this.section.tracks[tr.id];
    if (o !== undefined && o !== null) return this.rng.chance(+o);
    const l = tr.layer || {};
    if (this.goal.intensity < (l.min ?? 0) || this.goal.intensity > (l.max ?? 1)) return false;
    let c = l.chance ?? 1;
    if (wasActive) c += (1 - c) * 0.5; // continuity
    return this.rng.chance(c);
  }

  blockLen(b) { return Math.max(1, Math.round((b.beats || 4) * this.song.spb)); }

  startBlock(tr, ts, b) {
    ts.block = b;
    ts.start = this.step;
    ts.loop = 0;
    const len = this.blockLen(b);
    ts.base = b.gen ? generateTokens(b.gen, this.rng, len, b.mode || tr.mode) : expandTokens(b.pattern, len);
    ts.tokens = ts.base;
    ts.steps = parseTokens(ts.tokens);
    const h = (this.history[tr.id] ||= []);
    h.push(b.id);
    if (h.length > 4) h.shift();
  }

  pickBlock(tr, ts, { fill = false, tags } = {}) {
    const cands = (this.song.blocksByTrack[tr.id] || []).filter((b) => isFill(b) === fill);
    if (!cands.length) return null;
    const want = tags || this.section.tags;
    const I = this.goal.intensity, T = this.goal.tension;
    const hist = this.history[tr.id] || [];
    const weights = cands.map((b) => {
      let w = b.weight ?? 1;
      w *= rangeFit(I, b.intensity) * rangeFit(T, b.tension);
      let ov = 0;
      for (const t of b.tags || []) if (t !== 'fill' && want.includes(t)) ov++;
      const own = (b.tags || []).filter((t) => t !== 'fill').length;
      w *= ov ? 1 + 2 * ov : own ? 0.12 : 1;
      if (ts.block && b.id === ts.block.id) w *= tr.stickiness ?? 1.5;
      else if (hist.includes(b.id)) w *= 0.6;
      return w;
    });
    return this.rng.weighted(cands, weights);
  }

  onBlockLoop(tr, ts) {
    ts.loop++;
    const b = ts.block;
    if (b.gen && this.rng.chance(b.gen.regen ?? 0.3)) ts.base = generateTokens(b.gen, this.rng, ts.base.length, b.mode || tr.mode);
    const v = this.section.variation ?? this.song.variation;
    ts.tokens = (b.mutate ?? 1) > 0 && this.rng.chance(v) ? mutateTokens(ts.base, this.rng, tr.inst.type === 'drums', b.mutate ?? 1) : ts.base;
    ts.steps = parseTokens(ts.tokens);
    this.emit({ type: 'tokens', track: tr.id, tokens: ts.tokens });
  }

  midSectionBar() {
    const s = this.song, rng = this.rng;
    let changed = false;
    const churn = this.sectionBar % 4 === 0;
    for (const tr of s.tracks) {
      const ts = this.tracks[tr.id];
      if (!ts || this.locks[tr.id]) continue;
      // occasional layer in/out every 4 bars keeps long sections alive
      if (churn && !(this.section.tracks && tr.id in this.section.tracks) && rng.chance(s.layerChurn)) {
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
    const next = this.forced || this.nextSection || this.chooseNext();
    this.nextSection = next;
    const up = next.intensity - this.section.intensity;
    for (const tr of s.tracks) {
      const ts = this.tracks[tr.id];
      if (tr.inst.type !== 'drums' || !ts || !ts.active || this.locks[tr.id]) continue;
      if (up < -0.25 && rng.chance(0.4)) {
        ts.fill = { start: this.step, end: this.step + s.stepsPerBar, steps: parseTokens(expandTokens('', s.stepsPerBar)) };
        this.log('drop');
        continue;
      }
      let p = s.fillChance;
      if (next !== this.section) p += 0.3;
      if (up > 0.15) p = 1;
      if (!rng.chance(p)) continue;
      const tags = up < -0.1 ? next.tags : [...new Set([...this.section.tags, ...next.tags])];
      const b = this.pickBlock(tr, ts, { fill: true, tags });
      if (!b) continue;
      const len = Math.min(this.blockLen(b), s.stepsPerBar);
      const end = this.step + s.stepsPerBar;
      ts.fill = { start: end - len, end, steps: parseTokens(expandTokens(b.pattern, len)) };
      this.log(`fill ${b.id}`);
    }
    this.log(`next → ${next.id}`);
    this.emitState();
  }

  chooseNext() {
    const s = this.song, cur = this.section;
    let list = Object.entries(cur.next || {}).filter(([id, w]) => s.sectionMap[id] && w > 0).map(([id, w]) => [s.sectionMap[id], +w]);
    if (!list.length) list = s.sections.map((x) => [x, 1]);
    const inf = this.target.influence;
    if (inf <= 0) return this.rng.weighted(list.map((x) => x[0]), list.map((x) => x[1]));
    const d2 = list.map(([sec]) => (sec.intensity - this.target.intensity) ** 2 + (sec.tension - this.target.tension) ** 2);
    const min = Math.min(...d2);
    const w = list.map(([, w0], i) => w0 * (1 - inf + inf * Math.exp(-(d2[i] - min) / (2 * 0.08 * 0.08))));
    return this.rng.weighted(list.map((x) => x[0]), w);
  }

  // If the current section is far from where the game wants to be, end it within `within` bars.
  distToTarget(sec) {
    return Math.hypot(sec.intensity - this.target.intensity, sec.tension - this.target.tension);
  }

  hurry(within) {
    if (!this.section) return;
    if (this.distToTarget(this.section) < 0.2 && this.target.influence > 0) return;
    const end = this.sectionBar + 1 + Math.max(0, within | 0);
    if (end < this.sectionBars) this.sectionBars = end;
    if (this.sectionBar === this.sectionBars - 1) this.nextSection = this.chooseNext();
    this.emitState();
  }

  pickProgression() {
    const s = this.song;
    if (!s.progressions.length) return null;
    if (this.progLock && s.progMap[this.progLock]) return s.progMap[this.progLock];
    const tags = this.section.tags, T = this.goal.tension;
    const w = s.progressions.map((p) => {
      let x = p.weight ?? 1;
      let ov = 0;
      for (const t of p.tags || []) if (tags.includes(t)) ov++;
      x *= ov ? 1 + 3 * ov : (p.tags || []).length ? 0.03 : 1;
      x *= rangeFit(T, p.tension);
      if (this.prog && p.id === this.prog.id) x *= s.progStickiness;
      return x;
    });
    return this.rng.weighted(s.progressions, w);
  }

  // Re-link runtime state after a hot song edit.
  refresh() {
    const s = this.song;
    const sec = s.sectionMap[this.section.id];
    if (sec) this.section = sec;
    else { this.section = { ...this.section, tags: this.section.tags || [] }; this.sectionBars = this.sectionBar + 1; }
    if (this.nextSection) this.nextSection = s.sectionMap[this.nextSection.id] || null;
    if (this.prog) this.prog = s.progMap[this.prog.id] || this.pickProgression();
    this.chordKey = '';
    for (const id of Object.keys(this.tracks)) {
      const ts = this.tracks[id], tr = s.trackMap[id];
      if (!tr) { delete this.tracks[id]; continue; }
      if (!ts.block) continue;
      const b = s.blockMap[ts.block.id];
      if (!b || b.track !== id) {
        ts.block = null; ts.active = false; ts.steps = null;
        if (ts.sounding) { this.synth.release(id); ts.sounding = null; }
        continue;
      }
      const len = this.blockLen(b);
      ts.block = b;
      if (!b.gen) ts.base = expandTokens(b.pattern, len);
      else if (!ts.base || ts.base.length !== len) ts.base = generateTokens(b.gen, this.rng, len, b.mode || tr.mode);
      ts.tokens = ts.base;
      ts.steps = parseTokens(ts.tokens);
    }
    for (const [id, b] of Object.entries(this.locks)) if (!s.blockMap[b]) delete this.locks[id];
    if (this.progLock && !s.progMap[this.progLock]) this.progLock = null;
    this.emitState();
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
        ? { active: ts.active, block: ts.block && ts.block.id, tags: (ts.block && ts.block.tags) || [], tokens: ts.tokens, locked: this.locks[tr.id] || null, fill: !!ts.fill }
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
      chords: this.prog ? this.prog.chordList.map((c) => chordLabel(s.keyRoot, this.prog.scale, c)) : [],
      scale: this.prog ? this.prog.scaleName : s.scaleName,
      intensity: this.intensity,
      tension: this.tension,
      goal: { ...this.goal },
      target: { ...this.target },
      mood: this.moodName,
      tracks,
    });
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }
}
