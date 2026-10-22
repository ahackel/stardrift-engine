// node tools/test.mjs — engine sanity checks (determinism, mood routing, hot reload, audio health, stingers, themes)
import { readFileSync, readdirSync } from 'node:fs';
import { Engine } from '../src/engine/engine.js';
import { degSemis, foldDegree, prepareSong } from '../src/engine/theory.js';
import { migrateSong } from '../src/engine/plays.js';
import { diskSamples } from '../src/disk-samples.js';
import { KITS } from '../src/engine/drums.js';
import { expandTokens } from '../src/engine/pattern.js';

const SAMPLES = await diskSamples();
// an engine with the sample library loaded, as the player has it
const newEngine = (sr, song, seed) => { const e = new Engine(sr, song, seed); e.setSamples(SAMPLES); return e; };

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const song = readJson('../songs/deep-space.json');
const SR = 44100;
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) failed++; };

// two sounds for the synth checks (the editor's library has them as "Power chord guitar" and "String ensemble")
const POWER_CHORDS = {
  sound: { type: 'string', string: { decay: 3, bright: 0.7, mute: 0.6 }, drive: 0.85, env: { a: 0.001, d: 1, s: 1, r: 0.06 }, cutoff: 12000, resonance: 0.7, amp: 'guitar', poly: 3 },
  track: { octave: 3, volume: 0.19, pan: -0.25, echo: 0.05, reverb: 0.2 },
};
const STRINGS = {
  sound: { type: 'wave', wave: 'saw', smooth: true, unison: 3, detune: 10, env: { a: 0.35, d: 1, s: 0.85, r: 0.9 }, vibrato: { depth: 0.06, rate: 5, delay: 0.3 }, cutoff: 3300, breath: 0.1, body: 'strings', ensemble: 0.8, swell: 0.8, poly: 10 },
  track: { octave: 3, volume: 0.17, pan: 0, echo: 0.05, reverb: 0.6, follow: true },
};

function run(engine, secs, onBlock) { // onBlock(seconds, engine) before each 128-sample block
  const L = new Float32Array(128), R = new Float32Array(128);
  let hash = 0, peak = 0, bad = 0;
  for (let i = 0, n = Math.round(secs * SR); i < n; i += 128) {
    onBlock?.(i / SR, engine);
    engine.process(L, R, 128);
    for (let j = 0; j < 128; j++) {
      if (!Number.isFinite(L[j])) bad++;
      peak = Math.max(peak, Math.abs(L[j]));
      hash = (hash * 31 + Math.round(L[j] * 1e4)) | 0;
    }
  }
  return { hash, peak, bad };
}

// 1. Determinism: same seed => identical note decisions (audio may differ only by random unison phases)
const logOf = (seed) => { const e = newEngine(SR, song, seed); const out = []; run(e, 90, () => { for (const ev of e.drainEvents()) if (ev.type === 'log' || ev.type === 'note') out.push(ev.text || `${ev.track}:${ev.midi}`); }); return out.join('|'); };
ok(logOf(42) === logOf(42), 'same seed produces the same arrangement');
ok(logOf(42) !== logOf(43), 'different seeds produce different arrangements');

// 2. Audio health
const h = run(newEngine(SR, song, 7), 120);
ok(h.bad === 0, `no NaN/Inf samples (${h.bad})`);
ok(h.peak > 0.1 && h.peak < 1, `peak level sane (${h.peak.toFixed(3)})`);

// 3. Mood routing: a mood request reaches a matching section quickly and smoothly (through bridges)
for (const [mood, want, maxSecs, from] of [['tension', 'tension', 30, 'relaxed'], ['action', 'peak', 40, 'relaxed'], ['relaxed', 'calm|release', 40, 'action']]) {
  const e = newEngine(SR, song, 11);
  e.setMood(from);
  run(e, 60);
  e.drainEvents();
  e.setMood(mood);
  let reached = null;
  const path = [];
  run(e, 60, (t) => {
    for (const ev of e.drainEvents()) if (ev.type === 'state' && ev.section && path[path.length - 1] !== ev.section) path.push(ev.section);
    if (reached === null && new RegExp(`^(${want})$`).test(e.section.id)) reached = t;
  });
  ok(reached !== null && reached <= maxSecs, `setMood('${mood}') → ${want} after ${reached?.toFixed(1)}s via ${path.join(' → ')}`);
}

// 3a. The way to a mood: each section on the way is a step nearer along the links; a section no link leads to is
// jumped to; a mood without sections leads nowhere (the music walks on)
{
  const e = newEngine(SR, song, 11);
  run(e, 2);
  e.setMood('action');
  const goal = e.song.sectionMap[e.moodSec], d = e.stepsTo(goal), path = [e.section.id];
  run(e, 60, () => { if (e.section.id !== path.at(-1) && path.at(-1) !== goal.id) path.push(e.section.id); });
  const nearer = path.slice(1).every((id, i) => id === 'breather' || (d.get(e.song.sectionMap[id]) ?? 9) < (d.get(e.song.sectionMap[path[i]]) ?? 9));
  ok(path.at(-1) === goal.id && nearer, `setMood('action') takes the shortest way (${path.join(' → ')})`);
  const cut = structuredClone(song);
  for (const x of cut.sections) if (x.next) delete x.next.peak;
  const j = newEngine(SR, cut, 11);
  run(j, 2);
  j.setMood('action');
  let at = null;
  run(j, 40, (t) => { if (at === null && j.section.id === 'peak') at = t; });
  ok(at !== null, `a mood's section no link leads to is jumped to (after ${at?.toFixed(1)} s)`);
  const none = structuredClone(song);
  delete none.moods.wonder.sections;
  const n = newEngine(SR, none, 11);
  run(n, 2);
  n.setMood('wonder');
  ok(n.moodSec === null && run(n, 20).bad === 0, 'a mood without sections leads nowhere: the music walks on');
}

// Older songs: sections and moods with intensity and tension, sounds whose filter followed them, links weighed 0–3
{
  const old = {
    sections: [{ id: 'intro', intensity: 0.1, tension: 0.1, next: { calm: 1 } }, { id: 'calm', intensity: 0.2, tension: 0.1, next: { calm: 0.5, peak: 1.5 } }, { id: 'peak', intensity: 0.9, tension: 0.4, next: { calm: 2 } }],
    moods: { relaxed: { intensity: 0.1, tension: 0.05 }, action: { intensity: 0.85, tension: 0.4, influence: 1 } },
    instruments: { pad: { type: 'wave', cutoff: 600, cutoffIntensity: 2000, cutoffTension: -1000 } },
    tracks: [{ id: 'pad', instrument: 'pad', clips: [] }], blocks: [], progressions: [],
  };
  const m = migrateSong(old);
  ok(m.sections.every((x) => x.intensity === undefined && x.tension === undefined) && m.moods.action.influence === undefined, 'an older song\'s sections and moods lose intensity and tension');
  ok(m.moods.relaxed.sections?.calm === 1 && m.moods.action.sections?.peak === 1, 'an older mood leads to the nearest section the music can get to (not the intro)');
  ok(m.instruments.pad.fx?.[0]?.cutoff === 1300 && m.instruments.pad.cutoffIntensity === undefined, `a filter that followed the mood stays where it sat on average, in its effects now (${JSON.stringify(m.instruments.pad.fx)})`);
  ok(JSON.stringify(m.sections[1].next) === '{"calm":0.25,"peak":1}' && m.sections[2].next.calm === 1, 'older links are scaled by the strongest, to steps');
  ok(JSON.stringify(migrateSong(m)) === JSON.stringify(m) && old.sections[0].intensity === 0.1, 'converting twice changes nothing, the song itself is left alone');
}

