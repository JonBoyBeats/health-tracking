// End-to-end test: the real app and the real supabase-js, against an in-memory stand-in for
// Supabase's auth, REST and Edge Function endpoints (served through Playwright request routing).
// The stand-in "food" function runs the real lookup code, so food searches hit live USDA and
// Open Food Facts.
//
// Run from the repo root:
//   python3 -m http.server 8765 --bind 127.0.0.1 &
//   USDA_API_KEY=... FIXTURES=<dir with noodles.y4m, chobani.png> node tests/app.e2e.js
// (behind an HTTPS proxy, add NODE_USE_ENV_PROXY=1)
const { chromium, devices } = require('playwright');
const assert = require('assert');
const path = require('path');

const BASE = 'http://127.0.0.1:8765/';
const SB = 'https://test.supabase.co';
const OUT = process.env.OUT || require('os').tmpdir(); // screenshots
const FIXTURES = process.env.FIXTURES || OUT;
const JON = '11111111-1111-1111-1111-111111111111';
const WIFE = '22222222-2222-2222-2222-222222222222';
const users = { 'jon@example.com': JON, 'wife@example.com': WIFE };
const profiles = [
  { id: JON, name: 'jon', target_calories: 2000, target_protein: 150, target_carbs: 200, target_fat: 65, target_fiber: 30, created_at: '2026-01-01' },
  { id: WIFE, name: 'wife', target_calories: 2000, target_protein: 150, target_carbs: 200, target_fat: 65, target_fiber: 30, created_at: '2026-01-02' },
];
let entries = [];
let foods = [];
const requests = [];
let nextId = 1;
let lib, assistLib;
let aiScript = []; // scripted Claude replies for the AI logging test (functions/v1/assist)
const fakeClaude = { messages: { create: async (req) => ({ content: aiScript.shift()(req), stop_reason: 'tool_use' }) } };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function session(email) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const user = { id: users[email], email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01' };
  return { access_token: `${b64({ alg: 'HS256' })}.${b64({ sub: user.id, exp, role: 'authenticated' })}.sig`, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'r', user };
}
const eq = (url, col) => url.searchParams.get(col)?.replace(/^eq\./, '');

