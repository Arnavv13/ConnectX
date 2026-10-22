const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return { users: [], messages: [], files: [] }; }
}
let db = loadDB();
function saveDB() {
  const temp = DB_PATH + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(db, null, 2));
  fs.renameSync(temp, DB_PATH);
}
const sessions = new Map(); // token -> user id
const socketsByUser = new Map();
const startedAt = Date.now();
const counters = { messages: 0, files: 0, bytesUploaded: 0, connectionsOpened: 0 };
const onlineIds = () => [...socketsByUser.keys()];
const safeUser = u => ({ id: u.id, username: u.username, displayName: u.displayName, online: socketsByUser.has(u.id) });
function userById(id) { return db.users.find(u => u.id === id); }
function currentUser(req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.cookies?.cc_session;
  const id = token && sessions.get(token);
  return id ? userById(id) : null;
}
app.use(express.json({ limit: '50kb' }));
app.use((req, res, next) => {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)cc_session=([^;]+)/);
  req.cookies = { cc_session: m ? decodeURIComponent(m[1]) : null };
  next();
});
function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please sign in again.' });
  req.user = user; next();
}
const authLimiter = new Map();
function limitAuth(req, res, next) {
  const ip = req.ip || 'local';
  const now = Date.now();
  const arr = (authLimiter.get(ip) || []).filter(t => now - t < 60000);
  if (arr.length >= 20) return res.status(429).json({ error: 'Too many attempts. Wait one minute and try again.' });
  arr.push(now); authLimiter.set(ip, arr); next();
}

app.get('/health', (req, res) => res.json({ status: 'ok', database: 'ok', uptimeSec: Math.floor((Date.now()-startedAt)/1000) }));
app.post('/api/register', limitAuth, async (req, res) => {
  const displayName = String(req.body.displayName || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (displayName.length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters.' });
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–20 letters, numbers or underscores.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must have at least 6 characters.' });
  if (db.users.some(u => u.username === username)) return res.status(409).json({ error: 'That username is already taken.' });
  const user = { id: crypto.randomUUID(), username, displayName, passwordHash: await bcrypt.hash(password, 10), createdAt: Date.now() };
  db.users.push(user); saveDB();
  const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, user.id);
  res.json({ token, user: safeUser(user) });
});
app.post('/api/login', limitAuth, async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const user = db.users.find(u => u.username === username);
  if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.passwordHash)))
    return res.status(401).json({ error: 'Incorrect username or password.' });
  const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, user.id);
  res.json({ token, user: safeUser(user) });
});
app.post('/api/logout', requireAuth, (req, res) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (token) sessions.delete(token);
  for (const socket of io.sockets.sockets.values()) if (socket.data.userId === req.user.id) socket.disconnect(true);
  res.json({ ok: true });
});
app.get('/api/me', requireAuth, (req, res) => res.json({ user: safeUser(req.user) }));
app.get('/api/users', requireAuth, (req, res) => res.json({
  users: db.users.filter(u => u.id !== req.user.id).map(safeUser).sort((a,b)=>a.displayName.localeCompare(b.displayName))
}));
app.get('/api/messages/:userId', requireAuth, (req, res) => {
  const peer = userById(req.params.userId);
  if (!peer) return res.status(404).json({ error: 'Student not found.' });
  const messages = db.messages.filter(m =>
    (m.from === req.user.id && m.to === peer.id) || (m.from === peer.id && m.to === req.user.id)
  ).slice(-200).map(m => ({ ...m, sender: safeUser(userById(m.from)), file: m.fileId ? db.files.find(f => f.id === m.fileId) : null }));
  res.json({ messages });
});

