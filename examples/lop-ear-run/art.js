// Pixel art for Lop Ear Run. Sprites are small grids of palette indices, filled from shapes (ellipses, capsules) and
// outlined, so the rabbit's lop ear can swing to any angle. Each sprite comes with a collision mask (the ear is soft:
// it never counts).

export const W = 300, H = 90, GROUND = 78; // the world in art pixels; GROUND: the y of the ground line

// palette indices
const OUT = 1, FUR = 2, EAR = 3, PINK = 4, INK = 5, BERRY = 6, ORANGE = 7, LEAF = 8, FAINT = 9, LIGHT = 10, FOX = 11, BELLY = 12;

export const PALETTES = {
  day: { bg: '#f7f6f0', 1: '#3a3a3a', 2: '#fdfbf6', 3: '#d9cbbd', 4: '#f19bb2', 5: '#535353', 6: '#c33d5f', 7: '#ee8a2a', 8: '#57a447', 9: '#dedbd0', 10: '#f7f6f0', 11: '#d9682b', 12: '#fdfbf6', 13: '#9a9a94' },
  night: { bg: '#1d2033', 1: '#141625', 2: '#f4f1ea', 3: '#c9bcae', 4: '#e88aa3', 5: '#c3c6d8', 6: '#e0577a', 7: '#ee8a2a', 8: '#57a447', 9: '#2e3350', 10: '#1d2033', 11: '#d9682b', 12: '#f4f1ea', 13: '#6a7090' },
};

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ellipse = (cx, cy, rx, ry) => (x, y) => ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1;
const capsule = (x1, y1, x2, y2, r) => (x, y) => {
  const px = x + 0.5, py = y + 0.5, dx = x2 - x1, dy = y2 - y1;
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return (px - x1 - t * dx) ** 2 + (py - y1 - t * dy) ** 2 <= r * r;
};

class Grid {
  constructor(w, h) { this.w = w; this.h = h; this.px = new Uint8Array(w * h); }
  // fill the shapes with a color; outline: the pixels around them (4-neighbours) in that color. → the filled mask
  layer(shapes, color, outline = 0) {
    const { w, h, px } = this, m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (shapes.some((s) => s(x, y))) { m[y * w + x] = 1; px[y * w + x] = color; }
    if (outline) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!m[i] && ((x > 0 && m[i - 1]) || (x < w - 1 && m[i + 1]) || (y > 0 && m[i - w]) || (y < h - 1 && m[i + w]))) px[i] = outline;
      }
    }
    return m;
  }
  dot(x, y, c) { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.px[y * this.w + x] = c; }
}

// a sprite: { w, h, mask, draw(ctx, x, y, palette) }; drawn into a canvas per palette, on first use
function sprite(g, mask) {
  const canvases = {};
  return {
    w: g.w, h: g.h, mask,
    draw(ctx, x, y, pal) {
      let c = canvases[pal.bg];
      if (!c) {
        c = canvases[pal.bg] = new OffscreenCanvas(g.w, g.h);
        const cx = c.getContext('2d'), img = cx.createImageData(g.w, g.h);
        for (let i = 0; i < g.px.length; i++) {
          const k = g.px[i];
          if (!k) continue;
          const hex = pal[k];
          img.data.set([parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255], i * 4);
        }
        cx.putImageData(img, 0, 0);
      }
      ctx.drawImage(c, Math.round(x), Math.round(y));
    },
  };
}

// a sprite from rows of characters: '.' is empty, the rest name palette entries in `keys`
function fromRows(rows, keys) {
  const g = new Grid(rows[0].length, rows.length), mask = new Uint8Array(g.w * g.h);
  rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') { g.px[y * g.w + x] = keys[ch]; mask[y * g.w + x] = 1; } }));
  return sprite(g, mask);
}

// ---------------------------------------------------------------------------------------------------------- the rabbit
// pose: run | jump | duck | idle | dead; frame 0/1 (legs); ear: the lop ear's angle in radians (0 hangs straight down,
// more swings it back and up); blink. The sprite is 32×26, its feet on row RABBIT_FOOT.
export const RABBIT_FOOT = 24;
const rabbits = new Map();

export function rabbit(pose, frame = 0, ear = 0.4, blink = false) {
  const a = Math.round(clamp(ear, -0.2, 2.6) * 8) / 8, key = `${pose}${frame}${a}${blink}`;
  if (!rabbits.has(key)) rabbits.set(key, drawRabbit(pose, frame, a, blink));
  return rabbits.get(key);
}

