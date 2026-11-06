// Cage Cup multiplayer server.
// Serves the game, hosts rooms, and RUNS each online match itself so both players
// get the same delay. No installs needed: only Node's built-in modules (Node 18+).
//   Local:   node server.js            (optional: PORT=9000 node server.js)
//   Hosted:  the host sets PORT; start command is "node server.js".
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const PORT = Number(process.env.PORT) || 8080;
const GAME = path.join(__dirname, 'cage-cup.html');
const MAX_ROOMS = 500;
const TICK = 1 / 60, SNAP_EVERY = 2; // simulate at 60 Hz, send 30 snapshots a second
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// testing only: fake network delay in both directions
const SIM_LAG = Number(process.env.SIM_LAG_MS) || 0;
const SIM_JIT = Number(process.env.SIM_JITTER_MS) || 0;

function readGame() { return fs.readFileSync(GAME, 'utf8'); }
function gameVersion() { return crypto.createHash('sha1').update(readGame()).digest('hex').slice(0, 12); }
function page() {
  const html = readGame();
  const ver = crypto.createHash('sha1').update(html).digest('hex').slice(0, 12);
  const body = html.replace('<script>', `<script>window.CAGE_SERVER=1;window.CAGE_VER='${ver}';\n`);
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    // "Add to Home Screen" opens the game full screen, with no browser bars
    '<meta name="theme-color" content="#0d1820"><meta name="mobile-web-app-capable" content="yes">' +
    '<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">' +
    '<meta name="apple-mobile-web-app-title" content="Cage Cup"><link rel="manifest" href="/manifest.webmanifest">' +
    '<link rel="apple-touch-icon" href="/icon-180.png"><link rel="icon" href="/icon-192.png">' +
    '</head><body>' + body + '</body></html>';
}
let engineCache = null;
function engineSource() {
  const html = readGame();
  const i = html.indexOf('// ===ENGINE START==='), j = html.indexOf('// ===ENGINE END===');
  if (i < 0 || j < 0) throw new Error('engine markers missing in cage-cup.html');
  const src = html.slice(i, j);
  if (!engineCache || engineCache.src !== src) engineCache = { src, script: new vm.Script(src + '\n;var __api={newMatch,update,snap,applyRemoteInput,makeStarTeam,getM:()=>M,give:e=>take(e)};', { filename: 'engine.js' }) };
  return engineCache.script;
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
function baseUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || 'http';
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host)) { const lan = lanUrls()[0]; if (lan) return lan; }
  return `${proto}://${host}`;
}

const MANIFEST = JSON.stringify({
  name: 'Cage Cup', short_name: 'Cage Cup', start_url: '/', scope: '/', display: 'fullscreen', orientation: 'landscape',
  background_color: '#0d1820', theme_color: '#0d1820',
  icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }]
});
// players online: every open game checks in about every 30s with a random id; count the ids seen in the last 70s
const seen = new Map();
function onlineCount() { const cut = Date.now() - 70000; for (const [k, t] of seen) if (t < cut) seen.delete(k); return seen.size; }
const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (req.method === 'GET' && url.split('?')[0] === '/online') {
    try { const id = new URL(url, 'http://x').searchParams.get('id'); if (id && /^[a-z0-9]{6,24}$/i.test(id) && (seen.has(id) || seen.size < 100000)) seen.set(id, Date.now()); } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ n: onlineCount() })); return;
  }
  if (req.method === 'GET' && url.startsWith('/version')) {
    try { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end(gameVersion()); } catch (e) { res.writeHead(500); res.end(); }
    return;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && url.split('?')[0] === '/menu-music.mp3') {
    // phones need byte-range support to stream audio
    const f = path.join(__dirname, 'menu-music.mp3');
    fs.stat(f, (err, st) => {
      if (err) { res.writeHead(404); res.end(); return; }
      const base = { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'max-age=86400' };
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (m) {
        let s = m[1] ? +m[1] : st.size - +m[2], e = m[1] && m[2] ? +m[2] : st.size - 1;
        s = Math.max(0, s); e = Math.min(e, st.size - 1);
        if (s > e) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return; }
        res.writeHead(206, { ...base, 'Content-Range': `bytes ${s}-${e}/${st.size}`, 'Content-Length': e - s + 1 });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(f, { start: s, end: e }).pipe(res);
      } else {
        res.writeHead(200, { ...base, 'Content-Length': st.size });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(f).pipe(res);
      }
    });
    return;
  }
  if (req.method === 'GET' && url === '/manifest.webmanifest') { res.writeHead(200, { 'Content-Type': 'application/manifest+json' }); res.end(MANIFEST); return; }
  const ic = req.method === 'GET' && /^\/icon-(180|192|512)\.png$/.exec(url);
  if (ic) {
    try { const buf = fs.readFileSync(path.join(__dirname, `icon-${ic[1]}.png`)); res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' }); res.end(buf); }
    catch (e) { res.writeHead(404); res.end(); }
    return;
  }
  if (req.method === 'GET' && url.startsWith('/healthz')) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (req.method === 'GET' && (url === '/' || url.startsWith('/?') || url.startsWith('/index.html'))) {
    try { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(page()); }
    catch (e) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('Could not read cage-cup.html next to server.js'); }
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
});

