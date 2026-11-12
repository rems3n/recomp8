// Recomp 8 — minimal OAuth 2.1 authorization server for the /mcp resource. No dependencies.
// Authorization-code + PKCE (S256), dynamic client registration (RFC 7591), client-ID metadata documents,
// rotating refresh tokens, RFC 8414 / RFC 9728 discovery. The single user consents by entering the app PIN.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');

function makeOAuth({ DATA_DIR, APP_KEY }) {
  const FILE = path.join(DATA_DIR, 'oauth.json');
  let db = { clients: {}, access: {}, refresh: {} };
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) { }
  const save = () => { const tmp = FILE + '.tmp'; fs.writeFile(tmp, JSON.stringify(db), err => { if (!err) fs.rename(tmp, FILE, () => { }); }); };
  const codes = new Map();           // code -> {client_id, redirect_uri, challenge, exp}
  const fails = new Map();           // ip -> {n, until}
  const ACCESS_TTL = 7 * 864e5, REFRESH_TTL = 365 * 864e5, CODE_TTL = 5 * 6e4, MAX_CLIENTS = 50;
  const rnd = n => crypto.randomBytes(n).toString('base64url');
  const sha = t => crypto.createHash('sha256').update(t).digest('hex');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const base = req => process.env.PUBLIC_URL || ((req.headers['x-forwarded-proto'] || 'http').split(',')[0] + '://' + (req.headers['x-forwarded-host'] || req.headers.host));
  const json = (res, code, body, extra) => { res.writeHead(code, Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }, extra || {})); res.end(JSON.stringify(body)); };
  const readForm = req => new Promise((resolve, reject) => { let s = ''; req.on('data', d => { s += d; if (s.length > 1e5) { reject(new Error('too large')); req.destroy(); } }); req.on('end', () => { try { resolve(/json/.test(req.headers['content-type'] || '') ? JSON.parse(s || '{}') : Object.fromEntries(new URLSearchParams(s))); } catch (e) { reject(e); } }); });
  const okRedirect = u => { try { const x = new URL(u); return x.protocol === 'https:' || ((x.hostname === 'localhost' || x.hostname === '127.0.0.1') && x.protocol === 'http:'); } catch (e) { return false; } };
  const prune = () => { const now = Date.now(); for (const k of Object.keys(db.access)) if (db.access[k].exp < now) delete db.access[k]; for (const k of Object.keys(db.refresh)) if (db.refresh[k].exp < now) delete db.refresh[k]; };
  const pinOk = pin => { const a = Buffer.from(sha(String(pin || ''))), b = Buffer.from(sha(String(APP_KEY))); return !!APP_KEY && crypto.timingSafeEqual(a, b); };

  // client-ID metadata document: client_id is an https URL that serves {client_id, redirect_uris, client_name}
  const fetchClientDoc = url => new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { return resolve(null); }
    if (u.protocol !== 'https:' || /^(localhost|\d+\.\d+\.\d+\.\d+|\[.*\])$/.test(u.hostname)) return resolve(null);
    const r = https.get(u, { headers: { accept: 'application/json', 'user-agent': 'Recomp8-OAuth/1.0' } }, resp => { if (resp.statusCode !== 200) { resp.resume(); return resolve(null); } let s = ''; resp.on('data', d => { s += d; if (s.length > 65536) r.destroy(); }); resp.on('end', () => { try { const j = JSON.parse(s); resolve(j.client_id === url && Array.isArray(j.redirect_uris) ? j : null); } catch (e) { resolve(null); } }); });
    r.on('error', () => resolve(null)); r.setTimeout(8000, () => { r.destroy(); resolve(null); });
  });
  const getClient = async id => { if (db.clients[id]) return db.clients[id]; if (/^https:\/\//.test(id || '')) { const d = await fetchClientDoc(id); if (d) return { client_id: id, redirect_uris: d.redirect_uris.filter(okRedirect), client_name: d.client_name || new URL(id).hostname, doc: true }; } return null; };

  const issue = client_id => { prune(); const at = rnd(32), rt = rnd(32), now = Date.now(); db.access[sha(at)] = { client_id, exp: now + ACCESS_TTL }; db.refresh[sha(rt)] = { client_id, exp: now + REFRESH_TTL }; save(); return { access_token: at, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TTL / 1000), refresh_token: rt, scope: 'recomp8' }; };
  const validToken = req => { const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); if (!m) return false; const t = db.access[sha(m[1])]; return !!(t && t.exp > Date.now()); };
  const challenge = req => `Bearer resource_metadata="${base(req)}/.well-known/oauth-protected-resource"`;

  const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{margin:0;font:16px/1.45 system-ui,-apple-system,sans-serif;background:#17191c;color:#ecebe6;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}.c{background:#1f2226;border:1px solid #363b42;border-radius:14px;padding:22px;max-width:400px;width:100%}h1{font-size:22px;margin:0 0 4px}h1 span{color:#e8893c}p{color:#9a9890;font-size:14px;margin:8px 0}b{color:#ecebe6}ul{color:#9a9890;font-size:14px;padding-left:18px;margin:8px 0}input{width:100%;box-sizing:border-box;font-size:18px;padding:12px;border-radius:9px;border:1px solid #363b42;background:#17191c;color:#ecebe6;margin:10px 0}button{width:100%;min-height:48px;border-radius:9px;border:0;font:600 16px system-ui;cursor:pointer;margin-top:8px}.a{background:#e8893c;color:#17191c}.d{background:none;color:#9a9890;border:1px solid #363b42}.e{color:#e06c6c}</style></head><body><div class="c">${body}</div></body></html>`;
  const consent = (q, client, err) => page('Connect to Recomp 8', `<h1>RECOMP<span>8</span></h1><p><b>${esc(client.client_name || 'An app')}</b> wants to connect to your Recomp 8 data.</p><ul><li>Read your plan, workout logs, food logs and weigh-ins</li><li>Change your workouts, meals, targets and goals</li><li>Log food, sets and weigh-ins</li></ul><p>It will return to <b>${esc(new URL(q.redirect_uri).host)}</b>.</p>${err ? `<p class="e">${esc(err)}</p>` : ''}<form method="post" action="/oauth/authorize">${['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource'].map(k => `<input type="hidden" name="${k}" value="${esc(q[k] || '')}">`).join('')}<input type="password" name="pin" inputmode="numeric" autocomplete="current-password" placeholder="App PIN" required autofocus><button class="a" name="decision" value="allow">Allow</button><button class="d" name="decision" value="deny" formnovalidate>Deny</button></form>`);

  async function checkAuthz(q) {
    const client = await getClient(q.client_id);
    if (!client) return { err: 'Unknown client. Register first (dynamic client registration) or use a client-ID metadata URL.' };
    if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) return { err: 'redirect_uri does not match the registered client.' };
    return { client };
  }

  // returns true when the request was handled
  async function handle(req, res, url) {
    const p = url.pathname;
    if (req.method === 'OPTIONS' && (p.startsWith('/oauth/') || p.startsWith('/.well-known/oauth'))) { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version', 'access-control-allow-methods': 'GET, POST, OPTIONS' }); res.end(); return true; }
    if (req.method === 'GET' && p.startsWith('/.well-known/oauth-protected-resource')) { json(res, 200, { resource: base(req) + '/mcp', authorization_servers: [base(req)], bearer_methods_supported: ['header'], scopes_supported: ['recomp8'], resource_name: 'Recomp 8' }); return true; }
    if (req.method === 'GET' && (p.startsWith('/.well-known/oauth-authorization-server') || p.startsWith('/.well-known/openid-configuration'))) { const b = base(req); json(res, 200, { issuer: b, authorization_endpoint: b + '/oauth/authorize', token_endpoint: b + '/oauth/token', registration_endpoint: b + '/oauth/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['recomp8'], client_id_metadata_document_supported: true }); return true; }

    if (p === '/oauth/register' && req.method === 'POST') {
      let b; try { b = await readForm(req); } catch (e) { json(res, 400, { error: 'invalid_client_metadata' }); return true; }
      const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter(okRedirect) : [];
      if (!uris.length) { json(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https (or http://localhost)' }); return true; }
      const ids = Object.keys(db.clients); if (ids.length >= MAX_CLIENTS) { ids.sort((a, c) => db.clients[a].created - db.clients[c].created).slice(0, ids.length - MAX_CLIENTS + 1).forEach(id => delete db.clients[id]); }
      const client = { client_id: 'rc8_' + rnd(12), redirect_uris: uris, client_name: String(b.client_name || 'MCP client').slice(0, 80), created: Date.now() };
      db.clients[client.client_id] = client; save();
      json(res, 201, { client_id: client.client_id, client_id_issued_at: Math.floor(client.created / 1000), redirect_uris: uris, client_name: client.client_name, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }); return true;
    }

    if (p === '/oauth/authorize' && (req.method === 'GET' || req.method === 'POST')) {
      let q; try { q = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await readForm(req); } catch (e) { res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }); res.end(page('Error', '<h1>Bad request</h1>')); return true; }
      const html = (code, body) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action *" }); res.end(body); };
      const { client, err } = await checkAuthz(q);
      if (err) { html(400, page('Cannot connect', `<h1>Cannot connect</h1><p class="e">${esc(err)}</p>`)); return true; }
      const back = params => { const u = new URL(q.redirect_uri); Object.entries(params).forEach(([k, v]) => v != null && v !== '' && u.searchParams.set(k, v)); res.writeHead(302, { location: u.toString(), 'cache-control': 'no-store' }); res.end(); };
      if ((q.response_type && q.response_type !== 'code') || !q.code_challenge || (q.code_challenge_method || 'plain') !== 'S256') { if (req.method === 'GET' && !q.code_challenge) { back({ error: 'invalid_request', error_description: 'PKCE with S256 is required', state: q.state }); return true; } }
      if (req.method === 'GET') { html(200, consent(q, client)); return true; }
      if (q.decision === 'deny') { back({ error: 'access_denied', state: q.state }); return true; }
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); const f = fails.get(ip) || { n: 0, until: 0 };
      if (f.until > Date.now()) { html(429, consent(q, client, 'Too many wrong PINs. Try again in 15 minutes.')); return true; }
      if (!pinOk(q.pin)) { f.n++; if (f.n >= 5) { f.until = Date.now() + 15 * 6e4; f.n = 0; } fails.set(ip, f); html(401, consent(q, client, 'Wrong PIN.')); return true; }
      fails.delete(ip);
      const code = rnd(24); codes.set(code, { client_id: q.client_id, redirect_uri: q.redirect_uri, challenge: q.code_challenge, exp: Date.now() + CODE_TTL });
      back({ code, state: q.state }); return true;
    }

    if (p === '/oauth/token' && req.method === 'POST') {
      let b; try { b = await readForm(req); } catch (e) { json(res, 400, { error: 'invalid_request' }); return true; }
      if (b.grant_type === 'authorization_code') {
        const c = codes.get(b.code); codes.delete(b.code);
        if (!c || c.exp < Date.now() || c.client_id !== b.client_id || c.redirect_uri !== b.redirect_uri) { json(res, 400, { error: 'invalid_grant' }); return true; }
        if (!b.code_verifier || crypto.createHash('sha256').update(b.code_verifier).digest('base64url') !== c.challenge) { json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' }); return true; }
        json(res, 200, issue(c.client_id)); return true;
      }
      if (b.grant_type === 'refresh_token') {
        const k = sha(String(b.refresh_token || '')); const r = db.refresh[k];
        if (!r || r.exp < Date.now() || (b.client_id && b.client_id !== r.client_id)) { json(res, 400, { error: 'invalid_grant' }); return true; }
        delete db.refresh[k]; json(res, 200, issue(r.client_id)); return true;
      }
      json(res, 400, { error: 'unsupported_grant_type' }); return true;
    }
    return false;
  }
  const connections = () => { prune(); const byClient = {}; Object.values(db.refresh).forEach(r => { byClient[r.client_id] = (byClient[r.client_id] || 0) + 1; }); return Object.keys(byClient).map(id => ({ client_id: id, name: (db.clients[id] || {}).client_name || id })); };
  const revokeAll = () => { db.access = {}; db.refresh = {}; save(); };
  return { handle, validToken, challenge, connections, revokeAll };
}
module.exports = { makeOAuth };
