// Lop Ear Run: a pixel rabbit with lop ears runs, jumps brambles and ducks crows. A small game that drives the Stardrift
// engine the way a game would: one mood for each state of play, stingers for its events.
//
//   relaxed    the title and game over        jump       the rabbit jumps
//   exploring  the first stretch              reward     a carrot
//   tension    once crows fly in (300)        discovery  the fox is left behind
//   action     once the run is fast (700)     alert      the rabbit trips
//   danger     while the fox chases it
//   wonder     while it is night
import { StardriftPlayer } from 'stardrift-engine';
import { W, H, GROUND, PALETTES, RABBIT_FOOT, rabbit, bramble, rock, crow, fox, carrot, cloud, moon, text, hits } from './art.js';

const view = document.getElementById('game'), vctx = view.getContext('2d');
const world = document.createElement('canvas');
world.width = W; world.height = H;
const ctx = world.getContext('2d');

// ------------------------------------------------------------------------------------------------------------- tuning
const START_SPEED = 110, MAX_SPEED = 270, ACCEL = 3; // art pixels per second (per second)
const GRAVITY = 1500, JUMP = 330, JUMP_CUT = 140; // a held jump rises to about 36 px, a tap to about 12
const RABBIT_X = 30, SCORE_PER_PX = 0.1;
const CROWS_FROM = 300, FAST_FROM = 700; // the scores where tension and action begin
const NIGHT_EVERY = 900, NIGHT_SECS = 14, FOX_FIRST = 500, FOX_EVERY = 1000, FOX_SECS = 12;

// --------------------------------------------------------------------------------------------------------- the music
const music = new StardriftPlayer();
const song = fetch('song.json').then((r) => r.json());
let audio = 'off'; // off | starting | on
let muted = false;
try { muted = localStorage.getItem('lop.muted') === '1'; } catch { /* no storage: sound on */ }
let mood = null;
const calls = []; // the last calls to the music, newest first, as game code would write them

function call(name, ...args) {
  calls.unshift(`music.${name}(${args.map((a) => JSON.stringify(a).replace(/"/g, "'").replace(/'(\w+)':/g, '$1: ')).join(', ')})`);
  calls.length = Math.min(calls.length, 5);
  if (audio === 'on') music[name](...args);
  showCalls();
}

// the first key or tap starts the audio (browsers need a user gesture for it)
async function startAudio() {
  if (audio !== 'off') return;
  audio = 'starting';
  try {
    await music.init();
    music.load(await song, { seed: Math.floor(Math.random() * 1e6) });
    music.setVolume(muted ? 0 : 1, 0);
    await music.play();
    audio = 'on';
    music.setMood(mood || 'relaxed', { within: 0 });
  } catch (err) {
    audio = 'off';
    status.textContent = `no music: ${err.message}`;
  }
}

// which mood the game is in: the music follows it
function wantedMood() {
  if (state !== 'run') return 'relaxed';
  if (chase) return 'danger';
  if (night) return 'wonder';
  return score() < CROWS_FROM ? 'exploring' : score() < FAST_FROM ? 'tension' : 'action';
}
function updateMood(options) {
  const m = wantedMood();
  if (m === mood) return;
  mood = m;
  if (options) call('setMood', m, options); else call('setMood', m);
  showMood();
}

// ----------------------------------------------------------------------------------------------------------- state
let state = 'title'; // title | run | over | paused
let speed, dist, bonus, t, alt, vAlt, held, ducking, ear, earVel, legT, obstacles, carrots, parts, floats;
let spawnIn, chase, night, nextNight, nextFox, overAt, blinkT, flash, hundreds;
let hi = 0;
try { hi = +localStorage.getItem('lop.hi') || 0; } catch { /* no storage */ }
const score = () => Math.floor(dist * SCORE_PER_PX) + bonus;
const rnd = Math.random;
const AUTO = new URLSearchParams(location.search).has('auto'); // ?auto: the rabbit runs by itself (to hear the moods)

