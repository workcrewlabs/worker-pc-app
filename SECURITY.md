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

## Vulnerability response

Do not publish a private vulnerability in a public issue. Production launch documentation must name a monitored security contact, response owner, severity policy, customer notification process, and emergency shutdown procedure.
