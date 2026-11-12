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
const OZ = 28.3495;

const state = {
  user: null, profiles: [], personId: null, day: localDay(new Date()), entries: [],
  editing: null,   // the log entry being edited, if any
  food: null,      // the food open in the amount sheet
  results: [],     // foods listed in the add sheet
  reader: null,    // the barcode scanner while the camera is on
  lastBarcode: null, // a barcode no source had, attached to a label photo taken next
  ai: [],          // the AI conversation so far (sent back with each answer)
  proposal: [],    // items the AI proposed, shown in the confirm sheet
  recipe: null,    // the recipe being built or edited
  recipeMode: false, // the add and amount sheets are picking a recipe ingredient
  weights: [],     // the shown person's weigh-ins, oldest first
  chart: null,     // the weight chart's points and scales, for the tooltip
};
const $ = (id) => document.getElementById(id);

// ---------- helpers ----------

function localDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const dateOf = (day) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d); };
const shortDate = (day) => dateOf(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

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

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const round = (n) => Math.round(Number(n) || 0);
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
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

// Open one sheet, closing any other.
function openSheet(id) {
  for (const d of document.querySelectorAll('dialog[open]')) if (d.id !== id) d.close();
  if (!$(id).open) $(id).showModal();
}

// "Who ate this?" buttons: each person, plus Both.
function renderWho(el, selected) {
  const options = [...state.profiles.map((p) => ({ id: p.id, name: p.name || 'Unnamed' })), { id: 'both', name: 'Both' }];
  el.innerHTML = options
    .map((o) => `<button type="button" data-who="${o.id}" aria-pressed="${o.id === selected}">${esc(o.name)}</button>`)
    .join('');
}

function chosenPeople(el) {
  const who = el.querySelector('[aria-pressed="true"]').dataset.who;
  return who === 'both' ? state.profiles.map((p) => p.id) : [who];
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

// "2 × 1 medium" for the day's log: serving names without their (sizes in parentheses).
function amountText(e) {
  if (!e.unit) return '';
  if (e.unit === 'g' || e.unit === 'oz') return `${round1(e.amount)} ${e.unit} · `;
  const unit = e.unit.replace(/\s*\([^)]*\)/g, '');
  return `${Number(e.amount) === 1 ? '' : `${round1(e.amount)} × `}${unit} · `;
}

function entryRow(e) {
  return `
    <button class="entry" data-entry="${e.id}">
      <span class="desc">${esc(e.description)}${e.is_estimate ? ' <span class="badge warn">Estimate</span>' : ''}
        <span class="macros">${esc(amountText(e))}P ${round(e.protein)} · C ${round(e.carbs)} · F ${round(e.fat)} · Fiber ${round(e.fiber)}</span></span>
      <span class="kcal">${round(e.calories)}</span>
    </button>`;
}

// ---------- foods ----------

// A saved row from the foods table, in the same shape the food function returns.
function fromSaved(row) {
  return {
    id: row.id, source: row.source, source_id: row.source_id, name: row.name, brand: row.brand, barcode: row.barcode,
    per100: Object.fromEntries(NUTRIENTS.map((n) => [n.key, Number(row[n.key]) || 0])),
    servings: row.servings || [], is_estimate: row.is_estimate, saved: true, checks: {},
    ingredients: row.ingredients || null,
  };
}

function toRow(f) {
  return {
    ...(f.id ? { id: f.id } : {}),
    name: f.name, brand: f.brand || null, barcode: f.barcode || null, source: f.source, source_id: f.source_id || null,
    ...f.per100, servings: f.servings, is_estimate: Boolean(f.is_estimate),
    ...(f.ingredients ? { ingredients: f.ingredients } : {}),
  };
}

const unitsFor = (f) => [...f.servings, { label: 'g', grams: 1 }, { label: 'oz', grams: OZ }];
const nutrientsFor = (f, grams) => Object.fromEntries(NUTRIENTS.map((n) => [n.key, (f.per100[n.key] * grams) / 100]));

function foodTitle(f) {
  return f.brand && !f.name.toLowerCase().includes(f.brand.toLowerCase()) ? `${f.name} (${f.brand})` : f.name;
}

function badges(f) {
  const out = [];
  if (f.source === 'recipe') out.push('<span class="badge">Recipe</span>');
  else if (f.saved) out.push('<span class="badge">Saved</span>');
  else out.push(`<span class="badge">${{ off: 'Open Food Facts', label: 'From label photo' }[f.source] || 'USDA'}</span>`);
  if (f.checks.sources_agree === true) out.push('<span class="badge good">✓ 2 sources agree</span>');
  if (f.checks.sources_agree === false) out.push('<span class="badge warn">Sources differ</span>');
  if (f.checks.calories_match === false) out.push('<span class="badge warn">Calories don\'t add up</span>');
  if (f.is_estimate) out.push('<span class="badge warn">Estimate</span>');
  return out.join(' ');
}

function resultRow(f, i) {
  const s = f.servings[0];
  const cals = s ? round((f.per100.calories * s.grams) / 100) : round(f.per100.calories);
  return `
    <button class="entry" data-result="${i}">
      <span class="desc">${esc(f.name)}
        <span class="macros">${f.brand ? `${esc(f.brand)} · ` : ''}${esc(s ? s.label : '100 g')}</span>
        <span>${badges(f)}</span></span>
      <span class="kcal">${cals}</span>
    </button>`;
}

function renderResults(heading, note = '') {
  $('results-heading').textContent = heading;
  $('results-heading').hidden = !heading;
  $('results-note').textContent = note;
  $('results').innerHTML = state.results.map(resultRow).join('');
}

// ---------- add sheet: recent foods, search, barcode ----------

async function openAdd(forRecipe = false) {
  state.editing = null;
  state.lastBarcode = null;
  state.recipeMode = forRecipe;
  for (const id of ['ai-form', 'add-divider', 'open-quick', 'label-link', 'open-recipe']) $(id).hidden = forRecipe;
  $('add-title').hidden = !forRecipe;
  $('food-q').value = '';
  openSheet('add');
  await showRecent();
}

async function showRecent() {
  state.results = (await db.recentFoods()).map(fromSaved);
  renderResults(state.results.length ? 'Recent' : '', state.results.length ? '' : 'Search for a food or scan a barcode.');
}

let searchToken = 0;
let searchTimer;

async function runSearch(text) {
  const token = ++searchToken;
  text = text.trim();
  if (text.length < 2) return showRecent();
  const saved = (await db.searchSavedFoods(text)).map(fromSaved);
  if (token !== searchToken) return;
  state.results = saved;
  renderResults('Results', 'Searching USDA…');
  try {
    const { results } = await db.lookup({ action: 'search', query: text });
    if (token !== searchToken) return;
    const isSaved = (r) => saved.some((s) => s.source === r.source && s.source_id === r.source_id);
    state.results = [...saved, ...results.filter((r) => !isSaved(r))];
    renderResults('Results', state.results.length ? '' : 'No matches. Try other words, scan the barcode, or use Quick add.');
  } catch (err) {
    if (token === searchToken) renderResults('Results', err.message);
  }
}

async function lookupBarcode(code) {
  code = code.replace(/\D/g, '');
  if (code.length < 8) return toast('That doesn\'t look like a full barcode');
  openSheet('add');
  $('food-q').value = '';
  state.results = [];
  renderResults('', `Looking up ${code}…`);
  try {
    const saved = await db.savedFoodByBarcode(code);
    if (saved) return openFood(fromSaved(saved));
    const { results } = await db.lookup({ action: 'barcode', code });
    if (results.length === 1) return openFood(results[0]);
    state.results = results;
    state.lastBarcode = results.length ? null : code;
    renderResults(
      results.length ? `Barcode ${code}` : '',
      results.length
        ? 'The two sources list different numbers for this product. Compare with the label and pick the one that matches.'
        : `Barcode ${code} isn't in USDA or Open Food Facts. Tap "Snap a label" to read the nutrition label, or search by name.`,
    );
  } catch (err) {
    renderResults('', err.message);
  }
}

// ---------- AI logging ----------

function renderChat(lines) {
  $('ai-chat').innerHTML = lines.map((l) => `<p class="bubble ${l.who}">${esc(l.text)}</p>`).join('');
  $('ai-chat').hidden = !lines.length;
}

let chatLines = [];

function resetAi() {
  state.ai = [];
  chatLines = [];
  renderChat(chatLines);
  $('ai-text').value = '';
  $('ai-text').placeholder = 'What did you eat? e.g. 2 eggs and toast with butter';
  $('ai-send').textContent = 'Log it';
  $('ai-reset').hidden = true;
  $('ai-status').textContent = '';
}

async function sendAi() {
  const text = $('ai-text').value.trim();
  if (!text || $('ai-send').disabled) return;
  chatLines.push({ who: 'me', text });
  renderChat(chatLines);
  $('ai-text').value = '';
  $('ai-send').disabled = true;
  $('ai-status').textContent = 'Working it out…';
  try {
    const res = await db.assist({
      action: 'chat', text, messages: state.ai,
      context: { people: state.profiles.map((p) => ({ id: p.id, name: p.name || 'Unnamed' })), me: state.user.id, forPerson: state.personId, meal: mealForNow() },
    });
    $('ai-status').textContent = '';
    if (res.type === 'question') {
      state.ai = res.messages;
      chatLines.push({ who: 'ai', text: res.question });
      renderChat(chatLines);
      $('ai-text').placeholder = 'Your answer';
      $('ai-send').textContent = 'Answer';
      $('ai-reset').hidden = false;
      $('ai-text').focus();
    } else {
      resetAi();
      openConfirm(res.items);
    }
  } catch (err) {
    chatLines.pop(); // let them send it again
    renderChat(chatLines);
    $('ai-text').value = text;
    $('ai-status').textContent = err.message;
  } finally {
    $('ai-send').disabled = false;
  }
}

// ---------- confirm sheet (AI proposals) ----------

function openConfirm(items) {
  state.proposal = items.map((it) => {
    if (!it.food) return { ...it };
    const units = unitsFor(it.food);
    const unitIndex = Math.max(0, units.findIndex((u) => u.label === it.unit));
    return { ...it, unitIndex, amount: it.amount };
  });
  $('confirm-form').meal.value = mealForNow();
  renderConfirm();
  openSheet('confirm');
}

function itemNutrients(it) {
  if (!it.food) return it.estimate;
  const unit = unitsFor(it.food)[it.unitIndex];
  return nutrientsFor(it.food, (Number(it.amount) || 0) * unit.grams);
}

function renderConfirm() {
  const groups = state.profiles.filter((p) => state.proposal.some((it) => it.person_id === p.id));
  $('confirm-items').innerHTML = groups.map((p) => `
    <h3 class="list-heading">${esc(p.name)}</h3>
    ${state.proposal.map((it, i) => (it.person_id === p.id ? confirmRow(it, i) : '')).join('')}`).join('')
    || '<p class="hint">Nothing left to save.</p>';
  updateConfirmTotals();
}

function confirmRow(it, i) {
  const title = it.food ? foodTitle(it.food) : it.name;
  const amount = it.food
    ? `<div class="row">
        <input class="amount-in" data-amount="${i}" inputmode="decimal" value="${round1(it.amount)}" aria-label="Amount">
        <select class="grow" data-unit="${i}" aria-label="Unit">${unitsFor(it.food).map((u, j) => `<option value="${j}" ${j === it.unitIndex ? 'selected' : ''}>${esc(u.label)}</option>`).join('')}</select>
      </div>`
    : `<div class="macros">${esc(`${round1(it.amount)} × ${it.unit}`)}</div>`;
  return `
    <div class="citem">
      <div class="citem-head">
        <span class="desc">${esc(title)} <span>${it.food ? badges(it.food) : '<span class="badge warn">Estimate</span>'}</span></span>
        <button type="button" class="icon" data-remove="${i}" aria-label="Remove ${esc(title)}">×</button>
      </div>
      ${amount}
      <div class="macros" data-item-macros="${i}"></div>
    </div>`;
}

function updateConfirmTotals() {
  state.proposal.forEach((it, i) => {
    const n = itemNutrients(it);
    const el = document.querySelector(`[data-item-macros="${i}"]`);
    if (el) el.textContent = `${round(n.calories)} cal · P ${round(n.protein)} · C ${round(n.carbs)} · F ${round(n.fat)} · Fiber ${round(n.fiber)}`;
  });
  const people = [...new Set(state.proposal.map((it) => it.person_id))];
  $('confirm-after').textContent = people.length ? 'After this: ' + people.map((id) => {
    const p = profile(id);
    const t = totals(id);
    const add = state.proposal.filter((it) => it.person_id === id).map(itemNutrients)
      .reduce((a, n) => ({ calories: a.calories + n.calories, protein: a.protein + n.protein }), { calories: 0, protein: 0 });
    const cal = round(p.target_calories - t.calories - add.calories);
    const pro = round(p.target_protein - t.protein - add.protein);
    return `${p.name} ${cal < 0 ? `${-cal} cal over` : `${cal} cal left`}, ${pro < 0 ? `${-pro}g protein over` : `${pro}g protein left`}`;
  }).join(' · ') : '';
}

async function saveProposal() {
  if (!state.proposal.length) return $('confirm').close();
  const meal = $('confirm-form').meal.value;
  const saved = new Map(); // one row per food, even when both people ate it
  const rows = [];
  for (const it of state.proposal) {
    const n = itemNutrients(it);
    const row = { person_id: it.person_id, eaten_on: state.day, meal, amount: round1(it.amount) };
    for (const k in n) row[k] = round1(n[k]);
    if (it.food) {
      const key = it.food.id || `${it.food.source}:${it.food.source_id}`;
      if (!saved.has(key)) saved.set(key, await db.saveFood(toRow(it.food)));
      const unit = unitsFor(it.food)[it.unitIndex];
      Object.assign(row, {
        description: foodTitle(it.food), food_id: saved.get(key).id, unit: unit.label,
        grams: round1((Number(it.amount) || 0) * unit.grams), is_estimate: Boolean(it.food.is_estimate),
      });
    } else {
      Object.assign(row, { description: it.name, unit: it.unit, is_estimate: true });
    }
    rows.push(row);
  }
  await db.addEntries(rows);
  const people = [...new Set(rows.map((r) => r.person_id))];
  state.proposal = [];
  $('confirm').close();
  await loadDay();
  toast(people.map(leftText).join(' · '));
}

// ---------- nutrition label photos ----------

// Shrinks a photo to a JPEG of at most `max` pixels on its long side, as base64.
async function photoToJpeg(file, max = 1600) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Couldn\'t open that photo'));
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85).split(',')[1];
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function readLabelPhoto(file) {
  state.results = [];
  renderResults('', 'Reading the label…');
  try {
    const image = await photoToJpeg(file);
    const { result } = await db.assist({ action: 'label', image, mediaType: 'image/jpeg', barcode: state.lastBarcode });
    if (!result.name) result.name = (prompt('What is this product called?') || '').trim() || 'Food from label';
    renderResults('', '');
    await openFood(result);
  } catch (err) {
    renderResults('', err.message);
  }
}

