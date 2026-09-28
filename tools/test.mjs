// node tools/test.mjs — engine sanity checks (determinism, mood routing, hot reload, audio health, stingers, theme)
import { readFileSync, readdirSync } from 'node:fs';
import { Engine } from '../src/engine/engine.js';
import { degSemis, foldDegree, prepareSong } from '../src/engine/theory.js';
import { starterSong, addTrack, removeTrack, songLike, emptySong, upgradeSong, playInstrument } from '../src/editor/library.js';
import { playsIn, setPlaysIn, togglePlaysIn, everywhere, renameTag } from '../src/editor/tags.js';
import { songParts, insertPart, clipTarget } from '../src/editor/parts.js';
import { stacksNotes } from '../src/editor/util.js';
import { clipsOf, tracksOf, linkClips, putClip, takeClip, renameClip } from '../src/editor/clips.js';
import { diskSamples } from './load-samples.mjs';
import { KITS } from '../src/engine/drums.js';

const SAMPLES = await diskSamples();
// an engine with the sample library loaded, as the player has it
const newEngine = (sr, song, seed) => { const e = new Engine(sr, song, seed); e.setSamples(SAMPLES); return e; };

const song = JSON.parse(readFileSync(new URL('../songs/deep-space.json', import.meta.url), 'utf8'));
const SR = 44100;
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) failed++; };

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
  const e = newEngine(SR, { ...song, breath: { every: 16, bars: [4, 4] } }, 3);
  let inBreath = null, after = null;
  run(e, 480, () => {
    for (const ev of e.drainEvents()) if (ev.type === 'state') {
      const active = Object.entries(ev.tracks).filter(([, t]) => t.active).map(([id]) => id);
      if (ev.section === 'breather') inBreath ||= active;
      else if (inBreath && !after && ev.section) after = ev.section;
    }
  });
  ok(inBreath && inBreath.every((id) => (song.tracks.find((t) => t.id === id).layer?.min ?? 0) <= 0), `breather keeps only ambient tracks (${inBreath})`);
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

// 8. Theme: theme blocks restate the song theme in varied forms, notes on the beat fit the chord
{
  const e = newEngine(SR, { ...song, humanize: 0 }, 4); // no late notes: the check reads the step a note starts on
  const forms = new Set();
  let onBeat = 0, fits = 0;
  const noteOn = e.synth.noteOn.bind(e.synth);
  e.synth.noteOn = (id, midis, vel) => {
    const ts = e.tracks[id];
    if (ts?.block?.theme && !e.curSting && e.step % e.song.spb === 0) {
      const sc = e.scaleNow(), root = foldDegree(e.chord.degree, sc.length);
      const pcs = e.chord.shape.map((o) => (((e.song.keyRoot + degSemis(sc, root + o)) % 12) + 12) % 12);
      onBeat++;
      if (pcs.includes(midis[0] % 12)) fits++;
    }
    noteOn(id, midis, vel);
  };
  run(e, 600, (t, en) => { for (const ev of en.drainEvents()) if (ev.type === 'log' && ev.text.startsWith('♪')) forms.add(ev.text.split(' ')[2]); });
  ok(forms.size >= 4, `the theme comes back in different forms (${[...forms]})`);
  ok(onBeat > 10 && fits === onBeat, `theme notes on the beat are chord tones (${fits}/${onBeat})`);
}

