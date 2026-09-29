import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { WORDS } from './words.js';

const PORT = process.env.PORT || 3000;
const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const MAX_PLAYERS = 10, MAX_ROOMS = 300, MAX_POINTS = 50000;
const COLORS = ['#ff5a5f', '#ffd23f', '#2ec4b6', '#7b5cff', '#ff9f1c', '#3a86ff', '#ef476f', '#06d6a0', '#f78fb3', '#8ac926'];

// ---------- static files ----------
const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
    const file = path.normalize(path.join(PUB, pathname === '/' ? 'index.html' : decodeURIComponent(pathname)));
    if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
});

// ---------- helpers ----------
const rooms = new Map();
const uid = () => randomBytes(4).toString('hex');
const clamp = (v, a, b, d) => { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
const unit = v => Math.min(1, Math.max(0, Number(v) || 0));
const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const cleanName = n => String(n || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16) || 'Player';
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const later = (r, ms, fn) => r.timers.push(setTimeout(fn, ms));
const clearTimers = r => { r.timers.forEach(clearTimeout); r.timers = []; };
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function roomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let c;
  do { c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); } while (rooms.has(c));
  return c;
}

// ---------- room state ----------
function newRoom() {
  const r = { code: roomCode(), players: new Map(), hostId: null, phase: 'lobby', settings: { rounds: 3, drawTime: 80 },
    round: 0, order: [], turn: 0, drawerId: null, word: '', choices: [], mask: '', ops: [], points: 0,
    guessed: new Set(), gains: {}, timers: [], endsAt: 0, last: null };
  rooms.set(r.code, r);
  return r;
}
function snapshot(r, pid) {
  const reveal = r.phase === 'turnEnd' || r.phase === 'gameEnd';
  return {
    type: 'state', you: pid, code: r.code, phase: r.phase, hostId: r.hostId, settings: r.settings, round: r.round,
    drawerId: r.drawerId, mask: r.mask, last: r.last,
    word: (pid === r.drawerId && r.phase === 'drawing') || reveal ? r.word : undefined,
    choices: r.phase === 'choosing' && pid === r.drawerId ? r.choices : undefined,
    left: Math.max(0, r.endsAt - Date.now()),
    total: r.phase === 'drawing' ? r.settings.drawTime * 1000 : r.phase === 'choosing' ? 15000 : 0,
    players: [...r.players.values()].map(p => ({ id: p.id, name: p.name, score: p.score, color: p.color, guessed: r.guessed.has(p.id) })),
  };
}
const pushState = r => r.players.forEach(p => send(p.ws, snapshot(r, p.id)));
const broadcast = (r, o, exceptId) => r.players.forEach(p => p.id !== exceptId && send(p.ws, o));
const say = (r, text, kind = 'sys') => broadcast(r, { type: 'chat', kind, text });
const allGuessed = r => r.players.size > 1 && [...r.players.keys()].every(id => id === r.drawerId || r.guessed.has(id));