// ---------- recipes ----------
// A recipe is saved as a food (source 'recipe') with "1 serving" and "whole recipe" sizes, so
// search, Recent and AI logging find it like any other food. Its ingredients are kept for editing.

const NKEYS = ['calories', 'protein', 'carbs', 'fat', 'fiber'];

function ingredient(food, amount, unit, grams) {
  const n = nutrientsFor(food, grams);
  const it = { food, food_id: food.saved ? food.id : null, name: foodTitle(food), amount: round1(amount), unit, grams: round1(grams) };
  for (const k of NKEYS) it[k] = round1(n[k]);
  return it;
}

// Grams and nutrients for one unit of an ingredient, so changing its amount scales cleanly.
function perUnit(it) {
  if (!it.per) {
    const a = Number(it.amount) || 1;
    it.per = { grams: it.grams / a };
    for (const k of NKEYS) it.per[k] = it[k] / a;
  }
  return it.per;
}

function recipeTotals() {
  const t = { grams: 0, calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
  for (const it of state.recipe.ingredients) for (const k in t) t[k] += Number(it[k]) || 0;
  return t;
}

function newRecipe() {
  state.recipe = { id: null, name: '', servings: 4, ingredients: [] };
  showRecipe();
}

function editRecipe(food) {
  const ingredients = (food.ingredients || []).map((i) => ({ ...i }));
  const total = ingredients.reduce((g, i) => g + Number(i.grams), 0);
  const serving = food.servings[0]?.grams || total;
  state.recipe = { id: food.id, name: food.name, servings: round1(total / serving) || 1, ingredients };
  showRecipe();
}

function showRecipe() {
  const f = $('recipe-form');
  state.recipeMode = true;
  f.name.value = state.recipe.name;
  f.servings.value = state.recipe.servings;
  $('recipe-title').textContent = state.recipe.id ? 'Edit recipe' : 'New recipe';
  $('recipe-delete').hidden = !state.recipe.id;
  renderRecipe();
  openSheet('recipe');
}

function renderRecipe() {
  $('recipe-items').innerHTML = state.recipe.ingredients.map((it, i) => `
    <div class="citem">
      <div class="citem-head">
        <span class="desc">${esc(it.name)}</span>
        <button type="button" class="icon" data-rremove="${i}" aria-label="Remove ${esc(it.name)}">×</button>
      </div>
      <div class="row">
        <input class="amount-in" data-ramount="${i}" inputmode="decimal" value="${round1(it.amount)}" aria-label="Amount">
        <span class="macros grow">× ${esc(it.unit)}</span>
      </div>
      <div class="macros" data-ritem="${i}"></div>
    </div>`).join('') || '<p class="hint">No ingredients yet.</p>';
  updateRecipeTotals();
}

function updateRecipeTotals() {
  state.recipe.ingredients.forEach((it, i) => {
    const el = document.querySelector(`[data-ritem="${i}"]`);
    if (el) el.textContent = `${round(it.calories)} cal · P ${round(it.protein)} · C ${round(it.carbs)} · F ${round(it.fat)} · Fiber ${round(it.fiber)}`;
  });
  const t = recipeTotals();
  const servings = Number($('recipe-form').servings.value) || 0;
  $('recipe-totals').innerHTML = t.grams > 0 && servings > 0 ? `
    <span class="big">${round(t.calories / servings)}</span> <span class="muted">cal per serving · ${round(t.grams / servings)} g</span>
    <div class="macros">P ${round(t.protein / servings)} · C ${round(t.carbs / servings)} · F ${round(t.fat / servings)} · Fiber ${round(t.fiber / servings)}</div>
    <div class="macros">Whole recipe: ${round(t.calories)} cal, ${round(t.grams)} g</div>` : '<span class="muted">Add ingredients and the number of servings.</span>';
}

async function saveRecipe() {
  const f = $('recipe-form');
  const r = state.recipe;
  r.name = f.name.value.trim();
  r.servings = Number(f.servings.value);
  const t = recipeTotals();
  if (!r.name) return toast('Give the recipe a name');
  if (!(r.servings > 0)) return toast('Enter the number of servings');
  if (!(t.grams > 0)) return toast('Add at least one ingredient');

  // Ingredients picked from search or the AI join the saved food list too.
  for (const it of r.ingredients) {
    if (!it.food_id && it.food) it.food_id = (await db.saveFood(toRow(it.food))).id;
  }
  const ingredients = r.ingredients.map((it) => {
    const row = { food_id: it.food_id || null, name: it.name, amount: round1(it.amount), unit: it.unit, grams: round1(it.grams) };
    for (const k of NKEYS) row[k] = round1(it[k]);
    return row;
  });
  const serving = t.grams / r.servings;
  await db.saveFood(toRow({
    id: r.id, name: r.name, brand: null, barcode: null, source: 'recipe', source_id: null,
    per100: Object.fromEntries(NKEYS.map((k) => [k, round1((t[k] * 100) / t.grams)])),
    servings: [
      { label: `1 serving (${round(serving)} g)`, grams: round1(serving) },
      { label: `whole recipe (${round(t.grams)} g)`, grams: round1(t.grams) },
    ],
    is_estimate: false, ingredients,
  }));
  state.recipe = null;
  toast('Recipe saved');
  await openAdd();
}

async function fillRecipeWithAi() {
  const text = $('recipe-text').value.trim();
  if (!text) return;
  $('recipe-ai').disabled = true;
  $('recipe-status').textContent = 'Reading the recipe…';
  try {
    const res = await db.assist({ action: 'recipe', text });
    const f = $('recipe-form');
    if (!f.name.value.trim()) f.name.value = res.name;
    f.servings.value = res.servings;
    state.recipe.name = f.name.value;
    state.recipe.servings = res.servings;
    state.recipe.ingredients.push(...res.ingredients.map((i) => ingredient(i.food, i.amount, i.unit, i.grams)));
    $('recipe-text').value = '';
    $('recipe-paste').open = false;
    $('recipe-status').textContent = '';
    renderRecipe();
    if (res.skipped.length) toast(`Couldn't find: ${res.skipped.join(', ')}. Add them by hand if they matter.`);
  } catch (err) {
    $('recipe-status').textContent = err.message;
  } finally {
    $('recipe-ai').disabled = false;
  }
}

// ---------- weight ----------

// Trend: an exponentially smoothed average (each weigh-in moves it 10% of the way), so day-to-day
// water swings don't hide the real direction.
function withTrend(ws) {
  let t = null;
  return ws.map((w) => {
    t = t == null ? w.pounds : t + 0.1 * (w.pounds - t);
    return { ...w, trend: t };
  });
}

async function openWeight() {
  const p = profile(state.personId);
  $('weight-person').textContent = p.name;
  const label = dayLabel(state.day);
  $('weight-day').textContent = label === 'Today' || label === 'Yesterday' ? label.toLowerCase() : label;
  state.weights = (await db.listWeights(state.personId)).map((w) => ({ day: w.measured_on, pounds: Number(w.pounds) }));
  const existing = state.weights.find((w) => w.day === state.day);
  $('weight-form').pounds.value = existing ? existing.pounds : '';
  openSheet('weight');
  renderWeight();
}

function renderWeight() {
  const pts = withTrend(state.weights);
  const last = pts.at(-1);
  if (!last) {
    $('weight-hero').innerHTML = '<p class="hint">No weigh-ins yet. Weigh in at the same time each day, like first thing in the morning; the trend line smooths out daily swings.</p>';
  } else {
    // Weekly rate: trend now vs. trend about two weeks earlier.
    const before = [...pts].reverse().find((p) => (dateOf(last.day) - dateOf(p.day)) / 864e5 >= 13);
    let rate = '';
    if (before) {
      const perWeek = ((last.trend - before.trend) / ((dateOf(last.day) - dateOf(before.day)) / 864e5)) * 7;
      rate = Math.abs(perWeek) < 0.1 ? 'Steady' : `${perWeek < 0 ? 'Losing' : 'Gaining'} ${Math.abs(perWeek).toFixed(1)} lb/week`;
    }
    $('weight-hero').innerHTML = `
      <span class="big">${last.trend.toFixed(1)}</span> <span class="muted">lb trend</span>
      <div class="macros">${rate ? `${rate} · ` : ''}Last weigh-in ${last.pounds.toFixed(1)} lb, ${shortDate(last.day)}</div>`;
  }
  $('weight-chart').innerHTML = weightChart(pts, state.day);
  $('weight-list').innerHTML = [...pts].reverse().slice(0, 14).map((p) => `
    <div class="wrow">
      <span>${esc(shortDate(p.day))}</span>
      <span><b>${p.pounds.toFixed(1)}</b> lb</span>
      <span class="muted">trend ${p.trend.toFixed(1)}</span>
      <button type="button" class="icon" data-wdelete="${p.day}" aria-label="Delete ${esc(shortDate(p.day))}">×</button>
    </div>`).join('');
}

// Last 30 days: weigh-ins as dots, the trend as a line. Tap or hover for values.
function weightChart(pts, endDay) {
  const start = shiftDay(endDay, -29);
  const shown = pts.filter((p) => p.day >= start && p.day <= endDay);
  state.chart = null;
  if (!shown.length) return pts.length ? '<p class="hint">No weigh-ins in the 30 days up to this date.</p>' : '';
  const W = Math.max(280, $('weight-chart').clientWidth || 320), H = 190;
  const pad = { l: 34, r: 10, t: 10, b: 24 };
  const vals = shown.flatMap((p) => [p.pounds, p.trend]);
  let lo = Math.floor(Math.min(...vals) - 0.5), hi = Math.ceil(Math.max(...vals) + 0.5);
  if (hi - lo < 4) { const mid = (hi + lo) / 2; lo = Math.floor(mid - 2); hi = Math.ceil(mid + 2); }
  const x = (day) => pad.l + ((dateOf(day) - dateOf(start)) / 864e5 / 29) * (W - pad.l - pad.r);
  const y = (v) => pad.t + ((hi - v) / (hi - lo)) * (H - pad.t - pad.b);
  const ticks = [lo, Math.round((lo + hi) / 2), hi];
  state.chart = { shown, x, y, H, pad };
  return `
    <div class="legend"><span><i class="key-dot"></i>Weigh-ins</span><span><i class="key-line"></i>Trend</span></div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Weight, last 30 days: weigh-ins and trend">
      ${ticks.map((t) => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join('')}
      <text class="tick" x="${pad.l}" y="${H - 6}">${esc(shortDate(start))}</text>
      <text class="tick" x="${W - pad.r}" y="${H - 6}" text-anchor="end">${esc(shortDate(endDay))}</text>
      <line id="wx" class="crosshair" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/>
      <path class="trend" d="${shown.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(1)} ${y(p.trend).toFixed(1)}`).join(' ')}"/>
      ${shown.map((p) => `<circle class="weigh" cx="${x(p.day).toFixed(1)}" cy="${y(p.pounds).toFixed(1)}" r="4"/>`).join('')}
    </svg>
    <div id="wtip" class="tip" hidden></div>`;
}

function showWeightTip(ev) {
  const c = state.chart;
  const svg = $('weight-chart').querySelector('svg');
  if (!c || !svg) return;
  const box = svg.getBoundingClientRect();
  const px = ((ev.clientX - box.left) / box.width) * svg.viewBox.baseVal.width;
  const p = c.shown.reduce((a, b) => (Math.abs(c.x(b.day) - px) < Math.abs(c.x(a.day) - px) ? b : a));
  const cx = c.x(p.day);
  const line = $('wx');
  line.setAttribute('x1', cx);
  line.setAttribute('x2', cx);
  line.setAttribute('visibility', 'visible');
  const tip = $('wtip');
  tip.innerHTML = `<b>${esc(shortDate(p.day))}</b> · ${p.pounds.toFixed(1)} lb · trend ${p.trend.toFixed(1)}`;
  tip.hidden = false;
  const left = (cx / svg.viewBox.baseVal.width) * box.width;
  tip.style.left = `${Math.min(Math.max(left - tip.offsetWidth / 2, 0), box.width - tip.offsetWidth)}px`;
}

function hideWeightTip() {
  $('wx')?.setAttribute('visibility', 'hidden');
  if ($('wtip')) $('wtip').hidden = true;
}

async function saveWeight() {
  const pounds = Number($('weight-form').pounds.value);
  if (!(pounds > 50 && pounds < 1000)) return toast('Enter a weight in pounds');
  await db.saveWeight(state.personId, state.day, round1(pounds));
  state.weights = (await db.listWeights(state.personId)).map((w) => ({ day: w.measured_on, pounds: Number(w.pounds) }));
  renderWeight();
  toast('Weight saved');
}

// ---------- scanner ----------

async function loadScanner() {
  if (window.ZXing) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/zxing-library-0.21.3.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the scanner'));
    document.head.append(s);
  });
}

function newReader() {
  const { BarcodeFormat: F, DecodeHintType, BrowserMultiFormatReader } = window.ZXing;
  const hints = new Map([[DecodeHintType.POSSIBLE_FORMATS, [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E]]]);
  return new BrowserMultiFormatReader(hints);
}

async function openScanner() {
  openSheet('scanner');
  $('scan-code').value = '';
  $('scan-status').textContent = 'Starting the camera…';
  try {
    await loadScanner();
    stopScanner();
    const reader = newReader();
    state.reader = reader;
    await reader.decodeFromConstraints({ video: { facingMode: 'environment' } }, $('scan-video'), (result) => {
      if (result && state.reader === reader) scanned(result.getText());
    });
    $('scan-status').textContent = 'Point the camera at the barcode.';
  } catch (err) {
    console.error(err);
    $('scan-status').textContent = 'The camera isn\'t available. Take a photo of the barcode or type its number instead.';
  }
}

function stopScanner() {
  state.reader?.reset();
  state.reader = null;
}

function scanned(code) {
  stopScanner();
  lookupBarcode(code);
}

async function scanPhoto(file) {
  $('scan-status').textContent = 'Reading the photo…';
  const url = URL.createObjectURL(file);
  try {
    await loadScanner();
    stopScanner();
    const result = await newReader().decodeFromImageUrl(url);
    scanned(result.getText());
  } catch {
    $('scan-status').textContent = 'Couldn\'t find a barcode in that photo. Try again closer up, or type the number.';
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- amount sheet ----------

async function openFood(food, entry = null) {
  state.food = food;
  state.editing = entry;
  const f = $('food-form');
  $('food-name').textContent = foodTitle(food);
  $('food-badges').innerHTML = badges(food);
  const forRecipe = state.recipeMode && !entry;
  $('food-delete').hidden = !entry;
  $('food-back').textContent = entry ? 'Cancel' : 'Back';
  $('food-who-field').hidden = Boolean(entry) || forRecipe;
  $('food-meal-field').hidden = forRecipe;
  $('food-after').hidden = forRecipe;
  $('food-save').textContent = forRecipe ? 'Add to recipe' : 'Save';
  $('food-edit-recipe').hidden = !(food.source === 'recipe' && food.saved && !forRecipe);
  if (!entry && !forRecipe) renderWho($('food-who'), state.personId);
  f.meal.value = entry ? entry.meal : mealForNow();
  fillUnits(entry);
  updateFoodPreview();
  openSheet('food');

  // USDA search results leave out household portions (1 cup, 1 medium...); fetch them.
  if (food.source === 'usda' && !food.saved && !(food.kind === 'label' && food.servings.length)) {
    try {
      const { result } = await db.lookup({ action: 'details', id: food.source_id });
      if (state.food !== food || !result.servings.length) return;
      const hadServing = food.servings.length > 0;
      food.servings = result.servings;
      if (!hadServing) fillUnits(null);
      else fillUnits({ amount: f.amount.value, unit: unitsFor(food)[f.unit.value]?.label });
      updateFoodPreview();
    } catch (err) {
      console.error(err);
    }
  }
}

// The unit list: the food's servings, then g and oz. Keeps the chosen amount and unit when possible.
function fillUnits(chosen) {
  const f = $('food-form');
  const units = unitsFor(state.food);
  f.unit.innerHTML = units.map((u, i) => `<option value="${i}">${esc(u.label)}</option>`).join('');
  let i = chosen ? units.findIndex((u) => u.label === chosen.unit) : -1;
  if (i >= 0) {
    f.amount.value = round1(chosen.amount);
  } else if (chosen?.grams) {
    i = units.length - 2;
    f.amount.value = round1(chosen.grams);
  } else if (state.food.servings.length) {
    i = 0;
    f.amount.value = 1;
  } else {
    i = units.length - 2;
    f.amount.value = 100;
  }
  f.unit.value = i;
}

function foodAmount() {
  const f = $('food-form');
  const unit = unitsFor(state.food)[f.unit.value];
  const amount = Number(f.amount.value) || 0;
  return { amount, unit, grams: amount * unit.grams };
}

function updateFoodPreview() {
  const { grams } = foodAmount();
  const n = nutrientsFor(state.food, grams);
  $('food-macros').innerHTML = `
    <span class="big">${round(n.calories)}</span> <span class="muted">cal · ${round(grams)} g</span>
    <div class="macros">P ${round(n.protein)} · C ${round(n.carbs)} · F ${round(n.fat)} · Fiber ${round(n.fiber)}</div>`;
  if (state.recipeMode && !state.editing) return;

  const people = state.editing ? [state.editing.person_id] : chosenPeople($('food-who'));
  $('food-after').textContent = 'After this: ' + people.map((id) => {
    const p = profile(id);
    const t = totals(id);
    const already = state.editing ? Number(state.editing.calories) : 0;
    const alreadyP = state.editing ? Number(state.editing.protein) : 0;
    const cal = round(p.target_calories - (t.calories - already + n.calories));
    const pro = round(p.target_protein - (t.protein - alreadyP + n.protein));
    return `${p.name} ${cal < 0 ? `${-cal} cal over` : `${cal} cal left`}, ${pro < 0 ? `${-pro}g protein over` : `${pro}g protein left`}`;
  }).join(' · ');
}

async function saveFoodEntry() {
  const f = $('food-form');
  const { amount, unit, grams } = foodAmount();
  if (!(grams > 0)) return toast('Enter an amount');
  if (state.recipeMode && !state.editing) {
    state.recipe.ingredients.push(ingredient(state.food, amount, unit.label, grams));
    return showRecipe();
  }
  const row = await db.saveFood(toRow(state.food));
  const n = nutrientsFor(state.food, grams);
  const values = {
    description: foodTitle(state.food), meal: f.meal.value, food_id: row.id,
    amount: round1(amount), unit: unit.label, grams: round1(grams), is_estimate: Boolean(state.food.is_estimate),
  };
  for (const k in n) values[k] = round1(n[k]);

  let people;
  if (state.editing) {
    await db.updateEntry(state.editing.id, values);
    people = [state.editing.person_id];
  } else {
    people = chosenPeople($('food-who'));
    await db.addEntries(people.map((id) => ({ ...values, person_id: id, eaten_on: state.day })));
  }
  $('food').close();
  await loadDay();
  toast(people.map(leftText).join(' · '));
}

// ---------- quick add / edit by numbers ----------

function openEntry(entry, description = '') {
  state.editing = entry || null;
  const f = $('entry-form');
  f.reset();
  $('entry-title').textContent = entry ? 'Edit' : 'Quick add';
  $('entry-delete').hidden = !entry;
  $('who-field').hidden = Boolean(entry);
  if (entry) {
    f.description.value = entry.description;
    for (const n of NUTRIENTS) f[n.key].value = round1(entry[n.key]) || '';
    f.meal.value = entry.meal;
  } else {
    f.description.value = description;
    f.meal.value = mealForNow();
    renderWho($('who'), state.personId);
  }
  updateCalcHint();
  openSheet('entry');
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
    people = chosenPeople($('who'));
    await db.addEntries(people.map((id) => ({ ...values, person_id: id, eaten_on: state.day })));
  }
  $('entry').close();
  await loadDay();
  toast(people.map(leftText).join(' · '));
}

async function deleteEditing(sheet) {
  if (!confirm(`Delete "${state.editing.description}"?`)) return;
  try {
    await db.deleteEntry(state.editing.id);
    $(sheet).close();
    await loadDay();
    toast('Deleted');
  } catch (err) { fail(err); }
}

async function editEntry(entry) {
  if (!entry.food_id) return openEntry(entry);
  try {
    await openFood(fromSaved(await db.getFood(entry.food_id)), entry);
  } catch {
    openEntry(entry); // the food was deleted: edit the numbers instead
  }
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
  openSheet('settings');
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

$('meals').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-entry]');
  if (b) editEntry(state.entries.find((e) => e.id === b.dataset.entry));
});

// Who-ate-this buttons behave like radio buttons.
document.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-who]');
  if (!b) return;
  for (const x of b.parentElement.children) x.setAttribute('aria-pressed', x === b);
  if ($('food').open) updateFoodPreview();
});

// Add sheet
$('open-add').addEventListener('click', () => openAdd(false).catch(fail));
$('food-q').addEventListener('input', (ev) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(ev.target.value).catch(fail), 400);
});
$('search-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  clearTimeout(searchTimer);
  runSearch($('food-q').value).catch(fail);
});
$('results').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-result]');
  if (b) openFood(state.results[b.dataset.result]).catch(fail);
});
$('open-scanner').addEventListener('click', () => openScanner());
$('open-quick').addEventListener('click', () => openEntry(null, $('food-q').value.trim()));

// AI logging
$('ai-form').addEventListener('submit', (ev) => { ev.preventDefault(); sendAi(); });
$('ai-text').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendAi(); }
});
$('ai-reset').addEventListener('click', resetAi);

// Label photo
$('label-photo').addEventListener('change', (ev) => {
  if (ev.target.files[0]) readLabelPhoto(ev.target.files[0]);
  ev.target.value = '';
});

// Recipes
$('open-recipe').addEventListener('click', newRecipe);
$('add-close').addEventListener('click', () => (state.recipeMode ? showRecipe() : $('add').close()));
$('food-edit-recipe').addEventListener('click', () => editRecipe(state.food));
$('recipe-add').addEventListener('click', () => {
  state.recipe.name = $('recipe-form').name.value;
  state.recipe.servings = $('recipe-form').servings.value;
  openAdd(true).catch(fail);
});
$('recipe-items').addEventListener('input', (ev) => {
  const i = ev.target.dataset.ramount;
  if (i == null) return;
  const it = state.recipe.ingredients[i];
  const per = perUnit(it);
  it.amount = Number(ev.target.value) || 0;
  it.grams = per.grams * it.amount;
  for (const k of NKEYS) it[k] = per[k] * it.amount;
  updateRecipeTotals();
});
$('recipe-items').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-rremove]');
  if (!b) return;
  state.recipe.ingredients.splice(Number(b.dataset.rremove), 1);
  renderRecipe();
});
$('recipe-form').servings.addEventListener('input', updateRecipeTotals);
$('recipe-ai').addEventListener('click', fillRecipeWithAi);
$('recipe-form').addEventListener('submit', (ev) => { ev.preventDefault(); saveRecipe().catch(fail); });
$('recipe-cancel').addEventListener('click', () => {
  state.recipeMode = false;
  state.recipe = null;
  $('recipe').close();
});
$('recipe-delete').addEventListener('click', async () => {
  if (!confirm(`Delete the recipe "${state.recipe.name}"? Days it was logged on keep their numbers.`)) return;
  try {
    await db.deleteFood(state.recipe.id);
    state.recipe = null;
    toast('Recipe deleted');
    await openAdd();
  } catch (err) { fail(err); }
});

// Weight
$('open-weight').addEventListener('click', () => openWeight().catch(fail));
$('weight-form').addEventListener('submit', (ev) => { ev.preventDefault(); saveWeight().catch(fail); });
$('weight-chart').addEventListener('pointermove', showWeightTip);
$('weight-chart').addEventListener('pointerdown', showWeightTip);
$('weight-chart').addEventListener('pointerleave', (ev) => { if (ev.pointerType === 'mouse') hideWeightTip(); });
$('weight-list').addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-wdelete]');
  if (!b || !confirm(`Delete the weigh-in for ${shortDate(b.dataset.wdelete)}?`)) return;
  try {
    await db.deleteWeight(state.personId, b.dataset.wdelete);
    state.weights = state.weights.filter((w) => w.day !== b.dataset.wdelete);
    renderWeight();
  } catch (err) { fail(err); }
});

// Confirm sheet
$('confirm-items').addEventListener('input', (ev) => {
  const i = ev.target.dataset.amount ?? ev.target.dataset.unit;
  if (i == null) return;
  if (ev.target.dataset.amount != null) state.proposal[i].amount = ev.target.value;
  else state.proposal[i].unitIndex = Number(ev.target.value);
  updateConfirmTotals();
});
$('confirm-items').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-remove]');
  if (!b) return;
  state.proposal.splice(Number(b.dataset.remove), 1);
  renderConfirm();
});
$('confirm-form').addEventListener('submit', (ev) => { ev.preventDefault(); saveProposal().catch(fail); });
$('confirm-back').addEventListener('click', () => openSheet('add'));

// Scanner
$('scanner').addEventListener('close', stopScanner);
$('scan-photo').addEventListener('change', (ev) => {
  if (ev.target.files[0]) scanPhoto(ev.target.files[0]);
  ev.target.value = '';
});
$('scan-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  stopScanner();
  lookupBarcode($('scan-code').value);
});

// Amount sheet
$('food-form').addEventListener('input', updateFoodPreview);
$('food-form').addEventListener('submit', (ev) => { ev.preventDefault(); saveFoodEntry().catch(fail); });
$('food-back').addEventListener('click', () => (state.editing ? $('food').close() : openSheet('add')));
$('food-delete').addEventListener('click', () => deleteEditing('food'));

// Quick add / edit sheet
$('entry-form').addEventListener('input', updateCalcHint);
$('entry-form').addEventListener('submit', (ev) => { ev.preventDefault(); saveEntry().catch(fail); });
$('entry-delete').addEventListener('click', () => deleteEditing('entry'));

// Settings
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
