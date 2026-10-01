// Star Party: a tiny multiplayer game for Onceworlds.
// Everyone online plays in one arena: grab stars, and golden ones are worth five.
// MIT licensed: copy it, change it, make it yours. The platform gives the game its players,
// servers, saves and badges through `window.onceworlds` (the SDK it injects into every game).

const ow = window.onceworlds;

const WORLD_W = 1200;
const WORLD_H = 700;
const SPEED = 340; // world units per second
const PLAYER_R = 20;
const STAR_R = 14;
const GOLD_R = 21;
const GOLD_VALUE = 5;
const STAR_COUNT = 8;
const GRAB_SLACK = 90; // how far off a star the host still accepts a grab (network delay)

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('overlay');
const headingEl = document.getElementById('heading');
const noteEl = document.getElementById('note');
const playBtn = document.getElementById('play');
const bestEl = document.getElementById('best');

let view = { scale: 1, x: 0, y: 0, dpr: 1 };

function resize() {
  // The resolution to draw at: the screen's, capped at 2x, scaled by the player's Graphics setting.
  const dpr = ow.settings.pixelRatio(2);
  canvas.width = Math.floor(innerWidth * dpr);
  canvas.height = Math.floor(innerHeight * dpr);
  const scale = Math.min(canvas.width / WORLD_W, canvas.height / WORLD_H) * 0.94;
  view = { scale, dpr, x: (canvas.width - WORLD_W * scale) / 2, y: (canvas.height - WORLD_H * scale) / 2 };
}
addEventListener('resize', resize);
ow.settings.on('change', resize);
resize();

// ---------------------------------------------------------------- player, saves

const player = await ow.player.get();
const hero = { x: rand(120, WORLD_W - 120), y: rand(120, WORLD_H - 120), hue: hash(String(player.id)) % 360, score: 0 };
let best = num(await ow.save.get('best'), 0);
let lifetime = num(await ow.save.get('lifetime'), 0);
showBest();

function showBest() {
  bestEl.textContent = best > 0 ? `Best ${best} · ${lifetime} stars all-time` : '';
}

let saveTimer = 0;
let submitted = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 1500);
}
function save() {
  fire(ow.save.set('best', best));
  fire(ow.save.set('lifetime', lifetime));
  if (hero.score > submitted) {
    submitted = hero.score;
    fire(ow.leaderboards.submit('most-stars', hero.score)); // guests get nothing back, which is fine
  }
}
// A page that's being hidden may be frozen next: send what's waiting now.
addEventListener('visibilitychange', () => document.hidden && save());

// ---------------------------------------------------------------- the room

let room = null;
let playing = false;
const requested = new Set(); // stars we've already asked the host for

async function connect() {
  room = await ow.rooms.join({ maxPlayers: 12 }); // a public server (a solo room when run outside the platform)
  field = [];
  seen = undefined;
  requested.clear();
  room.on('host', topUpStars);
  room.on('reconnect', topUpStars);
  room.on('message', onMessage);
  room.on('state', (key) => key === 'stars' && requested.clear());
  // Chat typed into the platform overlay shows up as a bubble over the sender (public chat only).
  room.on('chat', (entry) => {
    if (!entry.to && !entry.channel) bubbles.set(entry.from, { text: String(entry.text), until: performance.now() + 5000 });
  });
  room.on('leave', (p) => bubbles.delete(p.id));
  room.on('close', onClose);
  topUpStars();
}

// Stars live in shared room state so everyone sees the same ones. Only the host (one player, who keeps
// the role until they leave) changes them; everyone else asks. The host is whoever has been here longest,
// so every request is checked before it counts.
let field = []; // the stars, read safely from room state
let seen; // the state value `field` was read from

function stars() {
  const raw = room.state.stars;
  if (raw !== seen) {
    seen = raw;
    const next = readStars(raw);
    // A star that left the field pops, for everyone.
    for (const old of field) if (!next.some((s) => s.id === old.id)) burst(old.x, old.y, old.v > 1);
    field = next;
  }
  return field;
}