// Songs from before had one theme (song.theme) that theme clips played: it becomes a clip whose notes they play
{
  const sec = (id) => ({ id, bars: [8] });
  const old = {
    sections: [sec('calm'), sec('peak')], instruments: { lead: { type: 'pulse' }, kit: { type: 'drums' } },
    theme: { beats: 8, pattern: '0 - 2 - 4 - 2 - | 0 -*7' },
    tracks: [{ id: 'lead', instrument: 'lead', clips: ['line', 'head', 'whole'] }, { id: 'bell', instrument: 'lead', clips: ['echo'] }],
    blocks: [{ id: 'line', beats: 4, pattern: '0 . 2 .' }, { id: 'head', beats: 8, theme: ['head', 'slow'] }, { id: 'whole', beats: 8, theme: true }, { id: 'echo', beats: 16, theme: ['answer'] }],
  };
  const m = migrateSong(old), by = Object.fromEntries(m.blocks.map((b) => [b.id, b]));
  ok(m.theme === undefined && m.blocks.every((b) => b.theme === undefined) && old.theme && old.blocks[1].theme, 'an older song\'s theme goes, the song itself is left alone');
  ok(by.whole.pattern === old.theme.pattern && by.whole.mode === 'key' && by.whole.fit === true && by.whole.forms.length === 6 && !by.whole.from,
    'the theme clip as long as the theme, playing every form, holds its notes');
  ok(by.head.from === 'whole' && by.echo.from === 'whole' && JSON.stringify(by.head.forms) === '["head","slow"]' && !by.head.pattern && !by.line.from, 'the other theme clips play its notes, in their forms');
  ok(JSON.stringify(migrateSong(m)) === JSON.stringify(m), 'converting twice changes nothing');
  // no theme clip as long as the theme: a clip of their own holds the notes, and never plays itself
  const odd = migrateSong({ ...structuredClone(old), blocks: old.blocks.map((b) => (b.theme ? { ...b, beats: 16 } : b)) }), keep = odd.blocks.find((b) => b.id === 'theme_notes');
  ok(keep && keep.pattern === old.theme.pattern && keep.beats === 8 && Object.values(keep.sections).every((w) => w === 0) && odd.tracks[0].clips.includes('theme_notes')
    && odd.blocks.filter((b) => b.from === 'theme_notes').length === 3, 'with none as long, a clip at 0 % holds the theme');
  // the engine plays them: a clip playing another's notes, cut to its own length, in its forms
  const sg = { ...m, bpm: 120, humanize: 0, progressions: [{ id: 'p', chords: 'i:8' }], moods: {} };
  const e = newEngine(SR, sg, 2), seen = new Set();
  run(e, 40, (t, en) => { for (const ev of en.drainEvents()) if (ev.type === 'log' && ev.text.startsWith('♪')) seen.add(ev.text.split(' ').slice(1, 4).join(' ')); });
  ok([...seen].some((x) => x.endsWith('of whole')) && [...seen].some((x) => !x.includes(' of ')), `clips play the theme clip's notes (${[...seen].slice(0, 4).join('; ')})`);
}

// 3b. A held section: the music moves there at a bar line and stays, whatever mood is asked for; released, it moves on
{
  const e = newEngine(SR, song, 11);
  run(e, 20);
  e.lockSection('wonder');
  const seen = new Set();
  run(e, 90, (t) => { if (t > 6) seen.add(e.section.id); if (t > 30 && t < 30.01) e.setMood('action'); }); // it moves there within two bars
  ok(seen.size === 1 && seen.has('wonder'), `a held section plays on through a mood change (${[...seen].join(', ')})`);
  e.lockSection(null);
  run(e, 60, () => seen.add(e.section.id));
  ok(seen.size > 1, `released, the music moves on (${[...seen].join(', ')})`);
}

// 4. Hot reload keeps the position
{
  const e = newEngine(SR, song, 5);
  run(e, 20);
  const step = e.step, sec = e.section.id;
  const edited = JSON.parse(JSON.stringify(song));
  edited.blocks.find((b) => b.id === 'hold').pattern = '* -*31 . . 0+2 -*29';
  e.setSong(edited);
  ok(e.step === step && e.section.id === sec, 'hot reload keeps musical position');
  ok(run(e, 10).bad === 0, 'engine keeps running after hot reload');
}

// 5. Breathers: the music thins out to the ambient tracks now and then, and comes back
{
  const keep = song.breath.keep;
  const e = newEngine(SR, { ...song, breath: { ...song.breath, every: 16, bars: [4, 4] } }, 3);
  let inBreath = null, after = null;
  run(e, 480, () => {
    for (const ev of e.drainEvents()) if (ev.type === 'state') {
      const active = Object.entries(ev.tracks).filter(([, t]) => t.active).map(([id]) => id);
      if (ev.section === 'breather') inBreath ||= active;
      else if (inBreath && !after && ev.section) after = ev.section;
    }
  });
  ok(inBreath && inBreath.every((id) => keep.includes(id)), `breather keeps only the tracks it names (${inBreath})`);
  ok(!!after, `music returns after a breather (→ ${after})`);
}

// 6. Lead-in: the chord change into a new section is prepared in the section's last beats
{
  const e = newEngine(SR, song, 5);
  let changes = 0, prepared = 0, lastChordStep = -1;
  run(e, 120, () => {
    for (const ev of e.drainEvents()) {
      if (ev.type === 'chord') lastChordStep = e.step;
      if (ev.type === 'log' && ev.text.startsWith('▶') && e.section.bars && e.step > 0) { changes++; if (e.step - lastChordStep < e.song.stepsPerBar) prepared++; }
    }
  });
  ok(changes > 3 && prepared >= changes / 2, `lead-in chords before section changes (${prepared}/${changes})`);
}

// 7. Stingers: start on the beat, borrow their tracks (with their own chord), duck the rest, then hand back
{
  const e = newEngine(SR, song, 9);
  run(e, 20);
  e.sting('jump');
  let start = null, end = null, duck = null;
  const notes = new Set();
  run(e, 6, (t, en) => {
    for (const ev of en.drainEvents()) {
      if (ev.type === 'sting') { if (ev.on) { start = en.step; duck = en.synth.tracks.pad.gTarget; } else end = en.step; }
      if (ev.type === 'note' && start !== null && end === null) notes.add(ev.track);
    }
  });
  const len = 4 * e.song.spb;
  ok(start !== null && (start - 1) % e.song.spb < 2 && end - start >= len - 2 && end - start <= len + 2, `stinger starts on a beat and lasts its length (${start}…${end})`);
  ok(notes.has('arp') && notes.has('drums') && duck < 1, `stinger plays its parts and ducks the rest (pad ×${duck})`);
  ok(e.curSting === null && e.synth.duck === null, 'stinger ends and the music comes back up');
  const held = newEngine(SR, song, 2);
  held.setHold(true);
  held.sting('reward');
  let heard = 0;
  run(held, 1, (t, en) => { for (const ev of en.drainEvents()) if (ev.type === 'note') heard++; });
  ok(heard === 4 && held.step === 0, `a stinger sounds while the song is held (${heard} notes)`);
}

// 8. Themes: clips play another clip's notes (from) in varied forms, notes on the beat fit the chord
{
  const e = newEngine(SR, { ...song, humanize: 0 }, 4); // no late notes: the check reads the step a note starts on
  const forms = new Set();
  let onBeat = 0, fits = 0;
  const noteOn = e.synth.noteOn.bind(e.synth);
  e.synth.noteOn = (id, midis, vel) => {
    const ts = e.tracks[id];
    if (ts?.block?.from && !e.curSting && e.step % e.song.spb === 0) {
      const sc = e.scaleNow(), root = foldDegree(e.chord.degree, sc.length);
      const pcs = e.chord.shape.map((o) => (((e.song.keyRoot + degSemis(sc, root + o)) % 12) + 12) % 12);
      onBeat++;
      if (pcs.includes(midis[0] % 12)) fits++;
    }
    noteOn(id, midis, vel);
  };
  run(e, 600, (t, en) => { for (const ev of en.drainEvents()) if (ev.type === 'log' && ev.text.startsWith('♪')) forms.add(ev.text.split(' ')[1]); });
  ok(forms.size >= 4, `the theme comes back in different forms (${[...forms]})`);
  ok(onBeat > 10 && fits === onBeat, `theme notes on the beat are chord tones (${fits}/${onBeat})`);
}

// 9. Every song in songs/: healthy audio, each mood reached, each stinger plays, its themes come back
const toCheck = readdirSync(new URL('../songs/', import.meta.url)).filter((f) => f.endsWith('.json')).map((f) => [f, readJson(`../songs/${f}`)]);
for (const [file, sg] of toCheck) {
  const e = newEngine(SR, sg, 3);
  const h = run(e, 90);
  const themed = [];
  const ids = new Set(sg.blocks.map((b) => b.id));
  const orphans = sg.blocks.filter((b) => b.track !== undefined || !sg.tracks.some((t) => t.clips?.includes(b.id))).map((b) => b.id); // every clip on a track, none naming one
  ok(h.bad === 0 && h.peak > 0.1 && h.peak < 1 && !orphans.length && ids.size === sg.blocks.length, `${file}: healthy (peak ${h.peak.toFixed(2)}), blocks valid`);
  const far = [];
  for (const [mood, m] of Object.entries(sg.moods || {})) {
    e.setMood(mood);
    let got = false;
    run(e, 40, (t, en) => { got ||= en.inMood(en.section); for (const ev of en.drainEvents()) if (ev.type === 'log' && ev.text.startsWith('♪')) themed.push(ev.text); });
    if (!m.sections || !got) far.push(`${mood}→${e.section.id}`);
  }
  ok(!far.length, `${file}: every mood reaches one of its sections within 40 s${far.length ? ` — ${far.join(', ')}` : ''}`);
  ok(!sg.blocks.some((b) => b.from) || themed.length > 1, `${file}: its themes come back (${themed.length}×)`);
  const silent = (sg.stingers || []).filter((x) => {
    e.drainEvents();
    e.sting(x.id);
    let notes = 0;
    run(e, x.beats * 60 / sg.bpm + 1, (t, en) => { for (const ev of en.drainEvents()) if (ev.type === 'note') notes++; });
    return !notes;
  }).map((x) => x.id);
  ok(!silent.length, `${file}: every stinger plays (${(sg.stingers || []).length})${silent.length ? ` — silent: ${silent}` : ''}`);
}

