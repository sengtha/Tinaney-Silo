// Tinaney-Silo — AI analysis of your survey results with YOUR OWN Gemini key.
//
// Owner-only. Aggregates a survey's completed responses ON the silo (they never
// leave it) into per-question distributions, then asks Gemini for grounded
// insights. The Gemini key is the silo's own secret — Tinaney never sees your
// survey data or your API key.
//
// Deploy with "Verify JWT" ON (only the owner may call it).
//
// Required Edge Function secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  - this silo
//   SILO_JWT_SECRET   - authorise the owner token
//   GEMINI_API_KEY    - YOUR Google Gemini API key (https://aistudio.google.com/apikey)
// Optional:
//   GEMINI_MODEL      - generation model (default 'gemini-2.5-flash')

import { createClient } from 'npm:@supabase/supabase-js@2.39.3';
import { jwtVerify } from 'npm:jose@5.2.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Pick a display string from an i18n JSON blob.
function pickText(v: any, fallback = ''): string {
  if (!v) return fallback;
  if (typeof v === 'string') return v;
  return v.en || v.kh || Object.values(v)[0] as string || fallback;
}

async function geminiJSON(model: string, key: string, prompt: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 4096 },
    }),
  });
  if (!r.ok) throw new Error(`Gemini API error: ${await r.text()}`);
  const j = await r.json();
  const text = j.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned an empty response.');
  return text;
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

    const geminiKey = Deno.env.get('GEMINI_API_KEY');
    if (!geminiKey) {
      return new Response(JSON.stringify({ error: 'No GEMINI_API_KEY set on this silo. Add your own key to enable AI analysis.' }),
        { status: 400, headers: corsHeaders });
    }

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: survey } = await sb.from('surveys').select('*').eq('id', survey_id).maybeSingle();
    if (!survey) return new Response(JSON.stringify({ error: 'Survey not found' }), { status: 404, headers: corsHeaders });

    const { data: questions } = await sb.from('survey_questions').select('*').eq('survey_id', survey_id).order('order_index', { ascending: true });

    // Completed responses only. Cap the sample so the aggregation stays bounded.
    const SAMPLE_CAP = 2000;
    const { data: responses } = await sb.from('survey_responses')
      .select('id').eq('survey_id', survey_id).eq('status', 'completed').limit(SAMPLE_CAP);
    const respIds = (responses || []).map((r: any) => r.id);

    if (respIds.length === 0) {
      return new Response(JSON.stringify({ survey_id, response_count: 0, insights: null, message: 'No completed responses yet.' }),
        { status: 200, headers: corsHeaders });
    }

    const { data: answers } = await sb.from('survey_answers').select('question_id, answer_value').in('response_id', respIds);

    // Group answer values by question.
    const byQ = new Map<string, any[]>();
    for (const a of answers || []) {
      const arr = byQ.get(a.question_id) || [];
      arr.push(a.answer_value);
      byQ.set(a.question_id, arr);
    }

    // Build a compact, aggregated report — distributions, not raw rows.
    const lines: string[] = [];
    for (const q of questions || []) {
      const vals = byQ.get(q.id) || [];
      const qtext = pickText(q.question_text, '(question)');
      const opts: any[] = q.config?.options || [];
      const type = (q.question_type || '').toLowerCase();
      const optLabel = (id: any) => {
        const o = opts.find((o) => String(o.id) === String(id));
        return o ? pickText(o.label, String(id)) : String(id);
      };

      if (opts.length) {
        const counts: Record<string, number> = {};
        for (const v of vals) {
          const arr = Array.isArray(v) ? v : [v];
          for (const x of arr) { const l = optLabel(x); counts[l] = (counts[l] || 0) + 1; }
        }
        const dist = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([l, c]) => `${l}: ${c}`).join(', ');
        lines.push(`Q: ${qtext} [choice] (n=${vals.length}) — ${dist || 'no answers'}`);
      } else if (type.includes('rating') || type.includes('scale') || type.includes('number')) {
        const nums = vals.map(Number).filter((n) => !Number.isNaN(n));
        if (nums.length) {
          const mean = (nums.reduce((s, n) => s + n, 0) / nums.length).toFixed(2);
          lines.push(`Q: ${qtext} [numeric] (n=${nums.length}) — mean ${mean}, min ${Math.min(...nums)}, max ${Math.max(...nums)}`);
        } else {
          lines.push(`Q: ${qtext} [numeric] (n=0)`);
        }
      } else {
        const samples = vals.filter((v) => typeof v === 'string' && v.trim()).slice(0, 30);
        lines.push(`Q: ${qtext} [text] (n=${vals.length}) — samples: ${samples.map((s) => `"${s}"`).join('; ') || 'none'}`);
      }
    }

    const surveyTitle = pickText(survey.title, '(untitled survey)');
    const prompt = `You are a survey data analyst. Analyze ONLY the aggregated results below for the survey "${surveyTitle}". Ground every statement in these numbers — do not invent figures or themes not present. Respond in the same language as the survey questions.

Completed responses analysed: ${respIds.length}${respIds.length >= SAMPLE_CAP ? ' (sampled)' : ''}

AGGREGATED RESULTS:
${lines.join('\n')}

Return a JSON object with this exact shape:
{
  "summary": "2-4 sentence executive summary",
  "key_findings": ["specific, number-backed finding", "..."],
  "notable_patterns": ["cross-question or distribution pattern", "..."],
  "recommendations": ["actionable next step for the researcher", "..."]
}`;

    const model = Deno.env.get('GEMINI_MODEL') || 'gemini-2.5-flash';
    const insights = JSON.parse(await geminiJSON(model, geminiKey, prompt));

    return new Response(JSON.stringify({ survey_id, response_count: respIds.length, insights }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('analyze-survey error:', err);
    return new Response(JSON.stringify({ error: (err as Error).message || 'Internal Server Error' }),
      { status: 400, headers: corsHeaders });
  }
});
