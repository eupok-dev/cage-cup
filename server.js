// Cage Cup multiplayer server.
// Serves the game and relays messages between two players in each room.
// No installs needed: uses only Node's built-in modules (Node 18+).
//   Local:   node server.js            (optional: PORT=9000 node server.js)
//   Hosted:  the host sets PORT; start command is "node server.js".
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 8080;
const GAME = path.join(__dirname, 'cage-cup.html');
const MAX_ROOMS = 500;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I

let pageCache = null;
function page() {
  if (pageCache && process.env.NODE_ENV === 'production') return pageCache;
  const body = fs.readFileSync(GAME, 'utf8').replace('<script>', '<script>window.CAGE_SERVER=1;\n');
  pageCache = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '</head><body>' + body + '</body></html>';
  return pageCache;
}

function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(`http://${a.address}:${PORT}`);
    }
  }
  return out;
}

// Public base URL for share links. Uses the address the player connected through;
// on localhost it swaps in this computer's Wi-Fi address so friends can reach it.
function baseUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || (req.socket.encrypted ? 'https' : 'http');
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host)) {
    const lan = lanUrls()[0];
    if (lan) return lan;
  }
  return `${proto}://${host}`;
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (req.method === 'GET' && url.startsWith('/healthz')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return;
  }
  if (req.method === 'GET' && (url === '/' || url.startsWith('/?') || url.startsWith('/index.html'))) {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(page());
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Could not read cage-cup.html next to server.js');
    }
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ---- minimal WebSocket (RFC 6455, text frames) ----
function sendFrame(c, data, op = 1) {
  if (!c || c.sock.destroyed) return;
  const p = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let h;
  if (p.length < 126) h = Buffer.from([0x80 | op, p.length]);
  else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(p.length, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
  c.sock.write(Buffer.concat([h, p]));
}
const send = (c, obj) => sendFrame(c, JSON.stringify(obj));

// ---- rooms ----
const rooms = new Map(); // code -> { host, guest }
function newCode() {
  for (let n = 0; n < 50; n++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}
const other = c => (c.room ? (c.role === 'host' ? c.room.guest : c.room.host) : null);

function parse(c) {
  while (c.buf.length >= 2) {
    const b0 = c.buf[0], b1 = c.buf[1];
    const op = b0 & 0x0f, masked = b1 & 0x80;
    let len = b1 & 0x7f, off = 2;
    if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (c.buf.length < 10) return; len = Number(c.buf.readBigUInt64BE(2)); off = 10; }
    if (len > 1 << 20) { c.sock.destroy(); return; }
    const need = off + (masked ? 4 : 0) + len;
    if (c.buf.length < need) return;
    let payload = Buffer.from(c.buf.subarray(off + (masked ? 4 : 0), need));
    if (masked) { const m = c.buf.subarray(off, off + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
    c.buf = c.buf.subarray(need);
    c.alive = true;
    if (op === 8) { c.sock.end(); return; }
    if (op === 9) { sendFrame(c, payload, 10); continue; }
    if (op === 10) continue; // pong
    if (op === 1) { const peer = other(c); if (peer) sendFrame(peer, payload); }
  }
}

function join(c, params, req) {
  const want = (params.get('room') || '').toUpperCase();
  let code, room;
  if (params.get('create')) {
    if (rooms.size >= MAX_ROOMS) { send(c, { t: 'hello', role: 'full' }); setTimeout(() => c.sock.end(), 200); return; }
    code = newCode(); room = { host: null, guest: null, code };
    rooms.set(code, room);
  } else {
    room = rooms.get(want); code = want;
    if (!room) { send(c, { t: 'hello', role: 'none' }); setTimeout(() => c.sock.end(), 200); return; }
  }
  const role = !room.host ? 'host' : !room.guest ? 'guest' : 'full';
  if (role === 'full') { send(c, { t: 'hello', role: 'full' }); setTimeout(() => c.sock.end(), 200); return; }
  c.role = role; c.room = room; room[role] = c;
  send(c, { t: 'hello', role, room: code, link: `${baseUrl(req)}/?room=${code}`, urls: lanUrls() });
  console.log(`  [${code}] ${role} joined (${rooms.size} room${rooms.size === 1 ? '' : 's'} open)`);
  const peer = other(c);
  if (peer) { send(c, { t: 'peer', present: true }); send(peer, { t: 'peer', present: true }); }
}
function leave(c) {
  if (c.gone) return; c.gone = true;
  const room = c.room; if (!room) return;
  if (room[c.role] === c) room[c.role] = null;
  const peer = other(c);
  if (peer) send(peer, { t: 'peer', present: false });
  if (!room.host && !room.guest) rooms.delete(room.code);
  console.log(`  [${room.code}] ${c.role} left`);
}

server.on('upgrade', (req, sock) => {
  let params;
  try { const u = new URL(req.url, 'http://x'); if (u.pathname !== '/ws') throw 0; params = u.searchParams; }
  catch (e) { sock.destroy(); return; }
  if (!req.headers['sec-websocket-key']) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.setNoDelay(true);
  const c = { sock, buf: Buffer.alloc(0), role: null, room: null, alive: true };
  clients.add(c);
  join(c, params, req);
  sock.on('data', d => { c.buf = Buffer.concat([c.buf, d]); try { parse(c); } catch (e) { sock.destroy(); } });
  const bye = () => { clients.delete(c); leave(c); };
  sock.on('close', bye);
  sock.on('error', bye);
});

// Keep-alive: ping every 25s so hosting proxies don't drop idle connections; drop dead ones.
const clients = new Set();
setInterval(() => {
  for (const c of clients) {
    if (!c.alive) { c.sock.destroy(); continue; }
    c.alive = false;
    sendFrame(c, Buffer.alloc(0), 9);
  }
}, 25000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Cage Cup server is running.\n');
  console.log(`  Open:  http://localhost:${PORT}`);
  const urls = lanUrls();
  if (urls.length) console.log(`  On your Wi-Fi: ${urls[0]}`);
  console.log('\n  Click Play vs Person > Create game, then send your friend the link.');
  console.log('  Leave this window open while you play. Press Ctrl+C to stop.\n');
});
