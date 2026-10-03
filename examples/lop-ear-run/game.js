// Lop Ear Run: a rabbit, a dog or a cat runs, jumps cacti and ducks under branches and crows. A small game that drives
// the Stardrift engine the way a game would: one mood for each state of play, stingers for its events.
//
//   relaxed    the title, knocked out         jump       the animal jumps
//   exploring  the first stretch              reward     food
//   tension    once crows fly in (300)        bump       it runs into something
//   action     once the run is fast (700)     discovery  the fox is left behind
//   danger     while the fox chases it        alert      knocked out
//   wonder     while it is night
import { StardriftPlayer } from 'stardrift-engine';
import { W, H, GROUND, PALETTES, COLOR, FOOT, ANIMALS, DUCK_UNDER, CROW_BOTTOM, animal, stride, bird, cactus, rock, log, branch, crow, fox,
  FOOD, cloud, moon, heart, text, hits } from './art.js';

const view = document.getElementById('game'), vctx = view.getContext('2d');
const world = document.createElement('canvas');
world.width = W; world.height = H;
const ctx = world.getContext('2d');

// ------------------------------------------------------------------------------------------------------------- tuning
const START_SPEED = 110, MAX_SPEED = 270, ACCEL = 3; // art pixels per second (per second)
const GRAVITY = 1500, JUMP = 330, JUMP_CUT = 140; // a held jump rises to about 36 px, a tap to about 12
const RUN_X = 30, SCORE_PER_PX = 0.1;
const BRANCHES_FROM = 150, CROWS_FROM = 300, FAST_FROM = 700; // the scores where branches, crows (tension) and speed (action) begin
const NIGHT_EVERY = 900, NIGHT_SECS = 14, FOX_FIRST = 500, FOX_EVERY = 1000, FOX_SECS = 12;
const DRAIN = 2, BUMP = 30, MEAL = 12, SAFE_SECS = 1.5; // energy (of 100): lost per second, per bump; won per food; blinking after a bump

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
let state = 'title'; // title | run | ko | paused
let kind = 'rabbit';
try { if (ANIMALS[localStorage.getItem('lop.animal')]) kind = localStorage.getItem('lop.animal'); } catch { /* no storage */ }
let speed, dist, bonus, t, alt, vAlt, held, ducking, soft, softVel, phase, obstacles, food, parts, floats;
let spawnIn, chase, night, nextNight, nextFox, koT, koWhy, blinkT, flash, hundreds, energy, safe, hurtT, slow;
let hi = 0;
try { hi = +localStorage.getItem('lop.hi') || 0; } catch { /* no storage */ }
const score = () => Math.floor(dist * SCORE_PER_PX) + bonus;
const rnd = Math.random;
const AUTO = new URLSearchParams(location.search).has('auto'); // ?auto: the animal runs by itself (to hear the moods)

function reset() {
  speed = START_SPEED; dist = 0; bonus = 0; t = 0; alt = 0; vAlt = 0; held = false; ducking = false; soft = 0.2; softVel = 0; phase = 0;
  obstacles = []; food = []; parts = []; floats = [];
  spawnIn = 120; chase = null; night = 0; nextNight = NIGHT_EVERY; nextFox = FOX_FIRST; flash = 0; hundreds = 0;
  energy = 100; safe = 0; hurtT = 0; slow = 0; koT = 0;
}
reset();
blinkT = 0;

function start() {
  reset();
  state = 'run';
  showAnimals();
  updateMood();
}

function choose(k) {
  if (state === 'run' || state === 'paused' || !ANIMALS[k]) return;
  kind = k;
  try { localStorage.setItem('lop.animal', k); } catch { /* no storage */ }
  if (state === 'ko') { reset(); state = 'title'; }
  softVel -= 6; // a little bounce for the one picked
  showAnimals();
}
const KINDS = Object.keys(ANIMALS);
const chooseNext = (d) => choose(KINDS[(KINDS.indexOf(kind) + d + KINDS.length) % KINDS.length]);

