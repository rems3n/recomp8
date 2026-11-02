// Recomp 8 — tiny self-hosted sync server. No dependencies.
// Serves ./public and a JSON document store at /api, guarded by APP_KEY (x-key header).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const APP_KEY = process.env.APP_KEY || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE = path.join(DATA_DIR, 'store.json');
const PUBLIC = path.join(__dirname, 'public');
const COLLS = new Set(['logs', 'body', 'food', 'plan', 'settings']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

fs.mkdirSync(DATA_DIR, { recursive: true });
let store = {};
try { store = JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch (e) { store = {}; }
for (const c of COLLS) if (!store[c]) store[c] = {};

let writeTimer = null;
function persist() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    const tmp = STORE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(store), err => { if (!err) fs.rename(tmp, STORE, () => {}); });
  }, 150);
}

function send(res, code, body, type) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': type || 'application/json', 'cache-control': 'no-store' });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = ''; req.on('data', d => { s += d; if (s.length > 1e6) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : null); } catch (e) { reject(e); } });
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    if (APP_KEY && req.headers['x-key'] !== APP_KEY) return send(res, 401, { error: 'unauthorized' });
    const parts = url.pathname.slice(5).split('/').filter(Boolean);
    try {
      if (parts[0] === 'ping') return send(res, 200, { ok: true });
      if (parts[0] === 'all' && req.method === 'GET') return send(res, 200, store);
      const [coll, id] = parts;
      if (!COLLS.has(coll) || !id || !/^[A-Za-z0-9_\-.]{1,80}$/.test(id)) return send(res, 400, { error: 'bad path' });
      if (req.method === 'GET') return store[coll][id] ? send(res, 200, store[coll][id]) : send(res, 404, { error: 'not found' });
      if (req.method === 'PUT') { const body = await readBody(req); if (!body || typeof body !== 'object') return send(res, 400, { error: 'bad body' }); store[coll][id] = body; persist(); return send(res, 200, { ok: true }); }
      if (req.method === 'DELETE') { delete store[coll][id]; persist(); res.writeHead(204); return res.end(); }
      return send(res, 405, { error: 'method' });
    } catch (e) { return send(res, 400, { error: String(e.message || e) }); }
  }
  // static
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  p = path.normalize(p).replace(/^(\.\.[\/\\])+/, '');
  const file = path.join(PUBLIC, p);
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) => e2 ? send(res, 404, 'not found', 'text/plain') : send(res, 200, html, MIME['.html']));
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': p === '/index.html' ? 'no-cache' : 'public, max-age=86400' });
    res.end(data);
  });
}).listen(PORT, () => console.log('Recomp 8 listening on ' + PORT + (APP_KEY ? ' (PIN set)' : ' (NO PIN — set APP_KEY)')));
