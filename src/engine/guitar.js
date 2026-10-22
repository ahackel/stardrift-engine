// Guitar chords: a chord laid out on six strings in standard tuning, the way a player fingers it, so strums and
// picking patterns (the pattern's D U X B A S1–S4) play real voicings instead of a keyboard's close chord.
// A voicing is six notes (midi or null for a string not played), low E first, at the guitar's own pitch (E2–E4 open).
//   open   first position, open strings where they fit (C x32010, G 320003, D xx0232, Am x02210); a barre where none does
//   barre  movable barre chords with the root on the low E or A string (F 133211, Bm x24432)
//   power  root, fifth and octave on the low strings (E5 022xxx, A5 x022xx): rock rhythm
//   high   the top three strings, around the 5th fret: funk chops, reggae skanks, a second guitar
// Shared by the engine and the editor (its chord names and the rows a grid hears).

export const TUNING = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4: string 6 to string 1
export const SHAPES = ['open', 'barre', 'power', 'high'];
const STR = 6;

// every way to finger the chord on strings from..5 with each fret in [lo, hi] (0 always allowed when open), the
// lowest string on the root; scored, the best returned
function search(root, pcs, { lo, hi, open, from = [0, 1, 2], top = 5, posAt = 0 }) {
  let best = null, bestScore = -Infinity;
  const cur = new Array(STR).fill(null);
  const fretsFor = (s) => {
    const out = [];
    if (open && pcs.includes(TUNING[s] % 12)) out.push(0);
    for (let f = Math.max(1, lo); f <= hi; f++) if (pcs.includes((TUNING[s] + f) % 12)) out.push(f);
    return out;
  };
  const score = (bs, last) => {
    const frets = cur.slice(bs, last + 1), fretted = frets.filter((f) => f > 0);
    const min = fretted.length ? Math.min(...fretted) : 0, max = fretted.length ? Math.max(...fretted) : 0;
    if (max - min > 3) return -Infinity;
    // fingers: a barre (two or more strings at the lowest fret) is one, every other fretted note one more
    const atMin = fretted.filter((f) => f === min).length, fingers = (atMin > 1 ? 1 : atMin) + fretted.length - atMin;
    if (fingers > 4) return -Infinity;
    // a barre stops every string under it: no open string between its first and last
    if (atMin > 1) { const a = frets.indexOf(min), b = frets.lastIndexOf(min); if (frets.slice(a, b).some((f) => f === 0)) return -Infinity; }
    const notes = frets.map((f, i) => (TUNING[bs + i] + f) % 12), has = (pc) => notes.includes(pc);
    let sc = frets.length * 0.6;
    pcs.forEach((pc, i) => { if (!has(pc)) sc -= i === 2 && pcs.length > 3 ? 2 : 6; }); // a seventh chord may drop its fifth
    if (open) {
      const opens = frets.filter((f) => f === 0).length;
      if (!opens) return -Infinity; // that is a barre chord, played better as one
      sc += 0.6 * opens - 0.25 * min;
      // an open string beside a note high up the neck: a shape no one plays
      for (let i = 1; i < frets.length; i++) if ((frets[i] === 0 && frets[i - 1] >= 4) || (frets[i - 1] === 0 && frets[i] >= 4)) sc -= 1;
    } else sc -= 0.3 * Math.abs(min - posAt);
    if (max - min === 3) sc -= 2; // a stretch
    sc -= 0.4 * (top - last); // the top strings left out
    return sc;
  };
  const take = (bs, last) => {
    const sc = score(bs, last);
    if (sc > bestScore) { bestScore = sc; best = cur.slice(); }
  };
  // the strings from bs up, each a chord tone; it may stop early (the top strings not played) after three
  const walk = (s, bs) => {
    if (s > top) return take(bs, top);
    if (s - bs >= 3) take(bs, s - 1);
    for (const f of fretsFor(s)) { cur[s] = f; walk(s + 1, bs); }
    cur[s] = null;
  };
  for (const bs of from) {
    for (const f of fretsFor(bs)) {
      if ((TUNING[bs] + f) % 12 !== root) continue;
      if (!open && lo > 0 && f !== lo) continue; // a barre chord: the root under the barre
      cur.fill(null); cur[bs] = f;
      walk(bs + 1, bs);
    }
  }
  return best && { frets: best, score: bestScore };
}