// a bump costs energy and leaves the animal blinking (safe) for a moment; with none left it is knocked out
function bump() {
  energy = Math.max(0, energy - BUMP);
  safe = SAFE_SECS; hurtT = 0.35; slow = 1;
  if (alt === 0) vAlt = 150; // knocked up a little
  softVel -= 14;
  const [hx, hy] = headAt();
  for (let i = 0; i < 7; i++) parts.push({ x: hx, y: hy, vx: (rnd() - 0.3) * 120, vy: -40 - rnd() * 80, life: 0.5, color: COLOR.YELLOW });
  if (energy <= 0) { speed = -70; return knockOut('KNOCKED OUT!'); } // thrown back from what it ran into
  floats.push({ text: 'OUCH!', x: hx - 8, y: hy - 6, life: 0.7 });
  call('sting', 'bump');
}

function knockOut(why) {
  state = 'ko'; koT = 0; koWhy = why; energy = 0; ducking = false;
  if (chase) chase.leaving = true;
  call('sting', 'alert');
  updateMood({ within: 0 });
  if (score() > hi) { hi = score(); try { localStorage.setItem('lop.hi', String(hi)); } catch { /* no storage */ } }
  showAnimals();
}

// ------------------------------------------------------------------------------------------------------------- input
function press() {
  startAudio();
  if (state === 'title') return start();
  if (state === 'ko') { if (koT > 0.8) start(); return; }
  if (state === 'paused') { state = 'run'; if (audio === 'on') music.play(); return; }
  held = true;
  if (alt === 0 && !ducking) {
    vAlt = JUMP;
    softVel -= 9; // the ear flicks down as it takes off
    call('sting', 'jump');
  }
}
function release() {
  held = false;
  if (vAlt > JUMP_CUT) vAlt = JUMP_CUT;
}

const JUMP_KEYS = ['Space', 'ArrowUp', 'KeyW'], DUCK_KEYS = ['ArrowDown', 'KeyS'];
addEventListener('keydown', (e) => {
  if (e.target.closest?.('button') && (e.code === 'Space' || e.code === 'Enter')) return; // the buttons take their own keys
  if (JUMP_KEYS.includes(e.code)) { e.preventDefault(); if (!e.repeat) press(); }
  else if (DUCK_KEYS.includes(e.code)) { e.preventDefault(); startAudio(); ducking = true; }
  else if (e.code === 'ArrowLeft' || e.code === 'KeyA') { e.preventDefault(); chooseNext(-1); }
  else if (e.code === 'ArrowRight' || e.code === 'KeyD') { e.preventDefault(); chooseNext(1); }
  else if (e.code === 'KeyM') toggleMute();
  else if (e.code === 'KeyF') toggleFull();
});
addEventListener('keyup', (e) => {
  if (JUMP_KEYS.includes(e.code)) release();
  else if (DUCK_KEYS.includes(e.code)) ducking = false;
});
// touch: the left half ducks while held, the right half jumps; a mouse click jumps. On the title, a tap on an animal
// picks it (a second tap runs).
view.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  view.setPointerCapture(e.pointerId);
  const x = (e.offsetX / view.clientWidth) * W;
  if (state === 'title') {
    const k = KINDS.find((_, i) => x >= titleX(i) - 2 && x < titleX(i) + 26);
    if (k && k !== kind) { startAudio(); choose(k); return; }
  }
  if (e.pointerType === 'touch' && x < W / 2 && state === 'run') { startAudio(); ducking = true; } else press();
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

// full screen: only the game (Esc, F or the button leaves). Where the browser has none (iPhone), or its request fails or
// never answers (some embedded browsers), the game fills the window instead.
const stage = document.getElementById('stage');
function toggleFull() {
  if (document.fullscreenElement || stage.classList.contains('full')) {
    stage.classList.remove('full');
    if (document.fullscreenElement) document.exitFullscreen();
    return;
  }
  if (!document.fullscreenEnabled) return stage.classList.add('full');
  stage.requestFullscreen().catch(() => {});
  setTimeout(() => { if (!document.fullscreenElement) stage.classList.add('full'); }, 500);
}
document.addEventListener('fullscreenchange', () => { if (document.fullscreenElement) stage.classList.remove('full'); });
for (const id of ['full', 'exit-full']) {
  const b = document.getElementById(id);
  b.addEventListener('click', () => { startAudio(); toggleFull(); b.blur(); });
}

