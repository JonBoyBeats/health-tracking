// AI logging with Claude Haiku 5.5: turns "two eggs and toast with butter" into log items,
// asking a short follow-up question when the answer would change the numbers.
// Plain JavaScript so it runs in the Edge Function (Deno) and in Node tests; the Anthropic
// client and the saved-food lookups are passed in.
//
// The conversation (messages) goes back to the app after every turn and the app sends it back
// with the answer, so the function keeps no state between requests.

import { searchFoods, usdaFood, offBarcode, finish } from '../food/lib.js';

export const MODEL = 'claude-haiku-5-5';
const MAX_STEPS = 8; // model calls per request
const OZ = 28.3495;

const SYSTEM = `You log meals for a two-person household's food tracker.

Turn the description into a list of foods, each with an amount, for the right person.

How to work:
- Call search_foods for every food mentioned (several calls in one turn is fine). Pick the result that best matches. Prefer results marked "saved" (foods this household logged before), then the named brand when one is given, then plain USDA foods.
- Never invent nutrition numbers for a food that search found. Choose the amount and a unit from that result's servings list, or use "g" or "oz".
- Use typical portions when the description doesn't say ("a banana" is 1 medium, "toast" is 1 slice).
- Ask a follow-up with ask_user only when the answer would change the meal's calories by about 50 or more (how much butter or oil, whole vs skim milk, a large vs small portion of a calorie-dense food), or when it's unclear who ate something. Ask one short question at a time, at most two in total. Otherwise assume and move on.
- If a food isn't found after one or two searches (often restaurant dishes), use ref "estimate" and give your best estimate of its nutrients for the whole amount eaten.
- People: use the names exactly as given. "I" or "me" is the app user. "We", "us" or "both" means both people: give each person their own items, with their own amounts if they differ.
- Finish by calling log_foods once with every item. Don't write other text.`;

