# Tinaney-Silo — survey silo (BYOI)

A **Tinaney-Silo** is a sovereign node you run on **your own Supabase project**.
Tinaney is only the *discovery + identity* layer: Tinaney respondents take your
survey and their answers are written **directly** into your Supabase, using a
short-lived token **your** silo mints. Tinaney never holds your signing secret,
and you never hand Tinaney your survey data — respondents write it live into
your silo, gated by your own Row-Level Security.

This is the **Bring-Your-Own-Infrastructure (BYOI)** model for Tinaney surveys:
anyone can hold their survey **responses and answers** on a server they control,
while still being discoverable and taken from the Tinaney Hub.

> This repo is the silo **template** that third parties clone to stand up their
> own survey silo. Nothing here contains secrets — all secrets are set as
> Supabase Edge Function secrets at deploy time. It mirrors how
> [`Komsan-Page`](https://github.com/sengtha/Komsan-Page) is a public silo
> template for the Komsan Hub.

## How the trust works (no shared secrets)

```
Tinaney Hub                    Tinaney client (browser)         Your silo (this repo)
   │  create_silo_ticket(silo)        │                                 │
   │─────────────────────────────────▶│  ticket_id (one-time, 60s)      │
   │                                   │──── POST { ticket_id } ────────▶│ authenticate-hub-user
   │  redeem_silo_ticket(ticket_id)    │                                 │
   │◀──────────────────────────────────────────────────────────────────│  (Hub anon key)
   │  { user_id, email, silo_id, role }  (ticket invalidated)           │
   │───────────────────────────────────────────────────────────────────▶│ mint JWT (SILO_JWT_SECRET,
   │                                   │◀───── { token } (15m) ──────────│  sub = user_id)
   │                                   │  createClient(SILO_URL) + token → read survey / write answers
```

- The **ticket** is the only thing that crosses from Tinaney; it is one-time and
  expires in 60s.
- Your silo signs the session token with **`SILO_JWT_SECRET`** (your project's
  own JWT secret). Tinaney never sees it.
- `sub` on the minted token is the Tinaney user id, so your RLS uses
  `auth.uid()` with no shadow-user provisioning.
- `app_metadata.silo_role` is `owner` (you, the researcher) or `respondent`.

## Setup

1. Create a Supabase project (this becomes your silo).
2. Deploy the edge function:
   ```bash
   supabase functions deploy authenticate-hub-user
   ```
   In the dashboard, set **Verify JWT = OFF** for `authenticate-hub-user` (the
   ticket is the credential, not a Supabase JWT).
3. Set the function secrets:
   ```
   HUB_URL          = https://<tinaney-hub>.supabase.co
   HUB_ANON_KEY     = <tinaney hub anon/publishable key>
   SILO_JWT_SECRET  = <this project's JWT secret>   # Settings → API → JWT
   ```
4. Create your survey tables + RLS by running `supabase/schema.sql`. Each survey
   has `status` (`draft`/`active`/`closed`) and `publish_to_hub` (default true).
   Respondents take `active` surveys only and can read **only their own**
   response; the **owner** (you) reads/writes everything via Survey Studio.
   Responses are written as the respondent's own Tinaney id (forced server-side).
5. Link your silo to Tinaney (requires the **researcher** role): call
   `register_silo(name, silo_url, silo_anon_key, authenticate_url, logo_url)`.
   It returns your **`publish_secret`** — save it (shown once).
6. Deploy the Hub-sync function (Verify JWT = **ON** — owner only):
   ```bash
   supabase functions deploy sync-to-hub
   ```
   Secrets:
   ```
   HUB_INGEST_URL      = https://<tinaney-hub>/api/silos/ingest
   SILO_ID             = <id returned by register_silo>
   SILO_PUBLISH_SECRET = <publish_secret returned by register_silo>
   # (SILO_JWT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY already set)
   ```

## Media uploads (your own R2)

Survey Studio uploads question images straight to **your** Cloudflare R2, and
respondents upload image-type answers the same way — media never touches
Tinaney. Deploy the presign function (Verify JWT = **ON**):

```bash
supabase functions deploy sign-upload
```
Secrets:
```
R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
R2_PUBLIC_BASE = https://<your public bucket/CDN base>
# (SILO_JWT_SECRET already set)
```
Owner uploads land under `questions/`, respondent uploads under `answers/`; keys
are randomised so callers can't overwrite one another.

## Publishing to the Tinaney Hub catalog

When a survey becomes `active` with `publish_to_hub = true`, Survey Studio calls
`sync-to-hub`, which pushes a **public projection** (title, description snippet,
question count, reward note) to the Hub, HMAC-signed with your
`publish_secret`. It appears in Tinaney's discovery catalog; tapping it opens
your silo and the survey is taken live from here. Closing or deleting the survey
sends a retract. The **responses and answers never leave the silo.**

## Live polls (optional)

A Tinaney survey can run as a big-screen live poll. The silo owns the live state
and votes the same way it owns responses: add `live_sessions` / `live_votes`
tables to this schema and broadcast with Supabase Realtime on your own project.
Tinaney only projects "this survey is live now" into the catalog; the vote data
stays here. (Not included in the starter schema — wire it when you need it.)

## How Tinaney reads this silo

The Tinaney client mints a Hub ticket, calls `authenticate-hub-user`, and
creates a Supabase client bound to this silo with the returned token. It renders
the survey from `surveys` / `survey_questions` and writes `survey_responses` /
`survey_answers` against it. Nothing is proxied through Tinaney — the browser
talks to your silo directly.

## Data ownership & privacy

This is the point of BYOI:

- **Raw responses live only on your Supabase.** Tinaney holds a public
  projection of *published* surveys (title/description/counts) and nothing else.
- **RLS is the guard.** A respondent can read only their own response and
  answers; the owner (you) reads everything; Tinaney has no token for this
  project at all. The anon key is public — never disable RLS.
- **respondent_uid is forced server-side** by `set_response_defaults()`, so a
  client can never submit as someone else or start a response on a closed
  survey, or exceed your response quota.

## Repository layout

| Path | What's there |
|------|--------------|
| `supabase/schema.sql` | Survey tables (`surveys`, `survey_questions`, `survey_responses`, `survey_answers`) + RLS + anti-tamper trigger |
| `supabase/functions/authenticate-hub-user/` | Redeem a Hub ticket → mint this silo's short-lived JWT (Verify JWT = OFF) |
| `supabase/functions/sync-to-hub/` | Project a published survey to the Tinaney Hub catalog / retract it (owner only) |
| `supabase/functions/sign-upload/` | Presign an R2 upload for question/answer images |

## Publishing this template

To let third parties deploy their own survey silo, this repo is meant to be a
**public** GitHub repo named `Tinaney-Silo` that they clone (mirroring how
`Komsan-Page` is a public template). Nothing here contains secrets — all secrets
are set as Supabase Edge Function secrets at deploy time.
