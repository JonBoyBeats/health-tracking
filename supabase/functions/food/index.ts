// Supabase Edge Function "food": food search, barcode lookup and USDA details.
// The lookup logic lives in lib.js; this file adds sign-in checking, CORS and the USDA key.
import { searchFoods, lookupBarcode, usdaFood } from './lib.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Only our two signed-in users may use the function (it spends our USDA quota).
async function signedIn(req: Request) {
  const auth = req.headers.get('Authorization') || '';
  const apikey = req.headers.get('apikey') || '';
  if (!auth.startsWith('Bearer ') || !apikey) return false;
  const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, { headers: { Authorization: auth, apikey } });
  return res.ok;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (!(await signedIn(req))) return json(401, { error: 'Sign in first' });
  try {
    const { action, query, code, id } = await req.json();
    const opts = { usdaKey: Deno.env.get('USDA_API_KEY') };
    if (action === 'search' && query) return json(200, { results: await searchFoods(String(query).slice(0, 200), opts) });
    if (action === 'barcode' && code) return json(200, { results: await lookupBarcode(String(code), opts) });
    if (action === 'details' && id) return json(200, { result: await usdaFood(String(id), opts) });
    return json(400, { error: 'Unknown request' });
  } catch (err) {
    console.error(err);
    return json(502, { error: `Food lookup failed: ${(err as Error).message}` });
  }
});