// ---------- game flow ----------
function startGame(r) {
  r.players.forEach(p => (p.score = 0));
  r.round = 0; r.last = null;
  nextRound(r);
}
function nextRound(r) {
  r.round++;
  if (r.round > r.settings.rounds) return endGame(r);
  r.order = [...r.players.keys()]; r.turn = 0;
  nextTurn(r);
}
function nextTurn(r) {
  if (r.players.size < 2) { say(r, 'Not enough players, back to the lobby'); return toLobby(r); }
  while (r.turn < r.order.length && !r.players.has(r.order[r.turn])) r.turn++;
  if (r.turn >= r.order.length) return nextRound(r);
  r.drawerId = r.order[r.turn++];
  r.phase = 'choosing'; r.word = ''; r.mask = ''; r.ops = []; r.points = 0; r.guessed.clear(); r.gains = {};
  r.choices = [...WORDS].sort(() => Math.random() - 0.5).slice(0, 3);
  r.endsAt = Date.now() + 15000;
  broadcast(r, { type: 'clear' });
  pushState(r);
  later(r, 15000, () => startDrawing(r, r.choices[0]));
}
function startDrawing(r, word) {
  clearTimers(r);
  const ms = r.settings.drawTime * 1000;
  r.phase = 'drawing'; r.word = word; r.mask = word.replace(/[a-z0-9]/gi, '_');
  r.endsAt = Date.now() + ms;
  later(r, ms * 0.45, () => hint(r));
  later(r, ms * 0.7, () => hint(r));
  later(r, ms, () => endTurn(r));
  pushState(r);
}
function hint(r) {
  const hidden = [...r.mask].map((c, i) => (c === '_' ? i : -1)).filter(i => i >= 0);
  if (hidden.length <= 1) return;
  const i = hidden[Math.floor(Math.random() * hidden.length)];
  r.mask = r.mask.slice(0, i) + r.word[i] + r.mask.slice(i + 1);
  pushState(r);
}
function endTurn(r) {
  if (r.phase !== 'drawing') return;
  clearTimers(r);
  r.phase = 'turnEnd'; r.last = { word: r.word, gains: r.gains };
  r.endsAt = Date.now() + 5000;
  if (!r.guessed.size) say(r, 'Nobody guessed it this time');
  pushState(r);
  later(r, 5000, () => nextTurn(r));
}
function endGame(r) {
  clearTimers(r);
  r.phase = 'gameEnd'; r.drawerId = null; r.word = '';
  pushState(r);
}
function toLobby(r) {
  clearTimers(r);
  Object.assign(r, { phase: 'lobby', drawerId: null, word: '', mask: '', ops: [], points: 0 });
  r.guessed.clear();
  broadcast(r, { type: 'clear' });
  pushState(r);
}
function onChat(r, p, raw) {
  const text = String(raw || '').trim().slice(0, 100);
  if (!text) return;
  const now = Date.now();
  if (now - (p.lastChat || 0) < 400) return;
  p.lastChat = now;
  const drawing = r.phase === 'drawing', isDrawer = p.id === r.drawerId;
  if (drawing && !isDrawer && !r.guessed.has(p.id)) {
    const g = norm(text), w = norm(r.word);
    if (g && g === w) {
      const pts = 50 + Math.round(400 * Math.max(0, (r.endsAt - now) / (r.settings.drawTime * 1000)));
      p.score += pts; r.gains[p.id] = pts; r.guessed.add(p.id);
      const d = r.players.get(r.drawerId);
      if (d) { const bonus = Math.round(pts * 0.4); d.score += bonus; r.gains[d.id] = (r.gains[d.id] || 0) + bonus; }
      say(r, `${p.name} guessed the word`, 'good');
      pushState(r);
      if (allGuessed(r)) endTurn(r);
      return;
    }
    if (w.length >= 5 && lev(g, w) === 1) send(p.ws, { type: 'chat', kind: 'close', text: `${text} is really close` });
  }
  const msg = { type: 'chat', name: p.name, color: p.color, text, kind: 'chat' };
  if (drawing && (isDrawer || r.guessed.has(p.id))) {
    msg.kind = 'team';
    r.players.forEach(q => (q.id === r.drawerId || r.guessed.has(q.id)) && send(q.ws, msg));
  } else broadcast(r, msg);
}
function removePlayer(r, p) {
  r.players.delete(p.id); r.guessed.delete(p.id);
  if (!r.players.size) { clearTimers(r); rooms.delete(r.code); return; }
  say(r, `${p.name} left`);
  if (r.hostId === p.id) r.hostId = r.players.keys().next().value;
  const live = ['choosing', 'drawing', 'turnEnd'].includes(r.phase);
  if (live && r.players.size < 2) { say(r, 'Not enough players, back to the lobby'); return toLobby(r); }
  if (p.id === r.drawerId && r.phase === 'drawing') return endTurn(r);
  if (p.id === r.drawerId && r.phase === 'choosing') { clearTimers(r); return nextTurn(r); }
  if (r.phase === 'drawing' && allGuessed(r)) return endTurn(r);
  pushState(r);
}
function join(ws, r, name) {
  const used = [...r.players.values()].map(p => p.color);
  const p = { id: uid(), name: cleanName(name), ws, score: 0, color: COLORS.find(c => !used.includes(c)) || COLORS[0] };
  r.players.set(p.id, p);
  ws.player = p; ws.room = r;
  if (!r.hostId) r.hostId = p.id;
  say(r, `${p.name} joined`);
  pushState(r);
  send(ws, { type: 'sync', ops: r.ops });
}