function readStars(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw.slice(0, 40)) {
    if (!s || typeof s.id !== 'string' || s.id.length > 16) continue;
    const x = num(s.x, NaN);
    const y = num(s.y, NaN);
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    out.push({ id: s.id, x: clamp(x, 0, WORLD_W), y: clamp(y, 0, WORLD_H), v: s.v === GOLD_VALUE ? GOLD_VALUE : 1 });
  }
  return out;
}

function starR(star) {
  return star.v > 1 ? GOLD_R : STAR_R;
}

function newStar(current) {
  const gold = Math.random() < 0.14 && !current.some((s) => s.v > 1); // one golden star at a time
  return { id: Math.random().toString(36).slice(2, 9), x: rand(50, WORLD_W - 50), y: rand(50, WORLD_H - 50), v: gold ? GOLD_VALUE : 1 };
}

function topUpStars() {
  if (!room.isHost || !room.connected) return;
  const next = [...stars()];
  if (next.length >= STAR_COUNT) return;
  while (next.length < STAR_COUNT) next.push(newStar(next));
  room.setState('stars', next);
}

function hostGrant(starId, who) {
  if (!room.isHost || !room.connected) return;
  const star = stars().find((s) => s.id === starId);
  if (!star) return; // someone else got there first
  const mine = who.id === room.me.id;
  if (!mine) {
    const p = who.presence; // players ask, the host checks they were really next to it
    if (!p || Math.hypot(num(p.x, -1e4) - star.x, num(p.y, -1e4) - star.y) > PLAYER_R + starR(star) + GRAB_SLACK) return;
  }
  const rest = stars().filter((s) => s.id !== starId);
  room.setState('stars', [...rest, newStar(rest)]);
  if (mine) collect(star.v);
  else room.send({ type: 'granted', v: star.v }, { to: who.id });
}

function onMessage(msg, from) {
  if (!msg || typeof msg !== 'object' || !from) return;
  if (msg.type === 'grab' && room.isHost && typeof msg.id === 'string') hostGrant(msg.id, from);
  else if (msg.type === 'granted' && from.id === room.host) collect(clamp(Math.round(num(msg.v, 1)), 1, GOLD_VALUE));
}

let firstStar = false;
let firstGold = false;
function collect(value) {
  hero.score += value;
  lifetime += value;
  best = Math.max(best, hero.score);
  room.setPresence(hero);
  chime(value > 1);
  pop(hero.x, hero.y - PLAYER_R - 10, `+${value}`, value > 1);
  saveSoon();
  // The badges listed in onceworlds.json.
  if (!firstStar) {
    firstStar = true;
    fire(ow.badges.award('first-star'));
  }
  if (value > 1 && !firstGold) {
    firstGold = true;
    fire(ow.badges.award('party-star'));
  }
}

// ---------------------------------------------------------------- screens

let playedAt = 0;
let mode = 'title'; // 'title' before the first Play, 'closed' when the server connection ended

function showOverlay(heading, note, button) {
  headingEl.textContent = heading;
  noteEl.textContent = note;
  playBtn.textContent = button;
  playBtn.disabled = false;
  bestEl.style.display = mode === 'title' ? '' : 'none';
  overlay.classList.remove('off');
  playBtn.focus();
}

playBtn.addEventListener('click', async () => {
  unlockAudio(); // sound can only start from a tap inside the game
  if (mode === 'closed') {
    playBtn.disabled = true;
    try {
      await connect();
    } catch {
      showOverlay('Couldn’t join', 'Try again', 'Rejoin');
      return;
    }
    hero.score = 0;
    submitted = 0;
  }
  start();
});

