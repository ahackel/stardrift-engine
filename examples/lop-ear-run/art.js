// Pixel art for Lop Ear Run. Sprites are small grids of palette indices, filled from shapes (ellipses, capsules,
// triangles) and outlined, so ears and tails can swing to any angle. Each sprite comes with a collision mask (ears and
// tails are soft: they never count).

export const W = 300, H = 90, GROUND = 78; // the world in art pixels; GROUND: the y of the ground line

// palette indices
const OUT = 1, FUR = 2, EAR = 3, PINK = 4, INK = 5, BERRY = 6, ORANGE = 7, LEAF = 8, FAINT = 9, LIGHT = 10, FOX = 11, BELLY = 12,
  TAN = 14, BROWN = 15, GINGER = 16, STRIPE = 17, CACTUS = 18, CACTUS_DARK = 19, CACTUS_LIGHT = 20, YELLOW = 21, BARK = 22,
  WOOD = 23, FISH = 24, LEAF_DARK = 25;
export const COLOR = { INK, DIM: 13, BERRY, YELLOW, ENERGY: 26, LEAF, FAINT };

export const PALETTES = {
  day: { bg: '#f7f6f0', 1: '#3a3a3a', 2: '#fdfbf6', 3: '#e3d2c2', 4: '#f19bb2', 5: '#535353', 6: '#d6455f', 7: '#ee8a2a', 8: '#62b04f', 9: '#dedbd0',
    10: '#f7f6f0', 11: '#d9682b', 12: '#fdfbf6', 13: '#9a9a94', 14: '#dfa45e', 15: '#8a5a3b', 16: '#f2a65a', 17: '#c46f34', 18: '#6eae4c',
    19: '#3e7a39', 20: '#a6d46c', 21: '#ffcf3a', 22: '#7a5236', 23: '#e2bd86', 24: '#7aa5cf', 25: '#3f8a3a', 26: '#5dbb4c' },
  night: { bg: '#1d2033', 1: '#141625', 2: '#f4f1ea', 3: '#d3c3b3', 4: '#e88aa3', 5: '#c3c6d8', 6: '#e8607e', 7: '#ee8a2a', 8: '#4f9a48', 9: '#2e3350',
    10: '#1d2033', 11: '#d9682b', 12: '#f4f1ea', 13: '#6a7090', 14: '#cf975a', 15: '#7a5038', 16: '#e69a52', 17: '#b06232', 18: '#4f9446',
    19: '#2f6232', 20: '#86bd5e', 21: '#ffd24a', 22: '#6b4a33', 23: '#cfa974', 24: '#6f98c4', 25: '#2f6e35', 26: '#5dbb4c' },
};

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ellipse = (cx, cy, rx, ry) => (x, y) => ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1;
const capsule = (x1, y1, x2, y2, r) => (x, y) => {
  const px = x + 0.5, py = y + 0.5, dx = x2 - x1, dy = y2 - y1;
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return (px - x1 - t * dx) ** 2 + (py - y1 - t * dy) ** 2 <= r * r;
};
const triangle = (ax, ay, bx, by, cx, cy) => (x, y) => {
  const px = x + 0.5, py = y + 0.5;
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by), d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy), d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
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
  // color the shapes, only where `within` (a mask) is set
  paint(shapes, color, within) {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) if (within[y * this.w + x] && shapes.some((s) => s(x, y))) this.px[y * this.w + x] = color;
  }
  dot(x, y, c) { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.px[y * this.w + x] = c; }
  get(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.px[y * this.w + x] : 0; }
}
const union = (...masks) => masks.reduce((a, m) => a.map((v, i) => v | m[i]));

