// Tinaney-Silo — project one survey to the Tinaney Hub catalog (or retract it).
//
// Survey Studio calls this (with the owner's silo token) after activating,
// closing, editing or deleting a survey. We read the current row and, if it is
// (status='active' AND publish_to_hub), push a signed PUBLIC projection to the
// Hub ingest; otherwise we push a retract. Only discovery fields leave the silo
// (title / description snippet / question count) — the RESPONSES and ANSWERS
// never leave here.
//
// Deploy with "Verify JWT" ON (only the owner may call it).
//
// Required Edge Function secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  - this silo
//   SILO_JWT_SECRET       - to authorise the owner token
//   HUB_INGEST_URL        - https://<tinaney-hub>/api/silos/ingest
//   SILO_ID               - this silo's id in the Tinaney Hub (register_silo)
//   SILO_PUBLISH_SECRET   - the publish_secret register_silo returned

import { createClient } from 'npm:@supabase/supabase-js@2.39.3';
import { jwtVerify } from 'npm:jose@5.2.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Pick the first non-empty string from an i18n JSON blob for the snippet.
function firstText(v: any): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  for (const k of ['en', 'kh', ...Object.keys(v)]) {
    if (typeof v[k] === 'string' && v[k].trim()) return v[k];
  }
  return '';
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    // Authorise: owner token only.
    const auth = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    const { payload } = await jwtVerify(auth, new TextEncoder().encode(Deno.env.get('SILO_JWT_SECRET')!));
    if ((payload as any)?.app_metadata?.silo_role !== 'owner') {
      return new Response(JSON.stringify({ error: 'owner only' }), { status: 403, headers: corsHeaders });
    }

    const { survey_id } = await req.json();
    if (!survey_id) return new Response(JSON.stringify({ error: 'bad request' }), { status: 400, headers: corsHeaders });

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: row } = await sb.from('surveys').select('*').eq('id', survey_id).maybeSingle();

    const live = row && row.status === 'active' && row.publish_to_hub;

    let body: Record<string, unknown>;
    if (live) {
      const { count } = await sb
        .from('survey_questions')
        .select('id', { count: 'exact', head: true })
        .eq('survey_id', survey_id);
      body = {
        survey_id,
        action: 'upsert',
        projection: {
          title: row.title ?? {},
          snippet: firstText(row.description).slice(0, 200),
          question_count: count ?? 0,
          reward_note: row.reward_note ?? null,
          published_at: row.created_at,
        },
      };
    } else {
      body = { survey_id, action: 'retract' };
    }

    const raw = JSON.stringify(body);
    const ts = Date.now();

    const res = await fetch(Deno.env.get('HUB_INGEST_URL')!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Silo-Id': Deno.env.get('SILO_ID')!,
        'X-Silo-Timestamp': String(ts),
        'X-Silo-Signature': await sign(Deno.env.get('SILO_PUBLISH_SECRET')!, `${ts}.${raw}`),
      },
      body: raw,
    });

    return new Response(JSON.stringify({ ok: res.ok, synced: live ? 'upsert' : 'retract' }), {
      status: res.ok ? 200 : 502,
      headers: corsHeaders,
    });
  } catch {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: corsHeaders });
  }
});
