// Supabase Edge Function "assist": AI logging (Claude Haiku 5.5) and nutrition label photos.
// The logic lives in lib.js; this file adds sign-in checking, CORS, the API keys and saved-food lookups.
import Anthropic from 'npm:@anthropic-ai/sdk@1.3.0';
import { converse, readLabel } from './lib.js';
import { CORS, json, signedIn } from '../_shared/http.ts';

const client = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });

// Saved foods are read with the caller's own sign-in, so the database's access rules apply.
function savedFoods(req: Request) {
  const base = `${Deno.env.get('SUPABASE_URL')}/rest/v1/foods`;
  const headers = { Authorization: req.headers.get('Authorization')!, apikey: req.headers.get('apikey')! };
  const get = async (query: string) => {
    const res = await fetch(`${base}?${query}`, { headers });
    if (!res.ok) throw new Error(`saved foods: ${res.status}`);
    return res.json();
  };
  return {
    searchSaved: (text: string) => {
      const words = text.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean).slice(0, 6);
      const filters = words.map((w) => `search_text=ilike.${encodeURIComponent(`*${w}*`)}`).join('&');
      return get(`select=*&${filters}&order=last_used_at.desc&limit=3`);
    },
    getSaved: async (id: string) => (await get(`select=*&id=eq.${encodeURIComponent(id)}`))[0],
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (!(await signedIn(req))) return json(401, { error: 'Sign in first' });
  try {
    const body = await req.json();
    const deps = { client, foodOpts: { usdaKey: Deno.env.get('USDA_API_KEY') }, ...savedFoods(req) };
    if (body.action === 'chat' && body.text && body.context) {
      return json(200, await converse({ messages: body.messages, text: String(body.text).slice(0, 1000), context: body.context }, deps));
    }
    if (body.action === 'label' && body.image) {
      return json(200, { result: await readLabel({ image: body.image, mediaType: body.mediaType, barcode: body.barcode }, deps) });
    }
    return json(400, { error: 'Unknown request' });
  } catch (err) {
    console.error(err);
    if (err instanceof Anthropic.AuthenticationError) return json(502, { error: 'The AI key is missing or wrong (ANTHROPIC_API_KEY).' });
    if (err instanceof Anthropic.RateLimitError) return json(503, { error: 'The AI is busy or the monthly spending limit was reached. Try again later.' });
    if (err instanceof Anthropic.APIError) return json(502, { error: `The AI service had a problem (${err.status}). Try again.` });
    return json(502, { error: (err as Error).message });
  }
});