const TOOLS = [
  {
    name: 'search_foods',
    description: 'Search the household\'s saved foods and USDA FoodData Central. Returns up to 6 matches with nutrients per 100 g and serving sizes.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A food name, optionally with brand, e.g. "scrambled eggs" or "Dave\'s Killer Bread white"' } },
      required: ['query'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'ask_user',
    description: 'Ask the person one short follow-up question. Use only when the answer changes the numbers meaningfully.',
    input_schema: {
      type: 'object',
      properties: { question: { type: 'string' } },
      required: ['question'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'log_foods',
    description: 'Propose the final list of foods to log. The person reviews it before anything is saved.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              person: { type: 'string', description: 'Exactly one of the names given' },
              ref: { type: 'string', description: 'The ref of the chosen search result, or "estimate"' },
              name: { type: 'string', description: 'Short name of the food as eaten' },
              amount: { type: 'number' },
              unit: { type: 'string', description: 'One of the result\'s serving labels exactly, or "g" or "oz". For estimates, a description such as "1 burrito"' },
              estimate: {
                type: 'object',
                description: 'Only for ref "estimate": nutrients for the whole amount. Otherwise all zeros.',
                properties: {
                  calories: { type: 'number' }, protein: { type: 'number' }, carbs: { type: 'number' },
                  fat: { type: 'number' }, fiber: { type: 'number' },
                },
                required: ['calories', 'protein', 'carbs', 'fat', 'fiber'],
                additionalProperties: false,
              },
            },
            required: ['person', 'ref', 'name', 'amount', 'unit', 'estimate'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
    strict: true,
  },
];

const KIND_TEXT = { lab: 'USDA', dish: 'USDA (prepared dish)', label: 'brand label' };

// ---------- search tool ----------

function savedToFood(row) {
  return {
    id: row.id, source: row.source, source_id: row.source_id, name: row.name, brand: row.brand, barcode: row.barcode,
    per100: { calories: +row.calories, protein: +row.protein, carbs: +row.carbs, fat: +row.fat, fiber: +row.fiber },
    servings: row.servings || [], is_estimate: row.is_estimate, saved: true, checks: {},
  };
}

const refOf = (f) => (f.saved ? `saved:${f.id}` : `${f.source}:${f.source_id}`);

function forModel(f) {
  return {
    ref: refOf(f),
    name: f.name,
    brand: f.brand || undefined,
    from: f.saved ? 'saved' : KIND_TEXT[f.kind] || f.source,
    per_100g: f.per100,
    servings: f.servings.slice(0, 8).map((s) => s.label),
  };
}

async function searchTool(query, deps) {
  const [saved, found] = await Promise.all([
    deps.searchSaved(query).then((rows) => rows.map(savedToFood)).catch(() => []),
    searchFoods(query, deps.foodOpts),
  ]);
  const savedRefs = new Set(saved.map((f) => `${f.source}:${f.source_id}`));
  const list = [...saved.slice(0, 3), ...found.filter((f) => !savedRefs.has(`${f.source}:${f.source_id}`))].slice(0, 6);
  // USDA search results leave out household portions (1 large egg, 1 slice); fetch them for the top few.
  await Promise.all(list.slice(0, 4).map(async (f, i) => {
    if (f.saved || f.source !== 'usda' || f.servings.length) return;
    try { list[i] = await usdaFood(f.source_id, deps.foodOpts); } catch { /* keep the search result */ }
  }));
  return list.map(forModel);
}

// ---------- turning log_foods into items for the confirm screen ----------

async function resolveFood(ref, deps) {
  const [kind, ...rest] = ref.split(':');
  const id = rest.join(':');
  if (kind === 'saved') return savedToFood(await deps.getSaved(id));
  if (kind === 'usda') return usdaFood(id, deps.foodOpts);
  if (kind === 'off') return offBarcode(id);
  throw new Error(`unknown ref ${ref}`);
}

function gramsFor(food, amount, unit) {
  if (unit === 'g') return amount;
  if (unit === 'oz') return amount * OZ;
  const s = food.servings.find((x) => x.label === unit) || food.servings.find((x) => x.label.startsWith(unit));
  return s ? amount * s.grams : null;
}

async function resolveItems(items, people, deps) {
  const byName = new Map(people.map((p) => [p.name.trim().toLowerCase(), p.id]));
  return Promise.all(items.map(async (it) => {
    const person_id = byName.get(String(it.person).trim().toLowerCase()) || people[0].id;
    if (it.ref === 'estimate') {
      return { person_id, name: it.name, amount: it.amount, unit: it.unit, estimate: it.estimate };
    }
    const food = await resolveFood(it.ref, deps);
    let { amount, unit } = it;
    let grams = gramsFor(food, amount, unit);
    if (grams == null) { // a unit the food doesn't have: fall back to its first serving, or 100 g
      if (food.servings[0]) { unit = food.servings[0].label; amount = 1; grams = food.servings[0].grams; }
      else { unit = 'g'; amount = 100; grams = 100; }
    }
    return { person_id, name: it.name, food, amount, unit, grams };
  }));
}

// ---------- the conversation ----------

function contextText({ people, me, forPerson, meal }) {
  const others = people.filter((p) => p.id !== me).map((p) => p.name).join(', ');
  const name = (id) => people.find((p) => p.id === id)?.name;
  return `The app user is ${name(me)}. The other person is ${others}. ` +
    `If the description doesn't say who ate it, it was ${name(forPerson)}. Meal: ${meal}.`;
}

// One request from the app: either a new description, or the answer to the last question.
// Returns { type: 'question', question, messages } | { type: 'proposal', items, messages }.
export async function converse({ messages = [], text, context }, deps) {
  messages = [...messages];
  if (!messages.length) {
    messages.push({ role: 'user', content: `${contextText(context)}\n\nWhat was eaten: ${text}` });
  } else {
    // The answer to the last question: a tool result when it was asked with ask_user, else plain text.
    const asked = messages.at(-1).content.find?.((b) => b.type === 'tool_use' && b.name === 'ask_user');
    messages.push(asked
      ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: asked.id, content: text }] }
      : { role: 'user', content: text });
  }

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await deps.client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      output_config: { effort: 'medium' },
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });
    if (response.stop_reason === 'refusal') throw new Error('The AI declined this one. Try describing it differently, or search instead.');
    if (response.stop_reason === 'max_tokens') throw new Error('The AI ran out of room. Try a shorter description.');
    messages.push({ role: 'assistant', content: response.content });

    const calls = response.content.filter((b) => b.type === 'tool_use');
    const ask = calls.find((c) => c.name === 'ask_user');
    if (ask) return { type: 'question', question: ask.input.question, messages };
    const log = calls.find((c) => c.name === 'log_foods');
    if (log) return { type: 'proposal', items: await resolveItems(log.input.items, context.people, deps), messages };

    if (!calls.length) {
      // Plain text instead of a tool: treat it as a question if it asks one, otherwise nudge.
      const said = response.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
      if (said.endsWith('?')) return { type: 'question', question: said, messages };
      messages.push({ role: 'user', content: 'Please finish by calling log_foods with every item.' });
      continue;
    }

    const results = await Promise.all(calls.map(async (c) => {
      if (c.name !== 'search_foods') return { type: 'tool_result', tool_use_id: c.id, content: 'Unknown tool', is_error: true };
      try {
        return { type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(await searchTool(c.input.query, deps)) };
      } catch (err) {
        return { type: 'tool_result', tool_use_id: c.id, content: `Search failed: ${err.message}`, is_error: true };
      }
    }));
    messages.push({ role: 'user', content: results });
  }
  throw new Error('The AI took too many steps. Try a simpler description, or search instead.');
}

