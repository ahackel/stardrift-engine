// Pattern language: one whitespace-separated token per step (default 4 steps per beat).
//
//   .        rest (releases a held note)
//   -        hold the previous note
//   3        note: chord-tone index / scale degree / key degree (depends on block mode)
//   *        the whole current chord (instruments with poly) or a fast chip arpeggio (instruments with `arp`)
//   0+4+8    several notes at once
//   k s h    drum hits: k kick, s snare, h hat, o open hat, c crash/wash, t tom, m metal tick
// Suffixes: ' octave up, , octave down, # / b semitone up/down
// Flags:    ! accent, ? 50% chance, ?30 30% chance
// Repeat:   T*n repeats token T n times ("-*15"), `|` is ignored (visual bar separator)

export const REST = 0, HOLD = 1, NOTE = 2;
const REST_STEP = Object.freeze({ t: REST });
const HOLD_STEP = Object.freeze({ t: HOLD });

export function expandTokens(str, length = 0) {
  const out = [];
  for (const t of String(str || '').trim().split(/\s+/)) {
    if (!t || t === '|') continue;
    const m = /^(.+)\*(\d+)$/.exec(t);
    if (m) for (let i = 0, n = Math.min(+m[2], 4096); i < n; i++) out.push(m[1]);
    else out.push(t);
  }
  return length > 0 ? fitLength(out, length) : out;
}

// cut or pad (with rests) a token array to exactly `length` steps
export function fitLength(tokens, length) {
  const out = tokens.slice(0, length);
  while (out.length < length) out.push('.');
  return out;
}