const animalsEl = document.getElementById('animals');
for (const b of animalsEl.querySelectorAll('button')) b.addEventListener('click', () => { startAudio(); choose(b.dataset.animal); b.blur(); });
function showAnimals() {
  for (const b of animalsEl.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.animal === kind));
    b.disabled = state === 'run' || state === 'paused';
  }
}
showAnimals();

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
// low obstacles to jump (cacti, rocks, logs, low crows), high ones to duck under (branches, crows at head height),
// crows to run under; food now and then, on the ground or up in the air
function spawn() {
  const s = score(), r = rnd();
  let o;
  if (s >= CROWS_FROM && r < 0.22) {
    const at = ['low', 'head', 'head', 'high'][Math.floor(rnd() * 4)];
    const bottom = at === 'low' ? GROUND - 1 : at === 'head' ? DUCK_UNDER : GROUND - 24;
    o = { kind: 'crow', sprite: crow(0), x: W, y: bottom - CROW_BOTTOM, fly: 20, duck: at === 'head', over: at === 'high' };
  } else if (s >= BRANCHES_FROM && r < 0.38) {
    o = { kind: 'branch', sprite: branch(rnd), x: W, y: 0, fly: 0, duck: true };
  } else {
    const k = rnd(), sp = k < 0.15 ? rock(rnd) : k < 0.3 ? log(rnd) : cactus(rnd, s > 150 && rnd() < 0.35);
    o = { kind: 'ground', sprite: sp, x: W, y: GROUND - sp.h + 1, fly: 0 };
    // at speed, small cacti come in twos and threes
    for (let n = speed > 170 && rnd() < 0.35 ? 1 + Math.floor(rnd() * (speed > 220 ? 2 : 1)) : 0, x = W + sp.w; n > 0; n--) {
      const more = cactus(rnd, false);
      obstacles.push({ kind: 'ground', sprite: more, x: x - 2, y: GROUND - more.h + 1, fly: 0 });
      x += more.w - 2;
      o.extra = (o.extra || 0) + more.w - 2;
    }
  }
  obstacles.push(o);
  const gap = speed * (0.75 + rnd() * 0.9) + 24 + (o.duck ? 20 : 0);
  spawnIn = o.sprite.w + (o.extra || 0) + gap;
  if (rnd() < 0.35) {
    const sp = FOOD[ANIMALS[kind].food];
    food.push({ x: W + o.sprite.w + (o.extra || 0) + gap / 2, y: rnd() < 0.5 ? GROUND - sp.h - 3 : GROUND - 30 - rnd() * 10 });
  }
}

// ?auto: jump what is low, duck what is at head height, run under the rest; jump for food in the air when it is clear
function autopilot() {
  const ahead = obstacles.filter((o) => o.x + o.sprite.w > RUN_X + 2 && !o.over).sort((a, b) => a.x - b.x)[0];
  ducking = false;
  const gap = ahead ? ahead.x - (RUN_X + 22) : Infinity;
  if (ahead?.duck) { ducking = alt === 0 && gap < 30; return; }
  if (alt === 0 && gap < speed * 0.1 && gap > -8) return press();
  const snack = food.find((f) => f.y < GROUND - 20 && f.x > RUN_X);
  if (snack && alt === 0 && gap > 90 && snack.x - (RUN_X + 12) < speed * 0.12) press();
}

