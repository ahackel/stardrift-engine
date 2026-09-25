// Deterministic seeded RNG (mulberry32). Same seed => same music, in JS and (later) C#.
export class Rng {
  constructor(seed = 1) {
    this.s = (seed >>> 0) || 1;
  }

  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(a, b) { return a + (b - a) * this.next(); }
  int(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }
  chance(p) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }

  weighted(items, weights) {
    let total = 0;
    for (const w of weights) total += w > 0 ? w : 0;
    if (total <= 0) return items.length ? this.pick(items) : null;
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      const w = weights[i] > 0 ? weights[i] : 0;
      r -= w;
      if (r <= 0 && w > 0) return items[i];
    }
    return items[items.length - 1];
  }
}
