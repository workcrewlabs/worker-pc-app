# WorkCrew

WorkCrew is a secure Windows automation assistant. It combines the Playwright Agent CLI for browser work, pywinauto for native Windows controls, Claude for planning, and Stripe for paid access.

The repository currently contains a functional local MVP with mock billing and mock model responses. The mock mode never calls a paid API. Production mode fails during startup if identity, billing, or model credentials are missing.

## Plans

1. Pro costs $27 monthly or $270 yearly. The everyday gate is a rolling 5-hour cap (about three to four high-effort messages, frees as the window rolls), with a monthly backstop of $12 of model usage.
2. Ultra costs $200 monthly or $2,000 yearly. It uses the same rolling 5-hour model with a higher monthly backstop of $60 of model usage.
3. Annual plans include two months free. Annual payment does not combine the model allowance into one yearly pool.
4. There is no free plan and no trial.

## Local test

Requirements are Node.js 20 or newer and Windows 10 or Windows 11.

```powershell
npm install
npm run dev
```

The app opens at the payment screen because the local development identity is already authenticated. Annual billing is selected by default. Choose either test plan. Enter a task and run it. The mock planner opens `https://example.com` through the Playwright Agent CLI, then finishes without calling Claude.

The Playwright CLI downloads its Chromium browser on first use. This can take several minutes.

## Windows helper

Python is needed only to build the pywinauto helper.

```powershell
.\scripts\build-windows-agent.ps1
```

After the build, set this local value before starting WorkCrew:

```powershell
$env:WORKCREW_WINDOWS_AGENT="$PWD\python\windows-agent\dist\workcrew-windows-agent.exe"
```

The helper binds only to `127.0.0.1`, requires a random 256 bit launch token, accepts only validated JSON actions, and does not expose a shell or arbitrary Python execution.

## Production configuration

Copy the required production values from `.env.example` into a secure secret manager. Do not package secrets into Electron or commit them to Git.

Required external services are:

1. Supabase Auth for sign up, email verification, sessions, and password reset. Its free plan can support initial testing.
2. A libSQL database. Local SQLite works for development. A remote libSQL provider can be used for initial hosted testing.
3. Stripe Checkout, Billing, Customer Portal, and signed webhooks. Stripe has transaction fees even though it does not require a normal monthly software fee for basic payments.
4. Anthropic API access. This is variable cost and is limited by the WorkCrew budget ledger.
5. A Node.js host for the API. Free plans may be useful for a private test, but a paid service with uptime guarantees is appropriate before accepting customers.
6. A transactional email sender for production password and verification mail.
7. Windows code signing for public installers.

Provider free plans and limits can change. Production must not silently fall back to development bypasses when a free quota ends.

## Build commands

```powershell
npm run typecheck
npm test
npm run build
npm run package -w @workcrew/desktop
```

The unsigned local installer is written to the desktop release directory. Public distribution requires an authorized code signing identity.

## Security model

1. Claude and Stripe secrets exist only in the backend.
2. Paid entitlement is verified before run creation and before every model step.
3. Model cost is reserved atomically before each provider call.
4. Annual subscriptions receive monthly budget windows.
5. Renderer sandboxing and context isolation are enabled.
6. Authentication tokens are encrypted with Windows secure storage.
7. Browser automation uses an allowlisted subset of the Playwright Agent CLI.
8. Code execution, cookie commands, authentication export, storage mutation, and arbitrary selectors are blocked.
9. Browser URLs are restricted to HTTP and HTTPS.
10. Browser and Windows write actions require a visible one time approval.
11. The pywinauto helper is local only and authenticated per launch.
12. Logs and tool results redact common credential and payment patterns.

Read [SECURITY.md](SECURITY.md) before enabling real accounts or accepting payments.

## Repository

```text
apps/api                 Secure billing, entitlement, usage, and Claude service
apps/desktop             Electron and React Windows application
packages/contracts       Shared validation, plans, and action schemas
python/windows-agent     Local pywinauto helper
scripts                  Build automation
```

## Current launch boundary

The local MVP can be tested now. A public launch still requires real vendor accounts, Stripe eligibility, company and bank verification, a domain, email configuration, code signing, legal review, and a paid beta. Those activities require the company owner's identity and authorization.
Pre-launch security review.
