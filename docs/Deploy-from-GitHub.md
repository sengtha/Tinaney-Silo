# 🚀 Deploy a Silo from GitHub

Your silo is a **sovereign environment** — it lives on *your* Supabase project,
and Tinaney never touches it. This workflow deploys the whole silo (schema,
Edge Functions, function secrets) from **your fork**, with **your** credentials.

Unlike a Normsar Silo — which is a full Docker stack on a VM you own — a
Tinaney silo is **BYOI on hosted Supabase**: there is no server to SSH into, so
"deploy" means *apply the schema and push the functions to your project*. The
workflow does exactly that.

---

## What you need first

- A **Supabase project** (this becomes your silo).
- A **Supabase personal access token** —
  <https://supabase.com/dashboard/account/tokens>.
- Your **project ref** — Project Settings → General → *Reference ID*.
- Your project's **JWT secret** — Project Settings → API → *JWT Settings*
  (legacy JWT secret). This is `SILO_JWT_SECRET`.

---

## 1. Fork this repo

Fork `Tinaney-Silo`. Everything below happens in **your** fork; nothing is
shared with Tinaney.

## 2. Add repository secrets

**Settings → Secrets and variables → Actions → New repository secret.**

### Required — how the workflow reaches your project

| Secret | Where to get it |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | <https://supabase.com/dashboard/account/tokens> |
| `SUPABASE_PROJECT_REF` | Project Settings → General → *Reference ID* |
| `SUPABASE_DB_URL` | Connect → **Session pooler** connection string (IPv4-friendly, which GitHub runners need). Only used to apply `schema.sql`. |

If you leave `SUPABASE_DB_URL` unset the workflow still deploys the functions —
it just warns and skips the schema, which you then run by hand in the SQL
editor.

### Required — silo identity

| Secret | Value |
|---|---|
| `HUB_URL` | `https://<tinaney-hub>.supabase.co` |
| `HUB_ANON_KEY` | The Tinaney Hub anon/publishable key |
| `SILO_JWT_SECRET` | **Your** project's JWT secret (Settings → API) |

### Optional — per feature (leave unset to keep the feature off)

| Feature | Secrets |
|---|---|
| Publish surveys to the Tinaney catalog | `HUB_INGEST_URL`, `SILO_ID`, `SILO_PUBLISH_SECRET` |
| Question/answer image uploads to your R2 | `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_BASE` |
| AI analysis with your own Gemini key | `GEMINI_API_KEY`, `GEMINI_MODEL` |

> **Don't add `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY`.** Supabase injects
> those into every Edge Function automatically, and the CLI refuses secrets
> using the reserved `SUPABASE_` prefix.

## 3. Run it

**Actions → Deploy Silo → Run workflow.**

It will:

1. Apply `supabase/schema.sql` (tables, RLS, the anti-tamper trigger). The
   script is idempotent — `IF NOT EXISTS` / `OR REPLACE` / `DROP POLICY IF
   EXISTS` throughout — so re-running it is safe.
2. Push your configured function secrets with `supabase secrets set`.
3. Deploy every function in `supabase/functions/`, with `verify_jwt` taken from
   [`supabase/config.toml`](../supabase/config.toml) — `authenticate-hub-user`
   is **OFF** (the one-time Hub ticket is the credential) and everything else is
   **ON** (owner-only).

Each step can be toggled off from the *Run workflow* form when you only want to
redeploy one part.

## 4. Register with Tinaney (one time)

Deployment doesn't register the silo — that needs the **researcher** role on
the Hub. Call:

```
register_silo(name, silo_url, silo_anon_key, authenticate_url, logo_url)
```

It returns your **`publish_secret`** (shown once). Put it and the returned silo
id into the `SILO_PUBLISH_SECRET` / `SILO_ID` repo secrets, add
`HUB_INGEST_URL`, and re-run the workflow so `sync-to-hub` can publish.

---

## Continuous deploy

The workflow also runs on **push to `main`** when anything under `supabase/`
changes, so editing the schema or a function redeploys the silo on merge. In a
fork with no deploy secrets configured it notices and skips instead of failing.

Don't want that? Delete the `push:` block from
`.github/workflows/deploy-silo.yml` and keep it manual-only.

---

## Deploying by hand instead

Everything the workflow does, you can do locally:

```bash
supabase secrets set --project-ref <ref> \
  HUB_URL=... HUB_ANON_KEY=... SILO_JWT_SECRET=...

supabase functions deploy authenticate-hub-user --project-ref <ref>
supabase functions deploy sync-to-hub          --project-ref <ref>
supabase functions deploy sign-upload          --project-ref <ref>
supabase functions deploy analyze-survey       --project-ref <ref>

psql "<session pooler connection string>" -v ON_ERROR_STOP=1 -f supabase/schema.sql
```

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Missing secret SUPABASE_ACCESS_TOKEN and/or SUPABASE_PROJECT_REF` | Add them under Actions secrets. |
| Schema step warns and skips | `SUPABASE_DB_URL` isn't set. |
| `psql: could not connect` / network unreachable | You used the **direct** connection string; new projects are IPv6-only there and GitHub runners are IPv4. Use the **Session pooler** string. |
| `authenticate-hub-user` returns 401 to Tinaney | `verify_jwt` got turned back on. It must stay **OFF** — `supabase/config.toml` sets that. |
| Functions deploy but calls fail on `SILO_JWT_SECRET` | The secret must be *your project's own* JWT secret, or minted tokens won't verify. |
