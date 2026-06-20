# WorkCrew MVP Product and Launch Plan

Status: Proposed for approval

Date: June 20, 2026

Product name: WorkCrew

## 1. Executive recommendation

WorkCrew should be a paid Windows automation assistant that turns a plain language request into browser and desktop actions. The public product should not be called a Claude wrapper. Claude is an important model provider, but the product value is the secure task engine, Windows automation, billing controls, workflow memory, and user experience.

The desktop app should have one primary workspace, inspired by the simplicity of the supplied Cowork reference without copying its branding, icons, wording, or exact layout. Authentication, billing, permissions, settings, and run details should appear as dialogs or side panels. Legal pages, payment callbacks, and password reset links still require supporting web routes.

The first release should be Windows only. Electron, React, and TypeScript should power the desktop shell. Playwright should automate browsers through its Node library. The Playwright command line tools should remain available for development, recording, diagnostics, and tests. A bundled Python process should run pywinauto for native Windows applications. A cloud service should own Claude API access, subscriptions, entitlements, usage accounting, orchestration, and audit data.

There should be no free plan and no free trial. An account without a paid and active entitlement must never be allowed to call Claude through WorkCrew.

## 2. Naming direction

The approved product name is **WorkCrew**. It directly communicates that the app is a capable group of automated workers for browser and Windows tasks. The initial line is: **Put routine work on autopilot.**

Other candidates are:

1. Orin, which feels human and direct.
2. Tovi, which feels friendly and compact.
3. Veyra, which feels capable and modern.
4. Marlow, which feels warm and established.
5. Nolio, which feels distinctive and approachable.

WorkCrew is not legally cleared. Before public release, the name needs a trademark search, company registry search, domain review, social handle review, and common law conflict review in intended markets. Claude and Anthropic should appear only in factual provider disclosures.

## 3. Product promise

WorkCrew lets a paying user describe a task, review what will happen when needed, and allow the app to complete browser and Windows actions on the user's computer.

The first release should handle three workflow classes:

1. Browser workflows, such as navigating sites, filling ordinary forms, collecting information, downloading files, and updating web tools.
2. Windows workflows, such as organizing files and operating accessible controls in common desktop applications.
3. Mixed workflows, such as downloading a report in a browser, moving and renaming it in File Explorer, opening it in a desktop application, and producing a summary.

The app should not claim universal control of every Windows application. pywinauto depends on Win32 or Microsoft UI Automation exposure. Custom canvas controls, elevated applications, secure desktop prompts, locked sessions, remote sessions, and applications with poor accessibility trees can prevent reliable automation.

## 4. Plans and unit economics

### Pro

Price: $27 per month

Annual price: $270 per year, equal to two months free

Maximum Claude API cost per billing cycle: $6.75

Suggested product limits:

1. One Windows device.
2. One active run.
3. Saved workflows and local schedules.
4. Haiku for low complexity steps.
5. Sonnet for normal planning and execution.
6. Opus only when the model router decides that the task needs it, or when the user explicitly selects deep reasoning and has enough budget.

### Ultra

Price: $200 per month

Annual price: $2,000 per year, equal to two months free

Maximum Claude API cost per billing cycle: $50.00

Suggested product limits:

1. Five Windows devices.
2. One interactive desktop run per device.
3. More saved workflows and schedules.
4. Sonnet as the normal planning model.
5. Haiku for utility work.
6. Opus for complex planning and recovery when sufficient budget remains.
7. Priority run orchestration and support.

There are no overage charges and no automatic top ups in the MVP. When the API budget is exhausted, new model calls stop until the next paid billing cycle. Local viewing, exports, account access, and billing access remain available.

The current model prices used for initial planning are:

1. Claude Haiku 4.5 at $1 per million input tokens and $5 per million output tokens.
2. Claude Sonnet 4.6 at $3 per million input tokens and $15 per million output tokens.
3. Claude Opus 4.8 at $5 per million input tokens and $25 per million output tokens.

Model names and prices must be configuration data, not constants in the desktop app. A model registry in the backend should support price effective dates, model retirement, aliases, feature flags, and immediate routing changes.

The 25 percent rule applies only to model API cost. It does not create a 75 percent net profit margin. Payment fees, hosting, email, monitoring, storage, taxes, refunds, disputes, support, and company expenses still reduce profit. The finance dashboard must report revenue, Claude cost, infrastructure cost, refunds, payment fees, gross margin, and estimated contribution margin separately.

## 5. Exact budget enforcement