// ---- minimal WebSocket (RFC 6455) ----
function rawFrame(c, data, op = 1) {
  if (!c || c.sock.destroyed) return;
  const p = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let h;
  if (p.length < 126) h = Buffer.from([0x80 | op, p.length]);
  else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(p.length, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
  c.sock.write(Buffer.concat([h, p]));
}
function delayed(c, fn) {
  if (!SIM_LAG) return fn();
  const at = Math.max(Date.now() + SIM_LAG + Math.random() * SIM_JIT, c.lastAt || 0);
  c.lastAt = at; setTimeout(fn, at - Date.now());
}
const sendRaw = (c, str) => delayed(c, () => rawFrame(c, str));
const send = (c, obj) => sendRaw(c, JSON.stringify(obj));

// ---- rooms ----
const rooms = new Map();
function newCode() {
  for (let n = 0; n < 50; n++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}
const other = c => (c.room ? (c.role === 'host' ? c.room.guest : c.room.host) : null);
const teamOf = c => (c.role === 'host' ? 0 : 1);

function startMatch(room) {
  let api;
  try {
    const ctx = vm.createContext({ console, document: { querySelector: () => null } });
    engineSource().runInContext(ctx);
    api = ctx.__api;
  } catch (e) { console.error('  could not start the match engine:', e.message); return; }
  const teams = [api.makeStarTeam('barca'), api.makeStarTeam('madrid')];
  const match = { api, over: null, tick: 0, acc: 0, last: Date.now() };
  api.newMatch(teams[0], teams[1], { kits: ['barca', 'madrid'], human: [true, true], local: 0, names: ['Barcelona', 'Real Madrid'], dur: 240, countdown: 3, onEnd: sc => { match.over = sc; } });
  room.match = match;
  room.host.ready = room.guest.ready = false;
  for (const c of [room.host, room.guest]) send(c, { t: 'start', teams });
  match.timer = setInterval(() => {
    const now = Date.now();
    match.acc += Math.min(0.25, (now - match.last) / 1000); match.last = now;
    while (match.acc >= TICK) {
      match.acc -= TICK;
      api.update(TICK);
      match.tick++;
      if (match.over || match.tick % SNAP_EVERY === 0) {
        const s = JSON.stringify(api.snap());
        if (room.host) sendRaw(room.host, s);
        if (room.guest) sendRaw(room.guest, s);
      }
      if (match.over) {
        for (const c of [room.host, room.guest]) if (c) send(c, { t: 'over', sc: match.over });
        stopMatch(room); return;
      }
    }
  }, 1000 / 120);
  console.log(`  [${room.code}] match started`);
}
function stopMatch(room) {
  if (room.match) { clearInterval(room.match.timer); room.match = null; }
}

function onMessage(c, text) {
  let m; try { m = JSON.parse(text); } catch (e) { return; }
  const room = c.room; if (!room || !m || typeof m.t !== 'string') return;
  if (m.t === 'i') { if (room.match) room.match.api.applyRemoteInput(teamOf(c), m); return; }
  // latency: answer right away, and tell each player both players' latest measured round trips (shown beside the team names)
  if (m.t === 'ping') {
    if (Number.isFinite(m.r)) c.rtt = Math.max(0, Math.min(9999, Math.round(m.r)));
    const at = T => { const p = T ? room.guest : room.host; return p && Number.isFinite(p.rtt) ? p.rtt : null; };
    send(c, { t: 'pong', id: m.id, p: [at(0), at(1)] }); return;
  }
  if (m.t === 'test' && process.env.CAGE_TEST && room.match) { // automated tests only
    const T = teamOf(c), ctx = room.match.api.getM();
    const e = ctx.ents.find(q => q.team === T && q.slot === 3); e.x = T ? 450 : 350; e.y = 250; e.vx = e.vy = 0; e.fx = T ? -1 : 1; e.fy = 0;
    for (const q of ctx.ents) if (q.team !== T && !q.gk) { q.x = T ? 760 : 40; q.y = 40 + q.slot * 30; }
    room.match.api.give(e); e.immune = 99; return;
  }
  if (m.t === 'ready') {
    c.ready = !!m.v;
    const peer = other(c); if (peer) send(peer, { t: 'ready', v: c.ready });
    if (!room.match && room.host && room.guest && room.host.ready && room.guest.ready) startMatch(room);
  }
}

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
    if (masked) { const mk = c.buf.subarray(off, off + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= mk[i & 3]; }
    c.buf = c.buf.subarray(need);
    c.alive = true;
    if (op === 8) { c.sock.end(); return; }
    if (op === 9) { rawFrame(c, payload, 10); continue; }
    if (op === 1) { const text = payload.toString('utf8'); delayed(c.inQ, () => onMessage(c, text)); }
  }
}

function join(c, params, req) {
  const want = (params.get('room') || '').toUpperCase();
  let code, room;
  if (params.get('create')) {
    if (rooms.size >= MAX_ROOMS) { send(c, { t: 'hello', role: 'full' }); setTimeout(() => c.sock.end(), 200); return; }
    code = newCode(); room = { host: null, guest: null, code, match: null };
    rooms.set(code, room);
  } else {
    room = rooms.get(want); code = want;
    if (!room) { send(c, { t: 'hello', role: 'none' }); setTimeout(() => c.sock.end(), 200); return; }
  }
  const role = !room.host ? 'host' : !room.guest ? 'guest' : 'full';
  if (role === 'full') { send(c, { t: 'hello', role: 'full' }); setTimeout(() => c.sock.end(), 200); return; }
  c.role = role; c.room = room; c.ready = false; room[role] = c;
  send(c, { t: 'hello', role, room: code, link: `${baseUrl(req)}/?room=${code}`, urls: lanUrls() });
  console.log(`  [${code}] ${role} joined (${rooms.size} room${rooms.size === 1 ? '' : 's'} open)`);
  const peer = other(c);
  if (peer) { send(c, { t: 'peer', present: true }); send(peer, { t: 'peer', present: true }); if (peer.ready) send(c, { t: 'ready', v: true }); }
}
function leave(c) {
  if (c.gone) return; c.gone = true;
  const room = c.room; if (!room) return;
  if (room[c.role] === c) room[c.role] = null;
  stopMatch(room);
  const peer = other(c);
  if (peer) { peer.ready = false; send(peer, { t: 'peer', present: false }); }
  if (!room.host && !room.guest) rooms.delete(room.code);
  console.log(`  [${room.code}] ${c.role} left`);
}

const clients = new Set();
server.on('upgrade', (req, sock) => {
  let params;
  try { const u = new URL(req.url, 'http://x'); if (u.pathname !== '/ws') throw 0; params = u.searchParams; }
  catch (e) { sock.destroy(); return; }
  if (!req.headers['sec-websocket-key']) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.setNoDelay(true);
  const c = { sock, buf: Buffer.alloc(0), role: null, room: null, alive: true, inQ: { lastAt: 0 } };
  clients.add(c);
  join(c, params, req);
  sock.on('data', d => { c.buf = Buffer.concat([c.buf, d]); try { parse(c); } catch (e) { sock.destroy(); } });
  const bye = () => { clients.delete(c); leave(c); };
  sock.on('close', bye); sock.on('error', bye);
});

// keep-alive ping so hosting proxies don't drop idle connections
setInterval(() => {
  for (const c of clients) {
    if (!c.alive) { c.sock.destroy(); continue; }
    c.alive = false; rawFrame(c, Buffer.alloc(0), 9);
  }
}, 25000).unref();

server.listen(PORT, '0.0.0.0', () => {
  try { engineSource(); } catch (e) { console.error('  ' + e.message); }
  console.log('\n  Cage Cup server is running.\n');
  console.log(`  Open:  http://localhost:${PORT}`);
  const urls = lanUrls();
  if (urls.length) console.log(`  On your Wi-Fi: ${urls[0]}`);
  console.log('\n  Click Play vs Person > Create game, then send your friend the link.');
  console.log('  Leave this window open while you play. Press Ctrl+C to stop.\n');
});