// How many notes it plays at once is the instrument's; the engine reads an older song's track poly too
{
  const old = structuredClone(song), tr = old.tracks.find((t) => (old.instruments[t.instrument].poly || 1) > 1), inst = old.instruments[tr.instrument];
  tr.poly = inst.poly;
  delete inst.poly;
  ok(prepareSong(old).trackMap[tr.id].poly === tr.poly && prepareSong(song).trackMap[tr.id].poly === tr.poly, 'the engine takes poly from the instrument (or an older song\'s track)');
}

// breath: air in the note at the level its curve gives, relative to the tone, the same for every type (a string too)
{
  const { Synth } = await import('../src/engine/synth.js');
  const measure = (def) => { // the tone, and what breath adds to it (the same random phases, so the difference is the breath)
    const run = (d) => {
      let seed = 7;
      const rnd = Math.random;
      Math.random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
      const s = new Synth(SR);
      s.preview(d, [], { volume: 0.3 });
      s.pv.noteOn([69], 0.8);
      const out = Array.from({ length: SR / 2 }, () => s.pv.render());
      Math.random = rnd;
      return out;
    };
    const a = run({ ...def, breath: 0 }), b = run(def);
    let t = 0, n = 0;
    for (let i = SR / 4; i < SR / 2; i++) { t += a[i] ** 2; n += (b[i] - a[i]) ** 2; }
    return 10 * Math.log10(n / t);
  };
  const env = { a: 0.01, d: 0.3, s: 0.8, r: 0.3 };
  const levels = ['pulse', 'wave', 'fm', 'string', 'bowed'].map((type) => [type, measure({ type, env, breath: 0.25 })]);
  ok(levels.every(([, db]) => db > -27 && db < -20), `breath at 25 % is a hint of air, for every type (${levels.map(([t, db]) => `${t} ${db.toFixed(0)} dB`).join(', ')})`);
}


// 13. Amps and double tracking: every amp on a driven guitar, doubled, stays finite, sane and near the level without
{
  const { AMPS } = await import('../src/engine/fx.js');
  const { renderPhrase } = await import('../src/phrase.js');
  const e = POWER_CHORDS;
  const phrase = { bpm: 130, chords: 'i:4 VI:4', bars: 2, part: { pattern: '0 . 0 . 0+2+3! - 0 . 0 . 0 . 0+2+3 - - .', beats: 4 } };
  const base = renderPhrase(phrase, e.sound, e.track, { raw: true }).rms, off = [];
  for (const amp of Object.keys(AMPS)) {
    const r = renderPhrase(phrase, { ...e.sound, amp }, { ...e.track, double: 0.7 }, { raw: true });
    const db = 20 * Math.log10(r.rms / base);
    if (![...r.left, ...r.right].every(Number.isFinite) || Math.abs(db) > 4) off.push(`${amp} ${db.toFixed(1)} dB`);
  }
  ok(!off.length, `amps and double tracking are healthy and level-matched (${Object.keys(AMPS)})${off.length ? ` — ${off}` : ''}`);
}

// 14. Bodies, ensembles, swell and scoop: every body on a string section chord stays finite, sane and near its level
{
  const { BODIES } = await import('../src/engine/fx.js');
  const { renderPhrase } = await import('../src/phrase.js');
  const e = STRINGS;
  const phrase = { bpm: 96, chords: 'i:4 VI:4', bars: 2, part: { pattern: '0+2+4+5 -*13 . .', beats: 4 } };
  const base = renderPhrase(phrase, e.sound, e.track, { raw: true }).rms, off = [];
  for (const body of Object.keys(BODIES)) {
    const r = renderPhrase(phrase, { ...e.sound, body, ensemble: 0.8, swell: 1, scoop: 0.3 }, e.track, { raw: true });
    const db = 20 * Math.log10(r.rms / base);
    if (![...r.left, ...r.right].every(Number.isFinite) || Math.abs(db) > 6) off.push(`${body} ${db.toFixed(1)} dB`);
  }
  ok(!off.length, `bodies with ensemble, swell and scoop are healthy (${Object.keys(BODIES)})${off.length ? ` — ${off}` : ''}`);
  const sources = [['fm', { type: 'fm', fm: { ratio: 1, index: 5, env: 1, feedback: 0.3 }, unison: 3, detune: 8, env: { a: 0.05, d: 0.4, s: 0.8, r: 0.3 } }], ['warm', { ...e.sound, wave: 'warm' }]];
  const badSrc = sources.filter(([, s]) => { const r = renderPhrase(phrase, s, e.track, { raw: true }); return !(r.rms > 0.003) || ![...r.left].every(Number.isFinite); }).map(([n]) => n);
  ok(!badSrc.length, `fm and warm sources sound and stay finite${badSrc.length ? ` — ${badSrc}` : ''}`);
}

// 14b. The high pass filter, the wah, the bitcrush and the EQ on a pulse stay finite and near its level; a flat EQ changes nothing, cuts make
// it quieter and a boost louder
{
  const { renderPhrase } = await import('../src/phrase.js');
  const phrase = { bpm: 120, chords: 'i:4 VI:4', bars: 2, part: { pattern: '0 . 2 . 4 . 7 . 0+2+4 - - - . . . .', beats: 4 } };
  const snd = { type: 'pulse', duty: 0.25, env: { a: 0.01, d: 0.3, s: 0.7, r: 0.2 } };
  const base = renderPhrase(phrase, snd, {}, { raw: true }).rms, off = [];
  const level = (s) => { const r = renderPhrase(phrase, { ...snd, ...s }, {}, { raw: true }); return [r, 20 * Math.log10(r.rms / base)]; };
  const finite = (r) => [...r.left, ...r.right].every(Number.isFinite);
  for (const [cutoff, resonance] of [[300, 0.707], [2000, 3]]) {
    const [r, db] = level({ filter: 'high', cutoff, resonance });
    if (!finite(r) || db > 3 || db < -15) off.push(`high ${cutoff} Hz ${db.toFixed(1)} dB`);
  }
  const { FxChain } = await import('../src/engine/fx.js');
  if (new FxChain(SR).set([{ kind: 'eq', low: 0, mid: 0, midHz: 1000, high: 0 }], { music: true }).byKind.eq.eq !== null) off.push('a flat EQ is not left out');
  const [cut, cutDb] = level({ eq: { low: -12, mid: -12, midHz: 1000, high: -12 } });
  if (!finite(cut) || cutDb > -3) off.push(`EQ cuts ${cutDb.toFixed(1)} dB`);
  const [boost, boostDb] = level({ eq: { low: 6, mid: 6, midHz: 800, high: 6 } });
  if (!finite(boost) || boostDb < 1 || boostDb > 12) off.push(`EQ boosts ${boostDb.toFixed(1)} dB`);
  for (const [name, x] of [['wah', { wah: {} }], ['wah on notes', { wah: { mode: 'note', resonance: 8 } }], ['bitcrush', { crush: { bits: 3, rate: 4000 } }]]) {
    const [r, db] = level(x);
    if (!finite(r) || db > 3 || db < -6) off.push(`${name} ${db.toFixed(1)} dB`);
  }
  ok(!off.length, `the high pass filter, the wah, the bitcrush and the EQ are healthy (EQ cut ${cutDb.toFixed(1)} dB, boost +${boostDb.toFixed(1)} dB)${off.length ? ` — ${off}` : ''}`);
}

// 15. Recorded sounds and the bowed string: samples play at the note's pitch, drum hits play their recording (and
// fall back to synthesis without the library), the bowed string holds its pitch across the cello range
{
  const { Synth } = await import('../src/engine/synth.js');
  const note = (inst, midi, samples = SAMPLES, secs = 1.2) => {
    const s = new Synth(SR); s.samples = samples;
    s.configure({ bpm: 120, tracks: [{ id: 'x', poly: 1, volume: 1, inst }], fx: { echo: { beats: 1, feedback: 0, damp: 0, level: 0 }, reverb: { size: 0.5, damp: 0.5, level: 0 }, echoToReverb: 0 }, master: { gain: 1 } });
    s.tracks.x.g = 1;
    if (inst.type === 'drums') s.drum('x', [midi], 0.8); else s.noteOn('x', [midi], 0.8);
    const out = new Float64Array(Math.round(secs * SR));
    for (let i = 0; i < out.length; i++) out[i] = s.tracks.x.render();
    return out;
  };
  // pitch deviation in semitones: the best autocorrelation lag within half an octave of the note's period
  const pitchOf = (x, midi) => {
    const T = SR / (440 * 2 ** ((midi - 69) / 12)), N = 4096, st = 24000;
    let best = -1, bl = 0;
    for (let lag = Math.floor(T / 1.41); lag <= Math.ceil(T * 1.41); lag++) {
      let s = 0, e1 = 0, e2 = 0;
      for (let i = 0; i < N; i++) { s += x[st + i] * x[st + i + lag]; e1 += x[st + i] ** 2; e2 += x[st + i + lag] ** 2; }
      const r = s / Math.sqrt(e1 * e2 + 1e-20);
      if (r > best) { best = r; bl = lag; }
    }
    return 12 * Math.log2(T / bl);
  };
  const off = [];
  for (const [name, inst] of [['cello', { type: 'sample', sample: 'cello', env: { a: 0.01, d: 0.1, s: 1, r: 0.3 } }], ['trombone', { type: 'sample', sample: 'trombone', env: { a: 0.01, d: 0.1, s: 1, r: 0.3 } }],
    ['bowed', { type: 'bowed', env: { a: 0.08, d: 0.3, s: 0.9, r: 0.2 }, cutoff: 12000 }]]) {
    for (const midi of name === 'trombone' ? [46, 53, 60, 65] : [36, 43, 50, 57, 64]) {
      const d = pitchOf(note(inst, midi), midi);
      if (!(Math.abs(d) < 0.3)) off.push(`${name} ${midi}: ${d.toFixed(2)}`);
    }
  }
  ok(!off.length, `recorded notes and the bowed string play in tune${off.length ? ` — ${off}` : ''}`);
  const crash = { type: 'drums', kit: { c: { ...KITS.rock.c, sample: 'crash' } }, preset: 'rock' };
  const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
  const rec = note(crash, 'c'), synth = note(crash, 'c', {});
  ok(rms(rec) > 0.001 && rms(synth) > 0.001 && Math.abs(rms(rec) - rms(synth)) > 1e-4, 'drum hits play their recording, and synthesize without the library');
}

