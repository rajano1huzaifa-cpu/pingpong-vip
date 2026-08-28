/**
 * Ping Pong VIP — backend server
 * Express (REST API) + Socket.io (real-time matchmaking/relay) + SQLite (data)
 *
 * Run locally:   npm install && npm start
 * Env vars (see .env.example):
 *   PORT              - port to listen on (default 3000)
 *   JWT_SECRET        - long random string used to sign login tokens
 *   ADMIN_USERNAMES   - comma separated usernames that get admin rights on registration
 */
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_DEV_ONLY_SECRET';
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

if (JWT_SECRET === 'CHANGE_ME_DEV_ONLY_SECRET') {
  console.warn('[SECURITY WARNING] JWT_SECRET is not set. Set it in your environment before going live.');
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
// DB_PATH lets you point the database at a mounted persistent disk on your host
// (recommended in production — see README "Keeping your data" section).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  username_lower TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_banned INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL,
  rating INTEGER NOT NULL DEFAULT 1000,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rating ON users (rating DESC);
`);

function defaultState(username) {
  return {
    username,
    level: 1, xp: 0,
    coins: 300, gems: 50,
    stats: { wins: 0, losses: 0, matchesPlayed: 0, totalPoints: 0, winStreak: 0, bestStreak: 0, perfectGames: 0, tournamentsWon: 0, levelsCleared: 0 },
    rating: 1000,
    inventory: { paddles: ['paddle_classic'], balls: ['ball_classic'], arenas: ['arena_classic'], outfits: ['outfit_classic'], effects: ['effect_none'], animations: ['anim_none'] },
    equipped: { paddle: 'paddle_classic', ball: 'ball_classic', arena: 'arena_classic', outfit: 'outfit_classic', effect: 'effect_none', animation: 'anim_none' },
    achievements: {},
    dailyMissions: { date: null, list: [], session: {} },
    campaign: { cleared: {}, stars: {} },
    vip: { active: false, expiresAt: 0, activations: 0 },
    matchHistory: [],
    settings: { sfx: true, music: true, shake: true, invert: false }
  };
}

function rowToPublicUser(row) {
  const state = JSON.parse(row.state_json);
  return { ...state, username: row.username, isAdmin: !!row.is_admin, rating: row.rating };
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function signToken(user) {
  return jwt.sign({ uid: user.id, username: user.username, isAdmin: !!user.is_admin }, JWT_SECRET, { expiresIn: '30d' });
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session, please log in again.' });
  }
}
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  next();
}

// simple in-memory rate limiter for auth endpoints (per IP)
const attempts = new Map();
function rateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const rec = attempts.get(key) || { count: 0, reset: now + 60000 };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + 60000; }
  rec.count++;
  attempts.set(key, rec);
  if (rec.count > 20) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  next();
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------
app.post('/api/register', rateLimit, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || username.trim().length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters.' });
  if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  const uname = username.trim();
  const lower = uname.toLowerCase();
  const exists = db.prepare('SELECT id FROM users WHERE username_lower = ?').get(lower);
  if (exists) return res.status(409).json({ error: 'That username is already taken.' });

  const hash = bcrypt.hashSync(password, 10);
  const isAdmin = ADMIN_USERNAMES.includes(lower) ? 1 : 0;
  const now = Date.now();
  const state = defaultState(uname);
  const info = db.prepare(`INSERT INTO users (username, username_lower, password_hash, is_admin, state_json, rating, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(uname, lower, hash, isAdmin, JSON.stringify(state), 1000, now, now);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  const token = signToken(row);
  res.json({ token, player: rowToPublicUser(row) });
});

app.post('/api/login', rateLimit, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Enter your username and password.' });
  const row = db.prepare('SELECT * FROM users WHERE username_lower = ?').get(username.trim().toLowerCase());
  if (!row) return res.status(404).json({ error: 'No account found with that username.' });
  if (row.is_banned) return res.status(403).json({ error: 'This account has been suspended.' });
  if (!bcrypt.compareSync(password, row.password_hash)) return res.status(401).json({ error: 'Incorrect password.' });
  const token = signToken(row);
  res.json({ token, player: rowToPublicUser(row) });
});

// ---------------------------------------------------------------------------
// Player data routes (cloud save / cross-device sync)
// ---------------------------------------------------------------------------
app.get('/api/me', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.uid);
  if (!row) return res.status(404).json({ error: 'Account not found.' });
  res.json({ player: rowToPublicUser(row) });
});

