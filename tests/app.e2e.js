// Run: python3 -m http.server 8765 --bind 127.0.0.1 (from the repo root), then node tests/app.e2e.js
// End-to-end test of step 1: the real app and the real supabase-js, against an in-memory stand-in
// for Supabase's auth and REST endpoints (served through Playwright request routing).
const { chromium, devices } = require('playwright');
const assert = require('assert');

const BASE = 'http://127.0.0.1:8765/';
const SB = 'https://test.supabase.co';
const OUT = process.env.OUT || require('os').tmpdir(); // screenshots
const JON = '11111111-1111-1111-1111-111111111111';
const WIFE = '22222222-2222-2222-2222-222222222222';
const users = { 'jon@example.com': JON, 'wife@example.com': WIFE };
const profiles = [
  { id: JON, name: 'jon', target_calories: 2000, target_protein: 150, target_carbs: 200, target_fat: 65, target_fiber: 30, created_at: '2026-01-01' },
  { id: WIFE, name: 'wife', target_calories: 2000, target_protein: 150, target_carbs: 200, target_fat: 65, target_fiber: 30, created_at: '2026-01-02' },
];
let entries = [];
const requests = [];
let nextId = 1;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function session(email) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const user = { id: users[email], email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01' };
  return { access_token: `${b64({ alg: 'HS256' })}.${b64({ sub: user.id, exp, role: 'authenticated' })}.sig`, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'r', user };
}
const eq = (url, col) => url.searchParams.get(col)?.replace(/^eq\./, '');

async function fakeSupabase(route) {
  const req = route.request();
  const url = new URL(req.url());
  const method = req.method();
  const body = req.postData() ? JSON.parse(req.postData()) : null;
  requests.push({ method, path: url.pathname, search: url.search, body });
  const json = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });

  if (url.pathname === '/auth/v1/token') {
    if (body.password !== 'pw' || !users[body.email]) return json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
    return json(200, session(body.email));
  }
  if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204 });

  const auth = req.headers()['authorization'] || '';
  if (url.pathname.startsWith('/rest/v1/') && !auth.includes('.sig')) return json(401, { message: 'not signed in' });

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
  return json(404, { message: `unhandled ${method} ${url.pathname}` });
}

function localDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  // 1. Not configured yet: the setup message shows.
  {
    const page = await browser.newPage();
    await page.goto(BASE);
    await page.waitForSelector('#setup:not([hidden])');
    await page.close();
    console.log('ok  unconfigured shows setup message');
  }

  const context = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 1 });
  await context.route('**/js/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: `export const SUPABASE_URL='${SB}'; export const SUPABASE_KEY='sb_publishable_test';` }));
  await context.route(`${SB}/**`, fakeSupabase);
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());

  // 2. Login: wrong password shows an error, right password opens the app.
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
  assert.equal(await page.textContent('#left .big'), '2000');
  assert.equal(await page.getAttribute(`[data-person="${JON}"]`, 'aria-pressed'), 'true');
  console.log('ok  login error, then sign in shows today with full targets');

  // 3. Add for both, calories left blank -> computed from macros.
  await page.click('#open-add');
  await page.fill('[name=description]', 'Turkey sandwich');
  await page.fill('[name=protein]', '30');
  await page.fill('[name=carbs]', '40');
  await page.fill('[name=fat]', '10');
  await page.fill('[name=fiber]', '5');
  assert.match(await page.textContent('#calc-hint'), /370/);
  await page.selectOption('[name=meal]', 'lunch');
  await page.click('[data-who="both"]');
  await page.screenshot({ path: `${OUT}/step1-add.png` });
  await page.click('#entry-form button[type=submit]');
  await page.waitForSelector('#entry:not([open])', { state: 'attached' });
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.person_id).sort(), [JON, WIFE]);
  assert.ok(entries.every((e) => e.calories === 370 && e.eaten_on === localDay(new Date()) && e.meal === 'lunch'));
  await page.waitForSelector('#toast:not([hidden])');
  assert.equal(await page.textContent('#toast'), 'jon: 1630 cal left · wife: 1630 cal left');
  assert.equal(await page.textContent('#left .big'), '1630');
  assert.match(await page.textContent('#left .bar.protein'), /120g left/);
  assert.match(await page.textContent('#meals'), /Turkey sandwich/);
  await page.screenshot({ path: `${OUT}/step1-today.png` });
  console.log('ok  add for both: calories from macros, both logs, toast shows what is left');

  // 4. Switch to wife, edit her entry; Jon's is unchanged.
  await page.click(`[data-person="${WIFE}"]`);
  await page.click('.entry');
  assert.equal(await page.inputValue('[name=calories]'), '370');
  assert.ok(await page.isHidden('#who-field'));
  await page.fill('[name=calories]', '500');
  await page.click('#entry-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#left .big').textContent === '1500');
  assert.equal(entries.find((e) => e.person_id === WIFE).calories, 500);
  assert.equal(entries.find((e) => e.person_id === JON).calories, 370);
  console.log('ok  edit one person\'s entry leaves the other alone');

  // 5. Delete it.
  await page.click('.entry');
  await page.click('#entry-delete');
  await page.waitForFunction(() => document.querySelector('#left .big').textContent === '2000');
  assert.equal(entries.length, 1);
  console.log('ok  delete');

  // 6. Settings: rename and change a target.
  await page.click('#open-settings');
  const wifeSet = page.locator(`fieldset[data-profile="${WIFE}"]`);
  await wifeSet.locator('[name=name]').fill('Sarah');
  await wifeSet.locator('[name=target_calories]').fill('1800');
  await page.screenshot({ path: `${OUT}/step1-settings.png` });
  await page.click('#settings-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#people').textContent.includes('Sarah'));
  assert.equal(await page.textContent('#left .big'), '1800');
  console.log('ok  settings rename and target');

  // 7. Day navigation asks for the right day.
  await page.click('#prev-day');
  await page.waitForFunction(() => document.querySelector('#day-label').textContent === 'Yesterday');
  const y = new Date(); y.setDate(y.getDate() - 1);
  assert.ok(requests.some((r) => r.method === 'GET' && r.search.includes(`eaten_on=eq.${localDay(y)}`)));
  assert.ok(await page.isVisible('#go-today'));
  await page.click('#go-today');
  await page.waitForFunction(() => document.querySelector('#day-label').textContent === 'Today');
  console.log('ok  day navigation');

  // 8. Reload: still signed in, no login screen.
  await page.reload();
  await page.waitForSelector('#app:not([hidden])');
  assert.match(await page.textContent('#meals'), /Turkey sandwich/);
  console.log('ok  stays signed in after reload');

  // 9. Error while a sheet is open is visible.
  await page.click('#open-add');
  await page.fill('[name=description]', 'x');
  await context.route(`${SB}/rest/v1/log_entries*`, (r) => r.request().method() === 'POST'
    ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"db down"}' }) : fakeSupabase(r));
  await page.click('#entry-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'db down');
  assert.ok(await page.evaluate(() => document.querySelector('#toast').matches(':popover-open')));
  await context.unroute(`${SB}/rest/v1/log_entries*`);
  await page.click('#entry [data-close]');
  errors.splice(errors.findIndex((e) => e.includes('500')), 1); // the expected failed request
  console.log('ok  errors show above an open sheet');

  // 10. Sign out.
  await page.click('#open-settings');
  await page.click('#sign-out');
  await page.waitForSelector('#login:not([hidden])');
  await page.reload();
  await page.waitForSelector('#login:not([hidden])');
  console.log('ok  sign out');

  const unexpected = errors.filter((e) => !e.includes('db down') && !e.includes('status of 400')); // 400 = the wrong-password attempt
  if (unexpected.length) console.log('console errors:', unexpected); assert.deepEqual(unexpected, [], 'console errors');
  await browser.close();
  console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
