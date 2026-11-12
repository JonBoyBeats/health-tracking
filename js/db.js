// Every call to Supabase lives here.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const configured = Boolean(SUPABASE_URL && SUPABASE_KEY);
const client = configured ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

function check({ data, error }) {
  if (error) throw error;
  return data;
}

export async function currentUser() {
  const { data } = await client.auth.getSession();
  return data.session?.user ?? null;
}

export async function signIn(email, password) {
  return check(await client.auth.signInWithPassword({ email, password })).user;
}

export async function signOut() {
  await client.auth.signOut();
}

export async function listProfiles() {
  return check(await client.from('profiles').select('*').order('created_at'));
}

export async function updateProfile(id, fields) {
  check(await client.from('profiles').update(fields).eq('id', id));
}

export async function listEntries(day) {
  return check(await client.from('log_entries').select('*').eq('eaten_on', day).order('created_at'));
}

export async function addEntries(rows) {
  check(await client.from('log_entries').insert(rows));
}

export async function updateEntry(id, fields) {
  check(await client.from('log_entries').update(fields).eq('id', id));
}

export async function deleteEntry(id) {
  check(await client.from('log_entries').delete().eq('id', id));
}

// ---------- foods ----------

// Saved foods whose name or brand contains every word typed.
export async function searchSavedFoods(text) {
  let q = client.from('foods').select('*');
  for (const w of text.toLowerCase().split(/\s+/).filter(Boolean)) q = q.ilike('search_text', `%${w}%`);
  return check(await q.order('last_used_at', { ascending: false }).limit(8));
}

export async function recentFoods() {
  return check(await client.from('foods').select('*').order('last_used_at', { ascending: false }).limit(15));
}

export async function savedFoodByBarcode(code) {
  // The same product's barcode can be stored as 12 (UPC), 13 (EAN) or 14 (GTIN) digits.
  const bare = code.replace(/^0+/, '');
  const forms = [...new Set([code, bare, bare.padStart(12, '0'), bare.padStart(13, '0'), bare.padStart(14, '0')])];
  const rows = check(await client.from('foods').select('*').in('barcode', forms).limit(1));
  return rows[0] || null;
}

export async function getFood(id) {
  return check(await client.from('foods').select('*').eq('id', id).single());
}

// Saves a food to the shared list (or refreshes it if it's already there) and returns its row.
export async function saveFood(food) {
  const row = { ...food, last_used_at: new Date().toISOString() };
  if (row.id) return check(await client.from('foods').update(row).eq('id', row.id).select().single());
  return check(await client.from('foods').upsert(row, { onConflict: 'source,source_id' }).select().single());
}

async function callFunction(name, body, fallbackMessage) {
  const { data, error } = await client.functions.invoke(name, { body });
  if (error) {
    const detail = await error.context?.json?.().catch(() => null);
    throw new Error(detail?.error || fallbackMessage);
  }
  return data;
}

// The "food" Edge Function: { action: 'search', query } | { action: 'barcode', code } | { action: 'details', id }
export const lookup = (body) => callFunction('food', body, 'Food lookup is not available right now');

// The "assist" Edge Function: { action: 'chat', text, messages, context } | { action: 'label', image, barcode }
export const assist = (body) => callFunction('assist', body, 'The AI is not available right now');

export async function deleteFood(id) {
  check(await client.from('foods').delete().eq('id', id));
}

// ---------- weight ----------

export async function listWeights(personId) {
  return check(await client.from('weights').select('measured_on, pounds').eq('person_id', personId).order('measured_on'));
}

export async function saveWeight(personId, day, pounds) {
  check(await client.from('weights').upsert({ person_id: personId, measured_on: day, pounds }, { onConflict: 'person_id,measured_on' }));
}

export async function deleteWeight(personId, day) {
  check(await client.from('weights').delete().eq('person_id', personId).eq('measured_on', day));
}