// ---------- nutrition label photos ----------

const LABEL_SCHEMA = {
  type: 'object',
  properties: {
    readable: { type: 'boolean', description: 'False if this is not a nutrition label or the numbers cannot be read' },
    problem: { type: 'string', description: 'If not readable, a short reason the person can act on. Otherwise empty.' },
    name: { type: 'string', description: 'Product name if visible on the package, otherwise empty' },
    brand: { type: 'string', description: 'Brand if visible, otherwise empty' },
    serving_label: { type: 'string', description: 'Serving size as printed, e.g. "2/3 cup (55 g)"' },
    serving_grams: { type: 'number', description: 'Grams (or ml) in one serving, from the label' },
    calories: { type: 'number' }, protein: { type: 'number' }, carbs: { type: 'number', description: 'Total carbohydrate' },
    fat: { type: 'number', description: 'Total fat' }, fiber: { type: 'number', description: 'Dietary fiber, 0 if not listed' },
  },
  required: ['readable', 'problem', 'name', 'brand', 'serving_label', 'serving_grams', 'calories', 'protein', 'carbs', 'fat', 'fiber'],
  additionalProperties: false,
};

// Reads a Nutrition Facts panel. Returns a food in the same shape as the food function's results.
export async function readLabel({ image, mediaType = 'image/jpeg', barcode }, deps) {
  const response = await deps.client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: LABEL_SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
        { type: 'text', text: 'Read this Nutrition Facts label. Give the values per serving exactly as printed.' },
      ],
    }],
  });
  if (response.stop_reason === 'refusal') throw new Error('Couldn\'t read that photo. Try again, or type the numbers in.');
  const text = response.content.find((b) => b.type === 'text')?.text;
  const label = JSON.parse(text);
  if (!label.readable) throw new Error(label.problem || 'Couldn\'t read the label. Try a closer, straighter photo.');
  if (!(label.serving_grams > 0)) throw new Error('The label\'s serving size in grams isn\'t readable. Try a closer photo.');
  const per = (v) => (v * 100) / label.serving_grams;
  const servingLabel = /\d\s*(g|ml)\b/i.test(label.serving_label) ? label.serving_label : `${label.serving_label} (${label.serving_grams} g)`;
  return finish({
    source: 'label',
    source_id: barcode || null,
    name: label.name || '',
    brand: label.brand || null,
    barcode: barcode || null,
    kind: 'label',
    per100: { calories: per(label.calories), protein: per(label.protein), carbs: per(label.carbs), fat: per(label.fat), fiber: per(label.fiber) },
    servings: [{ label: servingLabel, grams: label.serving_grams }],
  });
}
