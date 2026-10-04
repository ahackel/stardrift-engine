// What plays in a section, in steps of 0 · 25 · 50 · 75 · 100 %:
//   section.tracks { trackId: chance }   how likely a track plays in the section
//   block.sections { sectionId: weight } how often a clip is picked on its track there, against the track's other
//   progression.sections { … }           clips (or the other sequences)
// Anything not listed is 1 (100 %): a new section, track, clip or sequence plays everywhere until told otherwise.
//   mood.sections { sectionId: weight } where the music heads when the game asks for the mood, picked by weight; here
//                                       not listed is 0, and a mood that lists none leads nowhere (the music walks on)
//   section.next { sectionId: weight }  the sections that may follow it, picked by weight; not listed is 0, and a
//                                       section that lists none goes on to any
// Songs from before (tags, weights, intensity and tension, track layers) are turned into these once: migrateSong()
// works out what the old rules picked in each section and rounds it to a step.
export const STEPS = [0, 0.25, 0.5, 0.75, 1];
// a song's own copy (structuredClone where there is one, which Safari has only from 15.4; a song is JSON)
const clone = typeof structuredClone === 'function' ? structuredClone : (x) => JSON.parse(JSON.stringify(x));
export const snap = (v) => Math.round(Math.min(1, Math.max(0, +v || 0)) * 4) / 4;

// a clip's or sequence's weight in a section (a breather counts as the section it interrupts)
export const weightIn = (item, sec) => item.sections?.[sec.base ?? sec.id] ?? 1;
// how likely a track plays in a section
export const chanceIn = (sec, trackId) => sec.tracks?.[trackId] ?? 1;

// ---------------------------------------------------------------- songs from before
const WOBBLE = [-0.04, -0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03, 0.04]; // how far the old conductor moved a section's mood
const avg = (f) => WOBBLE.reduce((a, d) => a + f(d), 0) / WOBBLE.length;

// A track's old layer ({ min, max, chance }: the intensities it played in, and how likely) as its chance in each
// section: { sectionId: step }, the sections it always plays in left out
function layerChances(layer, sections) {
  const l = layer || {}, on = l.chance ?? 1, out = {};
  for (const sec of sections) {
    const I = sec.intensity ?? 0.5; // it also tended to stay on: a bit more than its chance
    const c = snap(avg((d) => (I + d < (l.min ?? 0) || I + d > (l.max ?? 1) ? 0 : on + (1 - on) * 0.5)));
    if (c !== 1) out[sec.id] = c;
  }
  return out;
}

// A song once had one theme (song.theme: { beats, pattern }, in key degrees) that theme clips played (block.theme: true
// for any form, or a list of forms). Now any clip can play another clip's notes (block.from) in forms (block.forms):
// the theme's notes go to a theme clip as long as the theme (the one playing every form if there is one), and the other
// theme clips play its notes. With none as long, a clip of their own holds them: on the first theme clip's track (else
// the first melodic one), at 0 % in every section, so it never plays itself. Theme clips with no theme stay silent.
const ALL_FORMS = ['whole', 'head', 'sequence', 'slow', 'shift', 'answer'];
function migrateTheme(raw) {
  if (!raw || !(raw.theme || (raw.blocks || []).some((b) => b.theme))) return raw;
  const s = clone(raw), th = s.theme?.pattern ? s.theme : null, blocks = (s.blocks ||= []), tracks = s.tracks || [];
  delete s.theme;
  const idsOf = (t) => (Array.isArray(t.clips) ? t.clips : blocks.filter((b) => b.track === t.id).map((b) => b.id));
  const order = tracks.flatMap(idsOf), at = (b) => (order.includes(b.id) ? order.indexOf(b.id) : order.length);
  const themed = blocks.filter((b) => b.theme).sort((a, b) => at(a) - at(b));
  const formsOf = (b) => (Array.isArray(b.theme) ? b.theme.filter((f) => ALL_FORMS.includes(f)) : ALL_FORMS);
  const setForms = (b) => {
    const f = formsOf(b);
    delete b.theme;
    if (f.length && !(f.length === 1 && f[0] === 'whole')) b.forms = [...f];
  };
  if (!th) { themed.forEach(setForms); return s; }
  const beats = Math.max(1, +th.beats || 8), long = themed.filter((b) => (b.beats || 4) === beats);
  let src = long.find((b) => b.theme === true) || long.find((b) => formsOf(b).includes('whole')) || long[0];
  if (src) {
    setForms(src);
    delete src.mode; delete src.from;
  } else {
    const drums = (t) => s.instruments?.[t.instrument]?.type === 'drums';
    const host = (themed[0] && tracks.find((t) => idsOf(t).includes(themed[0].id))) || tracks.find((t) => !drums(t));
    if (!host) { themed.forEach(setForms); return s; }
    let id = 'theme_notes';
    for (let n = 2; blocks.some((b) => b.id === id); n++) id = `theme_notes_${n}`;
    src = { id, beats, sections: Object.fromEntries((s.sections || []).map((x) => [x.id, 0])) };
    blocks.push(src);
    if (Array.isArray(host.clips)) host.clips.push(id); else src.track = host.id;
  }
  Object.assign(src, { pattern: th.pattern, mode: 'key', fit: src.fit ?? true });
  for (const b of themed) if (b !== src) { setForms(b); delete b.pattern; delete b.mode; b.from = src.id; }
  return s;
}