// A clip swapped for a copy of its own while it plays (make unique) plays on
{
  const sg = structuredClone(song), e = newEngine(SR, sg, 2);
  run(e, 4, () => {});
  const id = Object.keys(e.tracks).find((k) => e.tracks[k].active && e.tracks[k].block), tr = sg.tracks.find((t) => t.id === id);
  const old = e.tracks[id].block.id, copy = { ...structuredClone(sg.blocks.find((b) => b.id === old)), id: `${old}_2`, color: '#ff5c5c' };
  sg.blocks.push(copy);
  tr.clips = tr.clips.map((x) => (x === old ? copy.id : x));
  e.setSong(structuredClone(sg));
  ok(e.tracks[id].active && e.tracks[id].block?.id === copy.id, 'a clip swapped for its copy while it plays plays on');
}

// A song's zip (Export for a game): the song and the recordings it plays come back as they went in, and only those
{
  const { songZip, openSongZip } = await import('../src/bundle.js');
  const { unzip } = await import('../src/zip.js');
  const { loadSamples, songSamples, LIBRARY_URL } = await import('../src/samples.js');
  const read = async (path) => { const b = readFileSync(new URL(path, LIBRARY_URL)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  const sg = { ...structuredClone(song), name: 'Zipped', instruments: { ...song.instruments, drums: { type: 'drums', kit: 'rock' }, keys: { type: 'sample', sample: 'cello' } } };
  const z = await songZip(sg, read), names = songSamples(sg), { song: back, read: zread } = await openSongZip(z);
  const got = await loadSamples(zread, names), same = names.every((n) => got[n]?.length === SAMPLES[n].length
    && got[n].every((zone, i) => zone.root === SAMPLES[n][i].root && zone.data.length === SAMPLES[n][i].data.length && zone.data.every((x, j) => x === SAMPLES[n][i].data[j])));
  const wavs = unzip(z).names.filter((f) => f.endsWith('.wav')).length, files = new Set(names.flatMap((n) => JSON.parse(readFileSync(new URL('samples.json', LIBRARY_URL))).samples[n].map((zn) => zn.file))).size;
  ok(JSON.stringify(back) === JSON.stringify(sg) && same && wavs === files, `a song's zip holds the song and its recordings (${names.join(', ')}: ${wavs} files), and only those`);
}

// validateSong: a song as written is clean; a broken one says where and what, each mistake once
{
  const { validateSong } = await import('../src/validate.js');
  const samples = Object.keys(SAMPLES), clean = validateSong(song, { samples });
  ok(!clean.errors.length && !clean.warnings.length, `the reference song validates clean${[...clean.errors, ...clean.warnings].map((e) => `\n    ${e}`).join('')}`);
  const bad = structuredClone(song), b = bad.blocks.find((x) => x.pattern);
  b.pattern = b.pattern.replace(/^\S+/, '3x');
  b.sections = { nowhere: 1 };
  bad.tracks[0].clips.push('gone');
  bad.progressions[0].chords = 'i:4 VIII:4';
  bad.instruments.x = { type: 'sample', sample: 'kazoo' };
  bad.tracks.push({ id: 'x', instrument: 'x', clips: [b.id] });
  const { errors } = validateSong(bad, { samples }), has = (...parts) => errors.some((e) => parts.every((p) => e.includes(p)));
  ok(has(`block "${b.id}"`, '"3x" is not a step') && has(`block "${b.id}"`, 'no section "nowhere"') && has(`track "${bad.tracks[0].id}"`, 'no block "gone"')
    && has('"VIII:4" is not a chord') && has('no recording "kazoo"') && errors.length === 5, `a broken song gets one error per mistake (${errors.length})`);
}

// SONG_FORMAT.md: its example song validates clean and plays, and it names every setting there is
{
  const { validateSong, FIELDS } = await import('../src/validate.js');
  const { SOUND_PARAMS } = await import('../src/engine/params.js');
  const doc = readFileSync(new URL('../SONG_FORMAT.md', import.meta.url), 'utf8'), example = JSON.parse(/```json\n([\s\S]*?)```/.exec(doc)[1]);
  const { errors, warnings } = validateSong(example, { samples: Object.keys(SAMPLES) }), h = run(newEngine(SR, example, 1), 20);
  ok(!errors.length && !warnings.length && h.peak > 0.1 && !h.bad, `the example in SONG_FORMAT.md validates clean and plays${[...errors, ...warnings].map((e) => `\n    ${e}`).join('')}`);
  const keys = new Set([...Object.values(FIELDS).flat(), ...SOUND_PARAMS.map(([p]) => p.split('.')[0])]), skip = ['$schema', 'format', 'color', 'track'];
  const missing = [...keys].filter((k) => !skip.includes(k) && !new RegExp(`\\b${k}\\b`).test(doc));
  ok(!missing.length, `SONG_FORMAT.md names every key a song may have${missing.length ? ` — not ${missing}` : ''}`);
}

// dist/ is built from the current src/, and the worklet there (what the player loads) plays on its own, as on the
// audio thread
{
  const { built } = await import('./build.mjs');
  const stale = Object.entries(await built()).filter(([name, text]) => { try { return readFileSync(new URL(`../dist/${name}`, import.meta.url), 'utf8') !== text; } catch { return true; } });
  ok(!stale.length, `dist/ is built from the current src/${stale.length ? ` — npm run build (${stale.map(([n]) => n)})` : ''}`);
  const url = new URL('../dist/worklet.js', import.meta.url);
  let Proc = null;
  Object.assign(globalThis, { sampleRate: SR, registerProcessor: (name, cls) => { Proc = cls; }, AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {} }; } } });
  await import(url.href);
  const p = new Proc(), L = new Float32Array(128), R = new Float32Array(128);
  p.onMessage({ type: 'load', song, seed: 1 });
  let peak = 0;
  for (let i = 0; i < 300; i++) { p.process([], [[L, R]]); for (const x of L) peak = Math.max(peak, Math.abs(x)); }
  ok(peak > 0.05, `the built worklet plays a song without imports (peak ${peak.toFixed(3)})`);
}

