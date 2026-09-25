// node tools/test.mjs — engine sanity checks (determinism, mood routing, hot reload, audio health)
import { readFileSync } from 'node:fs';
import { Engine } from '../src/engine/engine.js';

const song = JSON.parse(readFileSync(new URL('../songs/deep-space.json', import.meta.url), 'utf8'));
const SR = 44100;
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) failed++; };

function run(engine, secs, onBlock) {
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

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