// The editor once kept a section's moods on the section (section.moods: names): they are the moods' sections now
function migrateMoods(raw) {
  if (!raw?.sections?.some((x) => Array.isArray(x.moods))) return raw;
  const s = clone(raw);
  s.moods ||= {};
  for (const sec of s.sections) {
    for (const m of Array.isArray(sec.moods) ? sec.moods : []) if (s.moods[m]) (s.moods[m].sections ||= {})[sec.id] = 1;
    delete sec.moods;
  }
  return s;
}

// Links between sections (section.next) once weighed 0–3 in tenths: each section's, by its strongest, as steps (a link
// stays at least 25 %). Only the ratios count, so this changes little beyond the rounding.
function migrateNext(raw) {
  if (!raw?.sections?.some((x) => Object.values(x.next || {}).some((w) => w !== snap(w)))) return raw;
  const s = clone(raw);
  for (const sec of s.sections) {
    const max = Math.max(0, ...Object.values(sec.next || {}));
    for (const [k, w] of Object.entries(sec.next || {})) if (w > 0) sec.next[k] = Math.max(0.25, snap(w / max)); else delete sec.next[k];
  }
  return s;
}

// Sections and moods once had an intensity and a tension: a mood headed for the section nearest its own, and a sound's
// filter opened with them (cutoffIntensity, cutoffTension). A mood without sections now names that nearest section;
// a filter stays where it was at about half intensity and a little tension.
export function upgradeFilter(sound) {
  if (!sound || (sound.cutoffIntensity == null && sound.cutoffTension == null)) return sound;
  const f = (sound.cutoff ?? 16000) + 0.5 * (sound.cutoffIntensity || 0) + 0.3 * (sound.cutoffTension || 0);
  sound.cutoff = Math.round(Math.min(16000, Math.max(60, f)));
  delete sound.cutoffIntensity; delete sound.cutoffTension;
  return sound;
}
function dropLevels(raw) {
  const has = (o, ...keys) => o && typeof o === 'object' && keys.some((k) => k in o);
  if (!raw || !((raw.sections || []).some((x) => has(x, 'intensity', 'tension')) || Object.values(raw.moods || {}).some((m) => has(m, 'intensity', 'tension', 'influence'))
    || Object.values(raw.instruments || {}).some((d) => has(d, 'cutoffIntensity', 'cutoffTension')))) return raw;
  const s = clone(raw), secs = s.sections || [];
  // of the sections the music can get to (a section without links goes on to any)
  const led = secs.some((x) => !Object.values(x.next || {}).some((w) => w > 0)) ? secs : secs.filter((x) => secs.some((y) => y.next?.[x.id] > 0));
  for (const m of Object.values(s.moods || {})) {
    if (!m || typeof m !== 'object') continue;
    if (!m.sections && led.length && (m.intensity != null || m.tension != null)) {
      const d = (x) => Math.hypot((x.intensity ?? 0.5) - (m.intensity ?? 0.5), (x.tension ?? 0.3) - (m.tension ?? 0.3));
      m.sections = { [led.reduce((a, x) => (d(x) < d(a) ? x : a)).id]: 1 };
    }
    delete m.intensity; delete m.tension; delete m.influence;
  }
  for (const sec of secs) { delete sec.intensity; delete sec.tension; }
  for (const d of Object.values(s.instruments || {})) upgradeFilter(d);
  return s;
}

const LEGACY = (raw) => (raw.sections || []).some((x) => x.tags) || (raw.tracks || []).some((t) => t.layer)
  || [...(raw.blocks || []), ...(raw.progressions || [])].some((x) => x.tags || x.weight != null || x.intensity || x.tension);