// 9. Every song in songs/ and the starter song: healthy audio, each mood reached, each stinger plays, the theme comes back
const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const lib = readJson('../library/instruments.json');
const toCheck = readdirSync(new URL('../songs/', import.meta.url)).filter((f) => f.endsWith('.json')).map((f) => [f, readJson(`../songs/${f}`)]);
toCheck.push(['starter song', starterSong(readJson('../library/starter-song.json'), lib, { name: 'test', key: 'E', scale: 'dorian', bpm: 110 })]);
// styles: a new song like every example (library.js songLike)
const { Rng: SeedRng } = await import('../src/engine/rng.js');
const examples = readJson('../library/examples.json').examples;
for (const ex of examples) {
  const src = readJson(`../${ex.song}`);
  toCheck.push([`like ${ex.id}`, songLike(src, lib, new SeedRng(11), { ex })]);
  ok(Object.keys(ex.sounds || {}).every((id) => src.tracks.some((t) => t.id === id)) && Object.values(ex.sounds || {}).flat().every((id) => lib.instruments.some((e) => e.id === id)),
    `example ${ex.id}: its sound lists name its tracks and library sounds`);
}
{
  const ex = examples[0], src = readJson(`../${ex.song}`), a = songLike(src, lib, new SeedRng(5), { ex }), b = songLike(src, lib, new SeedRng(5), { ex });
  ok(JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(a) !== JSON.stringify(songLike(src, lib, new SeedRng(6), { ex })), 'songs like an example: same seed, same song');
}
for (const [file, sg] of toCheck) {
  const e = newEngine(SR, sg, 3);
  const h = run(e, 90);
  const themed = [];
  const ids = new Set(sg.blocks.map((b) => b.id));
  const orphans = sg.blocks.filter((b) => b.track !== undefined || !tracksOf(sg, b.id).length).map((b) => b.id); // every clip on a track, none naming one
  ok(h.bad === 0 && h.peak > 0.1 && h.peak < 1 && !orphans.length && ids.size === sg.blocks.length, `${file}: healthy (peak ${h.peak.toFixed(2)}), blocks valid`);
  const far = [];
  for (const [mood, m] of Object.entries(sg.moods || {})) {
    e.setMood(mood);
    run(e, 40, (t, en) => { for (const ev of en.drainEvents()) if (ev.type === 'log' && ev.text.startsWith('♪')) themed.push(ev.text); });
    const d = e.distToTarget(e.section);
    if (d > 0.3) far.push(`${mood}→${e.section.id} (${d.toFixed(2)})`);
  }
  ok(!far.length, `${file}: every mood reaches a nearby section within 40 s${far.length ? ` — ${far.join(', ')}` : ''}`);
  ok(!sg.theme || themed.length > 1, `${file}: the theme comes back (${themed.length}×)`);
  const silent = (sg.stingers || []).filter((x) => {
    e.drainEvents();
    e.sting(x.id);
    let notes = 0;
    run(e, x.beats * 60 / sg.bpm + 1, (t, en) => { for (const ev of en.drainEvents()) if (ev.type === 'note') notes++; });
    return !notes;
  }).map((x) => x.id);
  ok(!silent.length, `${file}: every stinger plays (${(sg.stingers || []).length})${silent.length ? ` — silent: ${silent}` : ''}`);
}

// 10. Instrument library: every entry becomes a track that plays its starter block; removing it leaves a clean song
{
  const sg = starterSong(readJson('../library/starter-song.json'), lib);
  const quiet = [];
  for (const entry of lib.instruments) {
    const tr = addTrack(sg, lib, entry);
    const e = newEngine(SR, sg, 1);
    e.lock(tr.id, clipsOf(sg, tr)[0].id);
    let notes = 0;
    run(e, 8, (t, en) => { for (const ev of en.drainEvents()) if (ev.type === 'note' && ev.track === tr.id) notes++; });
    if (!notes) quiet.push(entry.id);
    removeTrack(sg, tr.id);
  }
  ok(!quiet.length, `every library instrument plays as a new track (${lib.instruments.length})${quiet.length ? ` — silent: ${quiet}` : ''}`);
  ok(Object.keys(sg.instruments).length === 3 && sg.tracks.length === 3, 'removing a track removes its blocks and unused instrument');
}

