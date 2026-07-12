// Tinaney-Silo — silo-side token exchange.
//
// A visiting Tinaney respondent arrives with a one-time TICKET minted by the
// Tinaney Hub (create_silo_ticket). This function redeems that ticket at the
// Hub, then mints a short-lived Supabase JWT signed with THIS silo's own secret
// so the respondent can read this silo's Supabase directly and submit answers
// straight into it. The silo's signing secret never leaves the silo; the Hub
// only ever sees a one-time ticket.
//
// Deploy on the silo's Supabase with "Verify JWT" turned OFF for this function
// (the ticket is the credential, not a Supabase JWT).
//
// Required Edge Function secrets:
//   HUB_URL           - Tinaney Hub Supabase URL (e.g. https://<hub>.supabase.co)
//   HUB_ANON_KEY      - Tinaney Hub anon/publishable key (used to call redeem RPC)
//   SILO_JWT_SECRET   - THIS project's Supabase JWT secret (legacy HS256 secret)

import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import { SignJWT } from "npm:jose@5.2.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { ticket_id } = await req.json();
    if (!ticket_id) {
      return new Response(JSON.stringify({ error: "Missing ticket_id" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const hubUrl = Deno.env.get("HUB_URL");
    const hubKey = Deno.env.get("HUB_ANON_KEY");
    const siloSecret = Deno.env.get("SILO_JWT_SECRET");
    if (!hubUrl || !hubKey || !siloSecret) {
      throw new Error("Missing HUB_URL / HUB_ANON_KEY / SILO_JWT_SECRET");
    }

    // 1. Redeem the one-time ticket at the Tinaney Hub. The Hub invalidates it
    //    atomically and returns the visitor's identity.
    const hub = createClient(hubUrl, hubKey);
    const { data, error } = await hub.rpc("redeem_silo_ticket", { p_ticket_id: ticket_id });
    if (error || !data) {
      return new Response(JSON.stringify({ error: "Invalid or expired ticket" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    // 2. Mint this silo's own short-lived JWT. sub = the Tinaney user id, so this
    //    silo's RLS keys on auth.uid() natively (no shadow users needed). The
    //    role is 'owner' (the researcher who runs this silo) or 'respondent'.
    const secret = new TextEncoder().encode(siloSecret);
    const token = await new SignJWT({
      aud: "authenticated",
      role: "authenticated",
      sub: data.user_id,
      email: data.email,
      session_id: crypto.randomUUID(),
      aal: "aal1",
      is_anonymous: false,
      app_metadata: { provider: "tinaney_ticket", silo_id: data.silo_id, silo_role: data.role },
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(secret);

    return new Response(JSON.stringify({ token }), { status: 200, headers: corsHeaders });
  } catch (err) {
    console.error("authenticate-hub-user error:", err);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
