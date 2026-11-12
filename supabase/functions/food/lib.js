// Food lookups across USDA FoodData Central and Open Food Facts.
// Plain JavaScript using only fetch, so it runs in the Supabase Edge Function (Deno) and in Node tests.
//
// Every result has the same shape:
//   { source, source_id, name, brand, barcode, kind,
//     per100: { calories, protein, carbs, fat, fiber },    // per 100 g (or 100 ml)
//     servings: [{ label, grams }],                         // grams per serving
//     checks: { calories_match, sources_agree } }

const USDA = 'https://api.nal.usda.gov/fdc/v1';
const OFF = 'https://world.openfoodfacts.org/api/v2/product';
const OFF_USER_AGENT = 'health-tracking/1.0 (personal food log)';
const TIMEOUT_MS = 8000;

// USDA nutrient ids, with fallbacks for foods that report a different id.
const USDA_IDS = {
  calories: [1008, 2047, 2048],
  protein: [1003],
  carbs: [1005, 1050],
  fat: [1004, 1085],
  fiber: [1079],
};

// Lab-measured or curated data first, then generic dishes, then branded labels.
const KIND_RANK = { lab: 0, dish: 0.5, label: 2 };
const USDA_KIND = { Foundation: 'lab', 'SR Legacy': 'lab', 'Survey (FNDDS)': 'dish', Branded: 'label' };

async function getJson(url, headers = {}, body) {
  const init = body
    ? { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { headers };
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

const round1 = (n) => Math.round(n * 10) / 10;
const digitsOnly = (s) => String(s || '').replace(/\D/g, '');
const sameBarcode = (a, b) => digitsOnly(a).replace(/^0+/, '') === digitsOnly(b).replace(/^0+/, '');

// Title-case USDA's ALL-CAPS branded names; leave mixed-case names alone.
function tidy(s) {
  s = String(s || '').trim();
  return s && s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s\-/(&,.])(\w)/g, (m, a, c) => a + c.toUpperCase()) : s;
}

// Protein and carbs ~4 kcal/g, fat ~9 kcal/g. A label that misses by a lot is probably a typo.
export function caloriesMatch(p) {
  const fromMacros = 4 * p.protein + 4 * p.carbs + 9 * p.fat;
  const diff = Math.abs(p.calories - fromMacros);
  return diff <= 25 || diff / Math.max(p.calories, fromMacros) <= 0.2;
}

export function finish(food) {
  const p = food.per100;
  if (p.calories == null) p.calories = round1(4 * p.protein + 4 * p.carbs + 9 * p.fat);
  for (const k in p) p[k] = Math.max(0, round1(p[k] ?? 0)); // USDA's carbs "by difference" can dip below 0
  food.checks = { calories_match: caloriesMatch(p), sources_agree: null };
  return food;
}

// ---------- USDA ----------

function usdaNutrient(list, ids) {
  for (const id of ids) {
    const n = list.find((x) => (x.nutrientId ?? x.nutrient?.id) === id);
    const v = n?.value ?? n?.amount;
    if (v != null) return Number(v);
  }
  return null;
}

function usdaServings(f) {
  const out = [];
  const unit = String(f.servingSizeUnit || '').toLowerCase();
  if (f.servingSize && ['g', 'grm', 'ml', 'mlt'].includes(unit)) {
    const metric = `${round1(f.servingSize)} ${unit.startsWith('m') ? 'ml' : 'g'}`;
    const household = String(f.householdServingFullText || '').trim();
    out.push({ label: household ? `${household} (${metric})` : `1 serving (${metric})`, grams: Number(f.servingSize) });
  }
  for (const m of f.foodMeasures || f.foodPortions || []) {
    const grams = Number(m.gramWeight);
    const label = m.disseminationText || m.portionDescription
      || [m.amount, m.measureUnit?.name !== 'undetermined' ? m.measureUnit?.name : '', m.modifier].filter(Boolean).join(' ');
    if (grams > 0 && label && !/quantity not specified|guideline amount/i.test(label)) out.push({ label: `${label} (${round1(grams)} g)`, grams });
  }
  return out;
}

function fromUsda(f) {
  const n = f.foodNutrients || [];
  const per100 = {};
  for (const k in USDA_IDS) per100[k] = usdaNutrient(n, USDA_IDS[k]);
  return finish({
    source: 'usda',
    source_id: String(f.fdcId),
    name: tidy(f.description),
    brand: tidy(f.brandName || f.brandOwner) || null,
    barcode: f.gtinUpc || null,
    kind: USDA_KIND[f.dataType] || 'label',
    per100,
    servings: usdaServings(f),
  });
}

const GENERIC = ['Foundation', 'SR Legacy', 'Survey (FNDDS)'];