function reset() {
  speed = START_SPEED; dist = 0; bonus = 0; t = 0; alt = 0; vAlt = 0; held = false; ear = 0.2; earVel = 0; legT = 0;
  obstacles = []; carrots = []; parts = []; floats = [];
  spawnIn = 120; chase = null; night = 0; nextNight = NIGHT_EVERY; nextFox = FOX_FIRST; flash = 0; hundreds = 0;
}
reset();
blinkT = 0;

function start() {
  reset();
  state = 'run';
  updateMood();
}

function gameOver() {
  state = 'over';
  overAt = performance.now();
  call('sting', 'alert');
  updateMood({ within: 0 });
  if (score() > hi) { hi = score(); try { localStorage.setItem('lop.hi', String(hi)); } catch { /* no storage */ } }
}

// ------------------------------------------------------------------------------------------------------------- input
function press() {
  startAudio();
  if (state === 'title') return start();
  if (state === 'over') { if (performance.now() - overAt > 600) start(); return; }
  if (state === 'paused') { state = 'run'; if (audio === 'on') music.play(); return; }
  held = true;
  if (alt === 0 && !ducking) {
    vAlt = JUMP;
    earVel -= 9; // the ear flicks down as it takes off
    call('sting', 'jump');
  }
}
function release() {
  held = false;
  if (vAlt > JUMP_CUT) vAlt = JUMP_CUT;
}

const JUMP_KEYS = ['Space', 'ArrowUp', 'KeyW'], DUCK_KEYS = ['ArrowDown', 'KeyS'];
addEventListener('keydown', (e) => {
  if (JUMP_KEYS.includes(e.code)) { e.preventDefault(); if (!e.repeat) press(); }
  else if (DUCK_KEYS.includes(e.code)) { e.preventDefault(); startAudio(); ducking = true; }
  else if (e.code === 'KeyM') toggleMute();
});
addEventListener('keyup', (e) => {
  if (JUMP_KEYS.includes(e.code)) release();
  else if (DUCK_KEYS.includes(e.code)) ducking = false;
});
// touch: the left half ducks while held, the right half jumps; a mouse click jumps
view.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  view.setPointerCapture(e.pointerId);
  if (e.pointerType === 'touch' && e.offsetX < view.clientWidth / 2 && state === 'run') { startAudio(); ducking = true; } else press();
});
const lift = () => { ducking = false; release(); };
view.addEventListener('pointerup', lift);
view.addEventListener('pointercancel', lift);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden || state !== 'run') return;
  state = 'paused';
  if (audio === 'on') music.pause(0.2);
});

const muteBtn = document.getElementById('mute');
function toggleMute() {
  muted = !muted;
  try { localStorage.setItem('lop.muted', muted ? '1' : '0'); } catch { /* no storage */ }
  if (audio === 'on') music.setVolume(muted ? 0 : 1, 0.1);
  muteBtn.textContent = muted ? 'Sound off' : 'Sound on';
  muteBtn.setAttribute('aria-pressed', String(muted));
}
muteBtn.addEventListener('click', () => { startAudio(); toggleMute(); muteBtn.blur(); });
muteBtn.textContent = muted ? 'Sound off' : 'Sound on';
muteBtn.setAttribute('aria-pressed', String(muted));

// ------------------------------------------------------------------------------------------------- the music panel
const status = document.getElementById('status'), moodsEl = document.getElementById('moods'), callsEl = document.getElementById('calls');
let section = '–';
music.on('state', (ev) => { if (ev.section) { section = ev.section; showMood(); } });
music.on('error', (ev) => { status.textContent = ev.text; });
function showMood() {
  for (const el of moodsEl.children) el.classList.toggle('on', el.dataset.mood === mood);
  status.textContent = audio === 'on' ? `section: ${section}` : 'press a key or tap the game to start the music';
}
function showCalls() { callsEl.textContent = calls.join('\n'); }