Every model call must pass through the backend. The Claude API key must never be included in the installer, desktop files, logs, or client network responses.

The usage ledger should store money in integer microdollars. Before a call, the service should atomically reserve the worst permitted cost for known input, cache writes, and maximum output. Concurrent calls must lock the billing cycle budget so they cannot spend the same remaining balance. After the provider response, the service should settle the reservation against actual usage and release the difference.

The router should reduce the maximum output, choose a cheaper model, summarize context, or deny the call when the remaining budget cannot cover the reservation. Retries, tool loops, cache writes, cache reads, failed calls that are billed, and background model work must all use the same ledger.

Each usage row should contain the user, subscription, billing cycle, run, provider request identifier, model, price version, token categories, reserved cost, actual cost, status, and idempotency key. Reconciliation should compare the internal ledger with Anthropic usage reports each day.

The workspace should show a simple usage meter with the amount used, amount remaining, reset date, and the likely effect of choosing deep reasoning. It should never describe either plan as unlimited.

## 6. User experience

### Primary workspace

The app should open to one focused workspace after entitlement verification.

1. A compact left rail contains New task, Workflows, Scheduled, History, Help, and Account.
2. The center contains a large task composer, attachment button, folder selector, action mode, and automatic model selection.
3. Starter prompts show common tasks, such as organizing downloads, collecting information from a site, updating a spreadsheet, and preparing a daily report.
4. A running task replaces the starter prompts with a live timeline of plan steps, tool actions, approvals, outputs, warnings, and recovery attempts.
5. Persistent Pause and Stop controls remain visible during every run.
6. Account, billing, permissions, usage, and settings open in panels or dialogs so the app still feels like one page.

The visual identity should use its own color system, typography, icon set, spacing, and voice. The reference can guide density and hierarchy, but the final interface must not be a clone.

### Action modes

1. Ask mode lets the model explain and plan without taking actions.
2. Act mode executes ordinary allowed actions and asks before sensitive actions. This is the default.
3. Trusted workflow mode executes a previously reviewed workflow within explicit app, site, folder, and action boundaries.

Irreversible deletion, purchases, sending messages, publishing, financial actions, credential changes, permission changes, and submission of sensitive forms always require a final user confirmation in the MVP.

## 7. Authentication and hard paywall

Supabase Auth is the recommended MVP identity service because it provides password security, email verification, session management, reset flows, and PostgreSQL integration without building a password system from scratch. Production email should use a dedicated sender through Resend, Postmark, or an equivalent service.

The desktop authentication flow should use system browser sign in with Proof Key for Code Exchange and a registered application deep link. The app should never collect a reusable web session from an embedded browser.

Required account features are:

1. Email and password sign up.
2. Email ownership verification.
3. Sign in and sign out.
4. Forgot password email.
5. Reset password completion.
6. Session refresh.
7. Sign out from all devices.
8. Device list and device revocation.
9. Account deletion request.
10. Rate limiting, bot protection, and suspicious login controls.

The entitlement flow is:

1. The user installs and opens WorkCrew.
2. The app requires sign in or account creation.
3. The app requests an entitlement from the backend.
4. An account without an active plan sees only Pro and Ultra purchase options, account controls, legal links, and support.
5. Stripe Checkout opens in the system browser.
6. A signed Stripe webhook updates the subscription in the backend.
7. The app receives the new entitlement through polling or a secure real time channel.
8. The workspace unlocks only after the backend reports an active paid entitlement.

The Checkout success redirect is not proof of payment. Only verified webhook state can grant access. Subscription states such as incomplete, unpaid, canceled, paused, disputed, or expired must be locked. A failed renewal should lock model use according to a clearly disclosed payment recovery policy. The strict interpretation of the requested hard paywall is immediate lock when Stripe marks the entitlement inactive.

## 8. Stripe billing

Stripe Checkout should create subscriptions. Stripe Billing should own invoices and renewal state. Stripe Customer Portal should handle card changes, invoice history, cancellation, and plan changes.

The backend must process at least these event families:

1. Checkout completion.
2. Subscription creation, update, pause, resumption, and deletion.
3. Invoice paid and invoice payment failed.
4. Refund, dispute, and dispute resolution.
5. Customer deletion where applicable.

Every webhook must verify its signature, store the provider event identifier, be idempotent, tolerate events arriving out of order, and return quickly before asynchronous processing. A reconciliation job should repair missed or delayed events from Stripe.

The MVP should use monthly prices in United States dollars, no coupon codes, no trial, no prorated usage credit, and no metered overages. Plan upgrades can take effect immediately after successful payment. Downgrades and cancellations should take effect at the end of the paid period unless a refund policy requires otherwise.