// 11. Variations (compose.js): every candidate is valid song data of the right length, and a seed repeats them
{
  const { Rng } = await import('../src/engine/rng.js');
  const { blockVariations, progressionVariations, soundVariations, themeVariations } = await import('../src/engine/compose.js');
  const { SCALES, parseChords } = await import('../src/engine/theory.js');
  const { expandTokens, parseToken } = await import('../src/engine/pattern.js');
  const bad = [];
  let n = 0;
  for (const [, sg] of toCheck) {
    const spb = sg.stepsPerBeat || 4, ctx0 = { spb, stepsPerBar: spb * (sg.beatsPerBar || 4) };
    for (const b of sg.blocks.filter((x) => !x.theme)) {
      const tr = tracksOf(sg, b.id)[0], drums = sg.instruments[tr.instrument]?.type === 'drums';
      const cands = blockVariations(b, new Rng(n + 1), { ...ctx0, drums, poly: stacksNotes(sg, tr), mode: b.mode || tr.mode || 'chord' });
      for (const c of cands) {
        n++;
        const toks = expandTokens(c.value.pattern), len = Math.round((b.beats || 4) * spb);
        if (toks.length !== len || toks.some((x) => x !== '.' && x !== '-' && parseToken(x).t !== 2)) bad.push(`${b.id}/${c.kind}`);
      }
    }
    for (const p of sg.progressions) for (const c of progressionVariations(p, new Rng(n++), SCALES[p.scale || sg.scale])) if (parseChords(c.value.chords).length < 1) bad.push(`${p.id}/${c.kind}`);
    for (const [name, s] of Object.entries(sg.instruments)) for (const c of soundVariations(s, new Rng(n++))) if (c.value.type !== s.type) bad.push(`${name}/${c.kind}`);
    if (sg.theme) for (const c of themeVariations(sg.theme, new Rng(n++), ctx0)) if (expandTokens(c.value.pattern).length !== Math.round(sg.theme.beats * spb)) bad.push(`theme/${c.kind}`);
  }
  ok(n > 100 && !bad.length, `variations are valid song data (${n} candidates)${bad.length ? ` — bad: ${bad.slice(0, 5)}` : ''}`);
  const b = song.blocks.find((x) => x.id === 'pulse'), ctx = { spb: 4, stepsPerBar: 16, drums: false, mode: 'chord' };
  ok(JSON.stringify(blockVariations(b, new Rng(3), ctx)) === JSON.stringify(blockVariations(b, new Rng(3), ctx)), 'same seed, same variations');
}

// 12. Older songs: generator blocks become plain patterns of the block's length, the same each time; clips that
// name their track become the track's list
{
  const legacy = structuredClone(song);
  for (const t of legacy.tracks) { for (const id of t.clips) legacy.blocks.find((b) => b.id === id).track = t.id; delete t.clips; }
  const linked = linkClips(structuredClone(legacy));
  ok(JSON.stringify(linked.tracks.map((t) => t.clips)) === JSON.stringify(song.tracks.map((t) => t.clips)) && linked.blocks.every((b) => b.track === undefined), 'clips naming their track become the track\'s list');
  const named = linkClips({ format: 1, tracks: [{ id: 'bass' }, { id: 'drums' }], blocks: [{ id: 'bass_walk', track: 'bass' }, { id: 'drums_walk', track: 'drums' }, { id: 'bass_x', track: 'drums' }] });
  ok(named.format === 2 && named.blocks.map((b) => b.id).join() === 'walk,drums_walk,bass_x' && named.tracks[1].clips.join() === 'drums_walk,bass_x', 'an older song\'s clips lose their track prefix where the name stays unique');
  ok(linkClips({ format: 2, tracks: [{ id: 'bass', clips: ['bass_line'] }], blocks: [{ id: 'bass_line' }] }).blocks[0].id === 'bass_line', 'a name given in a format-2 song stays');
  const notes = (sg) => { const out = []; run(newEngine(SR, sg, 4), 30, (t, en) => { for (const ev of en.drainEvents()) if (ev.type === 'note') out.push(`${ev.track}:${ev.midi}`); }); return out.join('|'); };
  ok(notes(legacy) === notes(song), 'the engine plays an older song the same');

  const { freezeGenerators } = await import('../src/engine/compose.js');
  const { expandTokens } = await import('../src/engine/pattern.js');
  const old = () => ({ ...structuredClone(song), blocks: [...structuredClone(song.blocks), { id: 'old_gen', track: 'lead', beats: 8, mode: 'scale', gen: { rhythm: 'x - . x . . x - x - - . . . . .', range: [0, 9], leap: 2 } }] });
  const a = freezeGenerators(old()).blocks.at(-1), b = freezeGenerators(old()).blocks.at(-1);
  ok(!a.gen && expandTokens(a.pattern).length === 32 && a.pattern === b.pattern, `generator blocks freeze into patterns (${a.pattern})`);
}

