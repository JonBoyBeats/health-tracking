// Shared by the Edge Functions: CORS, JSON replies, and the signed-in check.

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Only our two signed-in users may use the functions (they spend our API quotas).
export async function signedIn(req: Request) {
  const auth = req.headers.get('Authorization') || '';
  const apikey = req.headers.get('apikey') || '';
  if (!auth.startsWith('Bearer ') || !apikey) return false;
  const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, { headers: { Authorization: auth, apikey } });
  return res.ok;
}
