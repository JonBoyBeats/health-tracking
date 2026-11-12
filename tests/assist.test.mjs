// Tests the AI logging plumbing (supabase/functions/assist/lib.js) against a scripted stand-in
// for Anthropic's Messages API. Food lookups are live (USDA and Open Food Facts).
// This checks the conversation mechanics, not the model's judgment.
//
// Run: USDA_API_KEY=... SDK=<path to node_modules/@anthropic-ai/sdk> node tests/assist.test.mjs
// (behind an HTTPS proxy, add NODE_USE_ENV_PROXY=1)
import http from 'node:http';
import assert from 'node:assert/strict';
import { converse, readLabel, MODEL } from '../supabase/functions/assist/lib.js';

const { default: Anthropic } = await import(process.env.SDK || '@anthropic-ai/sdk');

const JON = 'u-jon', SARAH = 'u-sarah';
const people = [{ id: JON, name: 'Jon' }, { id: SARAH, name: 'Sarah' }];
const context = { people, me: JON, forPerson: JON, meal: 'breakfast' };
const savedRows = [{
  id: 'saved-1', source: 'usda', source_id: '2674266', name: "Dave's Killer Bread, White Bread", brand: "Dave's Killer Bread",
  barcode: null, calories: 275, protein: 7.5, carbs: 52.5, fat: 5, fiber: 5, servings: [{ label: '1 SLICE (40 g)', grams: 40 }],
}];

// ---- scripted Messages API ----
const requests = [];
let script = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const r = JSON.parse(body);
    requests.push(r);
    // API rule: every tool_use in an assistant turn is answered by a tool_result in the next user turn.
    r.messages.forEach((m, i) => {
      if (m.role !== 'assistant') return;
      const ids = m.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
      const next = r.messages[i + 1];
      if (ids.length && next) {
        const got = Array.isArray(next.content) ? next.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id) : [];
        assert.deepEqual(got.sort(), ids.sort(), 'tool_results must answer every tool_use');
      }
    });
    const content = script.shift()(r);
    const stop = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: r.model, content, stop_reason: stop, stop_details: null, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const client = new Anthropic({ apiKey: 'test', baseURL: `http://127.0.0.1:${server.address().port}` });