function drawRabbit(pose, f, ear, blink) {
  const g = new Grid(32, 26);
  let body, earAt, eye, nose, cheek;
  if (pose === 'duck') {
    body = [ellipse(13, 19, 10, 4.5), ellipse(8, 19.5, 6, 4.5), ellipse(23.5, 17.5, 5, 4), ellipse(27.3, 19, 2.5, 2.1), ellipse(2.5, 17.5, 2.2, 2.2),
      ellipse(f ? 6 : 10, 22.6, 4.5, 1.4), capsule(24, 20, f ? 28 : 26.5, 23, 1.2)];
    earAt = [21.5, 14.5]; eye = [25, 16]; nose = [29, 18]; cheek = [26, 19];
  } else {
    const b = pose === 'run' && f === 0 ? -1 : 0;
    const legs = pose === 'jump' ? [ellipse(5, 21.5, 4.5, 1.5), capsule(21, 16, 25, 18.5, 1.3)]
      : pose === 'run' && f === 0 ? [ellipse(5.5, 22.4, 4.5, 1.6), capsule(20, 16 + b, 23.5, 22, 1.3)]
      : [ellipse(11, 22.4, 4.5, 1.6), capsule(19, 16 + b, 16.5, 22, 1.3)];
    body = [ellipse(13, 15 + b, 8.5, 6), ellipse(9, 16.5 + b, 6, 5.5), ellipse(18, 12.5 + b, 4, 4), ellipse(21.5, 10 + b, 5, 4.5),
      ellipse(25, 11.5 + b, 2.6, 2.3), ellipse(3.5, 13 + b, 2.3, 2.3), ...legs];
    earAt = [19.5, 6.5 + b]; eye = [23, 9 + b]; nose = [27, 11 + b]; cheek = [24, 12 + b];
  }
  const mask = g.layer(body, FUR, OUT);
  // the lop ear: from the top of the head, spoon-shaped, wider at the tip
  const [ex, ey] = earAt, L = 10, dx = -Math.sin(ear), dy = Math.cos(ear);
  g.layer([capsule(ex, ey, ex + dx * L * 0.8, ey + dy * L * 0.8, 1.5), ellipse(ex + dx * L * 0.82, ey + dy * L * 0.82, 2.3, 2.3)], EAR, OUT);
  if (pose === 'dead') for (const [x, y] of [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]]) g.dot(eye[0] + x, eye[1] + y, OUT);
  else { g.dot(eye[0], eye[1] + 1, OUT); if (!blink) g.dot(eye[0], eye[1], OUT); }
  g.dot(nose[0], nose[1], PINK);
  g.dot(cheek[0], cheek[1], PINK);
  return sprite(g, mask);
}

// ---------------------------------------------------------------------------------------------- obstacles and friends
// a blackberry bramble, different each time (rnd: () => 0…1)
export function bramble(rnd, big) {
  const w = big ? 13 + Math.floor(rnd() * 6) : 8 + Math.floor(rnd() * 3), h = big ? 14 + Math.floor(rnd() * 4) : 9 + Math.floor(rnd() * 3);
  const g = new Grid(w + 2, h + 1), shapes = [capsule(w / 2 + 1, h, w / 2 + 1, h * 0.4, 1.2), ellipse(w / 2 + 1, h * 0.35 + 1, w * 0.3, h * 0.3)];
  for (let k = 0; k < (big ? 6 : 3); k++) {
    const r = 2 + rnd() * 2;
    shapes.push(ellipse(1 + r + rnd() * (w - 2 * r), h * 0.35 + rnd() * (h * 0.65 - r), r, r));
  }
  const mask = g.layer(shapes, INK);
  for (let y = 0; y < g.h - 1; y++) for (let x = 1; x < g.w - 1; x++) { // thorns
    const i = y * g.w + x;
    if (!mask[i] && (mask[i + 1] || mask[i - 1] || mask[i + g.w]) && rnd() < 0.35) g.px[i] = INK;
  }
  for (let k = 0; k < (big ? 10 : 5); k++) { // berries
    const i = Math.floor(rnd() * mask.length);
    if (mask[i] && mask[i - 1] && mask[i + 1]) g.px[i] = BERRY;
  }
  return sprite(g, mask);
}

export function rock(rnd) {
  const w = 9 + Math.floor(rnd() * 4), g = new Grid(w + 2, 8);
  const mask = g.layer([ellipse(w / 2 + 1, 7, w / 2, 5)], FAINT, INK);
  g.dot(w / 2, 4, LIGHT); g.dot(w / 2 + 1, 4, LIGHT);
  return sprite(g, mask);
}