// a sprite: { w, h, mask, draw(ctx, x, y, palette) }; drawn into a canvas per palette, on first use
function sprite(g, mask, extra) {
  const canvases = {};
  return {
    w: g.w, h: g.h, mask, ...extra,
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

// ----------------------------------------------------------------------------------------------------------- animals
// Every animal faces right in a 26×20 grid, its feet on row FOOT. Poses: run (frames 0-3, see stride), jump (0 rising,
// 1 falling), duck (0/1), idle (0/1: the tail wags), hurt, ko. soft: the angle of the ear (rabbit, dog) or the tail
// (cat) in radians, swung by a spring in the game: 0 hangs down, more swings it back and up.
export const FOOT = 19;
export const ANIMALS = {
  rabbit: { name: 'RABBIT', food: 'carrot' },
  dog: { name: 'DOG', food: 'bone' },
  cat: { name: 'CAT', food: 'fish' },
};

// where a run is in its stride (phase 0…1) → { frame, lift }: the rabbit hops (crouched on the ground, stretched out
// as it rises, gathered as it falls), the dog and the cat gallop
export function stride(kind, phase) {
  if (kind === 'rabbit') {
    if (phase < 0.3) return { frame: 0, lift: 0 };
    const q = (phase - 0.3) / 0.7;
    return { frame: q < 0.5 ? 1 : 2, lift: Math.round(Math.sin(Math.PI * q) * 4) };
  }
  const frame = Math.floor(phase * 4) % 4;
  return { frame, lift: frame === 0 ? 1 : 0 };
}

const animals = new Map();
export function animal(kind, pose, frame = 0, soft = 0.4, blink = false, wiggle = 0) {
  const a = Math.round(clamp(soft, -0.4, 2.6) * 8) / 8, key = `${kind}${pose}${frame}${a}${blink}${wiggle}`;
  if (!animals.has(key)) {
    const g = new Grid(26, 20), { mask, head } = DRAW[kind](g, pose, frame, a, blink, wiggle);
    animals.set(key, sprite(g, mask, { head }));
  }
  return animals.get(key);
}

function eyes(g, pose, [x, y], blink) {
  if (pose === 'ko') for (const [dx, dy] of [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]]) g.dot(x + dx, y + dy, OUT);
  else if (pose === 'hurt') { g.dot(x - 1, y - 1, OUT); g.dot(x, y, OUT); g.dot(x - 1, y + 1, OUT); } // >
  else { g.dot(x, y + 1, OUT); if (!blink) g.dot(x, y, OUT); }
}
// a lop ear hanging from (x, y) at angle a: length L, spoon-shaped (wider at the tip)
const lopEar = (x, y, a, L, r, tip) => {
  const dx = -Math.sin(a), dy = Math.cos(a);
  return [capsule(x, y, x + dx * L * 0.75, y + dy * L * 0.75, r), ellipse(x + dx * L * 0.8, y + dy * L * 0.8, tip, tip)];
};
// legs from hip/shoulder to feet: [[x1, y1, x2, y2], …]
const legs = (list, r) => list.map(([x1, y1, x2, y2]) => capsule(x1, y1, x2, y2, r));

const DRAW = {
  // the rabbit: round and compact, one lop ear, a cotton tail that wiggles (wiggle: -1, 0, 1 moves it up or down)
  rabbit(g, pose, f, ear, blink, wiggle) {
    const crouch = pose === 'idle' || pose === 'hurt' || (pose === 'run' && f === 0);
    const stretch = (pose === 'run' && f === 1) || (pose === 'jump' && f === 0);
    let body, tail, earAt, eye, nose;
    if (crouch) {
      tail = [2.5, 12.5, 2];
      body = [ellipse(9.5, 13.5, 7, 5), ellipse(7.5, 15, 5, 4), ellipse(15.5, 9, 4.5, 4.5), ellipse(19, 10.8, 2.5, 2.2),
        ellipse(8.5, 18.4, 4.5, 1.4), capsule(14.5, 14, 15, 18.3, 1.2)];
      earAt = [13.5, 6]; eye = [17, 8]; nose = [20, 10];
    } else if (stretch) {
      tail = [2, 10.5, 2];
      body = [capsule(6.5, 12.5, 12, 10.5, 4.3), ellipse(16.5, 7.5, 4.5, 4.3), ellipse(20, 9.3, 2.5, 2.2),
        capsule(5, 14.5, 1.5, 17.5, 1.5), capsule(15, 12, 19, 15, 1.1)];
      earAt = [14.5, 4.5]; eye = [18, 6.5]; nose = [21, 8.5];
    } else if (pose === 'run' || pose === 'jump') { // gathered
      tail = [2.5, 11, 2];
      body = [ellipse(10, 12.5, 7, 5), ellipse(16, 8, 4.5, 4.3), ellipse(19.5, 9.8, 2.5, 2.2),
        capsule(8, 16, 12.5, 17.5, 1.5), capsule(15, 12.5, 16.5, 17.3, 1.1)];
      earAt = [14, 5]; eye = [17.5, 7]; nose = [21, 9];
    } else if (pose === 'duck') {
      tail = [1.8, 15, 1.8];
      body = [ellipse(10, 16, 8.5, 3.3), ellipse(18, 15.5, 4, 3.4), ellipse(21.3, 16.6, 2, 1.7),
        ellipse(f ? 6 : 8.5, 18.8, 3.5, 1.1), capsule(17, 18, f ? 20.5 : 19.5, 18.8, 1)];
      earAt = [16, 13]; eye = [19, 14.5]; nose = [22, 16];
    } else { // ko: on its back, feet up
      tail = [2.5, 16, 1.8];
      body = [ellipse(11, 16.5, 8, 3.2), ellipse(19, 15.8, 4.2, 3.4), ellipse(22.3, 17, 2, 1.6),
        capsule(8, 14, 6, 10.5, 1.3), capsule(13.5, 14, 14.5, 11, 1.1)];
      earAt = [17, 13.5]; eye = [20, 15.5]; nose = [23, 17];
    }
    g.layer([ellipse(tail[0] - 0.3, tail[1] + wiggle, tail[2] + 0.3, tail[2] + 0.3)], FUR, OUT); // soft, like the ear
    const mask = g.layer(body, FUR, OUT);
    g.layer(lopEar(earAt[0], earAt[1], ear, 7, 1.4, 2.1), EAR, OUT);
    eyes(g, pose, eye, blink);
    g.dot(nose[0], nose[1], PINK);
    if (pose !== 'ko') g.dot(eye[0] + 1, eye[1] + 3, PINK); // a blush
    return { mask, head: [earAt[0] + 1, earAt[1] - 3] };
  },

  // the dog: a beagle puppy, a floppy ear, a wagging tail
  dog(g, pose, f, ear, blink) {
    let body, far = [], near, tail, earAt, eye, nose, tongue = false, head, muzzle, saddle;
    if (pose === 'duck' || pose === 'ko') {
      const ko = pose === 'ko';
      head = ellipse(19.5, ko ? 15.5 : 14.8, 4.2, ko ? 3.6 : 3.8); muzzle = ellipse(23, ko ? 16.8 : 16.3, 2.5, 1.8);
      body = [ellipse(10.5, 16, 8, 3.2), head, muzzle];
      saddle = ellipse(10, 13.5, 6.5, 2.5);
      near = ko ? legs([[7, 14, 6, 10.5], [13.5, 14, 13, 10.5]], 1.2) : [ellipse(f ? 21 : 20, 18.9, 2.6, 1), ellipse(f ? 5 : 7, 18.9, 3, 1)];
      far = ko ? legs([[9.5, 14, 10, 10.5], [15.5, 14, 16.5, 10.5]], 1.2) : [];
      tail = [3, 15, 1.45];
      earAt = [18, ko ? 12.5 : 11.5]; eye = [21, ko ? 14.5 : 13.5]; nose = [25, ko ? 16 : 15.5]; tongue = ko;
    } else if (pose === 'idle') { // sitting
      head = ellipse(17, 6.5, 4.4, 4.2); muzzle = ellipse(20.5, 8.3, 2.6, 2);
      body = [ellipse(9, 14.5, 5.5, 4.5), ellipse(13.5, 12, 3.8, 5), head, muzzle, ellipse(9.5, 18.6, 3.5, 1.2)];
      saddle = ellipse(8, 12, 5, 3);
      near = legs([[13.5, 14, 13.5, 18.4]], 1.2); far = legs([[15.5, 14, 15.8, 18.4]], 1.2);
      tail = [4, 16.5, f ? 1.0 : 1.6];
      earAt = [15.5, 3]; eye = [18.5, 5]; nose = [22.5, 7.5];
    } else { // run, jump, hurt
      const k = pose === 'jump' ? (f ? 2 : 0) : pose === 'hurt' ? 1 : f;
      head = ellipse(19.5, 7, 4.4, 4.2); muzzle = ellipse(23, 8.8, 2.6, 2);
      body = [ellipse(10.5, 11.5, 7, 4.2), ellipse(15, 11.5, 3.8, 4.4), head, muzzle];
      saddle = ellipse(9.5, 8.5, 6.5, 3.2);
      const feet = [ // hind near, hind far, front near, front far
        [[3, 17.5], [4.5, 18.2], [19.5, 16.8], [18, 17.8]],
        [[7.5, 18.4], [9, 18.4], [14.5, 18.4], [16.5, 18.4]],
        [[10.5, 17.8], [9, 18.2], [12.5, 17.5], [14, 18]],
        [[6, 18.4], [7.5, 18.4], [16.5, 18.4], [15, 18.4]],
      ][k];
      near = legs([[7, 13.5, ...feet[0]], [15.5, 13.5, ...feet[2]]], 1.2);
      far = legs([[8, 13.5, ...feet[1]], [16, 13.5, ...feet[3]]], 1.1);
      tail = [4, 9.5, k % 2 ? 0.95 : 0.55];
      earAt = [18, 3.5]; eye = [21, 5.5]; nose = [25, 8]; tongue = pose === 'run';
    }
    const [tx, ty, ta] = tail, tdx = -Math.sin(ta), tdy = -Math.cos(ta);
    g.layer([capsule(tx, ty, tx + tdx * 5, ty + tdy * 5, 1.1)], TAN, OUT);
    g.dot(tx + tdx * 5.5, ty + tdy * 5.5, FUR);
    const farMask = g.layer(far, FUR, OUT);
    const bodyMask = g.layer([...body, ...near], FUR, OUT);
    g.paint([saddle, head], TAN, bodyMask);
    g.paint([muzzle], FUR, bodyMask);
    if (tongue) g.layer([ellipse(nose[0] - 2.5, nose[1] + 3.3, 1, 1.2)], PINK, OUT);
    g.layer(lopEar(earAt[0], earAt[1], ear, 5.5, 1.6, 2.2), BROWN, OUT);
    eyes(g, pose, eye, blink);
    g.dot(nose[0], nose[1], OUT);
    return { mask: union(farMask, bodyMask), head: [earAt[0] + 1, earAt[1] - 3] };
  },

  // the cat: a ginger kitten, pointed ears, the tail up
  cat(g, pose, f, tailA, blink) {
    let body, far = [], near, tailAt, eye, nose, ears, muzzle, chest, stripes;
    if (pose === 'duck' || pose === 'ko') {
      const ko = pose === 'ko', hy = ko ? 15.6 : 15.3;
      muzzle = ellipse(22.2, hy + 1.3, 1.9, 1.4);
      body = [ellipse(10.5, 16.3, 8, 2.9), ellipse(19.5, hy, 3.8, 3.3), muzzle];
      ears = [triangle(16.5, hy - 2.3, 15.3, hy - 5, 18.5, hy - 3), triangle(19.8, hy - 3, 21, hy - 5.2, 22, hy - 2.6)];
      near = ko ? legs([[7, 14.5, 6, 11], [13.5, 14.5, 13, 11]], 1) : [ellipse(f ? 21.5 : 20.5, 18.9, 2.3, 1), ellipse(f ? 5 : 7, 18.9, 2.6, 1)];
      far = ko ? legs([[9.5, 14.5, 10, 11], [15.5, 14.5, 16.5, 11]], 1) : [];
      chest = ellipse(16, 18, 2, 1.5);
      stripes = [7, 10, 13].map((x) => capsule(x, 13, x - 0.5, 15, 0.6));
      tailAt = [3.5, 16, 1.55];
      eye = [20.5, hy - 1]; nose = [23, hy + 0.5];
    } else if (pose === 'idle') { // sitting
      muzzle = ellipse(17.3, 9, 2, 1.6);
      body = [ellipse(9.5, 14, 5.5, 5), ellipse(13, 13, 3, 4.5), ellipse(14.5, 7.5, 4, 3.7), muzzle, ellipse(10, 18.6, 3.5, 1.2)];
      ears = [triangle(11.3, 5.5, 11.8, 0.8, 14.5, 4.2), triangle(15, 4, 17, 0.6, 18, 5.6)];
      near = legs([[13, 15, 13, 18.5]], 1); far = legs([[15, 15, 15.2, 18.5]], 1);
      chest = ellipse(14, 12, 2, 2.5);
      stripes = [5.5, 8.5].map((x) => capsule(x, 10, x - 0.5, 12.5, 0.6));
      tailAt = [4.5, 17, 1.25 + (f ? 0.2 : 0)];
      eye = [15.5, 7]; nose = [18.5, 8.5];
    } else { // run, jump, hurt
      const k = pose === 'jump' ? (f ? 2 : 0) : pose === 'hurt' ? 1 : f;
      muzzle = ellipse(22.3, 10, 2, 1.6);
      body = [ellipse(10.5, 12, 7, 3.8), ellipse(19.5, 8.5, 4, 3.7), muzzle];
      ears = [triangle(16.4, 6.2, 17, 1.6, 19.5, 5), triangle(20, 4.8, 22, 1.4, 23, 6.6)];
      const feet = [
        [[3, 17.3], [4.5, 18], [19.5, 16.5], [18, 17.6]],
        [[7, 18.4], [8.5, 18.4], [14.5, 18.4], [16.5, 18.4]],
        [[10.5, 17.6], [9, 18], [12.5, 17.3], [14, 17.8]],
        [[5.5, 18.4], [7, 18.4], [16.5, 18.4], [15, 18.4]],
      ][k];
      near = legs([[6.5, 13.5, ...feet[0]], [15, 13.5, ...feet[2]]], 1);
      far = legs([[7.5, 13.5, ...feet[1]], [15.5, 13.5, ...feet[3]]], 0.9);
      chest = ellipse(16, 13, 2.5, 2.2);
      stripes = [6.5, 9.5, 12.5].map((x) => capsule(x, 8, x - 0.5, 10.3, 0.6));
      tailAt = [4, 10.5, 0.35 + tailA * 0.6];
      eye = [20.5, 7.5]; nose = [23, 9.5];
    }
    // the tail: up and back from the rump, its tip curling forward
    const [tx, ty, ta] = tailAt, d1 = [-Math.sin(ta), -Math.cos(ta)], d2 = [-Math.sin(ta - 0.9), -Math.cos(ta - 0.9)];
    const mx = tx + d1[0] * 4.5, my = ty + d1[1] * 4.5;
    g.layer([capsule(tx, ty, mx, my, 1.1), capsule(mx, my, mx + d2[0] * 3.5, my + d2[1] * 3.5, 1.1)], GINGER, OUT);
    const farMask = g.layer(far, GINGER, OUT);
    const bodyMask = g.layer([...body, ...ears, ...near], GINGER, OUT);
    g.paint(stripes, STRIPE, bodyMask);
    g.paint([muzzle, chest], BELLY, bodyMask);
    eyes(g, pose, eye, blink);
    g.dot(nose[0], nose[1], PINK);
    return { mask: union(farMask, bodyMask), head: [eye[0] - 1, eye[1] - 6] };
  },
};

// the birds that circle a knocked-out head: two frames
const birds = [0, 1].map((f) => {
  const g = new Grid(9, 7);
  g.layer([ellipse(3.5, 4, 2.6, 1.8), ellipse(5.5, 2.8, 1.6, 1.6), f ? capsule(3, 4, 1.5, 5.5, 0.8) : capsule(3, 3.5, 1.5, 1.2, 0.8)], YELLOW, OUT);
  g.dot(8, 3, ORANGE); g.dot(5, 2, OUT);
  return sprite(g, new Uint8Array(g.w * g.h));
});
export const bird = (f) => birds[f];

// ------------------------------------------------------------------------------------------------------- obstacles
// low obstacles (jump them): cacti, rocks, logs; high ones (duck under them): branches, crows at head height.
// A high obstacle's mask ends on row DUCK_UNDER (above the ground): every animal stands taller, ducks lower.
export const DUCK_UNDER = GROUND - 11;

// a cactus, different each time (rnd: () => 0…1): a tall saguaro with arms, or a small barrel, prickly pear or sprout
export function cactus(rnd, big) {
  const type = big ? 'saguaro' : ['barrel', 'pear', 'sprout'][Math.floor(rnd() * 3)];
  const h = type === 'saguaro' ? 16 + Math.floor(rnd() * 5) : 9 + Math.floor(rnd() * 3), w = type === 'saguaro' ? 19 : type === 'sprout' ? 12 : 14;
  const g = new Grid(w, h + 3), base = h + 3, cx = w / 2, parts = []; // each part: [shape, axis x or null, half width, rib]
  let flower = null;
  if (type === 'saguaro') {
    const sides = rnd() < 0.3 ? [rnd() < 0.5 ? -1 : 1] : [-1, 1];
    for (const s of sides) {
      const ay = base - h * (0.4 + rnd() * 0.2), ax = cx + s * 5.4, top = ay - 3.5 - rnd() * 3;
      parts.push([capsule(cx, ay, ax, ay, 1.6), null, 1.6], [capsule(ax, ay, ax, top, 1.7), ax, 1.7]);
    }
    parts.push([capsule(cx, base - h + 2.6, cx, base + 3, 2.6), cx, 2.6, true]);
    if (rnd() < 0.5) flower = [Math.floor(cx), base - h - 1];
  } else if (type === 'barrel') {
    const rx = 4.5 + rnd(), ry = h / 2 + 0.5;
    parts.push([ellipse(cx, base - ry + 1, rx, ry), cx, rx, true]);
    flower = [Math.floor(cx), base - h - 1];
  } else if (type === 'pear') {
    parts.push([ellipse(cx - 2.8, base - h + 3.5, 2.5, 3.2), cx - 2.8, 2.5], [ellipse(cx + 3, base - h + 4.5, 2.4, 3), cx + 3, 2.4],
      [ellipse(cx, base - 4.5, 3.4, 5), cx, 3.4]);
  } else {
    parts.push([capsule(cx + 2.6, base - h + 4, cx + 2.6, base + 2, 1.8), cx + 2.6, 1.8], [capsule(cx - 1.8, base - h + 1.8, cx - 1.8, base + 2, 2.1), cx - 1.8, 2.1, true]);
  }
  const mask = g.layer(parts.map((p) => p[0]), CACTUS, OUT);
  // shading: the left side lit, the right in shadow, a rib down the middle; arms lit on top
  for (const [shape, axis, r, rib] of parts) {
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      if (!shape(x, y)) continue;
      const i = y * g.w + x;
      if (axis === null) { g.px[i] = !shape(x, y - 1) ? CACTUS_LIGHT : !shape(x, y + 1) ? CACTUS_DARK : CACTUS; continue; }
      const d = x + 0.5 - axis;
      g.px[i] = d < -r + 1.1 ? CACTUS_LIGHT : d > r - 1.1 ? CACTUS_DARK : rib && Math.abs(d) < 0.6 ? CACTUS_DARK : CACTUS;
    }
  }
  if (type === 'pear') for (let i = 0; i < mask.length; i++) if (mask[i] && g.px[i] === CACTUS && rnd() < 0.12) g.px[i] = CACTUS_DARK;
  // spines: little ticks out of the outline, now and then
  const outline = g.px.map((c, i) => c === OUT && !mask[i]);
  for (let y = 0; y < g.h - 2; y++) for (let x = 0; x < g.w; x++) {
    if (!outline[y * g.w + x] || rnd() > 0.22) continue;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1]]) {
      if (g.get(x - dx, y - dy) === 0 || !mask[(y - dy) * g.w + x - dx]) continue;
      if (g.get(x + dx, y + dy) === 0) g.dot(x + dx, y + dy, OUT);
    }
  }
  if (type === 'pear') for (const [x, y] of [[cx - 2.8, base - h + 0.3], [cx + 3, base - h + 1.5]]) if (rnd() < 0.7) g.layer([ellipse(x, y, 1.2, 1.2)], BERRY, OUT);
  if (flower) {
    const [fx, fy] = flower;
    for (const [dx, dy, c] of [[0, 0, YELLOW], [-1, 0, PINK], [1, 0, PINK], [0, -1, PINK], [-1, 1, PINK], [1, 1, PINK]]) g.dot(fx + dx, fy + dy, c);
  }
  return sprite(g, mask);
}

