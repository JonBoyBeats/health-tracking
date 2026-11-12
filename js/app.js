import * as db from './db.js';

const NUTRIENTS = [
  { key: 'calories', label: 'Calories', unit: '' },
  { key: 'protein', label: 'Protein', unit: 'g' },
  { key: 'carbs', label: 'Carbs', unit: 'g' },
  { key: 'fat', label: 'Fat', unit: 'g' },
  { key: 'fiber', label: 'Fiber', unit: 'g' },
];
const MEALS = [
  { key: 'breakfast', label: 'Breakfast' },
  { key: 'lunch', label: 'Lunch' },
  { key: 'dinner', label: 'Dinner' },
  { key: 'snack', label: 'Snacks' },
];

const state = { user: null, profiles: [], personId: null, day: localDay(new Date()), entries: [], editing: null };
const $ = (id) => document.getElementById(id);

// ---------- helpers ----------

function localDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shiftDay(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return localDay(new Date(y, m - 1, d + n));
}

function dayLabel(day) {
  const today = localDay(new Date());
  if (day === today) return 'Today';
  if (day === shiftDay(today, -1)) return 'Yesterday';
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function mealForNow() {
  const h = new Date().getHours();
  if (h < 11) return 'breakfast';
  if (h < 15) return 'lunch';
  if (h >= 17 && h < 21) return 'dinner';
  return 'snack';
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const round = (n) => Math.round(Number(n) || 0);
const num = (v) => (v === '' || v == null ? null : Number(v));
const caloriesFromMacros = (p, c, f) => 4 * (p || 0) + 4 * (c || 0) + 9 * (f || 0);
const profile = (id) => state.profiles.find((p) => p.id === id);

function totals(personId) {
  const t = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
  for (const e of state.entries) if (e.person_id === personId) for (const k in t) t[k] += Number(e[k]) || 0;
  return t;
}

function leftText(personId) {
  const p = profile(personId);
  const left = round(p.target_calories - totals(personId).calories);
  return left >= 0 ? `${p.name}: ${left} cal left` : `${p.name}: ${-left} cal over`;
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  // As a popover it sits in the top layer, so it also shows above an open sheet.
  if (el.showPopover && !el.matches(':popover-open')) el.showPopover();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
    if (el.hidePopover && el.matches(':popover-open')) el.hidePopover();
  }, 3500);
}

function fail(err) {
  console.error(err);
  toast(err?.message || 'Something went wrong');
}

// ---------- screens ----------

function show(id) {
  for (const s of ['setup', 'login', 'app']) $(s).hidden = s !== id;
}

async function start() {
  if (!db.configured) return show('setup');
  state.user = await db.currentUser();
  if (!state.user) return show('login');
  show('app');
  state.profiles = await db.listProfiles();
  state.personId = state.user.id;
  await loadDay();
}

async function loadDay() {
  state.entries = await db.listEntries(state.day);
  render();
}

function render() {
  $('people').innerHTML = state.profiles
    .map((p) => `<button data-person="${p.id}" aria-pressed="${p.id === state.personId}">${esc(p.name || 'Unnamed')}</button>`)
    .join('');

  $('day-label').textContent = dayLabel(state.day);
  $('go-today').hidden = state.day === localDay(new Date());

  const p = profile(state.personId);
  const t = totals(state.personId);
  const calLeft = round(p.target_calories - t.calories);
  $('left').innerHTML = `
    <div class="cal">
      <span class="big ${calLeft < 0 ? 'over' : ''}">${Math.abs(calLeft)}</span>
      <span class="muted">${calLeft < 0 ? 'cal over' : 'cal left'} · ${round(t.calories)} of ${round(p.target_calories)}</span>
    </div>
    ${NUTRIENTS.slice(1).map((n) => bar(n, t[n.key], p[`target_${n.key}`])).join('')}`;

  $('meals').innerHTML = MEALS.map((m) => {
    const items = state.entries.filter((e) => e.person_id === state.personId && e.meal === m.key);
    const cals = items.reduce((s, e) => s + Number(e.calories), 0);
    return `
      <section class="meal">
        <h3>${m.label}<span class="muted">${items.length ? `${round(cals)} cal` : ''}</span></h3>
        ${items.length ? items.map(entryRow).join('') : '<p class="empty">Nothing yet</p>'}
      </section>`;
  }).join('');
}

function bar(n, eaten, target) {
  const left = round(target - eaten);
  const pct = target > 0 ? Math.min(100, (eaten / target) * 100) : 0;
  return `
    <div class="bar ${n.key}">
      <div class="bar-head"><span>${n.label}</span>
        <span class="${left < 0 ? 'over' : 'muted'}">${left < 0 ? `${-left}g over` : `${left}g left`}</span></div>
      <div class="track"><div class="fill" style="width:${pct}%"></div></div>
    </div>`;
}

function entryRow(e) {
  return `
    <button class="entry" data-entry="${e.id}">
      <span class="desc">${esc(e.description)}${e.is_estimate ? ' <span class="badge">Estimate</span>' : ''}
        <span class="macros">P ${round(e.protein)} · C ${round(e.carbs)} · F ${round(e.fat)} · Fiber ${round(e.fiber)}</span></span>
      <span class="kcal">${round(e.calories)}</span>
    </button>`;
}