// Full-state save. Server re-validates numeric fields so a tampered client
// can't just write itself arbitrary coins/gems/rating (basic anti-cheat).
app.put('/api/me', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.uid);
  if (!row) return res.status(404).json({ error: 'Account not found.' });
  const prev = JSON.parse(row.state_json);
  const incoming = req.body && req.body.state;
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'Invalid save payload.' });

  // --- server-side validation / anti-cheat guardrails ---
  const clamp = (n, lo, hi, fallback) => (typeof n === 'number' && isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback);
  const merged = { ...prev, ...incoming };
  merged.level = clamp(incoming.level, 1, 9999, prev.level);
  merged.xp = clamp(incoming.xp, 0, 1e9, prev.xp);
  // currency can only increase by a bounded amount per save, or decrease (spending) — never jump up arbitrarily
  const coinDelta = (incoming.coins ?? prev.coins) - prev.coins;
  merged.coins = coinDelta > 5000 ? prev.coins + 5000 : clamp(incoming.coins, 0, 1e9, prev.coins);
  const gemDelta = (incoming.gems ?? prev.gems) - prev.gems;
  merged.gems = gemDelta > 1000 ? prev.gems + 1000 : clamp(incoming.gems, 0, 1e9, prev.gems);
  merged.rating = clamp(incoming.rating, 0, 5000, prev.rating);
  merged.username = row.username; // username never changes via this route

  const now = Date.now();
  db.prepare('UPDATE users SET state_json = ?, rating = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(merged), merged.rating, now, row.id);
  res.json({ ok: true, player: { ...merged, isAdmin: !!row.is_admin } });
});

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------
app.get('/api/leaderboard', (req, res) => {
  const rows = db.prepare('SELECT username, state_json, rating, is_admin FROM users WHERE is_banned = 0 ORDER BY rating DESC LIMIT 100').all();
  const list = rows.map(r => {
    const s = JSON.parse(r.state_json);
    return { username: r.username, rating: r.rating, level: s.level, wins: s.stats?.wins || 0, vip: !!s.vip?.active };
  });
  res.json({ leaderboard: list });
});

// ---------------------------------------------------------------------------
// Admin routes (owner/admin control panel API)
// ---------------------------------------------------------------------------
app.get('/api/admin/users', auth, requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, username, is_admin, is_banned, rating, created_at, updated_at FROM users ORDER BY id DESC LIMIT 500').all();
  res.json({ users: rows });
});
app.post('/api/admin/grant', auth, requireAdmin, (req, res) => {
  const { username, coins = 0, gems = 0 } = req.body || {};
  const row = db.prepare('SELECT * FROM users WHERE username_lower = ?').get((username || '').toLowerCase());
  if (!row) return res.status(404).json({ error: 'User not found.' });
  const state = JSON.parse(row.state_json);
  state.coins += Number(coins) || 0;
  state.gems += Number(gems) || 0;
  db.prepare('UPDATE users SET state_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(state), Date.now(), row.id);
  res.json({ ok: true });
});
app.post('/api/admin/ban', auth, requireAdmin, (req, res) => {
  const { username, banned = true } = req.body || {};
  const info = db.prepare('UPDATE users SET is_banned = ? WHERE username_lower = ?').run(banned ? 1 : 0, (username || '').toLowerCase());
  if (info.changes === 0) return res.status(404).json({ error: 'User not found.' });
  res.json({ ok: true });
});
app.post('/api/admin/make-admin', auth, requireAdmin, (req, res) => {
  const { username, admin = true } = req.body || {};
  const info = db.prepare('UPDATE users SET is_admin = ? WHERE username_lower = ?').run(admin ? 1 : 0, (username || '').toLowerCase());
  if (info.changes === 0) return res.status(404).json({ error: 'User not found.' });
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Real-time matchmaking + match relay (Socket.io)
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

let queue = []; // [{socketId, username, rating}]
const activeMatches = new Map(); // matchId -> {p1:socketId, p2:socketId}

function authSocket(socket) {
  const token = socket.handshake.auth?.token;
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
}

io.on('connection', (socket) => {
  const user = authSocket(socket);
  if (!user) { socket.disconnect(); return; }
  socket.data.username = user.username;

  socket.on('mm:join', () => {
    queue = queue.filter(q => q.socketId !== socket.id);
    const opponent = queue.shift();
    if (opponent && opponent.socketId !== socket.id) {
      const matchId = 'm_' + Date.now() + '_' + Math.floor(Math.random() * 9999);
      activeMatches.set(matchId, { p1: opponent.socketId, p2: socket.id });
      io.to(opponent.socketId).emit('mm:matched', { matchId, opponent: user.username, isHost: true });
      io.to(socket.id).emit('mm:matched', { matchId, opponent: opponent.username, isHost: false });
    } else {
      queue.push({ socketId: socket.id, username: user.username });
      socket.emit('mm:waiting');
    }
  });

  socket.on('mm:cancel', () => { queue = queue.filter(q => q.socketId !== socket.id); });

  // relay real-time paddle + ball state between the two matched sockets
  socket.on('match:state', ({ matchId, payload }) => {
    const m = activeMatches.get(matchId);
    if (!m) return;
    const otherId = m.p1 === socket.id ? m.p2 : m.p1;
    io.to(otherId).emit('match:state', payload);
  });
  socket.on('match:score', ({ matchId, payload }) => {
    const m = activeMatches.get(matchId);
    if (!m) return;
    const otherId = m.p1 === socket.id ? m.p2 : m.p1;
    io.to(otherId).emit('match:score', payload);
  });
  socket.on('match:end', ({ matchId }) => {
    activeMatches.delete(matchId);
  });

  socket.on('disconnect', () => {
    queue = queue.filter(q => q.socketId !== socket.id);
    for (const [id, m] of activeMatches.entries()) {
      if (m.p1 === socket.id || m.p2 === socket.id) {
        const otherId = m.p1 === socket.id ? m.p2 : m.p1;
        io.to(otherId).emit('match:opponentLeft');
        activeMatches.delete(id);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Ping Pong VIP server running on port ${PORT}`);
  console.log(`Database file: ${DB_PATH}`);
  if (ADMIN_USERNAMES.length) console.log('Admin usernames configured:', ADMIN_USERNAMES.join(', '));
});