function start() {
  mode = 'title';
  playing = true;
  playedAt = performance.now();
  overlay.classList.add('off');
  ow.controls.set({ stick: 'analog' }); // phones and tablets: the platform's thumbstick
  room.setPresence(hero);
}

function onClose(reason) {
  playing = false;
  mode = 'closed';
  ow.controls.set(null);
  if (reason === 'kicked') showOverlay('You were removed', '', 'Play');
  else if (reason === 'replaced') showOverlay('Playing in another tab', '', 'Play here');
  else showOverlay('Disconnected', '', 'Rejoin');
}

// The platform menu pauses play.
let paused = false;
ow.on('pause', () => (paused = true));
ow.on('resume', () => (paused = false));

// ---------------------------------------------------------------- input

const keys = new Set();
let target = null;
addEventListener('keydown', (e) => {
  keys.add(String(e.key).toLowerCase());
  target = null;
});
addEventListener('keyup', (e) => keys.delete(String(e.key).toLowerCase()));
addEventListener('blur', () => keys.clear());
canvas.addEventListener('pointerdown', (e) => {
  target = toWorld(e);
});
canvas.addEventListener('pointermove', (e) => {
  if (e.buttons) target = toWorld(e);
});

function toWorld(e) {
  return { x: (e.clientX * view.dpr - view.x) / view.scale, y: (e.clientY * view.dpr - view.y) / view.scale };
}

// ---------------------------------------------------------------- effects

const bits = []; // pop particles
const pops = []; // floating "+5"
const bubbles = new Map(); // chat bubbles by player id

function burst(x, y, gold) {
  if (ow.settings.reducedMotion) return;
  const count = ow.settings.quality === 'low' ? 6 : gold ? 28 : 12;
  for (let i = 0; i < count && bits.length < 160; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = rand(70, gold ? 360 : 230);
    bits.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.45 + Math.random() * 0.4, age: 0, hue: gold ? rand(0, 360) : rand(38, 56) });
  }
}

function pop(x, y, text, gold) {
  if (ow.settings.reducedMotion) return;
  pops.push({ x, y, text, gold, age: 0 });
  if (pops.length > 10) pops.shift();
}

// ---------------------------------------------------------------- loop

function update(dt) {
  if (playing && !paused) {
    let dx = 0;
    let dy = 0;
    if (keys.has('arrowleft') || keys.has('a')) dx -= 1;
    if (keys.has('arrowright') || keys.has('d')) dx += 1;
    if (keys.has('arrowup') || keys.has('w')) dy -= 1;
    if (keys.has('arrowdown') || keys.has('s')) dy += 1;
    if (!dx && !dy) [dx, dy] = [ow.controls.stick.x, ow.controls.stick.y];
    if (!dx && !dy && target) {
      const tx = target.x - hero.x;
      const ty = target.y - hero.y;
      const dist = Math.hypot(tx, ty);
      if (dist > 4) [dx, dy] = [tx / dist, ty / dist];
      else target = null;
    }
    const len = Math.hypot(dx, dy);
    if (len > 0) {
      // Full speed on keys and taps; the thumbstick goes slower when pushed less.
      const step = (SPEED * Math.min(len, 1) * dt) / len;
      hero.x = clamp(hero.x + dx * step, PLAYER_R, WORLD_W - PLAYER_R);
      hero.y = clamp(hero.y + dy * step, PLAYER_R, WORLD_H - PLAYER_R);
      room.setPresence(hero); // safe to call every frame: the SDK sends at most 20 updates/s
    }

    if (room.connected) {
      for (const star of stars()) {
        if (Math.hypot(star.x - hero.x, star.y - hero.y) > PLAYER_R + starR(star)) continue;
        if (room.isHost) hostGrant(star.id, room.me);
        else if (room.host && !requested.has(star.id)) {
          requested.add(star.id);
          room.send({ type: 'grab', id: star.id }, { to: room.host });
        }
      }
    }
  }

  for (let i = bits.length - 1; i >= 0; i--) {
    const b = bits[i];
    b.age += dt;
    if (b.age >= b.life) {
      bits.splice(i, 1);
      continue;
    }
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.vx *= 1 - Math.min(1, 3 * dt);
    b.vy *= 1 - Math.min(1, 3 * dt);
  }
  for (let i = pops.length - 1; i >= 0; i--) {
    pops[i].age += dt;
    if (pops[i].age > 0.9) pops.splice(i, 1);
  }
}