function rangeFit(v, r) {
  if (!r) return 1;
  const lo = r[0] ?? 0, hi = r[1] ?? 1;
  if (v >= lo && v <= hi) return 1;
  const d = v < lo ? lo - v : v - hi;
  return Math.max(0.01, Math.exp(-(d * d) / (2 * 0.07 * 0.07)));
}

// A copy of an older song with its tags, weights, ranges and layers turned into per-section steps; the song itself
// when there is nothing to turn. Each section is weighed as the old conductor did around its intensity and tension
// (it wobbled them by up to 0.04): clips that share a tag with it (or name no section) against each other, the one
// picked most at 100.
export function migrateSong(raw) {
  raw = migrateTheme(migrateNext(migrateMoods(raw)));
  return dropLevels(raw && LEGACY(raw) ? migrateLegacy(raw) : raw);
}
function migrateLegacy(raw) {
  const s = clone(raw), secs = s.sections || [];
  const known = new Set(secs.flatMap((x) => x.tags || []));
  const isFill = (b) => !!b.fill || (b.tags || []).includes('fill');
  const fitting = (list, want) => {
    const fit = list.filter((x) => !(x.tags || []).some((t) => known.has(t)) || x.tags.some((t) => want.includes(t)));
    return fit.length ? fit : list;
  };
  const overlap = (x, want) => (x.tags || []).filter((t) => t !== 'fill' && want.includes(t)).length;
  // how often each was picked (weights wOf(x, d) at a wobble d) as steps, the one picked most at 100; into out[id][sec]
  const put = (out, sec, list, wOf) => {
    const share = list.map((x) => avg((d) => { const sum = list.reduce((a, y) => a + wOf(y, d), 0); return sum > 0 ? wOf(x, d) / sum : 0; }));
    const max = Math.max(...share, 0);
    list.forEach((x, i) => { const v = max > 0 ? snap(share[i] / max) : 0; (out[x.id] ||= {})[sec] = Math.max(out[x.id]?.[sec] ?? 0, v); });
  };
  const bw = {}, pw = {}, byId = Object.fromEntries((s.blocks || []).map((b) => [b.id, b]));
  for (const sec of secs) {
    const I = sec.intensity ?? 0.5, T = sec.tension ?? 0.3, want = sec.tags || [], tracks = {};
    for (const tr of s.tracks || []) {
      const c = sec.tracks?.[tr.id] ?? layerChances(tr.layer, [sec])[sec.id] ?? 1; // auto: from the track's layer
      if (snap(c) !== 1) tracks[tr.id] = snap(c);
      const clips = Array.isArray(tr.clips) ? tr.clips.map((id) => byId[id]).filter(Boolean) : (s.blocks || []).filter((b) => b.track === tr.id);
      for (const fill of [false, true]) {
        const pool = clips.filter((b) => isFill(b) === fill);
        if (pool.length) put(bw, sec.id, fitting(pool, want), (b, d) => (b.weight ?? 1) * rangeFit(I + d, b.intensity) * rangeFit(T + d, b.tension) * (1 + 2 * overlap(b, want)));
      }
    }
    if (Object.keys(tracks).length) sec.tracks = tracks; else delete sec.tracks;
    const progs = s.progressions || [];
    if (progs.length) put(pw, sec.id, fitting(progs, want), (p, d) => (p.weight ?? 1) * (1 + 3 * overlap(p, want)) * rangeFit(T + d, p.tension));
  }
  // the map, only where it says something other than 100
  const settle = (x, w) => {
    const m = Object.fromEntries(secs.map((sec) => [sec.id, w ? w[sec.id] ?? 0 : 1]).filter(([, v]) => v !== 1));
    if (Object.keys(m).length) x.sections = m;
    if (isFill(x)) x.fill = true;
    delete x.tags; delete x.weight; delete x.intensity; delete x.tension;
  };
  for (const b of s.blocks || []) settle(b, bw[b.id]);
  for (const p of s.progressions || []) settle(p, pw[p.id]);
  // a breather kept the tracks that played from intensity 0: now it names them
  if (s.breath && !s.breath.keep) s.breath = { ...s.breath, keep: (s.tracks || []).filter((t) => (t.layer?.min ?? 0) <= 0).map((t) => t.id) };
  for (const t of s.tracks || []) delete t.layer;
  for (const sec of secs) delete sec.tags;
  return s;
}
