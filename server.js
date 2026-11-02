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
function readBody(req, max = 1e6) {
  return new Promise((resolve, reject) => {
    let s = ''; req.on('data', d => { s += d; if (s.length > max) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : null); } catch (e) { reject(e); } });
  });
}

/* ---------- food recognition: Claude vision + Open Food Facts + USDA ---------- */
const https = require('https');
function fetchJSON(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: opts.method || 'GET', headers: Object.assign({ 'user-agent': 'Recomp8/1.0 (personal tracker)' }, opts.headers || {}) }, r => {
      let s = ''; r.on('data', d => s += d); r.on('end', () => { try { resolve({ status: r.statusCode, json: JSON.parse(s) }); } catch (e) { resolve({ status: r.statusCode, json: null, text: s }); } });
    });
    req.on('error', reject); req.setTimeout(45000, () => req.destroy(new Error('timeout')));
    if (opts.body) req.write(opts.body); req.end();
  });
}
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const FDC_KEY = process.env.FDC_API_KEY || 'DEMO_KEY';
const VISION_PROMPT = `You are a nutrition estimator for a fat-loss tracker. Look at the photo of food or drink and estimate what is there and how much, using visual cues (plate size, utensils, packaging) for portions. Be concrete and err slightly high on calories and slightly low on protein so the user is never under-counted.
Reply with ONLY a JSON object, no prose:
{"items":[{"name":"short name","portion":"e.g. 6 oz grilled chicken","kcal":0,"p":0,"c":0,"f":0,"confidence":"high|medium|low"}],"note":"one sentence on what was uncertain"}
Numbers are integers: kcal = calories, p/c/f = grams protein/carbs/fat. If the photo has no food or drink, return {"items":[],"note":"no food found"}.`;
async function analyzeFood(image, mime, hint) {
  if (!ANTHROPIC_KEY) return { status: 503, body: { error: 'no_key', message: 'Add ANTHROPIC_API_KEY to the Railway service variables to enable photo logging.' } };
  const body = JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 900, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mime || 'image/jpeg', data: image } }, { type: 'text', text: VISION_PROMPT + (hint ? '\nUser note: ' + String(hint).slice(0, 300) : '') }] }] });
  const r = await fetchJSON('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' }, body });
  if (r.status !== 200 || !r.json) return { status: 502, body: { error: 'upstream', message: (r.json && r.json.error && r.json.error.message) || ('Claude API returned ' + r.status) } };
  const text = (r.json.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const m = text.match(/\{[\s\S]*\}/);
  try { const parsed = JSON.parse(m ? m[0] : text); parsed.model = r.json.model; return { status: 200, body: parsed }; } catch (e) { return { status: 502, body: { error: 'parse', message: 'Could not read the estimate', raw: text.slice(0, 500) } }; }
}
async function barcode(code) {
  const r = await fetchJSON('https://world.openfoodfacts.org/api/v2/product/' + encodeURIComponent(code) + '.json?fields=product_name,brands,nutriments,serving_size,serving_quantity,image_front_small_url');
  const p = r.json && r.json.product; if (!p) return { status: 404, body: { error: 'not_found', message: 'Not in Open Food Facts. Try a search instead.' } };
  const n = p.nutriments || {}; const num = k => { const v = n[k]; return typeof v === 'number' ? v : (v ? parseFloat(v) : 0) || 0; };
  const per100 = { kcal: num('energy-kcal_100g') || Math.round(num('energy_100g') / 4.184), p: num('proteins_100g'), c: num('carbohydrates_100g'), f: num('fat_100g') };
  const servG = parseFloat(p.serving_quantity) || null;
  return { status: 200, body: { name: p.product_name || 'Unknown product', brand: p.brands || '', serving: p.serving_size || null, servingGrams: servG, per100, image: p.image_front_small_url || null, source: 'Open Food Facts' } };
}
async function searchFood(q) {
  const r = await fetchJSON('https://api.nal.usda.gov/fdc/v1/foods/search?api_key=' + encodeURIComponent(FDC_KEY) + '&query=' + encodeURIComponent(q) + '&pageSize=10&dataType=Foundation,SR%20Legacy,Branded');
  if (r.status === 429) return { status: 429, body: { error: 'rate', message: 'USDA demo key is rate-limited; add FDC_API_KEY (free at fdc.nal.usda.gov) for more lookups.' } };
  const foods = (r.json && r.json.foods) || [];
  const get = (f, id, name) => { const ns = f.foodNutrients || []; const x = ns.find(n => n.nutrientId === id) || ns.find(n => n.nutrientName === name && (id !== 1008 || /kcal/i.test(n.unitName || ''))); return x ? +x.value || 0 : 0; };
  return { status: 200, body: { foods: foods.map(f => ({ name: f.description, brand: f.brandOwner || f.brandName || '', per100: { kcal: get(f, 1008, 'Energy'), p: get(f, 1003, 'Protein'), c: get(f, 1005, 'Carbohydrate, by difference'), f: get(f, 1004, 'Total lipid (fat)') }, servingGrams: f.servingSize && /g/i.test(f.servingSizeUnit || '') ? f.servingSize : null, serving: f.householdServingFullText || null })), source: 'USDA FoodData Central' } };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    if (APP_KEY && req.headers['x-key'] !== APP_KEY) return send(res, 401, { error: 'unauthorized' });
    const parts = url.pathname.slice(5).split('/').filter(Boolean);
    try {
      if (parts[0] === 'ping') return send(res, 200, { ok: true, vision: !!ANTHROPIC_KEY });
      if (parts[0] === 'food') {
        if (parts[1] === 'analyze' && req.method === 'POST') { const b = await readBody(req, 8e6); if (!b || !b.image) return send(res, 400, { error: 'no image' }); const out = await analyzeFood(b.image, b.mime, b.hint); return send(res, out.status, out.body); }
        if (parts[1] === 'barcode' && parts[2]) { const out = await barcode(parts[2]); return send(res, out.status, out.body); }
        if (parts[1] === 'search') { const q = url.searchParams.get('q') || ''; if (!q.trim()) return send(res, 400, { error: 'empty' }); const out = await searchFood(q); return send(res, out.status, out.body); }
        return send(res, 404, { error: 'unknown food route' });
      }
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