// the rabbit's tail: it bobs with every hop, and wiggles in quick bursts when the rabbit is not hopping
function wiggle() {
  if (kind !== 'rabbit') return 0;
  if (hopping()) return Math.round(Math.sin(phase * Math.PI * 4));
  return blinkT % 1.7 < 0.45 ? Math.round(Math.sin(blinkT * 40)) : 0;
}
function animalSprite() {
  const blink = (blinkT % 3.2) < 0.12, w = wiggle();
  if (state === 'ko') return animal(kind, alt > 0 ? 'hurt' : 'ko', 0, soft, false, w);
  if (state === 'title') return animal(kind, 'idle', Math.floor(blinkT * 5) % 2, soft, blink, w);
  if (hurtT > 0) return animal(kind, 'hurt', 0, soft);
  if (alt > 0) return animal(kind, 'jump', vAlt > 0 ? 0 : 1, soft, blink);
  if (ducking) return animal(kind, 'duck', Math.floor(phase * 4) % 2, soft, blink, w);
  return animal(kind, 'run', stride(kind, phase).frame, soft, blink, w);
}
const hopping = () => state === 'run' && alt === 0 && !ducking && hurtT <= 0;
const animalY = () => GROUND - FOOT - alt - (hopping() ? stride(kind, phase).lift : 0);
const headAt = () => { const sp = animalSprite(); return [RUN_X + sp.head[0], animalY() + sp.head[1]]; };