// Just enough of PostgREST's filters for the app's queries on foods.
function filterFoods(url) {
  let rows = [...foods];
  for (const f of url.searchParams.getAll('search_text')) {
    const w = f.replace(/^ilike\./, '').replace(/[%*]/g, '').toLowerCase();
    rows = rows.filter((r) => `${r.name} ${r.brand || ''}`.toLowerCase().includes(w));
  }
  if (url.searchParams.get('id')) rows = rows.filter((r) => r.id === eq(url, 'id'));
  const bc = url.searchParams.get('barcode');
  if (bc) {
    const list = bc.replace(/^in\.\(|\)$/g, '').split(',').map((s) => s.replace(/"/g, ''));
    rows = rows.filter((r) => list.includes(r.barcode));
  }
  if (url.searchParams.get('order')?.startsWith('last_used_at.desc')) rows.sort((a, b) => b.last_used_at.localeCompare(a.last_used_at));
  return rows.slice(0, Number(url.searchParams.get('limit')) || 1000);
}

async function fakeSupabase(route) {
  const req = route.request();
  const url = new URL(req.url());
  const method = req.method();
  const body = req.postData() ? JSON.parse(req.postData()) : null;
  const single = (req.headers()['accept'] || '').includes('vnd.pgrst.object');
  requests.push({ method, path: url.pathname, search: url.search, body });
  const json = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  const rows = (status, list) => (single ? (list.length === 1 ? json(status, list[0]) : json(406, { message: 'not one row' })) : json(status, list));
  if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });

  if (url.pathname === '/auth/v1/token') {
    if (body.password !== 'pw' || !users[body.email]) return json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
    return json(200, session(body.email));
  }
  if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204 });

  const auth = req.headers()['authorization'] || '';
  if (!auth.includes('.sig')) return json(401, { message: 'not signed in' });

  if (url.pathname === '/functions/v1/food') {
    const opts = { usdaKey: process.env.USDA_API_KEY };
    try {
      if (body.action === 'search') return json(200, { results: await lib.searchFoods(body.query, opts) });
      if (body.action === 'barcode') return json(200, { results: await lib.lookupBarcode(body.code, opts) });
      if (body.action === 'details') return json(200, { result: await lib.usdaFood(body.id, opts) });
    } catch (err) {
      return json(502, { error: `Food lookup failed: ${err.message}` });
    }
    return json(400, { error: 'Unknown request' });
  }
  if (url.pathname === '/functions/v1/assist') {
    const deps = {
      client: fakeClaude,
      foodOpts: { usdaKey: process.env.USDA_API_KEY },
      searchSaved: async (q) => foods.filter((f) => q.toLowerCase().split(/\s+/).every((w) => `${f.name} ${f.brand || ''}`.toLowerCase().includes(w))),
      getSaved: async (id) => foods.find((f) => f.id === id),
    };
    try {
      if (body.action === 'chat') return json(200, await assistLib.converse(body, deps));
      if (body.action === 'label') return json(200, { result: await assistLib.readLabel(body, deps) });
    } catch (err) {
      return json(502, { error: err.message });
    }
  }
  if (url.pathname === '/rest/v1/profiles') {
    if (method === 'GET') return json(200, profiles);
    if (method === 'PATCH') { Object.assign(profiles.find((p) => p.id === eq(url, 'id')), body); return route.fulfill({ status: 204 }); }
  }
  if (url.pathname === '/rest/v1/log_entries') {
    if (method === 'GET') return json(200, entries.filter((e) => e.eaten_on === eq(url, 'eaten_on')));
    if (method === 'POST') {
      for (const r of body) entries.push({ id: `e${nextId++}`, is_estimate: false, created_at: new Date().toISOString(), ...r });
      return route.fulfill({ status: 201 });
    }
    if (method === 'PATCH') { Object.assign(entries.find((e) => e.id === eq(url, 'id')), body); return route.fulfill({ status: 204 }); }
    if (method === 'DELETE') { entries = entries.filter((e) => e.id !== eq(url, 'id')); return route.fulfill({ status: 204 }); }
  }
  if (url.pathname === '/rest/v1/foods') {
    if (method === 'GET') return rows(200, filterFoods(url));
    if (method === 'POST') {
      assert.equal(url.searchParams.get('on_conflict'), 'source,source_id');
      let row = foods.find((f) => f.source_id && f.source === body.source && f.source_id === body.source_id);
      if (row) Object.assign(row, body);
      else foods.push((row = { id: `f${nextId++}`, created_at: new Date().toISOString(), ...body }));
      return rows(201, [row]);
    }
    if (method === 'PATCH') {
      const row = foods.find((f) => f.id === eq(url, 'id'));
      Object.assign(row, body);
      return rows(200, [row]);
    }
  }
  return json(404, { message: `unhandled ${method} ${url.pathname}` });
}

function localDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