// ------------------------------------------------------------------------------------------------------------ world
function spawn() {
  const s = score();
  let o;
  if (s >= CROWS_FROM && rnd() < 0.3) {
    const sp = crow(0), above = [2, 14, 26][Math.floor(rnd() * 3)]; // jump it, duck (or jump) it, run under it
    o = { kind: 'crow', sprite: sp, x: W, y: GROUND - above - sp.h, fly: 20 };
  } else {
    const sp = rnd() < 0.2 ? rock(rnd) : bramble(rnd, s > 150 && rnd() < 0.4);
    o = { kind: 'ground', sprite: sp, x: W, y: GROUND - sp.h + 1, fly: 0 };
    // at speed, brambles come in twos and threes
    for (let n = speed > 170 && rnd() < 0.35 ? 1 + Math.floor(rnd() * (speed > 220 ? 2 : 1)) : 0, x = W + sp.w; n > 0; n--) {
      const more = bramble(rnd, false);
      obstacles.push({ kind: 'ground', sprite: more, x: x - 1, y: GROUND - more.h + 1, fly: 0 });
      x += more.w - 1;
      o.extra = (o.extra || 0) + more.w - 1;
    }
  }
  obstacles.push(o);
  const gap = speed * (0.75 + rnd() * 0.9) + 24;
  spawnIn = o.sprite.w + (o.extra || 0) + gap;
  if (rnd() < 0.3) carrots.push({ x: W + o.sprite.w + gap / 2, y: GROUND - 30 - rnd() * 10 });
}

// ?auto: jump what is on the ground (and low crows), duck crows at head height, run under the high ones
function autopilot() {
  const next = obstacles.filter((o) => o.x + o.sprite.w > RABBIT_X + 6).sort((a, b) => a.x - b.x)[0];
  ducking = false;
  if (!next) return;
  const gap = next.x - (RABBIT_X + 26), above = GROUND - (next.y + next.sprite.h);
  if (next.kind === 'crow' && above >= 20) return;
  if (next.kind === 'crow' && above >= 10) { ducking = alt === 0 && gap < 40; return; }
  if (alt === 0 && gap < speed * 0.1 && gap > -8) press();
}

function rabbitSprite() {
  const blink = (t * 1000) % 3200 < 120;
  if (state === 'over') return rabbit('dead', 0, ear);
  if (state === 'title') return rabbit('idle', 1, ear, (blinkT % 3.2) < 0.12);
  if (alt > 0) return rabbit('jump', 0, ear, blink);
  const f = Math.floor(legT * 2) % 2;
  return rabbit(ducking ? 'duck' : 'run', f, ear, blink);
}
const rabbitY = () => GROUND - RABBIT_FOOT - alt;