// 16. The grid: sections play the blocks placed on their bars, moods play their flow in order (looping from their
// loop point), a mood change comes at the next bar line with a fill, a stinger with then changes the mood at once
{
  const grid = {
    format: 2, name: 'grid', bpm: 120, key: 'C', scale: 'minor',
    instruments: { lead: { type: 'pulse' }, drums: { type: 'drums', kit: 'chip' } },
    tracks: [{ id: 'lead', instrument: 'lead', octave: 5, clips: ['tune', 'tune2'] }, { id: 'drums', instrument: 'drums', clips: ['beat', 'fill', 'hit'] }],
    blocks: [
      { id: 'tune', beats: 4, pattern: '0 - 2 - 4 - 2 - 0 - . . 1 - . .' }, { id: 'tune2', beats: 8, pattern: '4 -*7 2 -*7 0 -*15' },
      { id: 'beat', beats: 4, pattern: 'k . h . s . h . k . h . s . h .' }, { id: 'fill', beats: 4, fill: true, pattern: 's s s s s s s s s s s s s! s! s! s!' },
      { id: 'hit', beats: 4, pattern: 'c! . . . k . . . . . . . . . . .' },
    ],
    progressions: [{ id: 'home', chords: 'i:4 VI:4' }, { id: 'dark', chords: 'iv:4 v:4' }],
    sections: [
      { id: 'intro', bars: 2, blocks: { drums: [{ at: 0, block: 'beat' }] }, chords: [{ at: 0, prog: 'home' }] },
      { id: 'verse', bars: 4, blocks: { drums: [{ at: 0, block: 'beat' }], lead: [{ at: 2, block: 'tune' }] } },
      { id: 'boss', bars: 3, blocks: { drums: [{ at: 0, block: 'beat' }], lead: [{ at: 0, block: 'tune2' }] }, chords: [{ at: 0, prog: 'dark' }] },
    ],
    moods: {
      calm: { flow: [['intro', 1], ['verse', 2]], loopFrom: 'verse' },
      boss: { flow: ['boss'], then: 'stop' },
    },
    stingers: [{ id: 'boss_appears', at: 'beat', beats: 4, then: 'boss', parts: [{ track: 'drums', block: 'hit' }] }],
  };
  const { validateSong } = await import('../src/validate.js');
  const v = validateSong(grid);
  ok(!v.errors.length && !v.warnings.length, `a grid song validates (${[...v.errors, ...v.warnings].join('; ') || 'clean'})`);
  const spbar = 16;
  // ticks, noting each section as it starts: [id, step] (and what plays where, each bar)
  const play = (e, n, seen = []) => { for (let i = 0; i < n; i++) { e.tick(); if (e.sectionBar === 0 && (e.step - 1) % spbar === 0) seen.push([e.section.id, e.step - 1]); } return seen; };
  {
    const e = newEngine(SR, grid, 1), seen = [], lead = [];
    for (let i = 0; i < 18 * spbar; i++) { play(e, 1, seen); if (e.step % spbar === 1) lead.push(e.tracks.lead?.active ? 1 : 0); }
    ok(seen.map((x) => x[0]).join() === 'intro,verse,verse,verse,verse', `a flow plays in order and loops from its loop point (${seen.map((x) => x[0]).join(' → ')})`);
    ok(lead.slice(2, 6).join('') === '0011', `a block plays from the bar it is placed on (lead in the verse: ${lead.slice(2, 6).join('')})`);
    ok(e.prog.id === 'home', 'a section with no chords placed keeps the progression that plays');
  }
  {
    const e = newEngine(SR, grid, 1);
    play(e, 2 * spbar + 5); // in the verse's first bar, 5 steps in
    e.setMood('boss');
    let fill = false;
    const seen = play(e, 3 * spbar, []);
    const at = seen.find((x) => x[0] === 'boss');
    ok(at && at[1] === 3 * spbar, `a mood change comes at the next bar line (boss at step ${at?.[1]}, the line at ${3 * spbar})`);
    const e2 = newEngine(SR, grid, 1);
    play(e2, 2 * spbar + 5);
    e2.setMood('boss');
    fill = !!e2.tracks.drums.fill && e2.tracks.drums.fill.end === 3 * spbar && e2.tracks.drums.fill.start === 2 * spbar + 5;
    ok(fill, 'the drums fill the rest of the bar before it');
    const e3 = newEngine(SR, grid, 1);
    play(e3, 2 * spbar + 14); // less than a beat left: the bar after
    e3.setMood('boss');
    const s3 = play(e3, 3 * spbar, []).find((x) => x[0] === 'boss');
    ok(s3 && s3[1] === 4 * spbar, `less than a beat before the line: the bar after (boss at step ${s3?.[1]})`);
    const after = play(e3, 4 * spbar, []);
    ok(after.some((x) => x[0] === 'end') && e3.tracks.lead.active === false, `a flow that stops ends in silence (${after.map((x) => x[0]).join(' → ')})`);
    e3.setMood('calm');
    const back = play(e3, 3 * spbar, []);
    ok(back[0]?.[0] === 'verse', `a mood comes back at its loop point (${back.map((x) => x[0]).join(' → ')})`);
  }
  {
    const e = newEngine(SR, grid, 1);
    play(e, 2 * spbar + 6);
    e.sting('boss_appears'); // on the next beat (step 40), 4 beats: ends at step 56, mid-bar
    const seen = play(e, 2 * spbar, []);
    const at = seen.find((x) => x[0] === 'boss');
    ok(at && at[1] === 3 * spbar + 8 + (spbar - 8), `a stinger with then switches the mood as it ends, its end the new bar line (boss at ${at?.[1]})`);
    ok(e.moodName === 'boss', 'and the mood is the stinger\'s then');
  }
  {
    const e = newEngine(SR, grid, 1);
    play(e, spbar + 5); // in the intro's second bar
    e.seek('calm', 1, 3); // the verse's bar 4: the lead's tune (from bar 3) one bar in
    play(e, 1);
    ok(e.section.id === 'verse' && e.sectionBar === 3, `seek jumps at once, to the bar (${e.section.id}, bar ${e.sectionBar + 1}, at step ${e.step - 1})`);
    const ts = e.tracks.lead;
    ok(ts.active && ts.block.id === 'tune' && e.step - 1 - ts.start === spbar, `a block placed before the bar plays on from where it would be (${e.step - 1 - ts.start} steps in)`);
    ok(e.flowPos.mood === 'calm' && e.flowPos.i === 1, 'and the flow goes on from there');
    const e2 = newEngine(SR, grid, 1);
    e2.seek('boss', 0, 2); // before the music started
    play(e2, 1);
    ok(e2.section.id === 'boss' && e2.sectionBar === 2 && e2.moodName === 'boss' && e2.prog.id === 'dark', `seek before it plays starts there (${e2.section.id}, bar ${e2.sectionBar + 1})`);
  }
}

// 17. Effect tracks: an effect block moves its setting across the bars it is placed on, on the tracks its row targets
// ("*": the whole mix), and back once it ends; a muted row moves nothing
{
  const { validateSong } = await import('../src/validate.js');
  const fxSong = (target, extra = {}) => ({
    format: 2, name: 'fx', bpm: 120, key: 'C', scale: 'minor',
    instruments: { lead: { type: 'pulse' }, drums: { type: 'drums', kit: 'chip' } },
    tracks: [{ id: 'lead', instrument: 'lead', octave: 5, clips: ['tune'] }, { id: 'drums', instrument: 'drums', clips: ['beat'] }],
    effectTracks: [{ id: 'fx', target, ...extra, clips: ['sweep', 'quiet', 'chop'] }],
    blocks: [
      { id: 'tune', beats: 4, pattern: '0 - 2 - 4 - 2 - 0 - 4 - 2 - 4 -' }, { id: 'beat', beats: 4, pattern: 'k . h . s . h . k . h . s . h .' },
      { id: 'sweep', fx: { kind: 'filter', from: 16000, to: 250 } }, { id: 'quiet', fx: { kind: 'volume', from: 0, to: 0, shape: 'hold' } },
      { id: 'chop', fx: { kind: 'gate', from: 1, to: 1, rate: 0.5 } },
    ],
    progressions: [{ id: 'home', chords: 'i:4 VI:4' }],
    sections: [
      { id: 'a', bars: 4, blocks: { lead: [{ at: 0, block: 'tune' }], drums: [{ at: 0, block: 'beat' }], fx: [{ at: 0, block: 'sweep' }, { at: 2, block: 'quiet' }] }, chords: [{ at: 0, prog: 'home' }] },
      { id: 'b', bars: 2, blocks: { lead: [{ at: 0, block: 'tune' }], fx: [{ at: 0, block: 'chop' }] } },
      { id: 'c', bars: 2, blocks: { lead: [{ at: 0, block: 'tune' }] } },
    ],
    moods: { calm: { flow: ['a', 'b', 'c'] } },
  });
  const v = validateSong(fxSong('*'));
  ok(!v.errors.length && !v.warnings.length, `a song with an effect track validates (${[...v.errors, ...v.warnings].join('; ') || 'clean'})`);
  const bad = validateSong({ ...fxSong('nope'), blocks: [...fxSong('*').blocks, { id: 'wrong', fx: { kind: 'wobble' } }] });
  ok(bad.errors.some((x) => x.includes('no track "nope"')) && bad.errors.some((x) => x.includes('"kind"')), `and a wrong target or kind is an error (${bad.errors.length})`);
  const ticks = (e, n) => { for (let i = 0; i < n; i++) e.tick(); };
  {
    const e = newEngine(SR, fxSong('*'), 1);
    ticks(e, 16); // bar 1 of the sweep's 2: halfway at the end of the step
    const lp = e.moved['*']?.filter;
    ok(lp > 1700 && lp < 2300, `an effect block on "*" moves the whole mix, along its curve (the low pass halfway: ${Math.round(lp)} Hz)`);
    ok(!e.moved.lead && !e.moved.drums, 'and not each track');
    ticks(e, 17);
    ok(e.moved['*']?.volume === 0 && e.moved['*'].filter === undefined, 'the next block on the row takes over at its bar');
    ticks(e, 32);
    ok(e.moved['*']?.gate === 1 && e.moved['*'].rate === 0.5, 'into the next section: its own row');
    ticks(e, 32);
    ok(!Object.keys(e.moved).length, 'a section with nothing on the row: nothing moves');
  }
  {
    const e = newEngine(SR, fxSong(['lead']), 1);
    ticks(e, 16);
    ok(e.moved.lead?.filter > 0 && !e.moved.drums && !e.moved['*'], 'targets: only the tracks it names');
    const e2 = newEngine(SR, fxSong('*', { except: ['drums'] }), 1);
    ticks(e2, 16);
    ok(e2.moved.lead?.filter > 0 && !e2.moved.drums && !e2.moved['*'], '"*" with except: every track but those');
    const e3 = newEngine(SR, fxSong('*'), 1);
    e3.setMute('fx', true);
    ticks(e3, 16);
    ok(!Object.keys(e3.moved).length, 'a muted effect row moves nothing');
  }
  {
    // the sound: silent under volume 0, clean through the sweep and the gate, back once nothing moves
    const e = newEngine(SR, fxSong('*'), 1);
    const L = new Float32Array(128), R = new Float32Array(128); // 2 s a bar at 120 bpm
    const peakOver = (secs) => { let p = 0, bad = 0; for (let i = 0; i < secs * SR; i += 128) { e.process(L, R, 128); for (let j = 0; j < 128; j++) { if (!Number.isFinite(L[j])) bad++; p = Math.max(p, Math.abs(L[j])); } } return { p, bad }; };
    const sweep = peakOver(4.2), quiet = peakOver(3.6), chop = peakOver(4), plain = peakOver(4);
    ok(sweep.bad + quiet.bad + chop.bad + plain.bad === 0, 'no NaN/Inf through the moves');
    ok(quiet.p < 0.01 && sweep.p > 0.05 && plain.p > 0.05, `volume 0 silences the mix, and it comes back (${sweep.p.toFixed(2)} → ${quiet.p.toFixed(3)} → ${plain.p.toFixed(2)})`);
    ok(!e.synth.mix.on, 'once nothing moves, the mix runs as before');
  }
}