export function rock(rnd) {
  const w = 9 + Math.floor(rnd() * 4), g = new Grid(w + 2, 8);
  const mask = g.layer([ellipse(w / 2 + 1, 7, w / 2, 5)], FAINT, INK);
  g.dot(w / 2 - 1, 4, LIGHT); g.dot(w / 2, 3, LIGHT); g.dot(w / 2 + 1, 3, LIGHT);
  return sprite(g, mask);
}

// a fallen log, its cut end toward the runner
export function log(rnd) {
  const w = 14 + Math.floor(rnd() * 6), g = new Grid(w + 2, 9);
  const mask = g.layer([capsule(3.5, 5, w - 3, 5, 3.4)], BARK, OUT);
  for (let x = 4; x < w - 5; x += 3 + Math.floor(rnd() * 2)) g.dot(x, 3 + Math.floor(rnd() * 4), BROWN);
  g.layer([ellipse(3.5, 5, 2.4, 3.4)], WOOD, OUT);
  g.dot(3, 4, BARK); g.dot(3, 5, BARK);
  return sprite(g, mask);
}

// a leafy branch hanging from the trees above, down to DUCK_UNDER
export function branch(rnd) {
  const g = new Grid(26, DUCK_UNDER + 1), b = g.h - 1, x0 = 6 + rnd() * 6;
  const stem = [capsule(x0, -2, x0 + 3, b - 12, 1.5), capsule(x0 + 3, b - 12, 13, b - 5, 1.2)];
  const leaves = [ellipse(13, b - 3.2, 6.5, 3.6), ellipse(7.5, b - 5, 4.2, 3.2), ellipse(19, b - 5.5, 4.2, 3.2), ellipse(12.5, b - 7.5, 4.5, 3),
    ...Array.from({ length: 4 }, (_, i) => ellipse(x0 + 0.8 * i + (i % 2 ? 4 : -3), 6 + i * ((b - 20) / 4), 2.6, 1.6))];
  const mask = union(g.layer(stem, BARK, OUT), g.layer(leaves, LEAF, OUT));
  for (let y = 1; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    const i = y * g.w + x;
    if (g.px[i] === LEAF && (!mask[i + g.w] || y === g.h - 1 || (x * 7 + y * 3) % 11 === 0)) g.px[i] = LEAF_DARK;
  }
  for (let k = 0; k < 3; k++) if (rnd() < 0.5) g.layer([ellipse(7 + k * 5 + rnd() * 2, b - 2 + rnd() * 1.5, 1.2, 1.2)], BERRY, OUT);
  return sprite(g, mask);
}

