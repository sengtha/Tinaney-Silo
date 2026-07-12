// Tinaney-Silo — presign an R2 upload.
//
// Survey Studio calls this to upload question images straight to the silo's OWN
// Cloudflare R2 bucket; respondents call it to upload image-type answers. Media
// never passes through Tinaney. Returns a presigned PUT URL and the eventual
// public URL. Any valid silo token (owner or respondent) may presign — the
// object key is randomised so callers can't overwrite each other.
//
// Deploy with "Verify JWT" ON.
//
// Required Edge Function secrets:
//   SILO_JWT_SECRET     - authorise the silo token
//   R2_ACCOUNT_ID       - Cloudflare account id
//   R2_BUCKET           - bucket name
//   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY - R2 S3 API token
//   R2_PUBLIC_BASE      - public base URL for the bucket (e.g. https://cdn.yoursilo.com)

import { jwtVerify } from 'npm:jose@5.2.0';
import { AwsClient } from 'npm:aws4fetch@1.0.20';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const EXT_OK = /^[a-z0-9]{1,5}$/;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    const { payload } = await jwtVerify(token, new TextEncoder().encode(Deno.env.get('SILO_JWT_SECRET')!));
    const role = (payload as any)?.app_metadata?.silo_role;
    if (role !== 'owner' && role !== 'respondent') {
      return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: corsHeaders });
    }

    const { content_type, ext } = await req.json();
    if (!content_type || !ext || !EXT_OK.test(String(ext))) {
      return new Response(JSON.stringify({ error: 'bad request' }), { status: 400, headers: corsHeaders });
    }

    const prefix = role === 'owner' ? 'questions' : 'answers';
    const key = `${prefix}/${crypto.randomUUID()}.${ext}`;
    const endpoint = `https://${Deno.env.get('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com/${Deno.env.get('R2_BUCKET')}/${key}`;

    const aws = new AwsClient({
      accessKeyId: Deno.env.get('R2_ACCESS_KEY_ID')!,
      secretAccessKey: Deno.env.get('R2_SECRET_ACCESS_KEY')!,
      service: 's3',
      region: 'auto',
    });
    const signed = await aws.sign(new Request(endpoint, { method: 'PUT', headers: { 'Content-Type': content_type } }), {
      aws: { signQuery: true },
    });

    return new Response(
      JSON.stringify({
        upload_url: signed.url,
        public_url: `${Deno.env.get('R2_PUBLIC_BASE')!.replace(/\/$/, '')}/${key}`,
      }),
      { status: 200, headers: corsHeaders }
    );
  } catch {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: corsHeaders });
  }
});