// 18. Game sounds: an instrument and a note. Each layer type and each effect renders clean and dies away; moves get
// where they go; vary 0 repeats, vary changes; key tunes to the chord (a step to the next chord tone); at 'beat' waits
// for the beat; a sound plays while the song is held; a duck quietens the music; an older sound converts
{
  const { renderSound, soundOf, soundLength } = await import('../src/engine/sfx.js');
  const { LAYER_TYPES, LAYER_MOVE_PARAMS, migrateSound } = await import('../src/engine/inst.js');
  const { migrateSong } = await import('../src/engine/plays.js');
  const { valueAt, movesOf, fxList, EFFECT_KINDS, fxParams } = await import('../src/engine/fx.js');
  const { validateSong } = await import('../src/validate.js');
  const peak = (a, from = 0, to = a.length) => { let p = 0; for (let i = from; i < to; i++) p = Math.max(p, Math.abs(a[i])); return p; };
  const fine = (b) => b.every(Number.isFinite) && peak(b) > 0.02 && peak(b) < 1.2 && Math.abs(b[b.length - 1]) < 0.02;
  const env = { a: 0.005, d: 0.2, s: 0, r: 0.05 };
  const types = LAYER_TYPES.filter((t) => t !== 'sample').filter((type) => !fine(renderSound({ length: 0.3, layers: [{ type, env, noise: 0.3, moves: [{ on: 'pitch', to: -24 }, { on: 'pitch', shape: 'wave', to: 2, rate: 8 }, { on: 'duty', to: 0.1, every: 0.05 }] }] })));
  ok(!types.length, `every layer type renders clean, and dies away at its end${types.length ? ` — ${types}` : ''}`);
  const fxBad = Object.keys(EFFECT_KINDS).filter((kind) => {
    const spec = fxParams(kind, false), [k] = Object.keys(spec), moves = k ? [{ on: k, shape: 'hump', to: spec[k].max }] : undefined;
    return !fine(renderSound({ note: 57, length: 0.3, layers: [{ type: 'wave', wave: 'saw', smooth: true, env }, { type: 'noise', level: 0.5, delay: 0.05, env }], fx: [{ kind, ...(kind === 'filter' && { type: 'band' }), moves }] }));
  });
  ok(!fxBad.length, `every effect renders clean, its first setting moving${fxBad.length ? ` — ${fxBad}` : ''}`);
  const mv = (m) => movesOf([{ on: 'pitch', to: 12, ...m }], LAYER_MOVE_PARAMS, { len: 0.25 });
  const ramp = mv({}), step = mv({ shape: 'step', at: 0.5 }), again = mv({ every: 0.1 }), P = LAYER_MOVE_PARAMS.pitch;
  ok(Math.abs(valueAt(0, 'pitch', ramp, P, 0.125) - 6) < 1e-9 && valueAt(0, 'pitch', step, P, 0.1) === 0
    && valueAt(0, 'pitch', step, P, 0.13) === 12 && valueAt(0, 'pitch', again, P, 0.1) === 0,
    'a pitch ramps in semitones (halfway: a tritone), steps at its point, and starts over every so often');
  ok(Math.abs(soundLength(soundOf({ length: 0.2, layers: [{ env: { a: 0.01, d: 0.1, s: 0, r: 0.1 } }, { delay: 0.1, env: { a: 0.01, s: 1, r: 0.2 } }] })) - 0.5) < 1e-9, 'a sound lasts until its last layer is quiet');
  const a = renderSound({ layers: [{}], vary: 0 }, { seed: 1 }), b = renderSound({ layers: [{}], vary: 0 }, { seed: 2 }), c = renderSound({ layers: [{}], vary: 0.8 }, { seed: 2 });
  ok(a.length === b.length && a.every((x, i) => x === b[i]) && c.length !== a.length, 'vary 0: every play the same; vary: they differ');
  const was = migrateSound({ id: 'x', layers: [{ wave: 'square', pitch: 880, length: 0.2, moves: [{ on: 'pitch', to: 1760 }] }, { wave: 'noise', pitch: 440, delay: 0.1 }] });
  const wl = was.inst?.layers || [];
  ok(was.note === 81 && was.length === 0.35 && wl[0]?.type === 'pulse' && wl[0].moves[0].to === 12 && wl[1]?.type === 'noise' && wl[1].pitch === -12 && !was.layers,
    'an older sound becomes a note and an instrument\'s layers: pitches in semitones from the first, its slide too');
  const flat = migrateSound({ id: 'f', note: 60, volume: 0.5, key: true, unison: 2, layers: [{ type: 'fm' }], fx: [{ kind: 'drive' }] }), now = migrateSound(flat);
  ok(flat.id === 'f' && flat.note === 60 && flat.volume === 0.5 && flat.key === true && flat.inst.unison === 2 && flat.inst.layers[0].type === 'fm' && flat.inst.fx[0].kind === 'drive' && !flat.fx && now === flat,
    'a sound with its instrument beside its note gets an inst; one with an inst stays as it is');
  // a move or an effect keeps its own clock: beats at the song's tempo, or Hz; with neither, where it plays
  const clk = movesOf([{ on: 'pitch', to: 1, beats: 0.5 }, { on: 'pitch', to: 1, shape: 'wave', rate: 4 }, { on: 'pitch', to: 1 }], LAYER_MOVE_PARAMS, { music: false, bps: 2, len: 0.3 });
  const trk = movesOf([{ on: 'pitch', to: 1, shape: 'wave', rate: 4 }, { on: 'pitch', to: 1 }], LAYER_MOVE_PARAMS, { music: true, bps: 2 });
  const fxs = fxList([{ kind: 'tremolo', beats: 0.5 }, { kind: 'phaser', rate: 3 }, { kind: 'chorus' }], false);
  ok(clk[0].len === 0.25 && clk[1].rate === 4 && clk[2].len === 0.3 && trk[0].rate === 4 && trk[1].len === 0.5 && fxs[0].beats === 0.5 && fxs[0].rate === undefined && fxs[1].rate === 3 && fxs[2].rate !== undefined,
    'moves and effects keep their own clock (beats or Hz), else where they play');
  const hoist = migrateSong({ instruments: { jump: { layers: [{}] } }, tracks: [], blocks: [], sounds: [{ id: 'jump', note: 60, layers: [{ type: 'noise' }] }, { id: 'zap', inst: { layers: [{ type: 'fm' }] } }, { id: 'lead', instrument: 'jump' }] });
  ok(hoist.sounds[0].instrument === 'jump_2' && hoist.instruments.jump_2.layers[0].type === 'noise' && hoist.instruments.zap.layers[0].type === 'fm' && hoist.sounds[1].instrument === 'zap' && !hoist.sounds[1].inst && hoist.sounds[2].instrument === 'jump' && migrateSong(hoist).sounds === hoist.sounds,
    'a sound\'s own instrument joins the song\'s, under its id; one that names an instrument stays');
  const song = {
    format: 2, name: 'sfx', bpm: 120, key: 'C', scale: 'major',
    instruments: { pad: { layers: [{ type: 'pulse' }] }, coin: { layers: [{ moves: [{ on: 'pitch', shape: 'step', to: 4, at: 0.3 }] }] },
      boom: { layers: [{ type: 'noise' }], fx: [{ kind: 'filter', cutoff: 800, moves: [{ on: 'cutoff', to: 100 }] }] } },
    tracks: [{ id: 'pad', instrument: 'pad', octave: 4, clips: ['hold'] }],
    blocks: [{ id: 'hold', beats: 4, pattern: '* - - - - - - - - - - - - - - -' }], progressions: [{ id: 'p', chords: 'I:4' }],
    sections: [{ id: 'a', bars: 4, blocks: { pad: [{ at: 0, block: 'hold' }] }, chords: [{ at: 0, prog: 'p' }] }], moods: { calm: { flow: ['a'] } },
    sounds: [{ id: 'coin', instrument: 'coin', note: 83, key: true, at: 'beat', vary: 0 }, { id: 'boom', instrument: 'boom', note: 30, length: 0.8, duck: 0.8 }, { id: 'pad', instrument: 'pad', note: 60 }],
  };
  const v = validateSong(song), bad = validateSong({ ...song, sounds: [{ id: 'x', layers: [{ type: 'kazoo', pitch: 'high', moves: [{ on: 'tone', to: 1 }] }], fx: [{ kind: 'fuzz' }], at: 'later' }] });
  const kit = validateSong({ ...song, instruments: { ...song.instruments, kit: { type: 'drums' } }, sounds: [{ id: 'k', instrument: 'kit' }, { id: 'n', instrument: 'nope' }] });
  ok(!v.errors.length && !v.warnings.length && bad.errors.length === 5 && kit.errors.length === 2,
    `sounds validate (older ones too), and a wrong type, number, move, effect or at is an error, as are a kit or an instrument the song lacks (${[...v.errors, ...v.warnings, ...bad.errors, ...kit.errors].join('; ')})`);
  const e = newEngine(SR, song, 1);
  ok(e.snap(84.3) === 84 && e.snap(84, 1) === 88 && e.snap(84, -1) === 79 && e.snap(90) === 91, 'key: the nearest tone of the chord (C: C E G), above or below');
  const L = new Float32Array(SR), R = new Float32Array(SR);
  e.process(L, R, 100);
  ok(e.sound('coin') && e.sfxQ.length === 1 && !e.sound('nope'), 'a sound "at beat" waits; a sound the song lacks plays nothing');
  e.process(L, R, (SR >> 1) + 100);
  ok(!e.sfxQ.length && e.synth.sfx.some((x) => !x.done), 'on the beat it plays');
  const pl = e.synth.sfx.find((x) => !x.done).p, m = pl.note, mt = m + pl.def.layers[0].moves[0].to;
  ok(Math.abs(m - Math.round(m)) < 1e-6 && [0, 4, 7].includes(Math.round(m) % 12) && [0, 4, 7].includes(Math.round(mt) % 12) && Math.round(mt) > Math.round(m),
    `it is tuned to the chord, its step up to the next chord tone (${Math.round(m)} → ${Math.round(mt)})`);
  const h = newEngine(SR, song, 1);
  h.setHold(true);
  h.sound('coin');
  h.process(L, R, SR >> 2);
  ok(peak(L) > 0.05, 'held, a sound plays at once');
  const d = newEngine(SR, { ...song, sounds: [{ id: 'boom', note: 30, length: 1, inst: { layers: [{ type: 'wave', wave: 'sine', smooth: true, level: 0.01 }] }, duck: 0.8 }] }, 1); // its own instrument (taken into the song)
  d.process(L, R, SR); const before = peak(L);
  d.sound('boom'); d.process(L, R, SR >> 1); const under = peak(L, SR >> 3, SR >> 1);
  ok(under < before * 0.5, `duck: the music gets quieter under the sound (${before.toFixed(2)} → ${under.toFixed(2)})`);
}