// ---------- add / edit ----------

function openEntry(entry) {
  state.editing = entry || null;
  const f = $('entry-form');
  f.reset();
  $('entry-title').textContent = entry ? 'Edit' : 'Add food';
  $('entry-delete').hidden = !entry;
  $('who-field').hidden = Boolean(entry);
  if (entry) {
    f.description.value = entry.description;
    for (const n of NUTRIENTS) f[n.key].value = round(entry[n.key]) || '';
    f.meal.value = entry.meal;
  } else {
    f.meal.value = mealForNow();
    const options = [...state.profiles.map((p) => ({ id: p.id, name: p.name || 'Unnamed' })), { id: 'both', name: 'Both' }];
    $('who').innerHTML = options
      .map((o) => `<button type="button" data-who="${o.id}" aria-pressed="${o.id === state.personId}">${esc(o.name)}</button>`)
      .join('');
  }
  updateCalcHint();
  $('entry').showModal();
}

function updateCalcHint() {
  const f = $('entry-form');
  const est = round(caloriesFromMacros(num(f.protein.value), num(f.carbs.value), num(f.fat.value)));
  $('calc-hint').textContent = f.calories.value === '' && est > 0 ? `Calories left blank: ${est} will be used, from the macros.` : '';
}

async function saveEntry() {
  const f = $('entry-form');
  const values = { description: f.description.value.trim(), meal: f.meal.value };
  for (const n of NUTRIENTS) values[n.key] = num(f[n.key].value) ?? 0;
  if (f.calories.value === '') values.calories = round(caloriesFromMacros(values.protein, values.carbs, values.fat));

  let people;
  if (state.editing) {
    await db.updateEntry(state.editing.id, values);
    people = [state.editing.person_id];
  } else {
    const who = $('who').querySelector('[aria-pressed="true"]').dataset.who;
    people = who === 'both' ? state.profiles.map((p) => p.id) : [who];
    await db.addEntries(people.map((id) => ({ ...values, person_id: id, eaten_on: state.day })));
  }
  $('entry').close();
  await loadDay();
  toast(people.map(leftText).join(' · '));
}

// ---------- settings ----------

function openSettings() {
  $('targets').innerHTML = state.profiles.map((p) => `
    <fieldset data-profile="${p.id}">
      <label>Name <input name="name" value="${esc(p.name)}" required></label>
      <div class="grid5">
        ${NUTRIENTS.map((n) => `<label>${n.label}${n.unit ? ` ${n.unit}` : ''}
          <input name="target_${n.key}" inputmode="decimal" value="${round(p[`target_${n.key}`])}" required></label>`).join('')}
      </div>
    </fieldset>`).join('');
  $('signed-in-as').textContent = state.user.email;
  $('settings').showModal();
}

async function saveSettings() {
  for (const fs of $('targets').querySelectorAll('fieldset')) {
    const fields = { name: fs.querySelector('[name="name"]').value.trim() };
    for (const n of NUTRIENTS) fields[`target_${n.key}`] = Number(fs.querySelector(`[name="target_${n.key}"]`).value) || 0;
    await db.updateProfile(fs.dataset.profile, fields);
  }
  $('settings').close();
  state.profiles = await db.listProfiles();
  render();
  toast('Targets saved');
}

// ---------- events ----------

$('login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  $('login-error').hidden = true;
  try {
    await db.signIn(f.email.value.trim(), f.password.value);
    await start();
  } catch (err) {
    $('login-error').textContent = err.message || 'Sign in failed';
    $('login-error').hidden = false;
  }
});

$('people').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-person]');
  if (!b) return;
  state.personId = b.dataset.person;
  render();
});

$('prev-day').addEventListener('click', () => { state.day = shiftDay(state.day, -1); loadDay().catch(fail); });
$('next-day').addEventListener('click', () => { state.day = shiftDay(state.day, 1); loadDay().catch(fail); });
$('go-today').addEventListener('click', () => { state.day = localDay(new Date()); loadDay().catch(fail); });

$('open-add').addEventListener('click', () => openEntry(null));
$('meals').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-entry]');
  if (b) openEntry(state.entries.find((e) => e.id === b.dataset.entry));
});

$('who').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-who]');
  if (!b) return;
  for (const x of $('who').children) x.setAttribute('aria-pressed', x === b);
});

$('entry-form').addEventListener('input', updateCalcHint);
$('entry-form').addEventListener('submit', (ev) => { ev.preventDefault(); saveEntry().catch(fail); });
$('entry-delete').addEventListener('click', async () => {
  if (!confirm(`Delete "${state.editing.description}"?`)) return;
  try {
    await db.deleteEntry(state.editing.id);
    $('entry').close();
    await loadDay();
    toast('Deleted');
  } catch (err) { fail(err); }
});

$('open-settings').addEventListener('click', openSettings);
$('settings-form').addEventListener('submit', (ev) => { ev.preventDefault(); saveSettings().catch(fail); });
$('sign-out').addEventListener('click', async () => {
  await db.signOut();
  $('settings').close();
  state.user = null;
  show('login');
});

for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => b.closest('dialog').close());

// Pick up anything the other person logged while the app was in the background.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.user) loadDay().catch(fail);
});

start().catch(fail);