function update(dt) {
  blinkT += dt;
  // the ear swings on a spring toward where the run, the wind and the jump would put it
  const earTarget = state === 'title' ? 0.15 + 0.05 * Math.sin(blinkT * 2)
    : state !== 'run' ? 0.9
    : ducking && alt === 0 ? 1.5
    : alt > 0 ? 0.5 + Math.max(-0.4, Math.min(1.9, -vAlt / 220))
    : 0.45 + 0.12 * Math.sin(legT * Math.PI * 2);
  earVel += ((earTarget - ear) * 170 - earVel * 11) * dt;
  ear += earVel * dt;
  if (AUTO && state === 'over' && performance.now() - overAt > 3000) start();
  if (state !== 'run') return;

  if (AUTO) autopilot();
  t += dt;
  speed = Math.min(MAX_SPEED, START_SPEED + ACCEL * t) * (chase ? 1.12 : 1);
  const dx = speed * dt;
  dist += dx;
  legT += dt * (4 + speed / 40);
  flash = Math.max(0, flash - dt);

  // jumping: a held jump floats, a ducked one falls fast
  if (alt > 0 || vAlt > 0) {
    vAlt -= GRAVITY * (ducking ? 3 : 1) * dt;
    alt += vAlt * dt;
    if (alt <= 0) {
      alt = 0; vAlt = 0;
      earVel += 7; // flop
      for (let i = 0; i < 3; i++) parts.push({ x: RABBIT_X + 8 + i * 3, y: GROUND - 1, vx: -30 - rnd() * 30, vy: -20 - rnd() * 20, life: 0.35, color: 5 });
    }
  }

  // the world moves left
  spawnIn -= dx;
  if (spawnIn <= 0) spawn();
  for (const o of obstacles) o.x -= dx + o.fly * dt;
  obstacles = obstacles.filter((o) => o.x > -o.sprite.w);
  for (const c of carrots) c.x -= dx;
  for (const c of clouds) { c.x -= dx * 0.15; if (c.x < -20) { c.x = W + rnd() * 80; c.y = 8 + rnd() * 30; } }
  hillX += dx * 0.08;
  groundX = (groundX + dx) % GROUND_LOOP;

  // what the rabbit runs into
  const rs = rabbitSprite(), ry = rabbitY();
  for (const o of obstacles) {
    if (o.kind === 'crow') o.sprite = crow(Math.floor(t * 6) % 2);
    if (hits(rs, RABBIT_X, ry, o.sprite, o.x, o.y)) { gameOver(); return; }
  }
  carrots = carrots.filter((c) => {
    if (c.x < -6) return false;
    if (c.x + 5 > RABBIT_X + 4 && c.x < RABBIT_X + 28 && c.y + 7 > ry && c.y < ry + 24) {
      bonus += 50;
      call('sting', 'reward');
      floats.push({ text: '+50', x: c.x, y: c.y - 4, life: 0.8 });
      for (let i = 0; i < 6; i++) parts.push({ x: c.x + 2, y: c.y + 3, vx: (rnd() - 0.5) * 90, vy: -rnd() * 80, life: 0.5, color: 7 });
      return false;
    }
    return true;
  });

  // the events: night falls now and then, a fox gives chase now and then (never both at once)
  const s = score();
  if (night) { night = Math.max(0, night - dt); }
  else if (!chase && s >= nextNight) { night = NIGHT_SECS; nextNight += NIGHT_EVERY; }
  if (chase) {
    chase.t += dt;
    chase.x = chase.t < FOX_SECS ? Math.min(-4, chase.x + 20 * dt) + Math.sin(chase.t * 9) * 0.6 : chase.x - 60 * dt;
    if (chase.x < -40 && chase.t > FOX_SECS) {
      chase = null;
      bonus += 100;
      call('sting', 'discovery');
      floats.push({ text: 'ESCAPED! +100', x: RABBIT_X, y: GROUND - 40, life: 1.4 });
    }
  } else if (!night && s >= nextFox) { chase = { t: 0, x: -40 }; nextFox += FOX_EVERY; }
  if (Math.floor(s / 100) > hundreds) { hundreds = Math.floor(s / 100); flash = 1; } // the score blinks every 100
  updateMood();
}

function updateBits(dt) {
  for (const p of parts) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 300 * dt; p.life -= dt; }
  parts = parts.filter((p) => p.life > 0);
  for (const f of floats) { f.y -= 12 * dt; f.life -= dt; }
  floats = floats.filter((f) => f.life > 0);
}

// ------------------------------------------------------------------------------------------------------------- draw
const clouds = [{ x: 60, y: 14 }, { x: 170, y: 28 }, { x: 260, y: 10 }];
const stars = Array.from({ length: 28 }, () => ({ x: Math.floor(rnd() * W), y: Math.floor(rnd() * 50), p: rnd() * 6 }));
let hillX = 0, groundX = 0;
const GROUND_LOOP = 600;
const groundBits = Array.from({ length: 70 }, () => ({ x: Math.floor(rnd() * GROUND_LOOP), kind: rnd() < 0.15 ? 'tuft' : rnd() < 0.5 ? 'dash' : 'dot', y: 2 + Math.floor(rnd() * 4) }));

