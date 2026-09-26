// node tools/test.mjs — engine sanity checks (determinism, mood routing, hot reload, audio health, stingers, theme)
import { readFileSync, readdirSync } from 'node:fs';
import { Engine } from '../src/engine/engine.js';
import { degSemis, foldDegree } from '../src/engine/theory.js';
import { starterSong, addTrack, removeTrack } from '../src/editor/library.js';

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
const logOf = (seed) => { const e = new Engine(SR, song, seed); const out = []; run(e, 90, () => { for (const ev of e.drainEvents()) if (ev.type === 'log' || ev.type === 'note') out.push(ev.text || `${ev.track}:${ev.midi}`); }); return out.join('|'); };
ok(logOf(42) === logOf(42), 'same seed produces the same arrangement');
ok(logOf(42) !== logOf(43), 'different seeds produce different arrangements');

// 2. Audio health
const h = run(new Engine(SR, song, 7), 120);
ok(h.bad === 0, `no NaN/Inf samples (${h.bad})`);
ok(h.peak > 0.1 && h.peak < 1, `peak level sane (${h.peak.toFixed(3)})`);

// 3. Mood routing: a mood request reaches a matching section quickly and smoothly (through bridges)
for (const [mood, want, maxSecs, from] of [['tension', 'tension', 30, 'relaxed'], ['action', 'peak', 40, 'relaxed'], ['relaxed', 'calm|release', 40, 'action']]) {
  const e = new Engine(SR, song, 11);
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
  const e = new Engine(SR, song, 5);
  run(e, 20);
  const step = e.step, sec = e.section.id;
  const edited = JSON.parse(JSON.stringify(song));
  edited.blocks.find((b) => b.id === 'pad_hold').pattern = '* -*31 . . 0+2 -*29';
  e.setSong(edited);
  ok(e.step === step && e.section.id === sec, 'hot reload keeps musical position');
  ok(run(e, 10).bad === 0, 'engine keeps running after hot reload');
}

// 5. Breathers: the music thins out to the ambient tracks now and then, and comes back
{
  const e = new Engine(SR, { ...song, breath: { every: 16, bars: [4, 4] } }, 3);
  let inBreath = null, after = null;
  run(e, 240, () => {
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
  const e = new Engine(SR, song, 5);
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
  const e = new Engine(SR, song, 9);
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
  const held = new Engine(SR, song, 2);
  held.setHold(true);
  held.sting('reward');
  let heard = 0;
  run(held, 1, (t, en) => { for (const ev of en.drainEvents()) if (ev.type === 'note') heard++; });
  ok(heard === 4 && held.step === 0, `a stinger sounds while the song is held (${heard} notes)`);
}

// 8. Theme: theme blocks restate the song theme in varied forms, notes on the beat fit the chord
{
  const e = new Engine(SR, song, 4);
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
// quick start: a song made up in every style (compose.js)
const { composeSong } = await import('../src/engine/compose.js');
const { Rng: SeedRng } = await import('../src/engine/rng.js');
const composeData = { styles: readJson('../library/styles.json'), lib, template: readJson('../library/starter-song.json') };
for (const st of composeData.styles.styles) toCheck.push([`style ${st.id}`, composeSong(st, composeData, new SeedRng(11))]);
{
  const st = composeData.styles.styles[0], a = composeSong(st, composeData, new SeedRng(5)), b = composeSong(st, composeData, new SeedRng(5));
  ok(JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(a) !== JSON.stringify(composeSong(st, composeData, new SeedRng(6))), 'made-up songs: same seed, same song');
}
for (const [file, sg] of toCheck) {
  const e = new Engine(SR, sg, 3);
  const h = run(e, 90);
  const themed = [];
  const ids = new Set(sg.blocks.map((b) => b.id));
  const orphans = sg.blocks.filter((b) => !sg.tracks.some((t) => t.id === b.track)).map((b) => b.id);
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
    const e = new Engine(SR, sg, 1);
    e.lock(tr.id, sg.blocks.find((b) => b.track === tr.id).id);
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
      const tr = sg.tracks.find((x) => x.id === b.track), drums = sg.instruments[tr.instrument]?.type === 'drums';
      const cands = blockVariations(b, new Rng(n + 1), { ...ctx0, drums, poly: (tr.poly || 1) > 1, mode: b.mode || tr.mode || 'chord' });
      for (const c of cands) {
        n++;
        const toks = b.gen ? expandTokens(c.value.gen.rhythm) : expandTokens(c.value.pattern);
        const len = b.gen ? expandTokens(b.gen.rhythm).length : Math.round((b.beats || 4) * spb);
        if (toks.length !== len || toks.some((x) => x !== '.' && x !== '-' && !/^x/.test(x) && parseToken(x).t !== 2)) bad.push(`${b.id}/${c.kind}`);
      }
    }
    for (const p of sg.progressions) for (const c of progressionVariations(p, new Rng(n++), SCALES[p.scale || sg.scale])) if (parseChords(c.value.chords).length < 1) bad.push(`${p.id}/${c.kind}`);
    for (const [name, s] of Object.entries(sg.instruments)) for (const c of soundVariations(s, new Rng(n++))) if (c.value.type !== s.type) bad.push(`${name}/${c.kind}`);
    if (sg.theme) for (const c of themeVariations(sg.theme, new Rng(n++), ctx0)) if (expandTokens(c.value.pattern).length !== Math.round(sg.theme.beats * spb)) bad.push(`theme/${c.kind}`);
  }
  ok(n > 100 && !bad.length, `variations are valid song data (${n} candidates)${bad.length ? ` — bad: ${bad.slice(0, 5)}` : ''}`);
  const b = song.blocks.find((x) => x.id === 'bass_pulse'), ctx = { spb: 4, stepsPerBar: 16, drums: false, mode: 'chord' };
  ok(JSON.stringify(blockVariations(b, new Rng(3), ctx)) === JSON.stringify(blockVariations(b, new Rng(3), ctx)), 'same seed, same variations');
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