If the operating company is based in Lebanon, Stripe is currently a launch blocker because Lebanon is not on Stripe's supported country list. The owner must use a legitimate company and bank relationship in a supported jurisdiction, or approve another payment provider. Identity, company, tax, and bank verification cannot be completed by the software agent on the owner's behalf.

## 9. Desktop architecture

### Electron shell

Electron is recommended because Playwright is a Node library and can run in the Electron main process without shipping a separate Node installation. React and TypeScript should implement the renderer. Electron Builder should create a signed Windows installer and update packages.

Security requirements include renderer sandboxing, context isolation, disabled Node integration, a strict Content Security Policy, typed and allowlisted interprocess messages, validated deep links, no remote code execution, signed updates, and secure local token storage through Windows Credential Manager.

### Browser automation

Production automation should use the Playwright Agent CLI through a constrained subprocess. The model must never provide a complete shell command. WorkCrew should map a validated action schema to a fixed CLI command and separate arguments. Commands that execute code, read cookies, export authentication state, or change browser storage remain blocked in the MVP.

Browser sessions should use dedicated WorkCrew profiles by default. Users can explicitly connect a persistent profile when they understand the security implications. Sensitive cookies and credentials must stay local. The model should receive only the smallest required page structure or image region.

### Windows automation

A signed Python side process, bundled with PyInstaller, should expose pywinauto through a private local named pipe. Each app launch should generate a short lived authentication secret for that pipe. The side process should support both UI Automation and Win32 backends, application discovery, window selection, control inspection, typed actions, screenshots, timeouts, cancellation, and structured errors.

The desktop app should never pass free form Python or shell code from the model into this process. Every action must match a versioned JSON schema and a local policy rule. Elevated applications should require an explicit elevated helper and a visible user approval. Secure desktop prompts and locked screens are out of scope.

### Local data

SQLite should hold local preferences, workflow definitions, resumable run state, and nonsecret history. Credentials and refresh tokens belong in Windows Credential Manager. Local logs should redact tokens, cookies, passwords, payment details, and sensitive form fields. Screen images should be temporary by default and deleted after the run unless the user explicitly keeps them.

## 10. Cloud architecture

The recommended backend is TypeScript with Fastify, PostgreSQL, Redis, and a durable job queue. The API and worker can deploy as separate services from the same repository. Object storage should hold only user approved artifacts and temporary encrypted automation evidence.

Core services are:

1. Identity adapter for Supabase sessions.
2. Billing and entitlement service for Stripe state.
3. Usage reservation and settlement service.
4. Model registry and routing service.
5. Run orchestrator with a durable state machine.
6. Policy service for action approvals and boundaries.
7. WebSocket gateway for plans, tool requests, tool results, streaming output, cancellation, and heartbeats.
8. Workflow and schedule service.
9. Notification service for email and desktop notifications.
10. Administration service for support, feature flags, prices, limits, and incident controls.

The desktop creates a run through a normal API request, then joins a scoped WebSocket channel. The backend asks Claude for a structured plan or next action. The desktop validates the requested tool against local policy, executes it, and returns a compact result. The orchestrator persists each transition so a connection loss can pause and safely resume rather than repeat actions.

## 11. Suggested data model

The first database should include:

1. Users and identities.
2. Devices and device sessions.
3. Stripe customers, subscriptions, prices, and webhook events.
4. Entitlements and billing cycles.
5. API usage reservations, settlements, and price versions.
6. Tasks, runs, steps, approvals, tool calls, and artifacts.
7. Workflow templates, workflow versions, schedules, and schedule runs.
8. Policy grants for sites, applications, folders, and action types.
9. Audit events, security events, support notes, and deletion requests.
10. Feature flags, model routes, and global kill switches.

Sensitive fields should be encrypted at the application layer when operational access is not required. All user owned rows need authorization checks. Administrative access must be separated, logged, and protected with multifactor authentication.

## 12. Model orchestration

The model router should use capability and cost, not merely plan name.

1. Haiku handles classification, compact extraction, short summaries, and simple next action selection.
2. Sonnet handles normal task planning, tool use, recovery, and user communication.
3. Opus handles difficult plans, repeated failures, ambiguous multistep work, and explicit deep reasoning requests when the remaining budget allows it.

The orchestrator should cap tool iterations, elapsed time, model retries, and repeated identical actions. It should detect loops, stale screens, changed page state, missing windows, authentication prompts, and unsafe requests. It should pause with a useful explanation rather than continue guessing.