export async function usdaSearch(query, { usdaKey, pageSize = 25, dataType = ['Branded'] } = {}) {
  const body = { query, pageSize, dataType };
  const data = await getJson(`${USDA}/foods/search`, usdaKey ? { 'X-Api-Key': usdaKey } : {}, body);
  return (data.foods || []).map(fromUsda);
}

// Full record for one USDA food: adds household portions (cups, slices...) that search results leave out.
export async function usdaFood(id, { usdaKey } = {}) {
  const f = await getJson(`${USDA}/food/${encodeURIComponent(id)}`, usdaKey ? { 'X-Api-Key': usdaKey } : {});
  return fromUsda(f);
}

// ---------- Open Food Facts ----------

function fromOff(p) {
  const n = p.nutriments || {};
  const servings = [];
  const qty = Number(p.serving_quantity);
  if (qty > 0) servings.push({ label: p.serving_size || `1 serving (${qty} g)`, grams: qty });
  return finish({
    source: 'off',
    source_id: String(p.code),
    name: p.product_name || 'Unnamed product',
    brand: (p.brands || '').split(',')[0].trim() || null,
    barcode: String(p.code),
    kind: 'label',
    per100: {
      calories: n['energy-kcal_100g'] ?? null,
      protein: n.proteins_100g,
      carbs: n.carbohydrates_100g,
      fat: n.fat_100g,
      fiber: n.fiber_100g,
    },
    servings,
  });
}

export async function offBarcode(code) {
  const fields = 'code,product_name,brands,serving_size,serving_quantity,nutriments';
  const data = await getJson(`${OFF}/${encodeURIComponent(code)}.json?fields=${fields}`, { 'User-Agent': OFF_USER_AGENT });
  return data.status === 1 && data.product?.nutriments ? fromOff({ ...data.product, code: data.code }) : null;
}

// ---------- combining sources ----------

// True when two label results for the same product are within ~15% on calories, protein, carbs and fat.
export function agree(a, b) {
  return ['calories', 'protein', 'carbs', 'fat'].every((k) => {
    const x = a.per100[k], y = b.per100[k];
    return Math.abs(x - y) <= Math.max(2, 0.15 * Math.max(x, y));
  });
}

// Same product from both sources: one result if they agree (marked as agreeing), both if they don't.
function combine(results) {
  const out = [];
  for (const r of results) {
    const twin = r.barcode && out.find((o) => o.barcode && o.source !== r.source && sameBarcode(o.barcode, r.barcode));
    if (!twin) { out.push(r); continue; }
    const ok = agree(twin, r);
    twin.checks.sources_agree = ok;
    if (!ok) { r.checks.sources_agree = false; out.push(r); }
  }
  return out;
}

function words(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

const stem = (w) => w.replace(/(es|s)$/, '');

// Best match first: how many search words the name/brand contains, fewer extra words in the name
// (so "Bananas, raw" beats "Babyfood, juice, orange and banana"), plain foods before brands unless
// the search names the brand, how trustworthy the data is,
// and whether its calories add up. USDA's own relevance order breaks ties.
function rank(results, query) {
  const q = words(query).map(stem);
  const score = (r) => {
    const name = words(r.name).map(stem);
    const have = new Set([...name, ...words(r.brand).map(stem)]);
    const matched = q.filter((w) => have.has(w)).length / (q.length || 1);
    const extra = name.filter((w) => w.length > 2 && !q.includes(w)).length;
    const startsRight = name[0] === q[0] ? 0.5 : 0;
    return matched * 10 - 0.25 * extra + startsRight - KIND_RANK[r.kind] - (r.checks.calories_match ? 0 : 5);
  };
  return results.map((r, i) => ({ r, i, s: score(r) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.r);
}

// Plain foods and branded products are searched separately: the ~400,000 branded products
// would otherwise crowd "chicken breast, raw" out of the results.
export async function searchFoods(query, opts = {}) {
  const [generic, branded] = await Promise.all([
    usdaSearch(query, { ...opts, dataType: GENERIC }),
    usdaSearch(query, { ...opts, dataType: ['Branded'] }),
  ]);
  return rank(combine([...generic, ...branded]), query);
}

// Exact barcode: Open Food Facts and USDA's branded foods, checked against each other.
export async function lookupBarcode(code, opts = {}) {
  code = digitsOnly(code);
  const [off, usda] = await Promise.allSettled([
    offBarcode(code),
    usdaSearch(code, opts).then((rs) => rs.filter((r) => r.barcode && sameBarcode(r.barcode, code))),
  ]);
  if (off.status === 'rejected' && usda.status === 'rejected') throw off.reason;
  const found = [...(usda.value || []), ...(off.value ? [off.value] : [])];
  return combine(found);
}