const allowedExt = new Set(['.pdf','.doc','.docx','.xls','.xlsx','.ppt','.pptx','.png','.jpg','.jpeg','.gif','.webp','.txt','.csv','.zip']);
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, crypto.randomBytes(18).toString('hex') + path.extname(file.originalname).toLowerCase())
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 }, fileFilter: (_req, file, cb) => {
  if (!allowedExt.has(path.extname(file.originalname).toLowerCase())) return cb(new Error('File type not allowed. Use PDF, Office documents, images, text, CSV or ZIP.'));
  cb(null, true);
}});
app.post('/api/files/:userId', requireAuth, (req, res, next) => upload.single('file')(req,res,err=>err?res.status(400).json({error:err.message || 'Upload failed.'}):next()), (req,res) => {
  const peer = userById(req.params.userId);
  if (!peer) { fs.unlink(req.file.path,()=>{}); return res.status(404).json({error:'Student not found.'}); }
  const file = { id: crypto.randomUUID(), name: path.basename(req.file.originalname).slice(0,160), storedName: req.file.filename, size: req.file.size, mime: req.file.mimetype, from: req.user.id, to: peer.id, createdAt: Date.now() };
  db.files.push(file);
  const msg = { id: crypto.randomUUID(), from: req.user.id, to: peer.id, text: '', fileId: file.id, createdAt: Date.now() };
  db.messages.push(msg); saveDB(); counters.files++; counters.bytesUploaded += file.size; counters.messages++;
  const payload = { ...msg, sender: safeUser(req.user), file: { id:file.id, name:file.name, size:file.size } };
  io.to(`user:${peer.id}`).emit('message:new', payload);
  io.to(`user:${req.user.id}`).emit('message:new', payload);
  io.emit('monitor:update', snapshot());
  res.json({ message: payload });
});
app.get('/api/files/:id', requireAuth, (req,res) => {
  const f = db.files.find(f => f.id === req.params.id);
  if (!f || (f.from !== req.user.id && f.to !== req.user.id)) return res.status(404).json({error:'File not found.'});
  const full = path.join(UPLOAD_DIR, path.basename(f.storedName));
  if (!fs.existsSync(full)) return res.status(404).json({error:'File is missing from storage.'});
  res.download(full, f.name);
});
function snapshot() {
  return { onlineUsers: onlineIds().length, registeredUsers: db.users.length, activeConnections: io.engine.clientsCount,
    messages: db.messages.length, messagesSinceStart: counters.messages, files: db.files.length,
    filesSinceStart: counters.files, bytesUploaded: counters.bytesUploaded, uptimeSec: Math.floor((Date.now()-startedAt)/1000) };
}
app.get('/api/monitor', requireAuth, (_req,res)=>res.json(snapshot()));
app.use(express.static(path.join(__dirname, 'public')));
app.use((err, _req, res, _next) => { console.error(err.message); if (!res.headersSent) res.status(500).json({error:'Server error.'}); });

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const id = sessions.get(token);
  if (!id || !userById(id)) return next(new Error('Please sign in again.'));
  socket.data.userId = id; next();
});
io.on('connection', socket => {
  const id = socket.data.userId;
  socket.join(`user:${id}`);
  if (!socketsByUser.has(id)) socketsByUser.set(id, new Set());
  socketsByUser.get(id).add(socket.id); counters.connectionsOpened++;
  io.emit('presence:update', { users: onlineIds(), snapshot: snapshot() });
  socket.on('message:send', ({ to, text }, ack = ()=>{}) => {
    const peer = userById(to);
    const body = String(text || '').trim().slice(0, 2000);
    if (!peer || peer.id === id || !body) return ack({error:'Choose a student and enter a message.'});
    const msg = { id: crypto.randomUUID(), from:id, to:peer.id, text:body, fileId:null, createdAt:Date.now() };
    db.messages.push(msg); saveDB(); counters.messages++;
    const payload = { ...msg, sender:safeUser(userById(id)), file:null };
    io.to(`user:${id}`).emit('message:new', payload);
    io.to(`user:${peer.id}`).emit('message:new', payload);
    io.emit('monitor:update', snapshot());
    ack({ok:true});
  });
  socket.on('net:ping', ack => { if (typeof ack === 'function') ack({at:Date.now()}); });
  socket.on('disconnect', () => {
    const set = socketsByUser.get(id); if (set) { set.delete(socket.id); if (!set.size) socketsByUser.delete(id); }
    io.emit('presence:update', { users:onlineIds(), snapshot:snapshot() });
  });
});
server.listen(PORT, '0.0.0.0', () => console.log(`Campus Connect running at http://localhost:${PORT}`));