const deps = {
  client,
  foodOpts: { usdaKey: process.env.USDA_API_KEY },
  searchSaved: async (q) => savedRows.filter((r) => q.toLowerCase().split(/\s+/).every((w) => `${r.name} ${r.brand}`.toLowerCase().includes(w.replace(/'s$/, '')))),
  getSaved: async (id) => savedRows.find((r) => r.id === id),
};

const thinking = { type: 'thinking', thinking: '', signature: 'sig-abc' };
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
// The tool results the scripted model "reads" (latest user turn), by query.
const resultsFor = (r) => {
  const last = r.messages.at(-1);
  const out = {};
  for (const b of last.content) if (b.type === 'tool_result') out[b.tool_use_id] = JSON.parse(b.content);
  return out;
};

try {
  // ---- 1. Search, a follow-up question, then the proposal ----
  let picked;
  script = [
    () => [thinking, use('t1', 'search_foods', { query: 'scrambled eggs' }), use('t2', 'search_foods', { query: "dave's killer bread" }), use('t3', 'search_foods', { query: 'butter' })],
    (r) => { picked = resultsFor(r); return [thinking, use('t4', 'ask_user', { question: 'About how much butter: a thin spread or a full tablespoon?' })]; },
    () => {
      const egg = picked.t1[0], bread = picked.t2[0], butter = picked.t3.find((f) => /butter/i.test(f.name));
      const eggUnit = egg.servings.find((s) => /egg/i.test(s)) || 'g';
      return [thinking, use('t5', 'log_foods', { items: [
        { person: 'Jon', ref: egg.ref, name: 'Scrambled eggs', amount: eggUnit === 'g' ? 120 : 2, unit: eggUnit, estimate: { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 } },
        { person: 'Jon', ref: bread.ref, name: 'Toast', amount: 1, unit: bread.servings[0], estimate: { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 } },
        { person: 'Jon', ref: butter.ref, name: 'Butter', amount: 5, unit: 'g', estimate: { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 } },
      ] })];
    },
  ];
  const q = await converse({ messages: [], text: "2 scrambled eggs and a slice of dave's killer bread toast with butter", context }, deps);
  assert.equal(q.type, 'question');
  assert.match(q.question, /butter/);
  // First request: model, effort, strict tools, context in the user turn, no sampling parameters.
  const first = requests[0];
  assert.equal(first.model, MODEL);
  assert.equal(first.output_config.effort, 'medium');
  assert.ok(first.tools.every((t) => t.strict === true));
  assert.match(first.messages[0].content, /The app user is Jon\. The other person is Sarah\..*Meal: breakfast/s);
  assert.ok(!('temperature' in first) && !('top_p' in first) && !('top_k' in first));
  // Search results: saved bread first, with servings; USDA results enriched with household portions.
  assert.equal(picked.t2[0].ref, 'saved:saved-1');
  assert.equal(picked.t2[0].from, 'saved');
  assert.ok(picked.t1.slice(0, 4).some((f) => f.servings.length > 0), 'egg results have portions');
  console.log('ok  description -> searches (saved first, portions filled in) -> follow-up question');

  const p = await converse({ messages: q.messages, text: 'a thin spread', context }, deps);
  assert.equal(p.type, 'proposal');
  // The answer went back as the ask_user tool result, and earlier turns were sent back unchanged.
  const third = requests[2];
  assert.deepEqual(third.messages.slice(0, q.messages.length), JSON.parse(JSON.stringify(q.messages)));
  assert.deepEqual(third.messages.at(-1).content, [{ type: 'tool_result', tool_use_id: 't4', content: 'a thin spread' }]);
  assert.equal(third.messages[1].content[0].signature, 'sig-abc', 'thinking blocks passed back');
  assert.equal(p.items.length, 3);
  const [egg, toast, butter] = p.items;
  assert.ok(p.items.every((i) => i.person_id === JON && i.food && i.grams > 0));
  assert.equal(toast.food.saved, true);
  assert.equal(toast.grams, 40);
  assert.equal(butter.grams, 5);
  assert.ok(egg.food.servings.length > 0);
  console.log(`ok  answer -> proposal with real foods: ${egg.amount} × ${egg.unit} = ${Math.round(egg.grams)} g eggs, toast 40 g, butter 5 g`);

  // ---- 2. Both people, different amounts, and a restaurant estimate ----
  script = [
    () => [thinking, use('s1', 'search_foods', { query: 'chipotle chicken burrito' })],
    (r) => {
      const found = resultsFor(r).s1;
      assert.ok(Array.isArray(found));
      const est = { calories: 1050, protein: 55, carbs: 110, fat: 40, fiber: 12 };
      return [thinking, use('s2', 'log_foods', { items: [
        { person: 'Jon', ref: 'estimate', name: 'Chipotle chicken burrito', amount: 1, unit: '1 burrito', estimate: est },
        { person: 'sarah', ref: 'estimate', name: 'Chipotle chicken burrito', amount: 0.5, unit: '1 burrito', estimate: { ...est, calories: 525 } },
      ] })];
    },
  ];
  const b = await converse({ messages: [], text: 'we split a chipotle chicken burrito, I had most of it', context }, deps);
  assert.equal(b.type, 'proposal');
  assert.deepEqual(b.items.map((i) => i.person_id), [JON, SARAH]);
  assert.ok(b.items.every((i) => !i.food && i.estimate.calories > 0));
  console.log('ok  both people, matched by name in any case, with estimates');

  // ---- 3. Plain-text question instead of the tool, then a unit the food doesn't have ----
  script = [
    () => [thinking, { type: 'text', text: 'Was that whole milk or skim?' }],
    () => [thinking, use('m1', 'search_foods', { query: 'milk whole' })],
    (r) => {
      const milk = resultsFor(r).m1[0];
      return [thinking, use('m2', 'log_foods', { items: [{ person: 'Jon', ref: milk.ref, name: 'Whole milk', amount: 1, unit: 'a big glass', estimate: { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 } }] })];
    },
  ];
  const t = await converse({ messages: [], text: 'glass of milk', context }, deps);
  assert.equal(t.type, 'question');
  const t2 = await converse({ messages: t.messages, text: 'whole', context }, deps);
  assert.equal(requests.at(-2).messages.at(-1).content, 'whole', 'plain answer appended as user text');
  assert.equal(t2.type, 'proposal');
  assert.ok(t2.items[0].grams > 0 && t2.items[0].unit !== 'a big glass', 'unknown unit falls back to a real serving');
  console.log(`ok  plain-text question works; unknown unit fell back to "${t2.items[0].unit}"`);

  // ---- 4. Label photo ----
  script = [(r) => {
    assert.equal(r.output_config.format.type, 'json_schema');
    assert.equal(r.messages[0].content[0].type, 'image');
    return [{ type: 'text', text: JSON.stringify({ readable: true, problem: '', name: 'Protein Granola', brand: 'Acme', serving_label: '2/3 cup (55g)', serving_grams: 55, calories: 230, protein: 10, carbs: 30, fat: 8, fiber: 4 }) }];
  }];
  const label = await readLabel({ image: 'aGVsbG8=', barcode: '012345678905' }, deps);
  assert.equal(label.source, 'label');
  assert.equal(label.source_id, '012345678905');
  assert.equal(label.per100.calories, 418.2);
  assert.deepEqual(label.servings, [{ label: '2/3 cup (55g)', grams: 55 }]);
  assert.equal(label.checks.calories_match, true);
  script = [() => [{ type: 'text', text: JSON.stringify({ readable: false, problem: 'The photo is too blurry.', name: '', brand: '', serving_label: '', serving_grams: 0, calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 }) }]];
  await assert.rejects(readLabel({ image: 'aGVsbG8=' }, deps), /too blurry/);
  console.log('ok  label photo -> per-100 g food; unreadable photo explains why');

  // ---- 5. Refusal ----
  script = [() => []];
  const orig = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'general_harms', explanation: '' }, usage: { input_tokens: 1, output_tokens: 0 } }));
    });
  });
  await assert.rejects(converse({ messages: [], text: 'x', context }, deps), /declined/);
  server.removeAllListeners('request');
  server.on('request', orig);
  console.log('ok  refusal gives a readable message');

  console.log('all passed');
} finally {
  server.close();
}