// The standings, worked out a few times a second.
let board = [];
let boardAt = -1e9;
function standings(now) {
  if (now - boardAt < 200) return board;
  boardAt = now;
  board = [];
  for (const p of room.players.values()) {
    const mine = p.id === room.me.id;
    if (mine ? !playing : !p.presence) continue;
    board.push({ id: p.id, name: cleanName(p.name), score: mine ? hero.score : clamp(Math.floor(num(p.presence.score, 0)), 0, 99999), mine });
  }
  board.sort((a, b) => b.score - a.score);
  return board;
}

let bgGradient = null;
const confetti = Array.from({ length: 46 }, (_, i) => ({ x: rand(20, WORLD_W - 20), y: rand(20, WORLD_H - 20), r: rand(2, 4.5), hue: (i * 47) % 360 }));

function draw(now) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0d0726';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.setTransform(view.scale, 0, 0, view.scale, view.x, view.y);
  bgGradient ??= makeBackground();
  ctx.fillStyle = bgGradient;
  ctx.beginPath();
  ctx.roundRect(0, 0, WORLD_W, WORLD_H, 34);
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(160, 130, 255, 0.55)';
  ctx.stroke();
  for (const c of confetti) {
    ctx.fillStyle = `hsl(${c.hue} 90% 70% / 0.28)`;
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const star of stars()) drawStar(star.x, star.y, star.v > 1, now);

  const rows = standings(now);
  const leader = rows.length && rows[0].score > 0 && (rows.length < 2 || rows[1].score < rows[0].score) ? rows[0].id : null;
  for (const p of room.players.values()) {
    const mine = p.id === room.me.id;
    let x;
    let y;
    let info;
    if (mine) {
      if (!playing) continue;
      [x, y, info] = [hero.x, hero.y, hero];
    } else {
      info = p.presence;
      if (!info) continue;
      const at = room.presenceAt(p.id) ?? info; // a moment in the past, between updates: other players glide
      x = clamp(num(at.x, 0), 0, WORLD_W);
      y = clamp(num(at.y, 0), 0, WORLD_H);
    }
    const score = mine ? hero.score : clamp(Math.floor(num(info.score, 0)), 0, 99999);
    ctx.globalAlpha = p.connected === false ? 0.4 : 1; // a held seat: they dropped and may be back
    drawPlayer(x, y, num(info.hue, 0) % 360, `${cleanName(p.name)} · ${score}`, mine, avatarFor(p.id), p.id === leader, now);
    ctx.globalAlpha = 1;
    const bubble = bubbles.get(p.id);
    if (bubble && bubble.until > now) drawBubble(x, y - PLAYER_R - 52, bubble.text);
  }

  for (const b of bits) {
    ctx.globalAlpha = 1 - b.age / b.life;
    ctx.fillStyle = `hsl(${b.hue} 95% 65%)`;
    ctx.beginPath();
    ctx.arc(b.x, b.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  for (const f of pops) {
    ctx.globalAlpha = 1 - f.age / 0.9;
    ctx.font = `900 ${f.gold ? 34 : 26}px ui-rounded, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#2a1170';
    ctx.strokeText(f.text, f.x, f.y - f.age * 70);
    ctx.fillStyle = f.gold ? '#fff2a8' : '#ffd35c';
    ctx.fillText(f.text, f.x, f.y - f.age * 70);
  }
  ctx.globalAlpha = 1;

  if (playing) drawHud(rows);
}

// The HUD is drawn in screen pixels. The top-left corner belongs to the platform's buttons.
function drawHud(rows) {
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  const narrow = innerWidth < 520;

  // My score, top centre (below the platform's buttons on a phone).
  const text = `★ ${hero.score}`;
  ctx.font = '900 26px ui-rounded, system-ui, sans-serif';
  const w = ctx.measureText(text).width + 36;
  const px = innerWidth / 2 - w / 2;
  const py = narrow ? 62 : 14;
  ctx.fillStyle = 'rgba(20, 10, 60, 0.78)';
  ctx.beginPath();
  ctx.roundRect(px, py, w, 44, 22);
  ctx.fill();
  ctx.fillStyle = '#ffd35c';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, innerWidth / 2, py + 23);

  // The standings, top right.
  const shown = rows.slice(0, narrow ? 3 : 5);
  const bw = narrow ? 150 : 200;
  const bx = innerWidth - bw - 12;
  ctx.font = '800 14px ui-rounded, system-ui, sans-serif';
  shown.forEach((row, i) => {
    const y = 14 + i * 30;
    ctx.fillStyle = row.mine ? 'rgba(255, 211, 92, 0.92)' : 'rgba(20, 10, 60, 0.7)';
    ctx.beginPath();
    ctx.roundRect(bx, y, bw, 26, 13);
    ctx.fill();
    ctx.fillStyle = row.mine ? '#2a1170' : '#f4efff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(`${i + 1}  ${row.name.slice(0, narrow ? 9 : 14)}`, bx + 12, y + 14);
    ctx.textAlign = 'right';
    ctx.fillText(String(row.score), bx + bw - 12, y + 14);
  });

  if (performance.now() - playedAt < 12_000) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.font = '800 14px ui-rounded, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(244, 239, 255, 0.7)';
    // Not in the lower corners: thumbs cover them on a phone.
    ctx.fillText(ow.controls.touch ? 'Drag to move · Golden stars are worth 5' : 'WASD or tap to move · Golden stars are worth 5 · / to chat', innerWidth / 2, innerHeight - 16);
  }
}

let last = 0;
function frame(now) {
  update(Math.min(0.05, (now - last) / 1000));
  last = now;
  draw(now);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- drawing

function makeBackground() {
  const g = ctx.createLinearGradient(0, 0, 0, WORLD_H);
  g.addColorStop(0, '#2b1a78');
  g.addColorStop(1, '#170d45');
  return g;
}

function drawStar(x, y, gold, now) {
  const r = gold ? GOLD_R : STAR_R;
  const calm = ow.settings.reducedMotion;
  ctx.save();
  ctx.translate(x, y + (calm ? 0 : Math.sin(now / 400 + y) * 2.5));
  if (!calm) ctx.rotate(((now / (gold ? 600 : 900) + x) % (Math.PI * 2)));
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 ? r * 0.46 : r;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath();
  const color = gold ? `hsl(${(now / 8) % 360} 95% 66%)` : '#ffd35c';
  ctx.fillStyle = color;
  ctx.shadowColor = gold ? color : 'rgba(255, 211, 92, 0.75)';
  ctx.shadowBlur = gold ? 26 : 14;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = gold ? '#fff' : '#fff2a8';
  ctx.stroke();
  ctx.restore();
}

// Every player's platform avatar (a headshot), loaded once; a coloured disc until it arrives.
const avatars = new Map();
function avatarFor(id) {
  if (!avatars.has(id)) {
    avatars.set(id, null);
    Promise.resolve(ow.player.avatarUrl(id, 'head')).then((url) => {
      if (!url) return;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => avatars.set(id, img);
      img.src = url;
    }).catch(() => {});
  }
  return avatars.get(id);
}

function drawPlayer(x, y, hue, label, mine, avatar, leading, now) {
  ctx.beginPath();
  ctx.arc(x, y, PLAYER_R, 0, Math.PI * 2);
  ctx.fillStyle = `hsl(${hue} 80% 62%)`;
  ctx.fill();
  if (avatar) {
    ctx.save();
    ctx.clip();
    ctx.drawImage(avatar, x - PLAYER_R, y - PLAYER_R, PLAYER_R * 2, PLAYER_R * 2);
    ctx.restore();
  }
  ctx.beginPath();
  ctx.arc(x, y, PLAYER_R, 0, Math.PI * 2);
  ctx.lineWidth = mine ? 5 : 4;
  ctx.strokeStyle = mine ? '#fff' : `hsl(${hue} 85% 78%)`;
  ctx.stroke();

  if (leading) {
    const bob = ow.settings.reducedMotion ? 0 : Math.sin(now / 300) * 2;
    const cy = y - PLAYER_R - 8 + bob;
    ctx.beginPath();
    ctx.moveTo(x - 13, cy);
    ctx.lineTo(x - 15, cy - 14);
    ctx.lineTo(x - 7, cy - 7);
    ctx.lineTo(x, cy - 17);
    ctx.lineTo(x + 7, cy - 7);
    ctx.lineTo(x + 15, cy - 14);
    ctx.lineTo(x + 13, cy);
    ctx.closePath();
    ctx.fillStyle = '#ffd35c';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#7a3b00';
    ctx.stroke();
  }

  ctx.font = '800 15px ui-rounded, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 5;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(13, 7, 38, 0.9)';
  ctx.strokeText(label, x, y + PLAYER_R + 7);
  ctx.fillStyle = '#f4efff';
  ctx.fillText(label, x, y + PLAYER_R + 7);
}

function drawBubble(x, y, text) {
  const shown = text.length > 40 ? `${text.slice(0, 39)}…` : text;
  ctx.font = '700 15px ui-rounded, system-ui, sans-serif';
  const w = ctx.measureText(shown).width + 24;
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - 15, w, 30, 15);
  ctx.fill();
  ctx.fillStyle = '#1b1245';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(shown, x, y);
}

// ---------------------------------------------------------------- sound
// Plain Web Audio: the platform's volume slider and mute button apply automatically.

let audio = null;
function unlockAudio() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    audio ??= new AudioCtx();
    if (audio.state === 'suspended') audio.resume();
  } catch {
    audio = null;
  }
}

function chime(gold) {
  if (!audio) return;
  try {
    const t = audio.currentTime;
    (gold ? [660, 880, 1320, 1760] : [880, 1320]).forEach((freq, i) => {
      const start = t + i * 0.07;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
      osc.connect(gain).connect(audio.destination);
      osc.start(start);
      osc.stop(start + 0.32);
    });
  } catch {
    // Sound is a bonus: never let it stop the game.
  }
}

// ---------------------------------------------------------------- helpers

function showFatal(message) {
  overlay.classList.add('off');
  document.body.insertAdjacentHTML(
    'beforeend',
    '<p style="position:fixed;inset:0;display:grid;place-items:center;margin:0;color:#f4efff;font:16px system-ui"></p>',
  );
  document.body.lastElementChild.textContent = message;
}

/** Wait for a promise (or not) without ever throwing: saves, badges and scores are nice to have. */
function fire(result) {
  Promise.resolve(result).catch(() => {});
}

/** Names come from other players: drawn with canvas text only, and kept short. */
function cleanName(name) {
  return String(name ?? '').slice(0, 24) || 'Player';
}

function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function hash(text) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

// ---------------------------------------------------------------- start
// Last on purpose: everything above exists before the first server event or tap can reach it.

ow.controls.set(null); // none on the title screen
try {
  await connect();
} catch (err) {
  showFatal(`Couldn’t join a server: ${err.message}`);
  throw err;
}
playBtn.disabled = false;
playBtn.focus();
last = performance.now();
requestAnimationFrame(frame);