// 19. Layers: an older instrument's source becomes its first layer; two layers sound together, the second at its own
// pitch and after its delay; a muted layer is silent; a layer's pitch move starts again on every note, in beats
{
  const { compileInst, Voice, timeMoves } = await import('../src/engine/voice.js');
  const { migrateInstrument } = await import('../src/engine/inst.js');
  const m = migrateInstrument({ type: 'wave', wave: 'saw', env: { a: 0.1 }, unison: 2, cutoff: 900 });
  ok(m.layers?.[0]?.type === 'wave' && m.layers[0].env.a === 0.1 && m.unison === 2 && m.fx[0].kind === 'filter' && m.type === undefined, 'an older instrument: its source is the first layer, its filter an effect');
  ok(migrateInstrument({ type: 'drums', kit: 'clean' }).layers === undefined, 'a drum kit has no layers');
  // the strongest frequency of a buffer (by a scan of the DFT around the guesses)
  const power = (buf, f) => { let re = 0, im = 0; for (let i = 0; i < buf.length; i++) { re += buf[i] * Math.cos((2 * Math.PI * f * i) / SR); im += buf[i] * Math.sin((2 * Math.PI * f * i) / SR); } return Math.hypot(re, im) / buf.length; };
  const play = (def, n = SR >> 2, bps = 2) => {
    const p = compileInst(def, SR); timeMoves(p, { music: true, bps });
    const v = new Voice(); v.start(p, 57, 1, null);
    return Float32Array.from({ length: n }, () => v.render(p));
  };
  const sine = { type: 'wave', wave: 'sine', smooth: true, env: { a: 0.001, s: 1 } };
  const two = play({ layers: [sine, { ...sine, pitch: 12, delay: 0.1 }] });
  const early = two.subarray(0, SR / 20), late = two.subarray(SR * 0.15, SR * 0.2);
  ok(power(early, 220) > 0.2 && power(early, 440) < 0.02 && power(late, 440) > 0.2, 'a second layer an octave up comes in after its delay');
  const muted = play({ layers: [sine, { ...sine, pitch: 12, off: true }] }).subarray(0, SR / 20);
  ok(power(muted, 440) < 0.02, 'a muted layer is silent');
  const slide = play({ layers: [{ ...sine, moves: [{ on: 'pitch', to: 12, beats: 0.25 }] }] }, SR >> 1); // a quarter beat at 2 beats a second: 125 ms
  ok(power(slide.subarray(SR * 0.2, SR * 0.25), 440) > 0.2, 'a pitch move gets there in its beats');
  // drawbars: A3 at '808000000' sounds the 16′ (110 Hz) and the 8′ (220 Hz), nothing at 5⅓′ (330 Hz); a drawbar at 5 is 9 dB down
  // measured over 0.4 s through a Hann window: a short plain window lets the 220 Hz bar leak into 330 Hz by as much
  // as the threshold, more or less with the random phase each note starts at
  const hann = (buf, f) => { let re = 0, im = 0, sw = 0; for (let i = 0; i < buf.length; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (buf.length - 1)), a = (2 * Math.PI * f * i) / SR; re += w * buf[i] * Math.cos(a); im += w * buf[i] * Math.sin(a); sw += w; } return Math.hypot(re, im) / sw; };
  const bars = play({ layers: [{ type: 'wave', drawbars: '808000000', env: { a: 0.001, s: 1 } }] }, SR >> 1).subarray(SR / 10);
  const half = play({ layers: [{ type: 'wave', drawbars: '805000000', env: { a: 0.001, s: 1 } }] }, SR >> 1).subarray(SR / 10);
  ok(hann(bars, 110) > 0.1 && hann(bars, 220) > 0.1 && hann(bars, 330) < 0.005 && Math.abs(20 * Math.log10(hann(half, 220) / hann(half, 110)) + 9) < 1, 'drawbars: each a sine at its footage, a step 3 dB');
}

{
  // the leslie: the horn gets to fast in about a second, the drum in about four, slowing takes longer; the treble moves
  const { FxChain } = await import('../src/engine/fx.js');
  const fx = new FxChain(SR), L = { kind: 'leslie', speed: 1, depth: 0.7, ramp: 1 };
  fx.set([L], { music: true, bps: 2 });
  let bad = false, pans = [];
  const run = (sec) => { for (let i = 0; i < sec * SR; i++) { const y = fx.run(Math.sin(i * 0.06) * 0.5, 1); if (!(Math.abs(y) < 2)) bad = true; if (!(i & 511)) pans.push(fx.pan); } };
  run(1);
  const [horn, drum] = fx.stages[0].rot;
  fx.set([{ ...L, speed: 2 }], { music: true, bps: 2 });
  run(1);
  const h1 = horn.hz, d1 = drum.hz;
  run(4);
  ok(h1 > 6 && d1 < 4 && drum.hz > 5.5 && !bad, `a leslie speeds up, the horn first (after 1 s: horn ${h1.toFixed(1)} Hz, drum ${d1.toFixed(1)} Hz)`);
  fx.set([{ ...L, speed: 1 }], { music: true, bps: 2 });
  run(1);
  ok(horn.hz > 1.2 && horn.hz < 3 && Math.min(...pans) < -0.3 && Math.max(...pans) > 0.3, 'and slows down more slowly, the horn moving it from side to side');
}

