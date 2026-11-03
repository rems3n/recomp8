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
const TEXT_PROMPT = `You are a nutrition estimator for a fat-loss tracker. The user typed what they ate. Split it into items, assume typical US portions and preparation when unstated (e.g. "eggs" = large whole eggs fried in a little butter, "toast" = 1 slice standard bread, "chicken" = ~6 oz cooked breast), and estimate calories and macros from USDA-style values. Lean slightly high on calories and slightly low on protein so the user is never under-counted.
Reply with ONLY a JSON object: {"items":[{"name":"short name","portion":"what you assumed","kcal":0,"p":0,"c":0,"f":0,"confidence":"high|medium|low"}],"note":"one sentence on the biggest assumption"}
Integers only. If nothing edible is described, return {"items":[],"note":"nothing to log"}.`;
async function estimateText(text, slot) {
  if (!ANTHROPIC_KEY) return { status: 503, body: { error: 'no_key', message: 'Add ANTHROPIC_API_KEY on the server to enable text logging.' } };
  const body = JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 700, messages: [{ role: 'user', content: TEXT_PROMPT + (slot ? '\nMeal slot: ' + slot : '') + '\n\nUser ate: ' + String(text).slice(0, 600) }] });
  const r = await fetchJSON('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' }, body });
  if (r.status !== 200 || !r.json) return { status: 502, body: { error: 'upstream', message: (r.json && r.json.error && r.json.error.message) || ('Claude API returned ' + r.status) } };
  const t = (r.json.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n'); const m = t.match(/\{[\s\S]*\}/);
  try { return { status: 200, body: JSON.parse(m ? m[0] : t) }; } catch (e) { return { status: 502, body: { error: 'parse', message: 'Could not read the estimate' } }; }
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

/* ---------- coach chat: Anthropic Messages API, streaming + tool use, server-side loop ---------- */
const EXLIB = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'exlib.json'), 'utf8'));   // exercises, templates, meals, slots (built from recomp.html)
const CHAT_MODEL = process.env.CHAT_MODEL || ANTHROPIC_MODEL;
const START_DATE = '2026-11-02', END_DATE = '2026-12-31';
const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEK_PLAN = { 1: ['FB', 'WALK', 'FB', 'WALK', 'FB', 'SPIN', 'WALK'], 8: ['DLL', 'DLU', 'TEST', 'WALK', 'REST', 'WALK', 'REST'], def: ['LA', 'UA', 'RUN', 'LB', 'UB', 'BIKE', 'WALK'] };
const WEEK_MEALS = { 1: ['b1', 'l1', 's1', 'd1', 'e1'], 2: ['b2', 'l3', 's2', 'd3', 'e2'], 3: ['b4', 'l2', 's3', 'd5', 'e1'], 4: ['b1', 'l4', 's1', 'd2', 'e1'], 5: ['b3', 'l1', 's2', 'd7', 'e2'], 6: ['b2', 'l6', 's4', 'd4', 'e1'], 0: ['b5', 'l5', 's3', 'd6', 'e0'] };
function pd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function ymd(d) { return d.toISOString().slice(0, 10); }
function addDays(s, n) { const d = pd(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
function weekNo(s) { return Math.floor((pd(s) - pd(START_DATE)) / 864e5 / 7) + 1; }
function defaultTpl(s) { const w = weekNo(s), dow = (pd(s).getUTCDay() + 6) % 7; return (WEEK_PLAN[w] || WEEK_PLAN.def)[dow]; }
function planDay(s) { const o = store.plan.days && store.plan.days.days && store.plan.days.days[s]; if (o) return { tpl: o.tpl, ex: o.ex || EXLIB.tpl[o.tpl].ex.map(([id, sets, reps]) => ({ id, sets, reps })) }; const t = defaultTpl(s); return { tpl: t, ex: EXLIB.tpl[t].ex.map(([id, sets, reps]) => ({ id, sets, reps })) }; }
function mealsFor(s) { const dow = pd(s).getUTCDay(); const wk = (store.plan.meals && store.plan.meals.week) || {}; const custom = (store.plan.meals && store.plan.meals.custom) || {}; const out = {}; EXLIB.slots.forEach(([k], i) => { const id = (wk[dow] || {})[k] || WEEK_MEALS[dow][i]; out[k] = { id, ...(EXLIB.meals[id] || custom[id] || { n: id }) }; }); return out; }
function foodTotals(s) { const f = store.food[s]; const t = { kcal: 0, p: 0, c: 0, f: 0, items: [] }; ((f && f.items) || []).forEach(i => { t.kcal += +i.k || 0; t.p += +i.p || 0; t.c += +i.c || 0; t.f += +i.f || 0; t.items.push(i.n); }); return t; }
function exName(id) { return (EXLIB.ex[id] || {}).n || id; }
function buildContext(today) {
  const w = weekNo(today); const p = planDay(today); const t = EXLIB.tpl[p.tpl];
  const settings = Object.assign({ kcal: 2300, p: 180, c: 240, f: 70 }, store.settings.main || {});
  const body = Object.values(store.body).sort((a, b) => a.date < b.date ? -1 : 1).slice(-14).map(r => `${r.date}: ${r.w} lb${r.fat ? ', ' + r.fat + '% fat' : ''}${r.muscle ? ', ' + r.muscle + ' lb muscle' : ''}`);
  const recent = Object.values(store.logs).filter(l => l.date < today && l.date >= addDays(today, -14)).sort((a, b) => a.date < b.date ? 1 : -1).slice(0, 8).map(l => `${l.date} ${EXLIB.tpl[l.tpl] ? EXLIB.tpl[l.tpl].n : l.tpl}${l.done ? ' (done)' : ' (not finished)'}: ` + (l.ex || []).map(e => exName(e.id) + ' ' + e.sets.filter(s => s.done).map(s => `${s.r}@${s.w || 0}`).join('/')).join('; '));
  const todayLog = store.logs[today];
  const food = foodTotals(today); const meals = mealsFor(today);
  const week = []; for (let i = 0; i < 7; i++) { const d = addDays(addDays(START_DATE, (w - 1) * 7), i); if (d > END_DATE) break; const pp = planDay(d); week.push(`${DOWS[pd(d).getUTCDay()]} ${d.slice(5)}: ${EXLIB.tpl[pp.tpl].n}${store.logs[d] && store.logs[d].done ? ' ✓' : ''}`); }
  return `TODAY: ${today} (${DOWS[pd(today).getUTCDay()]}), week ${w} of the 8-week plan (phase: ${['', 'Recover + learn the lifts', 'Find working weights', 'Progressive overload', 'Progressive overload', 'Progressive overload', 'Progressive overload', 'Peak loads', 'Deload + re-test', 'Carry on'][w] || ''}).
TODAY'S SESSION: ${t.n} [${p.tpl}] — ${t.d}
Exercises: ${p.ex.length ? p.ex.map(e => `${e.id} (${exName(e.id)}) ${e.sets}x${e.reps}`).join('; ') : 'none (cardio/rest day)'}
${todayLog ? 'Logged so far today: ' + (todayLog.ex || []).map(e => exName(e.id) + ' ' + e.sets.filter(s => s.done).map(s => `${s.r}@${s.w || 0}`).join('/')).filter(x => !/ $/.test(x)).join('; ') + (todayLog.done ? ' — marked done' : '') : 'Nothing logged yet today.'}
THIS WEEK: ${week.join(' | ')}
RECENT SESSIONS (last 14 days): ${recent.length ? recent.join('\n') : 'none yet'}
BODY (last 14 entries): ${body.length ? body.join('; ') : 'no weigh-ins yet'}
TARGETS: ${settings.kcal} kcal, ${settings.p} g protein, ${settings.c} g carbs, ${settings.f} g fat per day.
FOOD TODAY: ${Math.round(food.kcal)} kcal, ${Math.round(food.p)}P ${Math.round(food.c)}C ${Math.round(food.f)}F${food.items.length ? ' (' + food.items.join(', ') + ')' : ' (nothing logged)'}
TODAY'S PLANNED MEALS: ${EXLIB.slots.map(([k, l]) => `${l}: ${meals[k].n} [${meals[k].id}] ${meals[k].k} kcal/${meals[k].p}P`).join('; ')}`;
}
const SYSTEM_STATIC = `You are the in-app coach for Recomp 8, a personal 8-week fat-loss + muscle-gain tracker (Nov 2 – Dec 31, 2026) for Chris: 33, male, ~188 lb, endurance athlete (just ran the NYC Marathon), new to lifting, IT band history, trains at Planet Fitness (dumbbells to 75 lb, Smith machines, cables, selectorized machines, assisted pull-up, benches; NO squat rack or free barbell). Goal: ~1 lb/week fat loss while adding muscle; protein 180 g/day; lift 4x/week (upper/lower), cardio easy and short, no run over 40 min.
You answer briefly and concretely, like a good coach texting. Use the tools to CHANGE things when asked (shorten a workout, swap an exercise, move days, log food, log a weigh-in, change a meal) — do not just describe the change. After a tool call, confirm in one or two lines what changed. When shortening a session, keep one compound per main pattern (squat/hinge, push, pull) and cut isolation first; use supersets if helpful (say so in the reps field, e.g. "8-10 (superset)"). Keep IT-band work (hip abduction / Copenhagen) on lower days when possible. Use exercise ids from the library exactly. Never invent exercise ids; pick from the library or ask. Dates are YYYY-MM-DD. If a request is ambiguous, ask one short question.
EXERCISE LIBRARY (id: name | pattern | equipment):
${Object.entries(EXLIB.ex).map(([id, e]) => `${id}: ${e.n} | ${EXLIB.pat[e.p]} | ${e.eq}`).join('\n')}
SESSION TEMPLATES (code: name): ${Object.entries(EXLIB.tpl).map(([k, v]) => `${k}: ${v.n}`).join('; ')}
MEAL LIBRARY (id: name kcal/P/C/F): ${Object.entries(EXLIB.meals).map(([id, m]) => `${id}: ${m.n} ${m.k}/${m.p}/${m.c}/${m.f}`).join('; ')}
Meal slots: ${EXLIB.slots.map(([k, l]) => k + '=' + l).join(', ')}. Weekday numbers for meal swaps: 0=Sun … 6=Sat.`;
const TOOLS = [
  { name: 'set_day_exercises', description: 'Replace the exercise list for a date (keeps the session type unless tpl given). Use for shortening, swapping or re-ordering a workout. Logged sets for exercises that remain are preserved.', input_schema: { type: 'object', properties: { date: { type: 'string' }, tpl: { type: 'string', description: 'optional session template code' }, exercises: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, sets: { type: 'integer' }, reps: { type: 'string' } }, required: ['id', 'sets', 'reps'] } } }, required: ['date', 'exercises'] } },
  { name: 'set_day_template', description: 'Change what kind of day a date is (e.g. make it a rest day, or Lower A). Resets exercises to that template.', input_schema: { type: 'object', properties: { date: { type: 'string' }, tpl: { type: 'string' } }, required: ['date', 'tpl'] } },
  { name: 'swap_days', description: 'Swap the sessions of two dates.', input_schema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] } },
  { name: 'log_food', description: 'Add food items to a date\'s log.', input_schema: { type: 'object', properties: { date: { type: 'string' }, items: { type: 'array', items: { type: 'object', properties: { n: { type: 'string' }, k: { type: 'number' }, p: { type: 'number' }, c: { type: 'number' }, f: { type: 'number' } }, required: ['n', 'k', 'p'] } } }, required: ['date', 'items'] } },
  { name: 'log_body', description: 'Record a weigh-in.', input_schema: { type: 'object', properties: { date: { type: 'string' }, w: { type: 'number', description: 'lb' }, fat: { type: 'number' }, muscle: { type: 'number' } }, required: ['date', 'w'] } },
  { name: 'set_meal', description: 'Change the planned meal for a weekday slot (applies to that weekday for the rest of the plan).', input_schema: { type: 'object', properties: { weekday: { type: 'integer' }, slot: { type: 'string' }, meal_id: { type: 'string' } }, required: ['weekday', 'slot', 'meal_id'] } },
  { name: 'set_targets', description: 'Change daily calorie/macro targets.', input_schema: { type: 'object', properties: { kcal: { type: 'number' }, p: { type: 'number' }, c: { type: 'number' }, f: { type: 'number' } }, required: [] } },
  { name: 'get_history', description: 'Full workout logs, food totals and weigh-ins for a date range (use when the summary in context is not enough).', input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } },
  { name: 'get_day', description: 'The planned exercises and any log for one date.', input_schema: { type: 'object', properties: { date: { type: 'string' } }, required: ['date'] } }
];
function runTool(name, a) {
  const days = () => { if (!store.plan.days) store.plan.days = { days: {} }; if (!store.plan.days.days) store.plan.days.days = {}; return store.plan.days.days; };
  const mealsDoc = () => { if (!store.plan.meals) store.plan.meals = { week: {} }; if (!store.plan.meals.week) store.plan.meals.week = {}; return store.plan.meals; };
  const bad = m => ({ error: m });
  switch (name) {
    case 'set_day_exercises': { if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date)) return bad('bad date'); const cur = planDay(a.date); const unknown = (a.exercises || []).map(e => e.id).filter(id => !EXLIB.ex[id]); if (unknown.length) return bad('unknown exercise ids: ' + unknown.join(', ')); days()[a.date] = { tpl: a.tpl && EXLIB.tpl[a.tpl] ? a.tpl : cur.tpl, ex: a.exercises.map(e => ({ id: e.id, sets: Math.max(1, Math.min(8, +e.sets || 3)), reps: String(e.reps || '10') })) }; persist(); return { ok: true, date: a.date, exercises: days()[a.date].ex.map(e => `${exName(e.id)} ${e.sets}x${e.reps}`) }; }
    case 'set_day_template': { if (!EXLIB.tpl[a.tpl]) return bad('unknown template'); days()[a.date] = { tpl: a.tpl, ex: EXLIB.tpl[a.tpl].ex.map(([id, sets, reps]) => ({ id, sets, reps })) }; persist(); return { ok: true, date: a.date, session: EXLIB.tpl[a.tpl].n }; }
    case 'swap_days': { const pa = planDay(a.a), pb = planDay(a.b); days()[a.a] = pb; days()[a.b] = pa; persist(); return { ok: true, [a.a]: EXLIB.tpl[pb.tpl].n, [a.b]: EXLIB.tpl[pa.tpl].n }; }
    case 'log_food': { const f = store.food[a.date] || { date: a.date, items: [] }; a.items.forEach(i => f.items.push({ n: String(i.n), k: Math.round(+i.k || 0), p: Math.round(+i.p || 0), c: Math.round(+i.c || 0), f: Math.round(+i.f || 0), src: 'coach' })); store.food[a.date] = f; persist(); const t = foodTotals(a.date); return { ok: true, day_totals: { kcal: Math.round(t.kcal), p: Math.round(t.p), c: Math.round(t.c), f: Math.round(t.f) } }; }
    case 'log_body': { store.body[a.date] = { date: a.date, w: +a.w, fat: a.fat ? +a.fat : null, muscle: a.muscle ? +a.muscle : null, src: 'coach' }; persist(); return { ok: true }; }
    case 'set_meal': { if (!EXLIB.meals[a.meal_id] && !((store.plan.meals || {}).custom || {})[a.meal_id]) return bad('unknown meal id'); const m = mealsDoc(); m.week[a.weekday] = Object.assign({}, m.week[a.weekday] || {}, { [a.slot]: a.meal_id }); persist(); return { ok: true, weekday: DOWS[a.weekday], slot: a.slot, meal: (EXLIB.meals[a.meal_id] || {}).n || a.meal_id }; }
    case 'set_targets': { store.settings.main = Object.assign({ kcal: 2300, p: 180, c: 240, f: 70, maint: 2850 }, store.settings.main || {}, Object.fromEntries(Object.entries(a).filter(([k, v]) => ['kcal', 'p', 'c', 'f'].includes(k) && v))); persist(); return { ok: true, targets: store.settings.main }; }
    case 'get_history': { const inR = d => d >= a.from && d <= a.to; return { logs: Object.values(store.logs).filter(l => inR(l.date)).map(l => ({ date: l.date, session: (EXLIB.tpl[l.tpl] || {}).n, done: !!l.done, notes: l.notes, ex: (l.ex || []).map(e => ({ name: exName(e.id), sets: e.sets.filter(s => s.done).map(s => `${s.r}@${s.w || 0}`) })) })), food: Object.keys(store.food).filter(inR).map(d => { const t = foodTotals(d); return { date: d, kcal: Math.round(t.kcal), p: Math.round(t.p), items: t.items }; }), body: Object.values(store.body).filter(r => inR(r.date)) }; }
    case 'get_day': { const p = planDay(a.date); return { date: a.date, session: EXLIB.tpl[p.tpl].n, tpl: p.tpl, exercises: p.ex.map(e => ({ id: e.id, name: exName(e.id), sets: e.sets, reps: e.reps })), log: store.logs[a.date] || null, meals: mealsFor(a.date), food: foodTotals(a.date) }; }
  }
  return bad('unknown tool');
}
function anthropicStream(body, onEvent) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', accept: 'text/event-stream' } }, r => {
      if (r.statusCode !== 200) { let s = ''; r.on('data', d => s += d); r.on('end', () => { let m = s; try { m = JSON.parse(s).error.message; } catch (e) { } reject(new Error(m || ('HTTP ' + r.statusCode))); }); return; }
      let buf = '';
      r.on('data', chunk => { buf += chunk; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); const line = block.split('\n').find(l => l.startsWith('data:')); if (!line) continue; try { onEvent(JSON.parse(line.slice(5).trim())); } catch (e) { } } });
      r.on('end', resolve); r.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(120000, () => req.destroy(new Error('timeout')));
    req.end(JSON.stringify(body));
  });
}
async function chat(req, res) {
  if (!ANTHROPIC_KEY) return send(res, 503, { error: 'no_key', message: 'Add ANTHROPIC_API_KEY on the server.' });
  const b = await readBody(req, 2e6);
  const today = /^\d{4}-\d{2}-\d{2}$/.test(b.today || '') ? b.today : ymd(new Date());
  let messages = (b.messages || []).filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content).slice(-24).map(m => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
  if (!messages.length || messages[messages.length - 1].role !== 'user') return send(res, 400, { error: 'need a user message' });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  const emit = (type, data) => res.write(`data: ${JSON.stringify(Object.assign({ type }, data))}\n\n`);
  const system = [{ type: 'text', text: SYSTEM_STATIC, cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'CURRENT STATE (screen the user is on: ' + (b.screen || 'unknown') + ')\n' + buildContext(today) }];
  let changed = false;
  try {
    for (let round = 0; round < 6; round++) {
      const blocks = []; let cur = null; let stop = null;
      await anthropicStream({ model: CHAT_MODEL, max_tokens: 1200, stream: true, system, tools: TOOLS, messages }, ev => {
        if (ev.type === 'content_block_start') { cur = ev.content_block.type === 'tool_use' ? { type: 'tool_use', id: ev.content_block.id, name: ev.content_block.name, json: '' } : { type: 'text', text: '' }; blocks.push(cur); }
        else if (ev.type === 'content_block_delta') { if (ev.delta.type === 'text_delta') { cur.text += ev.delta.text; emit('text', { delta: ev.delta.text }); } else if (ev.delta.type === 'input_json_delta') cur.json += ev.delta.partial_json; }
        else if (ev.type === 'message_delta') stop = ev.delta.stop_reason;
      });
      const content = blocks.map(bk => bk.type === 'text' ? { type: 'text', text: bk.text } : { type: 'tool_use', id: bk.id, name: bk.name, input: bk.json ? JSON.parse(bk.json) : {} }).filter(bk => bk.type !== 'text' || bk.text);
      if (content.length) messages.push({ role: 'assistant', content });
      const uses = content.filter(bk => bk.type === 'tool_use');
      if (stop !== 'tool_use' || !uses.length) break;
      const results = [];
      for (const u of uses) { let out; try { out = runTool(u.name, u.input); } catch (e) { out = { error: String(e.message || e) }; } if (out && out.ok) changed = true; emit('tool', { name: u.name, input: u.input, ok: !!(out && out.ok) }); results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) }); }
      messages.push({ role: 'user', content: results });
      emit('text', { delta: '\n' });
    }
    emit('done', { changed });
  } catch (e) { emit('error', { message: String(e.message || e) }); }
  res.end();
}

