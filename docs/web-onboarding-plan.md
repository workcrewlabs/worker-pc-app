# WorkCrew web version + onboarding + free tier: build plan

Owner request (2026-07-17): onboarding exactly like Claude's (screenshots in
`D:\BUSSINESS AI TRAINING\ssapp\`), a free tier granted ONCE PER MONTH (not
daily) capped at $0.30 of token spend per user, then upgrade. A web (browser)
version that does chat and file generation (Excel etc.) like claude.ai, pushes
users to upgrade and to download the desktop app, and shows the recorder,
browser automation, and computer automation entry points but gates them with
"Download the app to use this" linking to the download page. Onboarding on BOTH
the website and the desktop app.

## Reference design (from the screenshots)

1. Landing: serif hero ("Think fast, build faster" style), sign-up card with
   Continue with Google / Continue with email. WorkCrew equivalent: email
   sign-up (existing auth), Google optional later.
2. Onboarding step "Get the most out of WorkCrew on your desktop": three
   columns (Chat: no setup required / Automations: best on desktop / Files and
   Excel: best on desktop), a big "Download for Windows" button, and Skip.
3. Step "Before your first chat": three info bullets (ad-free, safeguards,
   privacy note) + Continue.
4. Step "What's your name?" single input.
5. Step "What kind of work do you do?" role dropdown (Student, Founder,
   Writer, Educator, Consultant, Researcher, Healthcare, Software engineer,
   Other...).
6. Step: three role-tailored starter prompt cards + "I have my own topic".
7. Main app: "Free plan · Upgrade" pill at top; model/effort picker shows
   higher tiers with an Upgrade chip (locked on free).
8. Pricing page: Free / Pro / Ultra cards ("Plans that grow with you" layout).
9. When free budget is used: "Upgrade to keep chatting" modal with feature
   cards, "Not now" and "Explore plans", noting the limit resets next month.

## Decisions

- Free tier: new plan `free` in PLAN_CATALOG with monthlyApiBudgetMicrodollars
  = 300_000 ($0.30), dailyMicrodollars = same 300_000 (no daily gate beyond
  monthly), granted automatically at sign-up WITHOUT a card, once per user
  (subscription row created on first sign-in; monthly window resets by the
  existing budget anchor, so each calendar month they get $0.30 again; the
  owner said "once per month then upgrade", which the monthly budget window
  already models).
- Economy engine serves free users (GLM) so $0.30 goes far; same budget
  ledger, reservations, and caps as paid (security rule 6 already enforced).
- requireActive() currently rejects non-active subscriptions; free rows are
  status "active", plan "free", with no Stripe fields. Upgrade converts via
  the existing hosted-checkout flow (grant on webhook only, rule 7).
- Gate on web + free: model picker shows opus/fable tiers locked with Upgrade
  chip (plan-driven); automations and recorder allowed only on desktop.
- Web app: reuse the existing renderer React app with a WEB BRIDGE: a
  `window.workcrew` shim (new `apps/desktop/src/renderer/src/lib/web-bridge.ts`
  or separate `apps/web` build target) implementing:
    - auth via /v1/auth/* REST (tokens in memory + refresh in localStorage),
    - chat via fetch + SSE reader on /v1/chat,
    - conversations/attachments/entitlement via REST,
    - files.pick* via <input type=file>, no local paths; folder features
      hidden on web,
    - automation.execute / recorder / windows / browser: throw a typed
      DESKTOP_ONLY error; UI catches it and shows the download-gate modal.
  Build with a Vite web config (electron-vite renderer already is Vite) and
  env WORKCREW_WEB=1 to switch bridges; deploy as static site (Render static
  or same host as backend) with CORS already handled by the backend's
  allowed-origins config.
- Onboarding UI: one OnboardingFlow component (steps above), shared by web
  and desktop; state saved to localStorage (workcrew:v1:onboarding) and the
  name/role sent as chat context for personalization (context field exists).
  Desktop skips the "download the app" step; web shows it first with the
  Download for Windows button linking to the site download page.
- CORS: backend WORKCREW_ALLOWED_ORIGINS must include the web app origin.
- Rate limiting: sign-up already rate-limited (authLimit(8)); free tier makes
  abuse cheap, so keep per-IP sign-up limits and consider email verification
  REQUIRED for free credit (existing WORKCREW_REQUIRE_EMAIL_VERIFICATION
  supports this; production has it on).

## Phases

1. Backend free tier: PLAN_CATALOG `free` plan ($0.30/month, daily = monthly),
   auto-grant subscription row on first sign-in (guarded, idempotent),
   requireActive allows plan free, entitlement payload exposes plan "free" so
   the UI can show the Free banner and locked models. Tests: grant once only,
   budget cap enforced at $0.30, upgrade path unaffected.
2. Desktop onboarding: OnboardingFlow (name, role, before-first-chat,
   role-tailored starter prompts) shown once after first sign-in.
3. Web bridge + web build of the renderer with feature gates (download-gate
   modal on recorder/automation, upgrade pill, locked models, upgrade-to-keep-
   chatting modal on budget errors: backend already returns BUDGET_EXHAUSTED /
   RATE_LIMIT_DAY codes).
4. Website wiring: pricing page reflects Free/Pro/Ultra, download page, web
   app hosted at app.getworkcrew.com (owner deploys DNS; static hosting on
   Render).
5. Full verification (CDP for desktop, Playwright-style CDP for web) and
   release: backend deploy first, then desktop, then web.

## Free trial: ONE-TIME, never resets (owner clarification 2026-07-17)

The owner changed the free tier from "monthly reset" to a TRUE one-time trial:
$0.30 of tokens granted once at sign-up, and when spent the user is blocked
forever (no daily, no monthly reset) until they upgrade. Implemented via
`budgetWindowFor(subscription, now)` in budget.ts: the free plan uses a single
fixed window [anchor, anchor + 100 years] instead of the rolling monthly window,
so every ledger row shares one period and all usage counts against the one cap;
once reached it stays reached. Used in budgetHeadroom, reserveBudget, and the
two display paths in server.ts. Free exhaustion always reports the upgrade
message (never "free up tomorrow"). UI: header shows a single "Free trial · N
left" bar (not Today/Month), UpgradeWallModal free copy says the trial is
one-time and does not reset, and the budget-error matcher catches "all your
free tokens". Verified: fresh sign-up entitlement shows plan free, budget
300000, period end year 2126; new tests prove the window never rolls and a
spent account stays BUDGET_EXHAUSTED 90 days later.

Rough capacity: economy engine (glm) ~1.4/4.4 microdollars per input/output
token, so $0.30 buys roughly 100-250 short chat messages, fewer for long
answers or file generation. The exact count shows live in the Free trial bar.

## Status

- [x] Phase 1 backend free tier: DONE 2026-07-17. free plan in PLAN_CATALOG
  ($0.30/month, no daily pacing), paidPlanIdSchema so checkout/change-plan
  only accept pro/ultra, grantFreeSubscriptionIfAbsent (INSERT-if-absent,
  never clobbers paid) called lazily from subscriptionState, change-plan
  falls back to fresh checkout for free users, CHECK-constraint migration for
  both dialects (pg constraint swap, sqlite table rebuild), free-tier.test.ts
  green (grant idempotent, paid untouched, $0.30 ledger cap).
  Original phase notes: STARTED 2026-07-17. Done: `free` plan in
  PLAN_CATALOG ($0.30 monthly, daily = monthly so no daily pacing),
  `paidPlanIdSchema` split so checkout/changePlan only accept pro/ultra
  (compiler-enforced in billing.ts createCheckout + changePlan + priceId),
  contracts rebuilt, full typecheck green. NEXT: auto-grant a free
  subscription row on first sign-in (idempotent, status active, plan free, no
  Stripe fields, currentPeriodEndMs far future), requireActive stays as is
  (free rows are active), entitlement already carries plan so the UI can show
  the Free banner; then tests (grant once, $0.30 cap enforced, upgrade path
  unchanged, webhook still sole granter of paid tiers).
- [x] Phase 2 desktop onboarding: DONE 2026-07-17 (visual pass pending in
  Phase 5). OnboardingFlow.tsx (before-first-chat, name via auth.setName,
  role dropdown, 3 role-tailored starter prompts + own topic; optional
  download step for web via showDownloadStep). Stored at
  workcrew:v1:onboarding; starter prompt seeds the composer once via
  takeOnboardingStarter in Workspace mount. Renders instead of Workspace
  when not done. ob-* styles in styles.css.
- [~] Phase 3 web bridge + gates: bridge DONE 2026-07-17, gates REMAINING.
  Done: lib/web-bridge.ts (full WorkCrewBridge over REST: auth with refresh
  token in localStorage + access in memory, SSE chat streaming with abort,
  conversations/entitlement/billing incl. window.open for hosted pages,
  attachments via base64 POST with a pseudo-path File registry, files.save
  via browser download using generateExport which is now browser-safe
  (uint8array when Buffer is undefined), DesktopOnlyError with code
  DESKTOP_ONLY for recorder/automation/folders/dictation);
  src/renderer/src/main-web.tsx entry installing the bridge;
  web/index.html + vite.web.config.ts (root=web, outDir=dist-web, port
  5190); npm scripts web:dev / web:build. All typechecked.
  REMAINING for Phase 3: catch DESKTOP_ONLY in the UI at the trigger points
  (record button, automation runs, folder pick/drop) and show a
  download-the-app modal linking to getworkcrew.com/#download; on web show
  the onboarding download step (OnboardingFlow showDownloadStep) and hide
  folder menu items; Free-plan UI for both web and desktop (Free plan pill
  with Upgrade, upgrade-to-keep-chatting modal on BUDGET_EXHAUSTED /
  RATE_LIMIT_DAY errors, locked higher models per plan); backend
  WORKCREW_ALLOWED_ORIGINS must include the web origin; verify web:build
  and run the app in a browser end to end (sign-up, free grant, chat,
  Excel download, gates).
- [x] Phase 3 gates: DONE 2026-07-17 and browser-verified end to end
  (sign-up, free grant, web onboarding with download step, chat streaming,
  Excel generated + downloaded in-browser, High effort locked on free,
  record/automation/folder all show the download-the-app modal, folder item
  stays visible). SSE CORS fix: /v1/chat writes raw headers, so the route now
  attaches Access-Control-Allow-Origin itself for allowlisted origins.
- [ ] Phase 4 deploy: web build (dist-web) needs hosting (e.g. Render static
  site at app.getworkcrew.com) with VITE_WORKCREW_API set at build time and
  the origin added to WORKCREW_ALLOWED_ORIGINS on the backend; the marketing
  site pricing page update (Free plan card) is owner content.
- [x] Phase 5 verification: desktop onboarding CDP-verified (4 steps,
  screenshots ob-1..4), web app browser-verified, all suites green.
  RELEASE still pending owner test round (free tier backend must deploy
  BEFORE or WITH the desktop/web releases; the desktop 0.1.23 must not ship
  before the backend, same ordering rule as 0.1.22).

Uncommitted dev gates in the worktree (do NOT ship): WORKCREW_DEV_CDP,
WORKCREW_DEV_AUTOLOGIN, WORKCREW_DEV_MINIMIZED in apps/desktop/src/main/index.ts.
The write_file + coding/Excel reliability work from 2026-07-16/17 is also
uncommitted and must be committed (without the dev gates) before release.
