// What each source, note effect and effect costs to play, as parts of a plain pulse note (inst.js costOf uses these).
//   node tools/cost.mjs
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { compileInst, Voice, timeMoves } = await import(root + '/src/engine/voice.js');
const { FxChain, EFFECT_KINDS } = await import(root + '/src/engine/fx.js');
const SR = 48000, N = SR * 2;
const time = (fn) => { fn(); const t = process.hrtime.bigint(); fn(); fn(); return Number(process.hrtime.bigint() - t) / 2 / N; }; // ns per sample
const voice = (def) => () => { const p = compileInst(def, SR); timeMoves(p, { music: true, bps: 2 }); const v = new Voice(); v.start(p, 57, 0.8, null); let s = 0; for (let i = 0; i < N; i++) s += v.render(p); return s; };
const env = { a: 0.01, s: 1 };
const base = time(voice({ layers: [{ type: 'pulse', env }] }));
const out = { pulse: 1 };
for (const [k, d] of Object.entries({
  triangle: { layers: [{ type: 'triangle', env }] }, wave: { layers: [{ type: 'wave', env }] }, fm: { layers: [{ type: 'fm', env }] },
  string: { layers: [{ type: 'string', env }] }, bowed: { layers: [{ type: 'bowed', env }] }, noise: { layers: [{ type: 'noise', env }] },
  'pulse u4': { unison: 4, layers: [{ type: 'pulse', env }] }, 'wave u4': { unison: 4, layers: [{ type: 'wave', env }] }, 'fm u4': { unison: 4, layers: [{ type: 'fm', env }] }, 'bowed u4': { unison: 4, layers: [{ type: 'bowed', env }] },
  'pulse+noise': { layers: [{ type: 'pulse', noise: 0.3, env }] }, 'pulse moves': { layers: [{ type: 'pulse', env, moves: [{ on: 'pitch', to: 3, shape: 'wave' }] }] },
  breath: { breath: 0.5, layers: [{ type: 'pulse', env }] }, vibrato: { vibrato: { depth: 0.2 }, layers: [{ type: 'pulse', env }] }, ensemble: { unison: 4, ensemble: 0.5, layers: [{ type: 'pulse', env }] },
})) out[k] = +(time(voice(d)) / base).toFixed(2);
for (const kind of Object.keys(EFFECT_KINDS)) {
  const fx = new FxChain(SR); fx.set([{ kind, ...(kind === 'filter' && { env: 1 }) }], { music: true, bps: 2 });
  const fn = () => { let s = 0; for (let i = 0; i < N; i++) s += fx.run(Math.sin(i * 0.05) * 0.5, 0.5); return s; };
  const empty = new FxChain(SR); empty.set([], { music: true });
  const e = time(() => { let s = 0; for (let i = 0; i < N; i++) s += empty.run(Math.sin(i * 0.05) * 0.5, 0.5); return s; });
  out['fx ' + kind] = +((time(fn) - e) / base).toFixed(2);
}
console.log('pulse voice ns/sample', base.toFixed(1)); console.log(out);