const MCP = require('./mcp.js').makeMcp({ store, persist, EXLIB, planDay, mealsFor, foodTotals, exName, buildContext, addDays, weekNo, DOWS, pd, START_DATE, END_DATE, WEEK_MEALS });
function authed(req) { if (!APP_KEY) return true; const h = req.headers.authorization || ''; return req.headers['x-key'] === APP_KEY || h === 'Bearer ' + APP_KEY; }

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/mcp' || url.pathname === '/mcp/') {
    res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', 'authorization, content-type, x-key, mcp-protocol-version, mcp-session-id'); res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (!authed(req)) { res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="recomp8"' }); return res.end('{"error":"unauthorized"}'); }
    if (req.method === 'GET') { res.writeHead(405, { 'content-type': 'application/json' }); return res.end('{"error":"streaming not offered; POST JSON-RPC"}'); }
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    try { const body = await readBody(req, 1e6); const out = await MCP.handle(body); if (out.body === null) { res.writeHead(202); return res.end(); } return send(res, out.status, out.body); }
    catch (e) { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
  }
  if (url.pathname.startsWith('/api/')) {
    if (APP_KEY && req.headers['x-key'] !== APP_KEY) return send(res, 401, { error: 'unauthorized' });
    const parts = url.pathname.slice(5).split('/').filter(Boolean);
    try {
      if (parts[0] === 'ping') return send(res, 200, { ok: true, vision: !!ANTHROPIC_KEY, chat: !!ANTHROPIC_KEY });
      if (parts[0] === 'chat' && req.method === 'POST') return chat(req, res);
      if (parts[0] === 'food') {
        if (parts[1] === 'analyze' && req.method === 'POST') { const b = await readBody(req, 8e6); if (!b || !b.image) return send(res, 400, { error: 'no image' }); const out = await analyzeFood(b.image, b.mime, b.hint); return send(res, out.status, out.body); }
        if (parts[1] === 'estimate' && req.method === 'POST') { const b = await readBody(req); if (!b || !String(b.text || '').trim()) return send(res, 400, { error: 'no text' }); const out = await estimateText(b.text, b.slot); return send(res, out.status, out.body); }
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