function parseAtom(a) {
  const m = /^(\*|-?\d+|[a-z])([',#b]*)$/.exec(a);
  if (!m) return null;
  let oct = 0, semi = 0;
  for (const c of m[2]) {
    if (c === "'") oct++;
    else if (c === ',') oct--;
    else if (c === '#') semi++;
    else if (c === 'b') semi--;
  }
  if (m[1] === '*') return { kind: 'chord', value: 0, oct, semi };
  if (/^-?\d+$/.test(m[1])) return { kind: 'num', value: +m[1], oct, semi };
  return { kind: 'hit', value: m[1], oct, semi };
}

export function parseToken(t) {
  if (!t || t === '.') return REST_STEP;
  if (t === '-') return HOLD_STEP;
  const m = /^([^!?]+)((?:!|\?\d*)*)$/.exec(t);
  if (!m) return REST_STEP;
  const atoms = m[1].split('+').map(parseAtom).filter(Boolean);
  if (!atoms.length) return REST_STEP;
  const q = /\?(\d*)/.exec(m[2]);
  return {
    t: NOTE,
    atoms,
    accent: m[2].includes('!'),
    prob: q ? (q[1] ? Math.min(100, +q[1]) / 100 : 0.5) : 1,
  };
}

// a note not held into the next step (a rest or another note follows) is short: string sounds with `mute` play it
// palm-muted, while held notes ring open
export const parseTokens = (tokens) => tokens.map((t, i) => {
  const st = parseToken(t);
  if (st.t === NOTE) st.short = tokens[(i + 1) % tokens.length] !== '-';
  return st;
});

// Tokens -> readable pattern string, one bar per group, runs compressed as T*n.
export function formatTokens(tokens, stepsPerBar = 16) {
  const bars = [];
  for (let b = 0; b < tokens.length; b += stepsPerBar) {
    const bar = tokens.slice(b, b + stepsPerBar);
    const parts = [];
    for (let i = 0; i < bar.length; ) {
      let j = i + 1;
      while (j < bar.length && bar[j] === bar[i]) j++;
      const n = j - i;
      if (n >= 3) parts.push(`${bar[i]}*${n}`);
      else for (let k = 0; k < n; k++) parts.push(bar[i]);
      i = j;
    }
    bars.push(parts.join(' '));
  }
  return bars.join(' | ');
}

export function nearestTone(d, tones, n) {
  let best = d, bestDist = Infinity;
  const o0 = Math.floor(d / n);
  for (let o = o0 - 1; o <= o0 + 1; o++) {
    for (const t of tones) {
      const c = o * n + t, dist = Math.abs(c - d);
      if (dist < bestDist) { best = c; bestDist = dist; }
    }
  }
  return best;
}

// Small, musical mutations applied when a block loops, so repeats are never identical.
export function mutateTokens(tokens, rng, isDrum, amount = 1) {
  const out = tokens.slice();
  const p = 0.12 * amount;
  for (let i = 0; i < out.length; i++) {
    const t = out[i];
    if (t === '-') continue;
    if (t === '.') {
      if (isDrum) {
        if (rng.chance(p * 0.4)) out[i] = rng.chance(0.75) ? 'h?' : 's?40';
      } else if (i > 0 && /^-?\d+$/.test(out[i - 1]) && rng.chance(p * 0.4)) {
        out[i] = String(+out[i - 1] + rng.pick([-1, 1]));
      }
      continue;
    }
    if (isDrum) {
      if (/^[hom]\??$/.test(t) && rng.chance(p)) out[i] = '.';
      continue;
    }
    const m = /^(-?\d+)(.*)$/.exec(t);
    if (!m) continue;
    const r = rng.next();
    if (r < p * 0.5) {
      out[i] = '.';
      for (let j = i + 1; j < out.length && out[j] === '-'; j++) out[j] = '.';
    } else if (r < p * 1.3) {
      out[i] = String(+m[1] + rng.pick([-1, 1, -2, 2])) + m[2];
    } else if (r < p * 1.6) {
      out[i] = m[1] + "'" + m[2];
    }
  }
  return out;
}

// Forms: how a clip restates its notes (block.forms; one is picked when it starts and, half the time, when it loops),
// so a melody comes back recognisable but not the same. Every form keeps the opening or the rhythm, which is what the
// ear holds on to. A clip can play another clip's notes (block.from): one melody, quoted by several clips and tracks.
//   whole     as written                     head    first half, then space
//   sequence  first half, then again a step or two higher/lower
//   slow      first half at half speed       shift   all of it a step or two higher/lower
//   answer    space, then the first half (a canon against a track playing it whole)
export const FORMS = ['whole', 'head', 'sequence', 'slow', 'shift', 'answer'];

const moveToken = (t, k) => t.replace(/(^|\+)(-?\d+)/g, (_, pre, n) => pre + (+n + k));

export function formTokens(notes, form, rng) {
  const n = notes.length, h = n >> 1, head = notes.slice(0, h), space = Array(n - h).fill('.');
  switch (form) {
    case 'head': return [...head, ...space];
    case 'sequence': { const k = rng.pick([-2, -1, 1, 2]); return [...head, ...head.map((t) => moveToken(t, k))]; }
    case 'slow': return head.flatMap((t) => [t, t === '.' ? '.' : '-']);
    case 'shift': { const k = rng.pick([-2, -1, 1, 2]); return notes.map((t) => moveToken(t, k)); }
    case 'answer': return [...space, ...head];
    default: return notes.slice();
  }
}

// the forms a clip may play in (block.forms; none: as written), and the clip whose notes it plays (block.from: another
// clip's, if that one has notes of its own; null if it is gone; else its own). blocks: the song's blocks by id, or a
// function from id to block. Shared by the engine and the editor.
export const formsOf = (b) => (Array.isArray(b?.forms) ? b.forms.filter((f) => FORMS.includes(f)) : []);
export const variesForm = (b) => formsOf(b).some((f) => f !== 'whole');
export function notesOf(b, blocks) {
  const src = b?.from && (typeof blocks === 'function' ? blocks(b.from) : blocks[b.from]);
  return src && !src.from && src !== b ? src : b?.from ? null : b;
}
