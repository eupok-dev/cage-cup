// Boot Rivals multiplayer server.
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
const zlib = require('zlib');

const PORT = Number(process.env.PORT) || 8080;
// the site's official address (search engines, link previews). Override with PUBLIC_URL if it ever changes.
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://bootrivals.com').replace(/\/+$/, '');
// once the domain works, set FORCE_DOMAIN=1 on the host so visits to the old onrender.com address move to the domain
const GAME = path.join(__dirname, 'cage-cup.html');
const MAX_ROOMS = 500;
const TICK = 1 / 60, SNAP_EVERY = 2; // simulate at 60 Hz, send 30 snapshots a second
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// testing only: fake network delay in both directions
const SIM_LAG = Number(process.env.SIM_LAG_MS) || 0;
const SIM_JIT = Number(process.env.SIM_JITTER_MS) || 0;

function readGame() { return fs.readFileSync(GAME, 'utf8'); }
function gameVersion() { return crypto.createHash('sha1').update(readGame()).digest('hex').slice(0, 12); }
// ---- search engines and link previews ----
const LANGS = ['en', 'es', 'pt', 'fr', 'de', 'ar'];
const SEO = {
  en: ['Boot Rivals – Free 6-a-Side Street Football Game | Play in Your Browser', 'Play Boot Rivals free in your browser: fast 6-a-side street football with a story campaign, skill moves, set plays and online matches against friends. No download needed.'],
  es: ['Boot Rivals – Juego de fútbol callejero 6 contra 6 gratis | Juega en el navegador', 'Juega gratis a Boot Rivals en tu navegador: fútbol callejero 6 contra 6 con campaña, regates, jugadas y partidos online contra amigos. Sin descargas.'],
  pt: ['Boot Rivals – Jogo de futebol de rua 6x6 grátis | Jogue no navegador', 'Jogue Boot Rivals grátis no navegador: futebol de rua 6 contra 6 com campanha, dribles, jogadas ensaiadas e partidas online contra amigos. Sem download.'],
  fr: ['Boot Rivals – Jeu de foot de rue à 6 gratuit | Jouez dans le navigateur', 'Jouez gratuitement à Boot Rivals dans votre navigateur : foot de rue à 6 avec campagne, gestes techniques, combinaisons et matchs en ligne entre amis. Sans téléchargement.'],
  de: ['Boot Rivals – Kostenloses 6-gegen-6 Straßenfußball-Spiel | Im Browser spielen', 'Spiel Boot Rivals kostenlos im Browser: schneller Straßenfußball sechs gegen sechs mit Kampagne, Tricks, Spielzügen und Online-Spielen gegen Freunde. Ohne Download.'],
  ar: ['Boot Rivals – لعبة كرة قدم الشوارع ستة ضد ستة مجانًا | العب في المتصفح', 'العب Boot Rivals مجانًا في متصفحك: كرة قدم شوارع سريعة ستة ضد ستة مع حملة قصصية ومهارات وخطط ومباريات أونلاين ضد أصدقائك. بدون تنزيل.']
};
// the public address for links shared or indexed (not the LAN address used for local testing)
function publicBase(req) {
  const host = (req && (req.headers['x-forwarded-host'] || req.headers.host)) || `localhost:${PORT}`;
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|\d+\.\d+\.\d+\.\d+)(:|$)/.test(host);
  if (!local) return PUBLIC_URL;   // always point search engines at the real domain, whichever address they came in on
  const proto = (req && (req.headers['x-forwarded-proto'] || '').split(',')[0]) || 'http';
  return `${proto}://${host}`;
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
function seoHead(req) {
  let lang = 'en'; try { const q = new URL(req.url, 'http://x').searchParams.get('lang'); if (LANGS.includes(q)) lang = q; } catch (e) {}
  const base = publicBase(req), url = base + '/' + (lang === 'en' ? '' : '?lang=' + lang), [title, desc] = SEO[lang];
  const ld = [{ '@context': 'https://schema.org', '@type': 'VideoGame', name: 'Boot Rivals', url: base + '/', description: SEO.en[1], image: base + '/og-image.png',
      genre: ['Sports', 'Football', 'Soccer', 'Arcade'], gamePlatform: ['Web browser', 'Android', 'iOS', 'Windows', 'macOS'], applicationCategory: 'Game', operatingSystem: 'Any',
      playMode: ['SinglePlayer', 'MultiPlayer'], inLanguage: LANGS, offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' } },
    { '@context': 'https://schema.org', '@type': 'WebSite', name: 'Boot Rivals', url: base + '/', inLanguage: LANGS }];
  return { lang, html:
    `<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">` +
    '<meta name="robots" content="index,follow,max-image-preview:large">' +
    `<link rel="canonical" href="${esc(url)}">` +
    LANGS.map(l => `<link rel="alternate" hreflang="${l}" href="${esc(base + '/' + (l === 'en' ? '' : '?lang=' + l))}">`).join('') +
    `<link rel="alternate" hreflang="x-default" href="${esc(base + '/')}">` +
    `<meta property="og:type" content="website"><meta property="og:site_name" content="Boot Rivals"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">` +
    `<meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(base + '/og-image.png')}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="Boot Rivals: six-a-side street football">` +
    `<meta property="og:locale" content="${{ en: 'en_US', es: 'es_ES', pt: 'pt_BR', fr: 'fr_FR', de: 'de_DE', ar: 'ar_AR' }[lang]}">` +
    `<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(base + '/og-image.png')}">` +
    `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>` };
}
function page(req) {
  const html = readGame();
  const ver = crypto.createHash('sha1').update(html).digest('hex').slice(0, 12);
  const seo = seoHead(req);
  // the game file carries its own <title> for the stand-alone preview; the server's head replaces it
  const body = html.replace(/<title>[^<]*<\/title>/, '').replace('<script>', `<script>window.CAGE_SERVER=1;window.CAGE_VER='${ver}';\n`);
  return `<!doctype html><html lang="${seo.lang}"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' + seo.html +
    // "Add to Home Screen" opens the game full screen, with no browser bars
    '<meta name="theme-color" content="#121318"><meta name="mobile-web-app-capable" content="yes">' +
    '<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">' +
    '<meta name="apple-mobile-web-app-title" content="Boot Rivals"><link rel="manifest" href="/manifest.webmanifest">' +
    '<link rel="apple-touch-icon" href="/icon-180.png?v=2"><link rel="icon" type="image/png" sizes="32x32" href="/icon-32.png?v=2"><link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png?v=2">' +
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
  name: 'Boot Rivals', short_name: 'Boot Rivals', start_url: '/', scope: '/', display: 'fullscreen', orientation: 'landscape',
  background_color: '#121318', theme_color: '#121318',
  icons: [{ src: '/icon-192.png?v=2', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png?v=2', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }]
});
// players online: every open game checks in about every 30s with a random id; count the ids seen in the last 70s
const seen = new Map();
function onlineCount() { const cut = Date.now() - 70000; for (const [k, t] of seen) if (t < cut) seen.delete(k); return seen.size; }
const PRIVACY_HTML = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>Privacy Policy \u2013 Boot Rivals</title><meta name=\"description\" content=\"How Boot Rivals handles your information. Short version: no accounts, no ads, no tracking.\">\n<link rel=\"icon\" type=\"image/png\" sizes=\"32x32\" href=\"/icon-32.png\"><link rel=\"canonical\" href=\"__BASE__/privacy\">\n<style>\n:root{color-scheme:dark}\nbody{margin:0;background:#121318;color:#e8eaee;font:16px/1.65 system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif}\n.wrap{max-width:720px;margin:0 auto;padding:max(24px,env(safe-area-inset-top)) 20px 48px}\na{color:#39ff14}\n.back{display:inline-block;margin-bottom:24px;font-weight:600;text-decoration:none}\n.back:hover{text-decoration:underline}\nh1{font-size:34px;line-height:1.15;margin:0 0 6px}\nh2{font-size:19px;margin:32px 0 6px}\n.date{color:#8a8f99;margin:0 0 20px;font-size:14px}\n.short{background:#1a1b21;border:1px solid #31343d;border-radius:12px;padding:14px 18px;margin:0 0 8px}\nul{padding-left:20px;margin:6px 0}li{margin:4px 0}\np{margin:6px 0}\nfooter{margin-top:40px;padding-top:16px;border-top:1px solid #31343d;color:#8a8f99;font-size:13px}\n</style></head><body><div class=\"wrap\">\n<a class=\"back\" href=\"/\">\u2190 Back to the game</a>\n<h1>Privacy Policy</h1>\n<p class=\"date\">Last updated: November 6, 2026</p>\n<p class=\"short\"><strong>The short version:</strong> Boot Rivals has no accounts, no ads and no tracking. Your settings and campaign progress stay in your own browser. We only handle what's needed to run online matches, and we never sell anything about you.</p>\n\n<h2>Who we are</h2>\n<p>Boot Rivals is a free browser football game run by an independent developer in Toronto, Canada. You can reach us at <a href=\"mailto:hello@bootrivals.com\">hello@bootrivals.com</a>.</p>\n\n<h2>What stays on your device</h2>\n<p>The game saves things like your language, sound settings, key bindings, club name and campaign progress in your browser's local storage. This never leaves your device and we can't see it. Clearing your browser's site data deletes it.</p>\n\n<h2>What our server sees</h2>\n<ul>\n<li><strong>Online matches:</strong> while you play online, your game inputs and match state pass through our server so the two players stay in sync. Nothing is kept after the match ends.</li>\n<li><strong>Players online counter:</strong> your browser sends a random ID every 30 seconds so we can show how many people are playing. It isn't linked to you and is forgotten after about a minute.</li>\n<li><strong>Basic server logs:</strong> like every website, our host receives your IP address and browser type when you visit. These logs are used only to keep the site running and are kept for a limited time.</li>\n</ul>\n<p>We don't use cookies, analytics, ads or any kind of tracking.</p>\n\n<h2>Other services we use</h2>\n<ul>\n<li><strong>Render</strong> hosts the website and game server.</li>\n<li><strong>Google Fonts</strong> and <strong>cdnjs (Cloudflare)</strong> deliver the fonts and the 3D graphics library, so they see your IP address when the page loads.</li>\n<li><strong>ImprovMX</strong> forwards emails sent to hello@bootrivals.com.</li>\n<li><strong>Buy Me a Coffee:</strong> if you choose to support the game, that happens on their site and under <a href=\"https://www.buymeacoffee.com/privacy-policy\" target=\"_blank\" rel=\"noopener\">their privacy policy</a>. We don't see your payment details.</li>\n</ul>\n\n<h2>Emails</h2>\n<p>If you email us, we'll use your address and message only to reply. We won't add you to a mailing list or share it.</p>\n\n<h2>Children</h2>\n<p>Boot Rivals is suitable for all ages and doesn't ask anyone for personal information. If you think a child has sent us personal information, email us and we'll delete it.</p>\n\n<h2>Your choices</h2>\n<p>You can clear the game's saved data at any time from your browser settings. If you have a question about your information, or want something deleted, email <a href=\"mailto:hello@bootrivals.com\">hello@bootrivals.com</a>.</p>\n\n<h2>Changes</h2>\n<p>If this policy changes, we'll update this page and the date at the top.</p>\n\n<h2>Disclaimer</h2>\n<p>Boot Rivals is not affiliated with, endorsed by or connected to any real football club, league, governing body or player. All team and player names in the game are made up. The game is provided free and as-is.</p>\n\n<footer>\u00a9 2026 Boot Rivals. All rights reserved.</footer>\n</div></body></html>\n";

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  // old address -> new domain (only when switched on, and never for health checks)
  if (process.env.FORCE_DOMAIN === '1' && (req.method === 'GET' || req.method === 'HEAD') && !url.startsWith('/healthz')) {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
    if (/\.onrender\.com(:\d+)?$/.test(host)) { res.writeHead(301, { Location: PUBLIC_URL + url }); res.end(); return; }
  }
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
  // default paths some browsers ask for without reading the page
  const alias = { '/apple-touch-icon.png': '180', '/apple-touch-icon-precomposed.png': '180', '/favicon.ico': '32' }[url.split('?')[0]];
  if (req.method === 'GET' && alias) { try { const buf = fs.readFileSync(path.join(__dirname, `icon-${alias}.png`)); res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' }); res.end(buf); } catch (e) { res.writeHead(404); res.end(); } return; }
  const ic = req.method === 'GET' && /^\/icon-(32|180|192|512)\.png(\?.*)?$/.exec(url);
  if (ic) {
    try { const buf = fs.readFileSync(path.join(__dirname, `icon-${ic[1]}.png`)); res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' }); res.end(buf); }
    catch (e) { res.writeHead(404); res.end(); }
    return;
  }
  // crawlers: robots.txt, a sitemap with every language, and the image shown when the link is shared
  if (req.method === 'GET' && url === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(`User-agent: *\nAllow: /\nDisallow: /ws\nDisallow: /online\n\nSitemap: ${publicBase(req)}/sitemap.xml\n`); return; }
  // privacy policy page
  if ((req.method === 'GET' || req.method === 'HEAD') && (url === '/privacy' || url === '/privacy/')) {
    const html = PRIVACY_HTML.replace('__BASE__', publicBase(req));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : html); return;
  }
  if (req.method === 'GET' && url === '/sitemap.xml') {
    const b = publicBase(req), u = l => b + '/' + (l === 'en' ? '' : '?lang=' + l), alt = LANGS.map(l => `<xhtml:link rel="alternate" hreflang="${l}" href="${u(l).replace(/&/g, '&amp;')}"/>`).join('');
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">' +
      LANGS.map(l => `<url><loc>${u(l).replace(/&/g, '&amp;')}</loc>${alt}<changefreq>weekly</changefreq><priority>${l === 'en' ? '1.0' : '0.8'}</priority></url>`).join('') + `<url><loc>${b}/privacy</loc><changefreq>yearly</changefreq><priority>0.2</priority></url>` + '</urlset>';
    res.writeHead(200, { 'Content-Type': 'application/xml' }); res.end(xml); return;
  }
  if (req.method === 'GET' && url === '/og-image.png') {
    try { const buf = fs.readFileSync(path.join(__dirname, 'og-image.png')); res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' }); res.end(buf); }
    catch (e) { res.writeHead(404); res.end(); }
    return;
  }
  if (req.method === 'GET' && url.startsWith('/healthz')) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (req.method === 'GET' && (url === '/' || url.startsWith('/?') || url.startsWith('/index.html'))) {
    try {
      const out = page(req), gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      const h = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Vary': 'Accept-Encoding' };
      if (gz) { const z = zlib.gzipSync(out, { level: 6 }); res.writeHead(200, { ...h, 'Content-Encoding': 'gzip', 'Content-Length': z.length }); res.end(z); }
      else { res.writeHead(200, h); res.end(out); }
    }
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
  api.newMatch(teams[0], teams[1], { kits: ['barca', 'madrid'], human: [true, true], local: 0, names: ['Marea FC', 'Solaris FC'], dur: 240, countdown: 3, onEnd: sc => { match.over = sc; } });
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
        const o = api.snap(); o.st = Math.round(match.tick * TICK * 1000);   // server sim time (ms): players time their playback by this, not by arrival
        const s = JSON.stringify(o);
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

// quick match: one open room waits for the next player who asks for a match; when they meet, the match starts by itself
let quickWait = null;
function join(c, params, req) {
  const want = (params.get('room') || '').toUpperCase();
  let code, room;
  if (params.get('quick')) {
    const w = quickWait;
    if (w && rooms.get(w.code) === w && w.host && !w.guest && !w.match && !w.host.sock.destroyed) { room = w; code = w.code; quickWait = null; }
    else {
      if (rooms.size >= MAX_ROOMS) { send(c, { t: 'hello', role: 'full' }); setTimeout(() => c.sock.end(), 200); return; }
      code = newCode(); room = { host: null, guest: null, code, match: null, quick: true };
      rooms.set(code, room); quickWait = room;
    }
  } else if (params.get('create')) {
    if (rooms.size >= MAX_ROOMS) { send(c, { t: 'hello', role: 'full' }); setTimeout(() => c.sock.end(), 200); return; }
    code = newCode(); room = { host: null, guest: null, code, match: null };
    rooms.set(code, room);
  } else {
    room = rooms.get(want); code = want;
    if (room && room.quick) room = null;   // quick-match rooms can't be joined by code
    if (!room) { send(c, { t: 'hello', role: 'none' }); setTimeout(() => c.sock.end(), 200); return; }
  }
  const role = !room.host ? 'host' : !room.guest ? 'guest' : 'full';
  if (role === 'full') { send(c, { t: 'hello', role: 'full' }); setTimeout(() => c.sock.end(), 200); return; }
  c.role = role; c.room = room; c.ready = false; room[role] = c;
  send(c, { t: 'hello', role, room: code, link: room.quick ? '' : `${baseUrl(req)}/?room=${code}`, urls: lanUrls(), quick: !!room.quick });
  console.log(`  [${code}] ${role} joined (${rooms.size} room${rooms.size === 1 ? '' : 's'} open)`);
  const peer = other(c);
  if (peer) { send(c, { t: 'peer', present: true }); send(peer, { t: 'peer', present: true }); if (peer.ready) send(c, { t: 'ready', v: true }); }
  // matched strangers: kick off after a short "opponent found" beat (no ready buttons for the first match)
  if (room.quick && room.host && room.guest && !room.match && !room.started) {
    room.started = true;
    setTimeout(() => { if (rooms.get(room.code) === room && room.host && room.guest && !room.match) startMatch(room); }, 1800);
  }
}
function leave(c) {
  if (c.gone) return; c.gone = true;
  const room = c.room; if (!room) return;
  if (room[c.role] === c) room[c.role] = null;
  stopMatch(room);
  const peer = other(c);
  if (peer) { peer.ready = false; send(peer, { t: 'peer', present: false }); }
  if (quickWait === room) quickWait = null;
  if (!room.host && !room.guest) rooms.delete(room.code);
  else if (room.quick && !room.match) {   // quick match: whoever is left goes back into the queue (as the host side)
    if (!room.host && room.guest) { room.host = room.guest; room.guest = null; room.host.role = 'host'; room.host.ready = false; send(room.host, { t: 'hello', role: 'host', room: room.code, link: '', urls: [], quick: true }); }
    else if (room.host) { room.host.ready = false; send(room.host, { t: 'hello', role: 'host', room: room.code, link: '', urls: [], quick: true }); }
    room.started = false; if (!quickWait) quickWait = room;
  }
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
  console.log('\n  Boot Rivals server is running.\n');
  console.log(`  Open:  http://localhost:${PORT}`);
  const urls = lanUrls();
  if (urls.length) console.log(`  On your Wi-Fi: ${urls[0]}`);
  console.log('\n  Click Play vs Person > Create game, then send your friend the link.');
  console.log('  Leave this window open while you play. Press Ctrl+C to stop.\n');
});