// a crow flying left; frame 0 wings up, 1 down
const crows = [0, 1].map((f) => {
  const g = new Grid(17, 11);
  const mask = g.layer([ellipse(9, 6.5, 5, 2.4), ellipse(3.8, 5.3, 2.2, 2), capsule(13, 6.5, 16, 5.5, 1.1), capsule(1.5, 5.6, 0.2, 6, 0.6),
    f ? capsule(9, 7, 11, 9.3, 1.4) : capsule(9, 6, 11, 1, 1.4)], INK);
  g.dot(3, 4, LIGHT);
  return sprite(g, mask);
});
export const crow = (f) => crows[f];
// the lowest row of a crow's mask, in either frame
export const CROW_BOTTOM = Math.max(...crows.map((c) => Math.max(...[...c.mask.keys()].filter((i) => c.mask[i]).map((i) => Math.floor(i / c.w)))));

// the fox that chases the runner (running right, behind it), two frames
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

// ------------------------------------------------------------------------------------------------------------- food
function bone() {
  const g = new Grid(12, 7);
  g.layer([capsule(3, 3.5, 9, 3.5, 1.2), ellipse(2.2, 2.4, 1.6, 1.6), ellipse(2.2, 4.6, 1.6, 1.6), ellipse(9.8, 2.4, 1.6, 1.6), ellipse(9.8, 4.6, 1.6, 1.6)], BELLY, OUT);
  return sprite(g, new Uint8Array(g.w * g.h));
}
function fish() {
  const g = new Grid(12, 8);
  g.layer([ellipse(6.5, 4, 3.8, 2.4), triangle(0.5, 1.2, 0.5, 6.8, 3.4, 4)], FISH, OUT);
  g.dot(8, 3, OUT); g.dot(6, 4, LIGHT); g.dot(4, 3, LIGHT);
  return sprite(g, new Uint8Array(g.w * g.h));
}
const carrot = fromRows([
  '.g.g.',
  '..g..',
  '.ooo.',
  '.ooo.',
  '.oo..',
  '..o..',
  '..o..',
], { g: LEAF, o: ORANGE });
export const FOOD = { carrot, bone: bone(), fish: fish() };

// ---------------------------------------------------------------------------------------------------------- the sky
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

export const heart = fromRows([
  'rr.rr',
  'rrrrr',
  'rrrrr',
  '.rrr.',
  '..r..',
], { r: BERRY });

// ------------------------------------------------------------------------------------------------- a 3×5 pixel font
const GLYPHS = {
  A: '25755', B: '65656', C: '34443', D: '65556', E: '74647', F: '74644', G: '34553', H: '55755', I: '72227', J: '11152', K: '55655', L: '44447', M: '57755',
  N: '65555', O: '25552', P: '65644', Q: '25563', R: '65655', S: '34216', T: '72222', U: '55557', V: '55552', W: '55775', X: '55255', Y: '55222', Z: '71247',
  0: '75557', 1: '26227', 2: '61247', 3: '61216', 4: '55711', 5: '74616', 6: '34757', 7: '71222', 8: '75757', 9: '75716',
  ' ': '00000', '.': '00002', ':': '02020', '!': '22202', '-': '00700', '/': '11244', '+': '02720', '<': '12421', '>': '42124',
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
