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