function draw() {
  const pal = night ? PALETTES.night : PALETTES.day;
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, W, H);

  if (night) {
    for (const s of stars) if (Math.sin(blinkT * 2 + s.p) > -0.6) { ctx.fillStyle = pal[5]; ctx.fillRect(s.x, s.y, 1, 1); }
    moon.draw(ctx, W - 60, 10, pal);
  }
  // far hills
  ctx.fillStyle = pal[9];
  for (let x = 0; x < W; x++) {
    const u = x + hillX, h = 7 + 4 * Math.sin(u * 0.021) + 3 * Math.sin(u * 0.057 + 1.3);
    ctx.fillRect(x, Math.round(GROUND - h), 1, Math.round(h));
  }
  for (const c of clouds) cloud.draw(ctx, c.x, c.y, pal);

  // the ground
  ctx.fillStyle = pal[5];
  ctx.fillRect(0, GROUND, W, 1);
  for (const b of groundBits) {
    const x = Math.round(((b.x - groundX) % GROUND_LOOP + GROUND_LOOP) % GROUND_LOOP);
    if (x >= W) continue;
    if (b.kind === 'dot') ctx.fillRect(x, GROUND + b.y, 1, 1);
    else if (b.kind === 'dash') ctx.fillRect(x, GROUND + b.y, 3, 1);
    else { ctx.fillRect(x, GROUND - 1, 1, 1); ctx.fillRect(x + 2, GROUND - 2, 1, 2); ctx.fillRect(x + 4, GROUND - 1, 1, 1); }
  }

  for (const c of carrots) carrot.draw(ctx, c.x, c.y + Math.round(Math.sin(blinkT * 5 + c.x * 0.1)), pal);
  for (const o of obstacles) o.sprite.draw(ctx, o.x, o.y, pal);
  if (chase) fox(Math.floor(chase.t * 10) % 2).draw(ctx, chase.x - 4, GROUND - 19, pal);
  rabbitSprite().draw(ctx, RABBIT_X, rabbitY(), pal);
  for (const p of parts) { ctx.fillStyle = pal[p.color]; ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1); }
  for (const f of floats) text(ctx, f.text, f.x, Math.round(f.y), pal[5]);

  // the score, blinking at every hundred
  const pad = (n) => String(n).padStart(5, '0');
  if (!(flash > 0 && Math.floor(flash * 8) % 2)) text(ctx, pad(score()), W - 6, 5, pal[5], 'right');
  if (hi) text(ctx, `HI ${pad(hi)}`, W - 30, 5, pal[13], 'right');

  if (state === 'title') {
    text(ctx, 'LOP EAR RUN', W / 2, 24, pal[5], 'center');
    text(ctx, 'PRESS SPACE OR TAP TO RUN', W / 2, 36, pal[5], 'center');
  } else if (state === 'over') {
    text(ctx, 'GAME OVER', W / 2, 24, pal[5], 'center');
    text(ctx, 'SPACE OR TAP TO RUN AGAIN', W / 2, 36, pal[5], 'center');
  } else if (state === 'paused') {
    text(ctx, 'PAUSED - SPACE OR TAP', W / 2, 30, pal[5], 'center');
  }

  // up to the screen, in whole pixels
  vctx.imageSmoothingEnabled = false;
  vctx.drawImage(world, 0, 0, view.width, view.height);
}

function fit() {
  const scale = Math.max(1, Math.round((view.clientWidth * devicePixelRatio) / W));
  if (view.width !== W * scale) { view.width = W * scale; view.height = H * scale; }
}
new ResizeObserver(fit).observe(view);
fit();

// fixed steps, so a slow frame never lets the rabbit pass through a bramble; at most a quarter second caught up
const STEP = 1 / 120;
let last = performance.now(), behind = 0;
function frame(now) {
  behind = Math.min(0.25, behind + (now - last) / 1000);
  last = now;
  for (; behind >= STEP; behind -= STEP) if (state !== 'paused') { update(STEP); updateBits(STEP); }
  draw();
  requestAnimationFrame(frame);
}
updateMood();
requestAnimationFrame(frame);