// a crow flying left; frame 0 wings up, 1 down
const crows = [0, 1].map((f) => {
  const g = new Grid(17, 12);
  const mask = g.layer([ellipse(9, 6.5, 5, 2.4), ellipse(3.8, 5.3, 2.2, 2), capsule(13, 6.5, 16, 5.5, 1.1), capsule(1.5, 5.6, 0.2, 6, 0.6),
    f ? capsule(9, 7, 11, 11, 1.4) : capsule(9, 6, 11, 1, 1.4)], INK);
  g.dot(3, 4, LIGHT);
  return sprite(g, mask);
});
export const crow = (f) => crows[f];

// the fox that chases the rabbit (running right, behind it), two frames
const foxes = [0, 1].map((f) => {
  const g = new Grid(34, 20);
  const mask = g.layer([ellipse(16, 11, 9, 4.5), ellipse(25, 8.5, 4, 3.6), capsule(26, 9, 31.5, 10.5, 1.6), capsule(23.5, 6, 24, 1.5, 1.2), capsule(26.5, 6, 27.5, 1.5, 1.2),
    capsule(8, 10, 1.5, f ? 7 : 12, 2.4),
    ...(f ? [capsule(11, 13, 7, 18, 1.2), capsule(21, 13, 25, 18, 1.2)] : [capsule(11, 13, 13, 18, 1.2), capsule(21, 13, 19, 18, 1.2)])], FOX, OUT);
  g.layer([ellipse(1.8, f ? 6.6 : 12.4, 1.8, 1.8)], BELLY);
  g.layer([ellipse(17, 14, 5, 1.6), ellipse(29, 11.2, 2.5, 1)], BELLY);
  g.dot(26, 7, OUT); g.dot(32, 10, OUT);
  return sprite(g, mask);
});
export const fox = (f) => foxes[f];

export const carrot = fromRows([
  '.g.g.',
  '..g..',
  '.ooo.',
  '.ooo.',
  '.oo..',
  '..o..',
  '..o..',
], { g: LEAF, o: ORANGE });

export const cloud = fromRows([
  '......ffff......',
  '...fff....ff....',
  '.ff.........fff.',
  'f..............f',
  'ffffffffffffffff',
], { f: FAINT });

export const moon = fromRows([
  '..mmm.',
  '.mm...',
  'mm....',
  'mm....',
  'mm....',
  '.mm...',
  '..mmm.',
], { m: INK });

// ------------------------------------------------------------------------------------------------- a 3×5 pixel font
const GLYPHS = {
  A: '25755', B: '65656', C: '34443', D: '65556', E: '74647', F: '74644', G: '34553', H: '55755', I: '72227', J: '11152', K: '55655', L: '44447', M: '57755',
  N: '65555', O: '25552', P: '65644', Q: '25563', R: '65655', S: '34216', T: '72222', U: '55557', V: '55552', W: '55775', X: '55255', Y: '55222', Z: '71247',
  0: '75557', 1: '26227', 2: '61247', 3: '61216', 4: '55711', 5: '74616', 6: '34757', 7: '71222', 8: '75757', 9: '75716',
  ' ': '00000', '.': '00002', ':': '02020', '!': '22202', '-': '00700', '/': '11244',
};
export const textWidth = (s) => s.length * 4 - 1;
// text at (x, y), its top left; align 'center' or 'right' moves x
export function text(ctx, s, x, y, color, align = 'left') {
  s = String(s).toUpperCase();
  if (align === 'center') x -= textWidth(s) / 2;
  if (align === 'right') x -= textWidth(s);
  x = Math.round(x);
  ctx.fillStyle = color;
  [...s].forEach((ch, i) => {
    const gl = GLYPHS[ch] || GLYPHS[' '];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (+gl[r] & (4 >> c)) ctx.fillRect(x + i * 4 + c, y + r, 1, 1);
  });
}

// do two sprites overlap, pixel for pixel (by their masks)?
export function hits(a, ax, ay, b, bx, by) {
  ax = Math.round(ax); ay = Math.round(ay); bx = Math.round(bx); by = Math.round(by);
  const x0 = Math.max(ax, bx), x1 = Math.min(ax + a.w, bx + b.w), y0 = Math.max(ay, by), y1 = Math.min(ay + a.h, by + b.h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (a.mask[(y - ay) * a.w + x - ax] && b.mask[(y - by) * b.w + x - bx]) return true;
  return false;
}