Prompts and tool schemas need versions. Run records should retain the prompt version, model, policy version, and tool version so failures can be reproduced. Prompt caching should be used where it saves money, but cache writes and reads must remain in the cost ledger.

## 13. Workflow and scheduling features

Users should be able to save a successful task as a workflow, name it, edit its allowed inputs, choose a schedule, and define its approval policy. Each saved workflow should retain a versioned plan and rediscover interface controls at run time rather than replaying raw screen coordinates.

Schedules should be stored in the cloud and mirrored locally. The local app must be installed, signed in, running or launchable, connected, unlocked, and entitled before an interactive desktop schedule can run. Windows Task Scheduler can launch WorkCrew at the requested time. The run should be skipped with a notification when the computer is locked, offline, or no longer entitled.

## 14. Safety and privacy

The launch version needs a visible permission center with app, site, folder, and action scopes. Permissions should expire or remain limited to a named workflow. Users need a complete local history of what the app read, changed, downloaded, uploaded, sent, or deleted.

The app must redact password fields, payment card fields, session cookies, authentication headers, recovery codes, and protected operating system secrets before model submission. It should prevent prompt content from silently widening permissions. Instructions found on a web page or in a document are untrusted data and cannot override system policy or user grants.

Required documents are Terms of Service, Privacy Policy, Acceptable Use Policy, Refund and Cancellation Policy, Security Overview, subprocessors list, cookie notice for the marketing site, and an account deletion process. Legal counsel should review them before launch.

## 15. Reliability and observability

The system should use structured logs, distributed traces, error reporting, cost metrics, queue metrics, and privacy safe product analytics. Alerts should cover failed payments, webhook lag, budget discrepancies, Claude errors, stuck runs, crash spikes, update failures, database health, and unusual automation behavior.

Global controls should disable a model, tool, application class, domain, app version, or all automation without shipping a new desktop release. Backups need tested restoration. Production, staging, and development data and secrets must remain separate.

## 16. Administration and support

An internal administration console should provide:

1. User and device lookup.
2. Subscription and entitlement state.
3. API budget and usage ledger details.
4. Run failure summaries with redacted diagnostics.
5. Refund and dispute locks.
6. Model, price, limit, and feature flag management.
7. Account suspension and deletion workflows.
8. Audit logs and support notes.
9. Incident banners and global kill switches.

The app should include support submission, diagnostic export with user review, status page access, release notes, and a clear app version.

## 17. Testing strategy

### Automated tests

1. Unit tests cover pricing, reservations, settlements, model routing, policy checks, state transitions, and webhook ordering.
2. Contract tests cover every tool schema and interprocess message.
3. Integration tests use Stripe test clocks and signed webhook fixtures, mocked Anthropic responses, a real test database, and Supabase test users.
4. Desktop tests cover authentication, entitlement lock, updates, deep links, pause, stop, crash recovery, and corrupted local state.
5. Playwright tests cover the web flows and the Electron renderer.
6. Windows automation tests run in clean Windows 10 and Windows 11 virtual machines at common display scaling settings.
7. Security tests cover token theft, forged deep links, hostile page instructions, unsafe interprocess calls, replayed webhooks, budget races, and update tampering.

### Benchmark workflows

1. Collect structured information from a test website and export a file.
2. Fill a test form and stop before final submission for approval.
3. Organize a folder by file type and date, with a reversible preview.
4. Operate Notepad and File Explorer through UI Automation.
5. Download a report in a browser, rename it, move it, and summarize it.
6. Pause, disconnect, restart, and safely resume a run without duplicate actions.
7. Reach the API budget with concurrent requests and verify that cost never exceeds the plan cap.

## 18. Launch acceptance gates

Literal zero bug software cannot be guaranteed. Launch ready should mean these measurable conditions are met:

1. No known critical or high severity security issue.
2. No known severity one or severity two product defect.
3. No Claude request can originate from an inactive entitlement.
4. Concurrency tests demonstrate that settled plus reserved model cost cannot exceed the fixed cycle cap.
5. Stripe webhook tests handle duplicates, delays, reordering, refunds, cancellations, and failed renewals.
6. A user can sign up, verify email, pay, unlock, reset a password, manage billing, cancel, and delete the account.
7. Pause and Stop prevent further local actions within the defined response target.
8. The benchmark suite reaches at least 95 percent successful completion across the supported Windows matrix.
9. Installer, uninstaller, code signing, updates, and rollback pass on clean machines.
10. Privacy deletion, backup restoration, incident response, and support procedures have been rehearsed.
11. Monitoring and kill switches are active before the first paid user.
12. A limited paid beta completes before broad release.