const cache = new Map();
// the frets of a chord (root: pitch class; pcs: its pitch classes, root first) in a shape: six frets, null = not played
export function chordFrets(root, pcs, shape = 'open') {
  const key = `${shape}:${root}:${pcs.join(',')}`;
  let v = cache.get(key);
  if (v) return v;
  pcs = [...new Set(pcs.map((p) => ((p % 12) + 12) % 12))];
  root = ((root % 12) + 12) % 12;
  if (shape === 'power') {
    // on the low E string up to the 7th fret, else on the A string
    const f6 = (root - TUNING[0] % 12 + 12) % 12, s = f6 <= 7 ? 0 : 1, f = s ? (root - TUNING[1] % 12 + 12) % 12 : f6;
    v = new Array(STR).fill(null);
    v[s] = f; v[s + 1] = f + 2; v[s + 2] = f + 2;
  } else if (shape === 'high') {
    let best = null;
    // any inversion on strings 3–1: every note a chord tone, as many of the chord's notes as fit, near the 5th fret
    for (let b = 2; b <= 10; b++) for (let f3 = b; f3 <= b + 3; f3++) for (let f2 = b; f2 <= b + 3; f2++) for (let f1 = b; f1 <= b + 3; f1++) {
      const fr = [f3, f2, f1], ns = fr.map((f, i) => (TUNING[3 + i] + f) % 12);
      if (!ns.every((n) => pcs.includes(n)) || Math.max(...fr) - Math.min(...fr) > 2) continue;
      const sc = new Set(ns).size * 3 - 0.3 * Math.abs(Math.min(...fr) - 5) - 0.2 * (Math.max(...fr) - Math.min(...fr)) + (ns.includes(pcs[0]) ? 0.5 : 0);
      if (!best || sc > best.sc) best = { sc, fr };
    }
    v = [null, null, null, ...(best ? best.fr : [5, 5, 5])];
  } else {
    const opn = shape === 'open' ? search(root, pcs, { lo: 0, hi: 4, open: true }) : null;
    let bar = null;
    for (let b = 1; b <= 11; b++) {
      const r = search(root, pcs, { lo: b, hi: b + 3, open: false, from: [0, 1], posAt: 2 });
      if (r && (!bar || r.score > bar.score)) bar = r;
    }
    v = (opn && (!bar || opn.score >= bar.score - 0.75) ? opn : bar || opn)?.frets || [null, 3, 2, 0, 1, 0];
  }
  cache.set(key, v);
  return v;
}

// the voicing's notes, string 6 first (null: not played), at the guitar's pitch moved by `shift` semitones
export function chordNotes(root, pcs, shape, shift = 0) {
  return chordFrets(root, pcs, shape).map((f, s) => (f === null ? null : TUNING[s] + f + shift));
}

// the frets as a guitarist writes them: x32010
export const fretText = (frets) => frets.map((f) => (f === null ? 'x' : f > 9 ? `(${f})` : String(f))).join('');

// What a guitar atom plays from a voicing (notes: six, null = not played): [{ m, s, order }] with s the string
// (0 = low E) and order its place in the strum.
//   D  a downstroke: every string played, low to high     U  an upstroke: the top four, high to low
//   X  a dead strum: every string, muted (a chuck)         B  the bass: the lowest string, the root
//   A  the alternate bass: the string above it             S1–S4  the highest string played, the next …
export function guitarStrings(notes, atom) {
  const played = [];
  notes.forEach((m, s) => { if (m != null) played.push({ m, s }); });
  if (!played.length) return [];
  const n = played.length;
  switch (atom) {
    case 'D': case 'X': return played.map((x, i) => ({ ...x, order: i }));
    case 'U': return played.slice(Math.max(0, n - 4)).reverse().map((x, i) => ({ ...x, order: i }));
    case 'B': return [{ ...played[0], order: 0 }];
    case 'A': return [{ ...played[Math.min(1, n - 1)], order: 0 }];
    default: {
      const k = /^S([1-6])$/.exec(atom);
      return k ? [{ ...played[Math.max(0, n - +k[1])], order: 0 }] : [];
    }
  }
}
export const GUITAR_ATOMS = ['D', 'U', 'X', 'B', 'A', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
