const express = require('express');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public'));

const limiter = rateLimit({ windowMs: 60*1000, max: 30, standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);

const matchLimiter = rateLimit({ windowMs: 60*1000, max: 10 });
app.use('/api/match/', matchLimiter);

const rooms = new Map();
let boardMessages = [];
const MAX_BOARD = 1000;
const MAX_ROOM_MSGS = 200;

function isValidUUID(id) { return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id); }

class Room {
  constructor(id, u1, u2) { this.roomId = id; this.user1 = u1; this.user2 = u2; this.messages = []; this.lastActive = Date.now(); }
  hasUser(uid) { return this.user1 === uid || this.user2 === uid; }
}

app.get('/api/init', (req, res) => res.json({ userId: uuidv4() }));

app.post('/api/match/join', (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  let pool = req.app.locals.matchingPool || [];
  if (pool.some(u => u.userId === userId)) return res.json({ success: true });
  const { myGender='secret', wantGender='any', ageRange='any' } = req.body;
  pool.push({ userId, myGender, wantGender, ageRange, timestamp: Date.now() });
  if (pool.length > 500) pool.shift();
  req.app.locals.matchingPool = pool;
  res.json({ success: true });
});

app.get('/api/match/check', (req, res) => {
  const { userId } = req.query;
  let pool = req.app.locals.matchingPool || [];
  const now = Date.now();
  pool = pool.filter(u => now - u.timestamp < 30000);
  req.app.locals.matchingPool = pool;
  const current = pool.find(u => u.userId === userId);
  if (!current) return res.json({ matched: false });
  for (let i = 0; i < pool.length; i++) {
    const other = pool[i];
    if (other.userId === userId) continue;
    const aWantsB = current.wantGender === 'any' || current.wantGender === other.myGender;
    const bWantsA = other.wantGender === 'any' || other.wantGender === current.myGender;
    const aAgeMatch = current.ageRange === 'any' || current.ageRange === other.ageRange;
    const bAgeMatch = other.ageRange === 'any' || other.ageRange === current.ageRange;
    if (aWantsB && bWantsA && aAgeMatch && bAgeMatch) {
      pool = pool.filter(u => u.userId !== userId && u.userId !== other.userId);
      req.app.locals.matchingPool = pool;
      const roomId = uuidv4();
      rooms.set(roomId, new Room(roomId, userId, other.userId));
      return res.json({ matched: true, roomId });
    }
  }
  res.json({ matched: false });
});

app.post('/api/match/cancel', (req, res) => {
  const { userId } = req.body;
  let pool = req.app.locals.matchingPool || [];
  pool = pool.filter(u => u.userId !== userId);
  req.app.locals.matchingPool = pool;
  res.json({ success: true });
});

app.get('/api/chat/poll', (req, res) => {
  const { roomId, lastMessageIndex } = req.query;
  if (!isValidUUID(roomId)) return res.status(400).json({ error: 'invalid roomId' });
  const room = rooms.get(roomId);
  if (!room) return res.json({ closed: true });
  const idx = parseInt(lastMessageIndex) || 0;
  res.json({ closed: false, messages: room.messages.slice(idx), currentLength: room.messages.length });
});

app.post('/api/chat/send', (req, res) => {
  const { roomId, userId, content } = req.body;
  if (!isValidUUID(roomId) || !content || content.length > 500) return res.status(400).json({ error: 'invalid' });
  const room = rooms.get(roomId);
  if (!room || !room.hasUser(userId)) return res.status(403).json({ error: 'forbidden' });
  room.messages.push({ senderId: userId, content, timestamp: Date.now() });
  if (room.messages.length > MAX_ROOM_MSGS) room.messages.shift();
  room.lastActive = Date.now();
  res.json({ success: true });
});

app.post('/api/chat/leave', (req, res) => {
  const { roomId, userId } = req.body;
  if (!isValidUUID(roomId)) return res.status(400).json({ error: 'invalid' });
  const room = rooms.get(roomId);
  if (!room || !room.hasUser(userId)) return res.status(403).json({ error: 'forbidden' });
  rooms.delete(roomId);
  res.json({ success: true });
});

app.get('/api/board/list', (req, res) => {
  const sorted = [...boardMessages].sort((a, b) => b.timestamp - a.timestamp);
  const safe = sorted.slice(0, 50).map(m => ({
    id: m.id, nickname: m.nickname, content: m.content, timestamp: m.timestamp,
    replies: m.replies.map(r => ({ nickname: r.nickname, content: r.content, timestamp: r.timestamp }))
  }));
  res.json({ messages: safe });
});

app.post('/api/board/post', (req, res) => {
  const { userId, nickname, content } = req.body;
  if (!content || content.length > 500) return res.status(400).json({ error: 'invalid content' });
  const safeNick = (nickname || '匿名').slice(0, 20);
  const msg = { id: uuidv4(), userId, nickname: safeNick, content, timestamp: Date.now(), replies: [] };
  boardMessages.push(msg);
  if (boardMessages.length > MAX_BOARD) boardMessages.shift();
  res.json({ success: true });
});

app.post('/api/board/reply', (req, res) => {
  const { messageId, userId, nickname, content } = req.body;
  if (!content || content.length > 500) return res.status(400).json({ error: 'invalid content' });
  const msg = boardMessages.find(m => m.id === messageId);
  if (!msg) return res.status(404).json({ error: 'not found' });
  const safeNick = (nickname || '匿名').slice(0, 20);
  msg.replies.push({ userId, nickname: safeNick, content, timestamp: Date.now() });
  res.json({ success: true });
});

setInterval(() => {
  const now = Date.now();
  for (let [id, room] of rooms) if (now - room.lastActive > 300000) rooms.delete(id);
}, 60000);

app.listen(PORT, () => console.log(`Secure server on ${PORT}`));
