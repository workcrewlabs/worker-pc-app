# WorkCrew backend deployment on Render

This is the exact configuration for hosting the WorkCrew backend (apps/api) on
Render. Read the readiness section first. Do not deploy until the prerequisites
are met, because a deploy now would put up a backend that loses all data on
restart and cannot process real payments or real AI.

## Readiness (must be true before deploying)

1. A persistent database. The backend currently uses a local SQLite file
   (WORKCREW_DATA_URL=file:workcrew.db). Render's disk is ephemeral and resets
   on every deploy, so accounts, subscriptions, and the usage ledger would be
   lost. Production must use a hosted libSQL database (Turso, free tier is fine)
   and set WORKCREW_DATA_URL to the libsql URL plus WORKCREW_DATA_AUTH_TOKEN.
2. Real billing. BILLING_MODE=stripe with the Stripe secret key, the four price
   ids, and the webhook secret.
3. Auth decision. Either the local provider (AUTH_MODE=local with a
   WORKCREW_LOCAL_AUTH_SECRET) or Supabase (AUTH_MODE=supabase). Password reset
   by email needs either Supabase or a transactional email sender.
4. The desktop app must be able to point at the hosted backend URL.

## Render web service settings

- Runtime: Node (Node 20 or newer).
- Root Directory: leave blank (the repository root). The backend is part of an
  npm workspaces monorepo and depends on the shared contracts package, so it
  must build from the root, not from apps/api.
- Build Command:
  `npm install && npm run build -w @workcrew/contracts && npm run build -w @workcrew/api`
- Start Command:
  `node apps/api/dist/server.js`
- Health Check Path: `/health`
- Port: do not set a port value. Render injects PORT and the server already
  reads it. You must set HOST to 0.0.0.0 (see env vars) so Render can reach it.

## Webhook path

The Stripe webhook route is `/v1/billing/webhook`.

After Render gives you a URL like `https://workcrew-backend.onrender.com`, the
full Stripe webhook URL is:

`https://workcrew-backend.onrender.com/v1/billing/webhook`

## Environment variables to set in Render (paste in Render, never in chat)

Required:
- `NODE_ENV` = `production`
- `HOST` = `0.0.0.0`
- `BILLING_MODE` = `stripe`
- `AUTH_MODE` = `local` (or `supabase` if we wire Supabase auth)
- `WORKCREW_LOCAL_AUTH_SECRET` = a 64 character random hex string (only if
  AUTH_MODE is local). Generate with:
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `WORKCREW_DATA_URL` = your Turso libsql URL (libsql://...)
- `WORKCREW_DATA_AUTH_TOKEN` = your Turso auth token
- `STRIPE_SECRET_KEY` = sk_test_... (then sk_live_... when going live)
- `STRIPE_WEBHOOK_SECRET` = whsec_... (added after you create the webhook)
- `STRIPE_PRO_MONTHLY_PRICE_ID` = price_...
- `STRIPE_PRO_YEARLY_PRICE_ID` = price_...
- `STRIPE_ULTRA_MONTHLY_PRICE_ID` = price_...
- `STRIPE_ULTRA_YEARLY_PRICE_ID` = price_...
- `ANTHROPIC_API_KEY` = sk-ant-...

If AUTH_MODE is supabase:
- `SUPABASE_URL` = https://...supabase.co
- `SUPABASE_ANON_KEY` = the anon public key

Optional (defaults exist):
- `ANTHROPIC_HAIKU_MODEL`, `ANTHROPIC_SONNET_MODEL`, `ANTHROPIC_OPUS_MODEL`
- `WORKCREW_ALLOWED_ORIGINS` (only matters for browser callers)

Note: with NODE_ENV=production the server refuses to start if any required
Stripe or Anthropic value is missing, if a developer bypass flag is on, or if
BILLING_MODE is still simulated. This is intentional and safe.

## Owner click and paste checklist (only when readiness is met)

1. Create a private GitHub repository and push the code (there is no remote yet).
2. Create a Turso database, copy its URL and auth token.
3. Create the four Stripe prices (or let me script them with your test secret key).
4. Create the Render web service with the settings above.
5. Paste the environment variables (leave STRIPE_WEBHOOK_SECRET out for the first deploy).
6. Deploy, then copy the Render URL.
7. In Stripe, add the webhook endpoint using the full webhook URL above, select
   the subscription and checkout events, and copy the whsec_ signing secret.
8. Paste STRIPE_WEBHOOK_SECRET into Render and redeploy.
9. Point the desktop app's backend URL at the Render URL.
10. Send a Stripe test event and confirm success.