(async () => {
  lib = await import(path.join(__dirname, '../supabase/functions/food/lib.js'));
  assistLib = await import(path.join(__dirname, '../supabase/functions/assist/lib.js'));
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${path.join(FIXTURES, 'noodles.y4m')}`],
  });
  const errors = [];

  // ---- Not configured yet: the setup message shows.
  {
    const page = await browser.newPage();
    await page.route('**/js/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: "export const SUPABASE_URL=''; export const SUPABASE_KEY='';" }));
    await page.goto(BASE);
    await page.waitForSelector('#setup:not([hidden])');
    await page.close();
    console.log('ok  unconfigured shows setup message');
  }

  const context = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 1, permissions: ['camera'] });
  await context.route('**/js/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: `export const SUPABASE_URL='${SB}'; export const SUPABASE_KEY='sb_publishable_test';` }));
  await context.route(`${SB}/**`, fakeSupabase);
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Protein Granola' : undefined));
  const closed = (id) => page.waitForSelector(`#${id}:not([open])`, { state: 'attached' });
  const big = () => page.textContent('#left .big');

  // ---- Login: wrong password shows an error, right password opens the app.
  await page.goto(BASE);
  await page.waitForSelector('#login:not([hidden])');
  await page.fill('[name=email]', 'jon@example.com');
  await page.fill('[name=password]', 'nope');
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#login-error:not([hidden])');
  assert.match(await page.textContent('#login-error'), /Invalid login credentials/);
  await page.fill('[name=password]', 'pw');
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app:not([hidden])');
  assert.equal(await page.textContent('#day-label'), 'Today');
  assert.equal(await big(), '2000');
  console.log('ok  login error, then sign in shows today with full targets');

  // ---- Quick add for both, calories left blank -> computed from macros.
  await page.click('#open-add');
  await page.waitForSelector('#add[open]');
  assert.match(await page.textContent('#results-note'), /Search for a food/);
  await page.fill('#food-q', 'Turkey sandwich');
  await page.click('#open-quick');
  await page.waitForSelector('#entry[open]');
  assert.equal(await page.inputValue('#entry-form [name=description]'), 'Turkey sandwich');
  await page.fill('#entry-form [name=protein]', '30');
  await page.fill('#entry-form [name=carbs]', '40');
  await page.fill('#entry-form [name=fat]', '10');
  await page.fill('#entry-form [name=fiber]', '5');
  assert.match(await page.textContent('#calc-hint'), /370/);
  await page.selectOption('#entry-form [name=meal]', 'lunch');
  await page.click('#who [data-who="both"]');
  await page.click('#entry-form button[type=submit]');
  await closed('entry');
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.person_id).sort(), [JON, WIFE]);
  assert.ok(entries.every((e) => e.calories === 370 && e.eaten_on === localDay(new Date()) && e.meal === 'lunch'));
  await page.waitForSelector('#toast:not([hidden])');
  assert.equal(await page.textContent('#toast'), 'jon: 1630 cal left · wife: 1630 cal left');
  assert.equal(await big(), '1630');
  console.log('ok  quick add for both: calories from macros, both logs, toast shows what is left');

  // ---- Edit the wife's quick-add entry; Jon's is unchanged. Then delete it.
  await page.click(`[data-person="${WIFE}"]`);
  await page.click('.entry');
  assert.equal(await page.inputValue('#entry-form [name=calories]'), '370');
  await page.fill('#entry-form [name=calories]', '500');
  await page.click('#entry-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#left .big').textContent === '1500');
  assert.equal(entries.find((e) => e.person_id === JON).calories, 370);
  await page.click('.entry');
  await page.click('#entry-delete');
  await page.waitForFunction(() => document.querySelector('#left .big').textContent === '2000');
  assert.equal(entries.length, 1);
  await page.click(`[data-person="${JON}"]`);
  console.log('ok  edit and delete a quick-add entry');

  // ---- Search USDA, pick a portion, save. The food is saved for next time.
  await page.click('#open-add');
  await page.fill('#food-q', 'banana');
  await page.waitForFunction(() => document.querySelector('#results [data-result]')?.textContent.includes('Bananas, raw'), null, { timeout: 30000 });
  await page.screenshot({ path: `${OUT}/step2-search.png` });
  await page.click('#results [data-result="0"]');
  await page.waitForSelector('#food[open]');
  assert.equal(await page.textContent('#food-name'), 'Bananas, raw');
  // Household portions arrive from USDA's details call.
  await page.waitForFunction(() => [...document.querySelectorAll('#food-form [name=unit] option')].some((o) => o.textContent.includes('medium')), null, { timeout: 30000 });
  const medium = await page.$eval('#food-form [name=unit]', (s) => [...s.options].find((o) => o.textContent.includes('medium')).value);
  await page.selectOption('#food-form [name=unit]', medium);
  await page.fill('#food-form [name=amount]', '1');
  assert.match(await page.textContent('#food-macros'), /^\s*105\s/);
  assert.match(await page.textContent('#food-after'), /jon 1525 cal left/);
  await page.screenshot({ path: `${OUT}/step2-amount.png` });
  await page.click('#food-form button[type=submit]');
  await closed('food');
  const banana = entries.find((e) => e.description === 'Bananas, raw');
  assert.ok(banana, 'banana logged');
  assert.equal(banana.calories, 105);
  assert.equal(banana.grams, 118);
  assert.match(banana.unit, /medium/);
  assert.equal(foods.length, 1);
  assert.equal(banana.food_id, foods[0].id);
  assert.equal(foods[0].source, 'usda');
  assert.ok(foods[0].servings.length > 3);
  assert.equal(await big(), '1525');
  assert.match(await page.textContent('#meals'), /\b1 medium · P 1/);
  console.log('ok  search USDA, pick a household portion, save; food saved to the shared list');

  // ---- Recent and saved foods come first, without duplicates.
  await page.click('#open-add');
  await page.waitForFunction(() => document.querySelector('#results-heading').textContent === 'Recent');
  assert.match(await page.textContent('#results'), /Bananas, raw.*Saved/s);
  await page.fill('#food-q', 'banana');
  await page.waitForFunction(() => !document.querySelector('#results-note').textContent.includes('Searching'), null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('#results [data-result]').length > 3);
  assert.match(await page.textContent('#results [data-result="0"]'), /Bananas, raw.*Saved/s);
  const rawCount = await page.$$eval('#results [data-result]', (bs) => bs.filter((b) => b.textContent.includes('Bananas, raw')).length);
  assert.equal(rawCount, 1);
  console.log('ok  recent foods, and saved foods first in search without duplicates');

  // ---- Scan with the camera (a fake camera showing the noodle kit's barcode).
  await page.click('#open-scanner');
  await page.waitForSelector('#food[open]', { timeout: 30000 });
  assert.match(await page.textContent('#food-name'), /Thai Peanut Noodle Kit/);
  assert.match(await page.textContent('#food-badges'), /2 sources agree/);
  assert.match(await page.inputValue('#food-form [name=unit]').then(async (v) => page.$eval(`#food-form [name=unit] option[value="${v}"]`, (o) => o.textContent)), /PACKAGE \(52 g\)/);
  await page.screenshot({ path: `${OUT}/step2-scanned.png` });
  const oz = await page.$eval('#food-form [name=unit]', (s) => [...s.options].find((o) => o.textContent === 'oz').value);
  await page.selectOption('#food-form [name=unit]', oz);
  await page.fill('#food-form [name=amount]', '2');
  await page.click('#food-form button[type=submit]');
  await closed('food');
  const noodles = entries.find((e) => /Noodle/.test(e.description));
  assert.equal(noodles.unit, 'oz');
  assert.equal(noodles.grams, 56.7);
  assert.equal(noodles.calories, Math.round(3.85 * 56.699 * 10) / 10);
  console.log('ok  camera scan: both sources agree, logged by the ounce');

  // From here on there's no camera (the fake one would keep scanning the noodles).
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('NotAllowedError')); });

  // ---- Scan from a photo (Chobani: only in Open Food Facts).
  await page.click('#open-add');
  await page.click('#open-scanner');
  await page.waitForFunction(() => document.querySelector('#scan-status').textContent.includes("camera isn't available"));
  await page.setInputFiles('#scan-photo', path.join(FIXTURES, 'chobani.png'));
  await page.waitForSelector('#food[open]', { timeout: 30000 });
  assert.equal(await page.textContent('#food-name'), 'Greek Yogurt Strawberry (Chobani)');
  assert.match(await page.textContent('#food-badges'), /Open Food Facts/);
  await page.click('#food-back');
  await page.waitForSelector('#add[open]');
  console.log('ok  barcode from a photo');

  // ---- Typed barcode that no source has.
  await page.click('#open-scanner');
  await page.fill('#scan-code', '000000000017');
  await page.click('#scan-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#results-note').textContent.includes("isn't in USDA"), null, { timeout: 30000 });
  await page.click('#add [data-close]');
  console.log('ok  unknown barcode explains what to do');

  // ---- Edit a food entry's amount.
  await page.click('.entry >> text=Bananas, raw');
  await page.waitForSelector('#food[open]');
  assert.ok(await page.isVisible('#food-delete'));
  assert.ok(await page.isHidden('#food-who-field'));
  assert.equal(await page.inputValue('#food-form [name=amount]'), '1');
  await page.fill('#food-form [name=amount]', '2');
  await page.click('#food-form button[type=submit]');
  await closed('food');
  assert.equal(entries.find((e) => e.id === banana.id).calories, 210);
  assert.equal(entries.find((e) => e.id === banana.id).grams, 236);
  assert.match(await page.textContent('#meals'), /2 × 1 medium · P 3/);
  assert.match(await page.textContent('#meals'), /2 oz · P 5/);
  await page.screenshot({ path: `${OUT}/step2-today.png` });
  console.log('ok  edit a food entry by amount');

  // ---- AI logging: describe, answer a follow-up, review, adjust, save.
  const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const zero = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
  let eggs;
  aiScript = [
    (r) => {
      assert.match(r.messages[0].content, /The app user is jon\. The other person is wife\./);
      return [use('a1', 'search_foods', { query: 'scrambled eggs' })];
    },
    (r) => {
      eggs = JSON.parse(r.messages.at(-1).content[0].content).find((f) => f.servings.some((x) => /large/.test(x)));
      return [use('a2', 'ask_user', { question: 'Did you both have the same amount?' })];
    },
    (r) => {
      assert.deepEqual(r.messages.at(-1).content, [{ type: 'tool_result', tool_use_id: 'a2', content: 'she had one, I had two' }]);
      const large = eggs.servings.find((x) => /large/.test(x));
      return [use('a3', 'log_foods', { items: [
        { person: 'jon', ref: eggs.ref, name: 'Scrambled eggs', amount: 2, unit: large, estimate: zero },
        { person: 'wife', ref: eggs.ref, name: 'Scrambled eggs', amount: 1, unit: large, estimate: zero },
        { person: 'jon', ref: 'estimate', name: 'Coffee with cream', amount: 1, unit: '1 mug', estimate: { calories: 60, protein: 1, carbs: 2, fat: 5, fiber: 0 } },
      ] })];
    },
  ];
  await page.click('#open-add');
  await page.fill('#ai-text', 'we had scrambled eggs and I had coffee with cream');
  await page.click('#ai-send');
  await page.waitForFunction(() => document.querySelector('#ai-chat .bubble.ai')?.textContent.includes('same amount'), null, { timeout: 30000 });
  assert.equal(await page.textContent('#ai-send'), 'Answer');
  await page.screenshot({ path: `${OUT}/step3-question.png` });
  await page.fill('#ai-text', 'she had one, I had two');
  await page.press('#ai-text', 'Enter');
  await page.waitForSelector('#confirm[open]', { timeout: 30000 });
  assert.match(await page.textContent('#confirm-items'), /jon.*Egg.*Estimate.*wife.*Egg/s);
  await page.screenshot({ path: `${OUT}/step3-confirm.png` });
  // Wife's eggs: 1 -> 2; remove the coffee.
  assert.equal((await page.$$('#confirm-items [data-amount]')).length, 2);
  await page.fill('#confirm-items [data-amount="1"]', '2');
  const eggCal = await page.textContent('[data-item-macros="0"]');
  assert.equal(await page.textContent('[data-item-macros="1"]'), eggCal, 'same amount, same numbers');
  await page.click('[data-remove="2"]');
  assert.doesNotMatch(await page.textContent('#confirm-items'), /Coffee/);
  assert.match(await page.textContent('#confirm-after'), /jon .* cal left.*wife .* cal left/);
  const before = { entries: entries.length, foods: foods.length };
  await page.click('#confirm-form button[type=submit]');
  await closed('confirm');
  const added = entries.slice(before.entries);
  assert.equal(added.length, 2);
  assert.deepEqual(added.map((e) => e.person_id).sort(), [JON, WIFE]);
  assert.ok(added.every((e) => e.amount === 2 && /large/.test(e.unit) && e.food_id && !e.is_estimate));
  assert.equal(foods.length, before.foods + 1, 'the food is saved once for both people');
  console.log('ok  AI logging: question, answer, both people, adjust, remove, save');

  // ---- An unknown barcode, then a label photo: saved under that barcode, found on the next scan.
  aiScript = [() => [{ type: 'text', text: JSON.stringify({ readable: true, problem: '', name: '', brand: '', serving_label: '2/3 cup (55g)', serving_grams: 55, calories: 230, protein: 10, carbs: 30, fat: 8, fiber: 4 }) }]];
  await page.click('#open-add');
  await page.click('#open-scanner');
  await page.fill('#scan-code', '000000000017');
  await page.click('#scan-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#results-note').textContent.includes('Snap a label'), null, { timeout: 30000 });
  await page.setInputFiles('#label-photo', path.join(FIXTURES, 'chobani.png'));
  await page.waitForSelector('#food[open]', { timeout: 30000 });
  assert.equal(await page.textContent('#food-name'), 'Protein Granola');
  assert.match(await page.textContent('#food-badges'), /From label photo/);
  assert.match(await page.textContent('#food-macros'), /^\s*230\s/);
  await page.click('#food-form button[type=submit]');
  await closed('food');
  const granola = foods.find((f) => f.source === 'label');
  assert.equal(granola.barcode, '000000000017');
  await page.click('#open-add');
  await page.click('#open-scanner');
  await page.fill('#scan-code', '000000000017');
  await page.click('#scan-form button[type=submit]');
  await page.waitForSelector('#food[open]');
  assert.match(await page.textContent('#food-badges'), /Saved/);
  await page.click('#food-back');
  await page.click('#add [data-close]');
  console.log('ok  label photo for an unknown barcode; the next scan finds it saved');

  // ---- Settings: rename and change a target.
  await page.click('#open-settings');
  const wifeSet = page.locator(`fieldset[data-profile="${WIFE}"]`);
  await wifeSet.locator('[name=name]').fill('Sarah');
  await wifeSet.locator('[name=target_calories]').fill('1800');
  await page.click('#settings-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#people').textContent.includes('Sarah'));
  console.log('ok  settings rename and target');

  // ---- Day navigation asks for the right day.
  await page.click('#prev-day');
  await page.waitForFunction(() => document.querySelector('#day-label').textContent === 'Yesterday');
  const y = new Date(); y.setDate(y.getDate() - 1);
  assert.ok(requests.some((r) => r.method === 'GET' && r.search.includes(`eaten_on=eq.${localDay(y)}`)));
  await page.click('#go-today');
  await page.waitForFunction(() => document.querySelector('#day-label').textContent === 'Today');
  console.log('ok  day navigation');

  // ---- Reload: still signed in.
  await page.reload();
  await page.waitForSelector('#app:not([hidden])');
  assert.match(await page.textContent('#meals'), /Turkey sandwich/);
  console.log('ok  stays signed in after reload');

  // ---- An error while a sheet is open is visible.
  await page.click('#open-add');
  await page.click('#open-quick');
  await page.fill('#entry-form [name=description]', 'x');
  await context.route(`${SB}/rest/v1/log_entries*`, (r) => r.request().method() === 'POST'
    ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"db down"}' }) : fakeSupabase(r));
  await page.click('#entry-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'db down');
  assert.ok(await page.evaluate(() => document.querySelector('#toast').matches(':popover-open')));
  await context.unroute(`${SB}/rest/v1/log_entries*`);
  await page.click('#entry [data-close]');
  console.log('ok  errors show above an open sheet');

  // ---- Sign out.
  await page.click('#open-settings');
  await page.click('#sign-out');
  await page.waitForSelector('#login:not([hidden])');
  await page.reload();
  await page.waitForSelector('#login:not([hidden])');
  console.log('ok  sign out');

  // Expected: the wrong-password 400, the deliberate 500, the switched-off camera.
  const unexpected = errors.filter((e) => !e.includes('db down') && !e.includes('status of 400') && !e.includes('status of 500') && !e.includes('NotAllowedError'));
  if (unexpected.length) console.log('console errors:', unexpected);
  assert.deepEqual(unexpected, [], 'console errors');
  await browser.close();
  console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