## 19. Build sequence

### Phase 0, approvals and prerequisites

Approve the product name, plan limits, company jurisdiction, payment provider, supported workflow boundaries, privacy position, and visual direction. Establish legitimate vendor accounts and production credentials.

### Phase 1, repository and delivery foundation

Create the monorepo, Electron app, React interface, backend, database migrations, shared schemas, local Python process, test framework, continuous integration, environments, secrets pattern, and release pipeline.

### Phase 2, identity, billing, and paywall

Build account flows, email delivery, Stripe Checkout, Customer Portal, webhooks, entitlement state, device sessions, hard lock, plan changes, cancellation, and the usage meter.

### Phase 3, Claude orchestration and cost controls

Build the model registry, router, prompt versions, structured tool protocol, durable run engine, streaming, budget reservation, settlement, reconciliation, loop protection, and cancellation.

### Phase 4, local automation

Build Playwright tools, browser profiles, download and upload handling, pywinauto named pipe service, UI Automation and Win32 adapters, permission checks, screenshots, redaction, pause, stop, and recovery.

### Phase 5, product workflow

Complete the single workspace, history, artifacts, approvals, saved workflows, schedules, permissions center, onboarding, notifications, settings, diagnostics, and accessibility.

### Phase 6, operations and administration

Build the administration console, support tools, model and price controls, feature flags, analytics, logs, traces, alerts, backups, status page, and incident controls.

### Phase 7, validation and release

Complete threat modeling, dependency review, license notices, accessibility review, Windows virtual machine testing, load testing, cost race testing, installer signing, update testing, legal pages, support procedures, and a controlled paid beta.

## 20. Repository shape

The proposed monorepo is:

```text
apps/
  desktop/
  api/
  worker/
  admin/
  web/
packages/
  contracts/
  policy/
  billing/
  model-router/
  observability/
python/
  windows-agent/
infra/
  migrations/
  deployment/
  monitoring/
docs/
  product/
  security/
  operations/
  legal-drafts/
```

## 21. Owner actions that cannot be automated away

The engineering work, configuration templates, tests, deployment scripts, documentation, and installers can be built in this workspace. The following actions legally or technically require the business owner:

1. Approve the final name and brand.
2. Own or authorize the company and domain.
3. Complete Stripe or alternate provider identity, company, tax, bank, and beneficial owner verification.
4. Complete Anthropic account verification, accept provider terms, fund the account, and authorize production credentials.
5. Obtain and authorize a Windows code signing identity.
6. Approve prices, refund rules, tax treatment, legal documents, and restricted use policy.
7. Provide a support address and accept responsibility for customer support and disputes.
8. Approve production launch after the paid beta and acceptance report.

These steps cannot be truthfully performed by an automated coding agent because they involve legal identity, banking, contracts, or owner authority.

## 22. Approval requested

Approval of this plan authorizes implementation with these defaults:

1. Product name WorkCrew, subject to clearance.
2. Windows only MVP.
3. Electron, React, TypeScript, Playwright Agent CLI, Python, and pywinauto.
4. TypeScript cloud backend, PostgreSQL, Redis, and durable jobs.
5. Supabase Auth and Stripe Billing.
6. No free plan and no trial.
7. Pro at $27 with a $6.75 Claude budget.
8. Ultra at $200 with a $50 Claude budget.
9. One primary workspace with supporting dialogs, web callbacks, and legal routes.
10. Default Act mode with mandatory confirmation for sensitive or irreversible actions.
11. A controlled paid beta before broad launch.

Implementation should begin only after the company jurisdiction and Stripe eligibility issue is resolved, because billing is a foundational dependency of the requested hard paywall.

## 23. References checked

1. [Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing)
2. [Claude model overview](https://platform.claude.com/docs/en/about-claude/models/overview)
3. [Stripe subscriptions](https://docs.stripe.com/billing/subscriptions/build-subscriptions)
4. [Stripe Customer Portal](https://docs.stripe.com/customer-management)
5. [Stripe webhooks](https://docs.stripe.com/webhooks)
6. [Stripe global availability](https://stripe.com/global)
7. [Playwright command line documentation](https://playwright.dev/docs/test-cli)
8. [Playwright installation](https://playwright.dev/docs/intro)
9. [pywinauto getting started](https://pywinauto.readthedocs.io/en/latest/getting_started.html)