// 13. Amps and double tracking: every amp on a driven guitar, doubled, stays finite, sane and near the level without
{
  const { AMPS } = await import('../src/engine/synth.js');
  const { renderPhrase } = await import('./lab/phrase.js');
  const e = lib.instruments.find((x) => x.id === 'power_chords');
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
  const { renderPhrase } = await import('./lab/phrase.js');
  const e = lib.instruments.find((x) => x.id === 'strings_ensemble');
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

// 12. Empty songs, "plays in" and the parts library
{
  const lib = readJson('../library/instruments.json');
  const empty = emptySong(readJson('../library/starter-song.json'), { key: 'D', scale: 'dorian', bpm: 90 });
  const r = run(newEngine(SR, empty, 3), 10, (t, e) => { if (t > 4 && t < 4.01) e.setMood('danger'); });
  ok(r.bad === 0 && empty.tracks.length === 0 && Object.keys(empty.moods).length > 0, 'an empty song plays (silently) and takes mood calls');
  addTrack(empty, lib, lib.instruments.find((e) => e.group === 'bass'));
  ok(run(newEngine(SR, empty, 3), 6).peak > 0.01, 'an empty song sounds after adding one track');

  const s = structuredClone(song);
  const b = s.blocks.find((x) => (x.tags || []).length && !x.tags.includes('fill'));
  const secIds = s.sections.map((x) => x.id);
  const target = secIds.find((id) => !playsIn(s, b.tags).has(id));
  const before = playsIn(s, b.tags);
  const after = togglePlaysIn(s, b, target);
  ok(after.has(target) && [...before].every((id) => after.has(id)), 'plays in: switching a section on keeps the others');
  const only = setPlaysIn(s, b, new Set([target]));
  ok(only.has(target), `plays in: one section alone (${[...only].join(', ')})`);
  setPlaysIn(s, b, new Set(secIds));
  ok(everywhere(s, b.tags) && !b.tags.filter((t) => t !== 'fill').length, 'plays in: every section means no tags');
  const sec = s.sections.find((x) => x.id === target);
  renameTag(s, target, 'renamed_sec');
  ok(!s.sections.some((x) => (x.tags || []).includes(target)) || (sec.tags || []).length > 1, 'renaming a section takes its own tag along');

  const src = structuredClone(song), parts = songParts(src);
  ok(parts.track.length === src.tracks.length && parts.clip.length > 0 && parts.prog.length === src.progressions.length, 'a song lists its parts');
  const dst = emptySong(readJson('../library/starter-song.json'));
  const drumClip = parts.clip.find((p) => p.drums), noteClip = parts.clip.find((p) => !p.drums && !p.clip.theme);
  ok(clipTarget(dst, noteClip) === null, 'a clip with no fitting track brings its own');
  const o1 = insertPart(dst, noteClip);
  const o2 = insertPart(dst, drumClip);
  ok(dst.tracks.length === 2 && dst.blocks.every((x) => x.track === undefined && tracksOf(dst, x.id).length === 1) && o1.kind === 'block' && o1.track, 'clips with no track to take them get new tracks');
  ok(parts.clip.every((p) => !p.track && !p.trackName && !p.sound && !p.group), 'a clip part is its notes, with no track');
  insertPart(dst, parts.clip.find((p) => p.drums && p !== drumClip) || drumClip);
  ok(dst.tracks.length === 2, 'a second drum clip goes onto the drum track');
  ok(dst.blocks.every((x) => !(x.tags || []).some((t) => t !== 'fill' && t !== 'main')), 'tags of other songs\' sections are dropped (it plays everywhere)');
  insertPart(dst, parts.track[0]);
  insertPart(dst, parts.prog[0]);
  if (parts.sting[0]) insertPart(dst, parts.sting[0]);
  const st = dst.stingers[0];
  ok(!st || st.parts.every((p) => dst.tracks.some((t) => t.id === p.track)), 'a stinger\'s parts find (or bring) their tracks');
  const rr = run(newEngine(SR, dst, 5), 12, (t, e) => { if (st && t > 3 && t < 3.01) e.sting(st.id); });
  ok(rr.bad === 0 && rr.peak > 0.01, 'a song built from parts plays');
  ok(JSON.stringify(o2) && dst.instruments && Object.keys(dst.instruments).length === dst.tracks.length, 'every track owns its sound');
}

// Shared instruments: two tracks can play one; tracks keep their own names; an instrument no track plays goes
{
  const sg = upgradeSong(structuredClone(song)), [a, b] = sg.tracks.filter((t) => sg.instruments[t.instrument]?.type !== 'drums');
  const nameB = b.name, oldB = b.instrument;
  playInstrument(sg, b, a.instrument);
  ok(b.instrument === a.instrument && b.name === nameB && !sg.instruments[oldB], 'a track can play another track\'s instrument (and keeps its name)');
  const again = upgradeSong(structuredClone(sg));
  ok(again.tracks.filter((t) => t.instrument === a.instrument).length === 2 && again.tracks.every((t) => t.name), 'a shared instrument stays shared, every track has a name');
  const e = newEngine(SR, sg, 2), heard = new Set();
  run(e, 20, (t, en) => { for (const ev of en.drainEvents()) if (ev.type === 'note') heard.add(ev.track); });
  ok(heard.size > 2, 'a song with a shared instrument plays');
}

// Shared clips: one clip on two tracks plays on both; taking it off one keeps it, off the last drops it
{
  const sg = structuredClone(song), mel = sg.tracks.filter((t) => sg.instruments[t.instrument]?.type !== 'drums');
  const [a, b] = mel, id = clipsOf(sg, a).find((x) => !x.theme && !(x.tags || []).includes('fill')).id;
  putClip(b, id);
  ok(tracksOf(sg, id).length === 2, 'a clip can be on two tracks');
  const e = newEngine(SR, sg, 2);
  e.lock(a.id, id); e.lock(b.id, id);
  const heard = new Set();
  run(e, 6, (t, en) => { for (const ev of en.drainEvents()) if (ev.type === 'note') heard.add(ev.track); });
  ok(heard.has(a.id) && heard.has(b.id), 'the engine plays a shared clip on both tracks');
  renameClip(sg, id, 'shared_one');
  ok(a.clips.includes('shared_one') && b.clips.includes('shared_one') && !a.clips.includes(id), 'renaming a clip renames it on every track');
  ok(!takeClip(sg, a, 'shared_one') && sg.blocks.some((x) => x.id === 'shared_one'), 'off one track, the clip stays for the other');
  ok(takeClip(sg, b, 'shared_one') && !sg.blocks.some((x) => x.id === 'shared_one'), 'off the last track, the clip is gone');
}

// How many notes it plays at once is the instrument's: an older song's track poly moves to its instrument (the first
// track that plays it says), and the engine reads either
{
  const old = structuredClone(song), tr = old.tracks.find((t) => (old.instruments[t.instrument].poly || 1) > 1), inst = old.instruments[tr.instrument];
  tr.poly = inst.poly;
  delete inst.poly;
  ok(prepareSong(old).trackMap[tr.id].poly === tr.poly && prepareSong(song).trackMap[tr.id].poly === tr.poly, 'the engine takes poly from the instrument (or an older song\'s track)');
  const up = upgradeSong(structuredClone(old));
  ok(up.instruments[tr.instrument].poly === tr.poly && up.tracks.every((t) => t.poly === undefined), 'an older song\'s track poly moves to its instrument');
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

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
