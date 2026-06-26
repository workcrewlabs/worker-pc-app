# WorkCrew Security Policy

## Security principles

WorkCrew uses least privilege, explicit authorization, server controlled entitlements, short data lifetimes, and fail closed production configuration.

## Secret boundaries

1. Anthropic and Stripe secret keys must exist only in the backend secret manager.
2. Supabase anonymous keys may be public, but service role keys must never enter the desktop app.
3. Desktop sessions are encrypted with the Windows Data Protection API through Electron secure storage.
4. Refresh tokens never enter the renderer process.
5. Logs must never contain authorization headers, cookies, passwords, recovery codes, payment card numbers, or complete page snapshots.

## Automation boundaries

The desktop accepts typed actions from `@workcrew/contracts`. Playwright Agent CLI commands that can execute JavaScript, read cookies, export authentication state, mutate storage, or route network traffic are not exposed. Browser interaction uses accessibility references from the latest snapshot. The pywinauto helper exposes no shell, process launch, file deletion, registry access, or arbitrary Python execution.

The first release asks for approval before browser and Windows write actions. Consequential actions such as purchases, sending messages, publishing, deleting, permission changes, financial activity, and security changes should remain blocked until a dedicated policy and confirmation flow exists.

## Production controls

1. Set `NODE_ENV=production`.
2. Keep all development bypass variables unset.
3. Store production secrets in the hosting provider secret manager.
4. Restrict Cross Origin Resource Sharing to approved origins.
5. Terminate transport security at a trusted proxy and use HTTPS only.
6. Verify Stripe webhook signatures and reconcile events.
7. Enable multifactor authentication for vendor and administrator accounts.
8. Use separate development, staging, and production projects.
9. Enable database backups and test restoration.
10. Sign the Windows installer and every update package.
11. Add error monitoring with sensitive data collection disabled.
12. Complete a threat model and independent security review before public launch.

## Data retention

Browser snapshots and native window inspection results should remain ephemeral unless the user explicitly saves an artifact. Production retention jobs should remove completed run details according to the published privacy policy. Account deletion must remove or anonymize user data after legally required billing records are separated.

## Access control matrix

Roles and what each may do. The backend is the only database client, so every row in this table is enforced by server-side checks (authentication plus ownership-scoped queries), not by client trust.

| Capability | Unauthenticated visitor | Authenticated user | Admin | Stripe webhook | Background worker (scheduler) | Desktop app client |
| --- | --- | --- | --- | --- | --- | --- |
| Load public pages (`/`, `/health`, `/reset`, `/billing/success`, `/billing/cancel`) | Yes | Yes | n/a | n/a | n/a | Yes |
| Sign up, sign in, refresh, sign out, password reset, email verify | Yes (IP rate limited) | Yes | n/a | No | No | Yes |
| Read or modify ANY record (conversation, run, attachment, subscription, usage) | No | Only their own (queries scoped by the verified `user_id`) | No special path exists | No | Only the owning user's, server-initiated | Only the signed-in user's |
| Start a run, advance a run step, send a chat turn, upload an attachment, summarize a recording | No | Yes, if subscription is active and within budget caps | n/a | No | The owning user's scheduled run only | Yes, as the signed-in user |
| Spend model tokens / trigger paid AI work | No | Yes, bounded by the 5-hour, daily, and monthly caps | n/a | No | Bounded by the same caps | Yes, bounded by the same caps |
| Create checkout, change plan (upgrade pays first via a hosted Stripe page), open billing portal | No | Yes, for their own account only | n/a | No | No | Yes, for the signed-in account |
| Grant credits / mark a subscription active | No | No (cannot self-grant) | No client path | Yes, only after Stripe signature verification; event-guarded and one-shot per referred user | No | No |
| Choose price IDs / amounts | No | No (server reads them from config/catalog) | n/a | No (server-set metadata only) | No | No |
| Read server secrets (Stripe secret, webhook secret, `DATABASE_URL`, service role, Anthropic key) | No | No | No | No | No | No (backend only; never shipped to the client) |

Notes:
- There is no admin HTTP surface today. No route grants elevated access based on a client-supplied flag. If an admin capability is added later, it must check a server-side role, never a request field.
- "Stripe webhook" and "background worker" are server contexts, not callers a user can impersonate: the webhook is signature-verified and the worker runs in the backend on behalf of the owning user.
- The desktop client has no privileges of its own; it acts strictly as the signed-in user and, in packaged builds, may only talk to the official backend origin.

## Accepted tradeoffs (reviewed, not defects)

1. Stateless access tokens (local and Supabase) have a one-hour TTL and are not checked against the session table on every request, so sign-out and session revocation invalidate future refreshes immediately but an already-issued access token remains valid until it expires. Bounded by the short TTL. Mitigate by shortening the TTL or carrying a session/token version if immediate revocation becomes required.

## Vulnerability response

Do not publish a private vulnerability in a public issue. Production launch documentation must name a monitored security contact, response owner, severity policy, customer notification process, and emergency shutdown procedure.
