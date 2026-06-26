# WorkCrew engineering rules

WorkCrew is a Fastify backend (`apps/api`), an Electron desktop app (`apps/desktop`), and shared contracts (`packages/contracts`). The backend is the ONLY database client; the desktop app talks to it over HTTPS and holds no server secrets.

## Security rules (always apply)

These are hard requirements. When writing or changing code, follow every one of them. See `SECURITY.md` for the access-control matrix and accepted tradeoffs.

1. Never trust client input. Validate every request body, query, route param, and relevant header with a zod schema (use `.strict()` so unexpected fields are rejected) before using it. Bound every string, array, and number. This applies to webhook payloads too, after the signature is verified.
2. Never put secrets in frontend or desktop code. Stripe secret key, Stripe webhook secret, `DATABASE_URL`, Supabase service role key, and the Anthropic key are backend only. Any third-party call that spends money or uses a secret runs on the backend, never in the renderer or desktop main process.
3. Every protected route must authenticate. Derive the user id ONLY from the verified token (the `sub` claim via `authenticate()`), never from a `user_id` field, query param, or header sent by the client.
4. Every data access must check ownership. Scope every query by the authenticated `user_id` (e.g. `WHERE id = ? AND user_id = ?`). Being logged in is not enough; confirm this user owns this record. Do not add a route that gates authorization on a client-supplied flag.
5. Every public endpoint needs rate limiting. The global limiter keys on the verified user id (authenticated) or client IP (pre-auth). Add a stricter per-route `routeLimit(n)` to expensive or sensitive routes (auth, billing, referral, model runs, attachments). Never key a rate limit on a raw, client-controlled header.
6. Every expensive action needs usage limits. Model runs, chat, and attachments must require auth and an active subscription and must reserve against the 5-hour, daily, and monthly budget caps (`reserveBudget`). A failed turn must release, not settle, its reservation.
7. Every payment or credit write must be idempotent. Verify the Stripe webhook signature against the raw body before reading any metadata, and make every handler safe to replay (guard by `stripe_events`; the `usage_ledger.dedupe_id` unique index enforces single-grant for any credit row). Grant a credit only through a single guarded write (the referral credit is one-shot per referred user). A plan upgrade grants the higher tier only from the post-payment `subscription.updated` webhook, never on the click.
8. Prefer least privilege. Use the narrowest key, scope, and capability that works. Pin dependencies (no `"latest"`) and keep the lockfile committed.
9. Validate environment variables at startup. In production, fail fast (throw) on missing or malformed critical config: durable `DATABASE_URL`, a live (`sk_live_`) Stripe key, an https non-localhost public URL, the auth secret, and no development bypasses or simulated billing.
10. Log security events safely. Emit a distinct log line for failed auth, rate-limit hits, webhook signature failures, and payment/credit events, including only codes, ids, masked email, and IP. Never log passwords, tokens, full API keys, payment details, or the database URL.
11. Do not expose sensitive errors to users. Return a generic message for 5xx and log the detail server-side; only return safe, specific messages for client (4xx) errors.

## Other conventions

- Match the surrounding code style; keep comments at the existing density and explain the why.
- Tests live next to the code (`*.test.ts`); run `npm run typecheck` and the relevant workspace `test` before considering a change done. There is no ESLint config; the TypeScript compiler is the linter.
- The desktop automation surface only accepts the typed actions in `@workcrew/contracts`; do not widen it to arbitrary shell, JavaScript, or file access without an approval gate.
