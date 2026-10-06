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
  ok(m.instruments.pad.cutoff === 1300 && m.instruments.pad.cutoffIntensity === undefined, `a filter that followed the mood stays where it sat on average (${m.instruments.pad.cutoff} Hz)`);
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
  const { AMPS } = await import('../src/engine/synth.js');
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
  const { BODIES } = await import('../src/engine/synth.js');
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
  const { compileInst } = await import('../src/engine/synth.js');
  if (compileInst({ ...snd, eq: { low: 0, mid: 0, midHz: 1000, high: 0 } }, SR).eq !== null) off.push('a flat EQ is not left out');
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

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