// 20. Tines, picks, bite and the ensemble: an FM ratio up to 16 stays clean on high notes; a string plucked at its
// middle has no even harmonics, at a quarter no 4th; a filter's bite: quiet notes ring less at its peak; the
// ensemble chorus keeps the level
{
  const { compileInst, Voice, timeMoves } = await import('../src/engine/voice.js');
  const { FxChain } = await import('../src/engine/fx.js');
  const note = (def, m, n = SR / 2) => { const p = compileInst(def, SR); timeMoves(p, { music: true, bps: 2 }); const v = new Voice(); v.start(p, m, 0.8, null); const o = new Float64Array(n); for (let i = 0; i < n; i++) o[i] = v.render(p); return o; };
  const harm = (x, f, from = SR / 20) => { let re = 0, im = 0; for (let i = from; i < x.length; i++) { const w = (2 * Math.PI * f * i) / SR; re += x[i] * Math.cos(w); im += x[i] * Math.sin(w); } return Math.hypot(re, im) / (x.length - from); };
  const db = (a, b) => 20 * Math.log10(a / b);
  let bad = 0;
  for (const m of [36, 72, 96, 108]) for (const v of note({ layers: [{ type: 'fm', fm: { ratio: 16, index: 3 }, env: { a: 0.001, s: 1 } }] }, m, SR / 5)) if (!(Math.abs(v) < 2)) bad++;
  ok(!bad, 'an FM ratio of 16 plays clean from C2 to C8');
  const pluck = (position) => note({ layers: [{ type: 'string', string: { decay: 3, bright: 0.8, position }, env: { a: 0.001, s: 1 } }] }, 57);
  // each pluck is a new burst of noise: the harmonics over eight of them
  const plucks = (position) => Array.from({ length: 8 }, () => pluck(position)), h = (xs, k) => Math.sqrt(xs.reduce((a, x) => a + harm(x, 220 * k) ** 2, 0));
  const mid = plucks(0.5), qtr = plucks(0.25);
  ok(db(h(mid, 2), h(mid, 1)) < -25 && db(h(mid, 4), h(mid, 1)) < -20 && db(h(qtr, 4), h(qtr, 1)) < -20 && db(h(qtr, 2), h(qtr, 1)) > -12,
    'a string plucked at its middle loses its even harmonics, at a quarter its 4th');
  const peak = (bite, loud) => { const fx = new FxChain(SR); fx.set([{ kind: 'filter', cutoff: 1000, resonance: 4, bite }], { music: true, bps: 2 }); let e = 0, r = 1; for (let i = 0; i < SR / 2; i++) { r = (r * 16807) % 2147483647; const y = fx.run((r / 2147483647 - 0.5) * loud, loud); e += y * y; } return Math.sqrt(e) / loud; };
  ok(Math.abs(peak(0, 0.3) / peak(0, 1) - 1) < 0.02 && peak(1, 0.3) < 0.75 * peak(1, 1) && Math.abs(peak(1, 1) / peak(0, 1) - 1) < 0.02, 'a filter\'s bite: the peak rings less on quiet notes, as set on loud ones');
  const level = (mode) => { const fx = new FxChain(SR); fx.set([{ kind: 'chorus', depth: 0.8, rate: 0.6, mode }], { music: false }); let e = 0, ex = 0, ok = true; for (let i = 0; i < SR; i++) { const x = Math.sin((i * 2 * Math.PI * 220) / SR) * 0.5; const y = fx.run(x, 1); if (!Number.isFinite(y)) ok = false; e += y * y; ex += x * x; } return ok ? 10 * Math.log10(e / ex) : NaN; };
  ok(Math.abs(level('ensemble') - level()) < 1.5, `the ensemble chorus plays at the chorus's level (${level('ensemble').toFixed(1)} dB / ${level().toFixed(1)} dB)`);
}

// 21. Guitars: chords fingered as a guitarist does (open, barre, power, the top strings); a strum plays its strings in
// turn, low to high down and high to low up; on a guitar the strings ring on through the next stroke, a downstroke
// damps the ones it leaves out, a rest every one; a dead strum dies at once; legato on a string: a note a step away
// from one held is a hammer-on, not picked again
{
  const { chordFrets, fretText, chordNotes, guitarStrings } = await import('../src/engine/guitar.js');
  const chord = (root, ivs, shape) => fretText(chordFrets(root, ivs.map((i) => (root + i) % 12), shape));
  const MAJ = [0, 4, 7], MIN = [0, 3, 7];
  ok(chord(0, MAJ) === 'x32010' && chord(7, MAJ) === '320003' && chord(2, MAJ) === 'xx0232' && chord(9, MIN) === 'x02210' && chord(4, MIN) === '022000' && chord(5, MAJ) === '133211' && chord(11, MIN) === 'x24432',
    `open chords: C ${chord(0, MAJ)}, G ${chord(7, MAJ)}, D ${chord(2, MAJ)}, Am ${chord(9, MIN)}, Em ${chord(4, MIN)}, F ${chord(5, MAJ)}, Bm ${chord(11, MIN)}`);
  ok(chord(9, MAJ, 'barre') === '577655' && chord(0, MAJ, 'barre') === 'x35553' && chord(4, MAJ, 'power') === '022xxx' && chord(0, MAJ, 'power') === 'x355xx' && /^xxx/.test(chord(0, MAJ, 'high')),
    `barre ${chord(9, MAJ, 'barre')} ${chord(0, MAJ, 'barre')}, power ${chord(4, MAJ, 'power')} ${chord(0, MAJ, 'power')}, high ${chord(0, MAJ, 'high')}`);
  const c = chordNotes(0, MAJ, 'open'), str = (a) => guitarStrings(c, a).map((x) => x.m).join(' ');
  ok(str('D') === '48 52 55 60 64' && str('U') === '64 60 55 52' && str('B') === '48' && str('A') === '52' && str('S1') === '64' && str('S3') === '55',
    'D plays the strings up from the root, U the top four down, B the root, A the string above, S1 the highest');
  // a song of one guitar track: notes as they start (the synth's strike), and the voices sounding
  const gsong = (pattern, inst = {}) => ({ name: 'g', bpm: 120, key: 'C', scale: 'major', humanize: 0, variation: 0, blockChange: 0, fillChance: 0, layerChurn: 0, leadIn: 0,
    instruments: { g: { poly: 6, guitar: { strum: 10 }, layers: [{ type: 'string', string: { decay: 4, bright: 0.6 }, env: { a: 0.001, d: 1, s: 1, r: 0.2 } }], ...inst } },
    tracks: [{ id: 'g', instrument: 'g', octave: 3, volume: 0.3, clips: ['b'] }], blocks: [{ id: 'b', beats: 4, pattern, mutate: 0 }],
    sections: [{ id: 's', bars: [4] }], progressions: [{ id: 'p', chords: 'I:16' }] });
  const watch = (song, secs) => {
    const e = newEngine(SR, song, 1), bus = () => e.synth.tracks.g, hits = [], L = new Float32Array(128), R = new Float32Array(128);
    let t = 0;
    const strike = e.synth.strike.bind(e.synth);
    e.synth.strike = (id, m, s, vel, short, first) => { hits.push({ t, m, s, short }); strike(id, m, s, vel, short, first); };
    const ringing = [];
    for (; t < secs * SR; t += 128) { e.process(L, R, 128); ringing.push(bus().voices.filter((v) => v.gate).length); }
    return { hits, ringing, e };
  };
  const down = watch(gsong('D - - - U - - - D - - - . . . .'), 2);
  const first = down.hits.filter((h) => h.t < SR / 4), up = down.hits.filter((h) => h.t >= 0.45 * SR && h.t < 0.75 * SR); // the beats at 0 and 0.5 s
  const gaps = first.slice(1).map((h, i) => h.t - first[i].t);
  ok(first.map((h) => h.m).join(' ') === '48 52 55 60 64' && gaps.every((g) => g >= 0.004 * SR && g <= 0.016 * SR) && up.map((h) => h.m).join(' ') === '64 60 55 52',
    `a downstroke plays C's strings low to high, about 10 ms apart (${gaps.map((g) => Math.round((g / SR) * 1000)).join(' ')} ms), the upstroke the top four back down`);
  const at = (sec) => down.ringing[Math.floor((sec * SR) / 128)];
  ok(at(0.8) === 5 && at(1.8) === 0, `the strings ring on through the upstroke (${at(0.8)} sounding), a rest damps them all (${at(1.8)})`);
  const power = watch(gsong('D - - - D - - - . . . . . . . .', { guitar: { strum: 10, shape: 'power' } }), 0.4);
  ok(power.hits.map((h) => h.m).join(' ') === '48 55 60', 'power chords: the root, fifth and octave (C3 G3 C4 for C)');
  const dead = watch(gsong('X - - - . . . . . . . . . . . .'), 0.3);
  ok(dead.hits.length === 5 && dead.hits.every((h) => h.short === 2), 'a dead strum (X) plays every string damped');
  // legato: a note a step from a held one is not picked again (the string's loop is not refilled)
  const { compileInst, Voice } = await import('../src/engine/voice.js');
  const p = compileInst({ legato: true, layers: [{ type: 'string', string: { decay: 4 } }] }, SR), v = new Voice();
  v.start(p, 60, 0.8, null);
  for (let i = 0; i < SR / 10; i++) v.render(p);
  const before = v.osc[0].kb.slice(), was = v.osc[0].kw;
  v.start(p, 62, 0.8, null);
  const same = v.osc[0].kw === was && v.osc[0].kb.every((x, i) => x === before[i]);
  v.start(p, 69, 0.8, null);
  ok(same && v.osc[0].kb.some((x, i) => x !== before[i]), 'legato: a note a step from a held one is a hammer-on (not picked again), a leap is picked');
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