// ---------- websocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', ws => {
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));
  let tokens = 60, stamp = Date.now();
  ws.on('message', raw => {
    const now = Date.now();
    tokens = Math.min(60, tokens + (now - stamp) * 0.05); stamp = now;
    if (--tokens < 0) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m && typeof m.type === 'string') handle(ws, m);
  });
  ws.on('close', () => ws.player && removePlayer(ws.room, ws.player));
});

function handle(ws, m) {
  if (!ws.player) {
    if (m.type === 'create') {
      if (rooms.size >= MAX_ROOMS) return send(ws, { type: 'error', text: 'Server is busy, try again soon' });
      join(ws, newRoom(), m.name);
    } else if (m.type === 'join') {
      const r = rooms.get(String(m.code || '').toUpperCase().trim());
      if (!r) return send(ws, { type: 'error', text: 'Room not found' });
      if (r.players.size >= MAX_PLAYERS) return send(ws, { type: 'error', text: 'Room is full' });
      join(ws, r, m.name);
    }
    return;
  }
  const p = ws.player, r = ws.room;
  const drawing = r.phase === 'drawing' && p.id === r.drawerId;
  switch (m.type) {
    case 'start':
      if (p.id !== r.hostId || !['lobby', 'gameEnd'].includes(r.phase)) return;
      if (r.players.size < 2) return send(ws, { type: 'error', text: 'You need at least 2 players' });
      r.settings = { rounds: clamp(m.rounds, 1, 6, 3), drawTime: clamp(m.drawTime, 30, 150, 80) };
      return startGame(r);
    case 'pick':
      if (r.phase === 'choosing' && p.id === r.drawerId && r.choices[m.i]) startDrawing(r, r.choices[m.i]);
      return;
    case 'chat': return onChat(r, p, m.text);
    case 'op-start': {
      if (!drawing || !m.op || r.points > MAX_POINTS) return;
      const o = m.op, pt = o.pts && o.pts[0] ? o.pts[0] : [0, 0];
      const op = { t: 's', color: /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : '#000000', size: clamp(o.size, 1, 40, 6), pts: [[unit(pt[0]), unit(pt[1])]] };
      r.ops.push(op); r.points++;
      return broadcast(r, { type: 'op-start', op }, p.id);
    }
    case 'op-pts': {
      const last = r.ops[r.ops.length - 1];
      if (!drawing || !last || !Array.isArray(m.pts) || r.points > MAX_POINTS) return;
      const pts = m.pts.slice(0, 100).map(q => [unit(q && q[0]), unit(q && q[1])]);
      last.pts.push(...pts); r.points += pts.length;
      return broadcast(r, { type: 'op-pts', pts }, p.id);
    }
    case 'undo': if (drawing) { r.ops.pop(); broadcast(r, { type: 'undo' }, p.id); } return;
    case 'clear': if (drawing) { r.ops = []; broadcast(r, { type: 'clear' }, p.id); } return;
  }
}

// drop dead connections (also keeps proxies from idling out sockets)
setInterval(() => wss.clients.forEach(ws => {
  if (!ws.alive) return ws.terminate();
  ws.alive = false; ws.ping();
}), 30000);

server.listen(PORT, () => console.log(`Doodle Dash running on port ${PORT}`));