function update(dt) {
  blinkT += dt;
  // the ear (the cat's tail) swings on a spring toward where the run, the wind and the jump would put it
  const target = state === 'title' ? 0.15 + 0.05 * Math.sin(blinkT * 2)
    : state === 'ko' ? (kind === 'rabbit' ? -0.3 : 1.2)
    : state !== 'run' ? 0.9
    : ducking && alt === 0 ? 1.5
    : alt > 0 ? 0.5 + Math.max(-0.4, Math.min(1.9, -vAlt / 220))
    : 0.45 + 0.12 * Math.sin(phase * Math.PI * 2);
  softVel += ((target - soft) * 170 - softVel * 11) * dt;
  soft += softVel * dt;
  if (state === 'ko') koT += dt;
  if (AUTO && state === 'ko' && koT > 3) start();
  if (state !== 'run' && state !== 'ko') return;

  if (state === 'run') {
    if (AUTO) autopilot();
    t += dt;
    slow = Math.max(0, slow - dt / 1.2);
    speed = Math.min(MAX_SPEED, START_SPEED + ACCEL * t) * (chase ? 1.12 : 1) * (1 - 0.45 * slow);
  } else speed *= Math.exp(-5 * dt); // knocked out: the world rolls to a stop (back a little, after a bump)
  const dx = speed * dt;
  dist += state === 'run' ? dx : 0;
  const was = phase;
  phase = (phase + dt * (1.6 + speed / 90)) % 1;
  if (phase < was && hopping() && kind === 'rabbit') { // a hop lands: the ear flops, a puff of dust
    softVel += 4;
    for (let i = 0; i < 2; i++) parts.push({ x: RUN_X + 6 + i * 4, y: GROUND - 1, vx: -20 - rnd() * 20, vy: -10 - rnd() * 15, life: 0.25, color: COLOR.FAINT });
  }
  flash = Math.max(0, flash - dt);
  safe = Math.max(0, safe - dt);
  hurtT = Math.max(0, hurtT - dt);

  // jumping: a held jump floats, a ducked one falls fast
  if (alt > 0 || vAlt > 0) {
    vAlt -= GRAVITY * (ducking ? 3 : 1) * dt;
    alt += vAlt * dt;
    if (alt <= 0) {
      alt = 0; vAlt = 0;
      softVel += 7; // flop
      for (let i = 0; i < 3; i++) parts.push({ x: RUN_X + 8 + i * 3, y: GROUND - 1, vx: -30 - rnd() * 30, vy: -20 - rnd() * 20, life: 0.35, color: COLOR.INK });
    }
  }

  // the world moves left
  if (state === 'run') { spawnIn -= dx; if (spawnIn <= 0) spawn(); }
  for (const o of obstacles) {
    o.x -= dx + o.fly * dt;
    if (o.kind === 'crow') o.sprite = crow(Math.floor(blinkT * 6) % 2);
  }
  obstacles = obstacles.filter((o) => o.x > -o.sprite.w);
  for (const f of food) f.x -= dx;
  food = food.filter((f) => f.x > -14);
  for (const c of clouds) { c.x -= dx * 0.15; if (c.x < -20) { c.x = W + rnd() * 80; c.y = 8 + rnd() * 30; } }
  hillX += dx * 0.08;
  groundX = (groundX + dx) % GROUND_LOOP;
  if (chase) {
    chase.t += dt;
    if (chase.leaving || chase.t >= FOX_SECS) chase.x -= (state === 'run' ? 60 : 30) * dt;
    else chase.x = Math.min(-4, chase.x + 20 * dt) + Math.sin(chase.t * 9) * 0.6;
    if (chase.x < -40 && (chase.leaving || chase.t > FOX_SECS)) {
      if (!chase.leaving) {
        bonus += 100;
        call('sting', 'discovery');
        floats.push({ text: 'ESCAPED! +100', x: RUN_X, y: GROUND - 40, life: 1.4 });
      }
      chase = null;
    }
  }
  if (state !== 'run') return;

  // what the animal runs into, what it eats
  const sp = animalSprite(), ay = animalY();
  if (!safe) for (const o of obstacles) if (hits(sp, RUN_X, ay, o.sprite, o.x, o.y)) { bump(); if (state !== 'run') return; break; }
  const meal = FOOD[ANIMALS[kind].food];
  food = food.filter((f) => {
    if (!(f.x + meal.w > RUN_X + 3 && f.x < RUN_X + 22 && f.y + meal.h > ay + 3 && f.y < ay + FOOT)) return true;
    energy = Math.min(100, energy + MEAL);
    bonus += 25;
    call('sting', 'reward');
    floats.push({ text: '+25', x: f.x, y: f.y - 6, life: 0.8 }, { sprite: heart, x: f.x + 14, y: f.y - 6, life: 0.8 });
    for (let i = 0; i < 6; i++) parts.push({ x: f.x + 3, y: f.y + 3, vx: (rnd() - 0.5) * 90, vy: -rnd() * 80, life: 0.5, color: COLOR.BERRY });
    return false;
  });

  // running tires: without food the energy runs out
  energy -= DRAIN * dt;
  if (energy <= 0) return knockOut('TOO TIRED!');

  // the events: night falls now and then, a fox gives chase now and then (never both at once)
  const s = score();
  if (night) { night = Math.max(0, night - dt); }
  else if (!chase && s >= nextNight) { night = NIGHT_SECS; nextNight += NIGHT_EVERY; }
  if (!chase && !night && s >= nextFox) { chase = { t: 0, x: -40 }; nextFox += FOX_EVERY; }
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
let stageBg = null;
const titleX = (i) => Math.round(W / 2 - 13 + (i - 1) * 34); // where the animals stand on the title

// the energy bar, top left: a heart and a bar that turns red (and blinks) when it runs low
function energyBar(pal) {
  const low = energy < 30;
  if (low && state === 'run' && Math.floor(blinkT * 4) % 2) return;
  heart.draw(ctx, 6, 5, pal);
  ctx.fillStyle = pal[COLOR.INK];
  ctx.fillRect(13, 5, 42, 5);
  ctx.fillStyle = pal.bg;
  ctx.fillRect(14, 6, 40, 3);
  ctx.fillStyle = pal[low ? COLOR.BERRY : COLOR.ENERGY];
  ctx.fillRect(14, 6, Math.ceil((40 * energy) / 100), 3);
}

// birds circling a knocked-out head; the ones behind it are drawn first
function dizzyBirds(pal, behind) {
  const [hx, hy] = headAt();
  for (let i = 0; i < 3; i++) {
    const a = koT * 4 + (i * Math.PI * 2) / 3;
    if ((Math.sin(a) < 0) !== behind) continue;
    bird(Math.floor(koT * 8 + i) % 2).draw(ctx, hx + Math.cos(a) * 9 - 4, hy + Math.sin(a) * 2.5 - 4, pal);
  }
}

function draw() {
  const pal = night ? PALETTES.night : PALETTES.day;
  if (stageBg !== pal.bg) stage.style.setProperty('--game-bg', stageBg = pal.bg); // around the game in full screen
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, W, H);

  if (night) {
    for (const s of stars) if (Math.sin(blinkT * 2 + s.p) > -0.6) { ctx.fillStyle = pal[COLOR.INK]; ctx.fillRect(s.x, s.y, 1, 1); }
    moon.draw(ctx, W - 60, 10, pal);
  }
  // far hills
  ctx.fillStyle = pal[COLOR.FAINT];
  for (let x = 0; x < W; x++) {
    const u = x + hillX, h = 7 + 4 * Math.sin(u * 0.021) + 3 * Math.sin(u * 0.057 + 1.3);
    ctx.fillRect(x, Math.round(GROUND - h), 1, Math.round(h));
  }
  for (const c of clouds) cloud.draw(ctx, c.x, c.y, pal);

  // the ground
  ctx.fillStyle = pal[COLOR.INK];
  ctx.fillRect(0, GROUND, W, 1);
  for (const b of groundBits) {
    const x = Math.round(((b.x - groundX) % GROUND_LOOP + GROUND_LOOP) % GROUND_LOOP);
    if (x >= W) continue;
    if (b.kind === 'dot') ctx.fillRect(x, GROUND + b.y, 1, 1);
    else if (b.kind === 'dash') ctx.fillRect(x, GROUND + b.y, 3, 1);
    else { ctx.fillRect(x, GROUND - 1, 1, 1); ctx.fillRect(x + 2, GROUND - 2, 1, 2); ctx.fillRect(x + 4, GROUND - 1, 1, 1); }
  }

  const meal = FOOD[ANIMALS[kind].food];
  for (const f of food) meal.draw(ctx, f.x, f.y + Math.round(Math.sin(blinkT * 5 + f.x * 0.1)), pal);
  for (const o of obstacles) o.sprite.draw(ctx, o.x, o.y, pal);
  if (chase) fox(Math.floor(chase.t * 10) % 2).draw(ctx, chase.x - 4, GROUND - 19, pal);

  if (state === 'title') {
    KINDS.forEach((k, i) => {
      const on = k === kind, x = titleX(i);
      ctx.globalAlpha = on ? 1 : 0.45;
      (on ? animalSprite() : animal(k, 'idle', 0, 0.15)).draw(ctx, x, GROUND - FOOT, pal);
      ctx.globalAlpha = 1;
      text(ctx, ANIMALS[k].name, x + 12, GROUND - 28, pal[on ? COLOR.INK : COLOR.DIM], 'center');
    });
  } else {
    if (state === 'ko') dizzyBirds(pal, true);
    ctx.globalAlpha = safe > 0 && state === 'run' && Math.floor(safe * 10) % 2 ? 0.35 : 1;
    animalSprite().draw(ctx, RUN_X, animalY(), pal);
    ctx.globalAlpha = 1;
    if (state === 'ko') dizzyBirds(pal, false);
  }
  for (const p of parts) { ctx.fillStyle = pal[p.color]; ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1); }
  for (const f of floats) {
    if (f.sprite) f.sprite.draw(ctx, f.x, Math.round(f.y), pal);
    else text(ctx, f.text, f.x, Math.round(f.y), pal[COLOR.INK]);
  }

  // the energy, the score (blinking at every hundred)
  if (state !== 'title') energyBar(pal);
  const pad = (n) => String(n).padStart(5, '0');
  if (!(flash > 0 && Math.floor(flash * 8) % 2)) text(ctx, pad(score()), W - 6, 5, pal[COLOR.INK], 'right');
  if (hi) text(ctx, `HI ${pad(hi)}`, W - 30, 5, pal[COLOR.DIM], 'right');

  if (state === 'title') {
    text(ctx, 'LOP EAR RUN', W / 2, 14, pal[COLOR.INK], 'center');
    text(ctx, '< > PICK - SPACE OR TAP TO RUN', W / 2, 25, pal[COLOR.INK], 'center');
  } else if (state === 'ko') {
    text(ctx, koWhy, W / 2, 24, pal[COLOR.INK], 'center');
    if (koT > 0.8) text(ctx, 'SPACE OR TAP TO RUN AGAIN', W / 2, 36, pal[COLOR.INK], 'center');
  } else if (state === 'paused') {
    text(ctx, 'PAUSED - SPACE OR TAP', W / 2, 30, pal[COLOR.INK], 'center');
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

// fixed steps, so a slow frame never lets the animal pass through a cactus; at most a quarter second caught up
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
