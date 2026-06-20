I now have a complete, grounded picture of the current codebase, the reference UI, and all research findings. I have everything needed to produce the build specification.

---

# WorkCrew Build Specification

Version 2.0 (Chat-first, Claude-desktop-style). Date 2026-06-20. Status: ready to drive implementation.

This document is the single source of truth for the next build. It recaps the vision, defines the target UX screen by screen, lays out the information architecture, lists every feature, specifies the technical architecture as concrete extensions of the code that exists today, defines the data model and the full IPC and HTTP surface, and gives a phased, dependency-ordered build plan with file-level tasks suitable for parallel agent workstreams. It closes with the security model, the owner-only items, and the open risks.

File paths in this document are absolute and refer to the repository root `D:\worker pc app`.

---

## 1. Product vision recap

WorkCrew is a paid Windows desktop application that looks and feels like the Claude desktop app (chat first: ask anything, upload documents, get streamed answers) and additionally runs real automations on the user's own PC. The two halves are:

1. A Claude-quality assistant. The user opens the app to a calm, dense chat surface, types a question or drops a PDF, image, spreadsheet, or Word file, and gets a streamed, citation-grounded answer. The Anthropic API key never leaves the server.
2. A real automation engine. The same conversation can trigger actions that drive the user's real Chrome (headed, with their saved logins) through Playwright, and native Windows applications through a bundled pywinauto helper. Users can save a successful task as a recurring routine that runs on a schedule on their machine.

Access is gated by a hard paywall. There is no free tier and no trial. Two plans exist: Pro and Ultra. Payment is simulated for now (a local checkout that writes a Stripe-shaped entitlement row) and swaps to real Stripe later with no schema change. Authentication is a real sign up and sign in flow. The current dev bypass flags (`WORKCREW_DEV_AUTH`, `WORKCREW_DEV_BILLING`, `WORKCREW_MOCK_AI`) are turned OFF so auth and the paywall actually appear.

Branding is WorkCrew purple. The product keeps the structure and density of the Claude desktop app but replaces the warm orange accent with a single purple accent, uses its own logo and wordmark, and renames Claude-specific labels (for example the quick-start chip "Claude's choice" becomes "WorkCrew picks").

What ships today versus the long-term plan. The repository already contains a working automation MVP (task composer, server-side budget ledger, Playwright CLI path, pywinauto helper, Stripe billing skeleton, Supabase auth skeleton) but with mock model responses and an automation-only single-screen workspace. This spec pivots the front of the product to a Claude-style chat app, adds real streaming chat and file upload, switches the browser path from the fragile Playwright CLI subprocess to headed `connectOverCDP` against the user's real Chrome, and turns the bypass flags off so the real auth and paywall gates run. The MVP_PLAN.md remains the long-term commercial reference (unit economics, admin console, legal). This spec is the buildable next milestone that gets the product to a launchable, demoable state.

---

## 2. Target UX, screen by screen (Claude desktop parity, WorkCrew purple)

### 2.1 The density and type-scale fix (do this first, it is the most visible defect)

The current build (`apps/desktop/src/renderer/src/App.tsx` plus `styles.css`) looks zoomed in. The empty state uses an oversized hero heading (`.pricing-intro h1` clamps to 52px, the workspace `h1` is large, the brand wordmark is 22px) and spreads the greeting, composer, and suggestions far apart. The Claude reference (`refernce front end screenshots/pc app main page .png`) shows the opposite: a modest one-line greeting around 28px, a single centered cluster, thin-bordered chips, a narrow dense sidebar, and generous but tight vertical rhythm.

Concrete fixes, all in `apps/desktop/src/renderer/src/styles.css` and the relevant components:

1. Define a dense type scale as CSS variables on `:root`: `--fs-greeting: 28px`, `--fs-h2: 18px`, `--fs-body: 14px`, `--fs-ui: 13px`, `--fs-small: 12px`, `--fs-eyebrow: 11px`. The greeting heading must use `--fs-greeting` at weight 500, not a hero clamp.
2. Set the base UI font on `:root` to 14px (`font-size: 14px`) and let the rest scale from variables. Remove the `clamp(34px, 4vw, 52px)` hero rule on the chat empty state. Keep the large clamp only on the marketing or paywall hero, not the chat surface.
3. Use a serif font for message and content body (assistant answers) with `line-height: 1.65`, and keep a sans (Inter or Segoe UI) for chrome. Add `--font-serif` and `--font-sans` tokens.
4. Tighten the empty-state cluster: greeting, composer, and chip row sit in a single vertically centered column with about 18px gaps, not three far-apart blocks. Remove the dotted background grid (`.workspace::before`) or reduce its opacity so it reads as calm.
5. Set `BrowserWindow` `zoomFactor` to 1.0 explicitly and `webPreferences.zoomFactor` default; verify no implicit DPI zoom. Confirm device-independent sizing by capturing with `WORKCREW_CAPTURE` at 1440x920 and comparing density against the reference image.

### 2.2 Global layout

A persistent left sidebar (about 260px, one or two luminance steps darker than the main panel) plus a centered main column. Border-defined surfaces, no heavy shadows, no avatars in messages. Warm-neutral-shifted-slightly-cool dark palette. Window chrome stays frameless-friendly with the existing `autoHideMenuBar: true`.

Palette tokens (replace the current values in `:root`, keep variable names so components do not churn). Use the Claude luminance relationships with purple as the single accent:

- `--bg` page: `#1F1E1D` (warm near-black, very slightly cool).
- `--panel` sidebar: `#1A1917` (one step darker than page).
- `--panel-2` raised surface, composer, cards: `#27262A` lifted by border not shadow.
- `--line` borders: `#393733`.
- `--text`: `#ECEAE4`. `--muted`: `#9A938A`.
- Accent purple replaces every place orange would be in Claude. `--accent: #8B5CF6` (WorkCrew purple). `--accent-soft: #A78BFA`. `--accent-ink: #FFFFFF`. `--accent-glow: rgba(139,92,246,.16)`. The accent is reserved for the sparkle logo, the send button, the active nav item, focus rings, and the active mode tab. Everything else is neutral.

### 2.3 Left sidebar (component `Sidebar.tsx`, new)

Top to bottom, mirroring the reference:

1. Window controls row (the app already hides the menu bar). Optional collapse toggle.
2. Top mode tabs styled as the reference shows them (Chat, Cowork, Code in Claude). For WorkCrew adopt selectively: a single segmented control with **Chat** and **Agent** (Agent is WorkCrew's automation and routine mode). Do not ship Cowork or Code to avoid scope creep. Active tab uses the purple accent.
3. **New chat** with the purple WorkCrew sparkle glyph (reuse `LogoMark` shrunk, or a dedicated sparkle).
4. **Search** (search conversations).
5. **Projects** (grouping of conversations and files; see 4).
6. **Artifacts** (browsable space listing all generated outputs and run evidence).
7. **Routines** (saved recurring automations; replaces and extends today's Workflows plus Scheduled).
8. **Recents**: chronological, single-line truncated conversation titles. Below Recents, a dedicated grouped section for run sessions when in Agent mode (see 2.7).
9. Footer pinned to bottom: account and plan area (user email, plan tier label, settings access, usage meter). Clicking opens the Account dialog.

### 2.4 Chat empty state (the main page, matches the reference)

A single vertically centered cluster in the main column (the sidebar persists). From top:

1. A one-line greeting with the purple sparkle to its left, for example "How can I help you today?" or a time-aware "Afternoon, {firstName}" as the reference shows. Modest size (`--fs-greeting`, 28px, weight 500). Not a hero.
2. The composer directly under the greeting (see 2.5).
3. A row of thin-bordered transparent quick-start chips: **Write**, **Learn**, **Code**, **Life stuff**, **WorkCrew picks** (renamed from "Claude's choice"). Each chip expands into a small rotating set of concrete task templates. For WorkCrew add automation-flavored templates inside the relevant chips (for example under "Life stuff": "Organize my Downloads folder", "Collect details from a website", "Prepare a report from a file").

### 2.5 The composer (component `Composer.tsx`, new, replacing the current `.composer` block)

One bordered input, about 16px corner radius, surface one to two luminance steps above the page, border only, no shadow. Auto-growing textarea. Controls:

- Lower-left: a **+** attachment button (file picker) plus a `/` command affordance. Drag-and-drop onto the composer and clipboard paste of images both add attachments (research: three entry points).
- Attachment chips render above the input row: filename, type icon, size, and page count for PDFs, each with a remove control and a per-attachment sensitivity toggle (redaction, default off).
- Lower-right: the model name plus effort label (for example "Opus 4.8 - High"), a voice button placeholder, and the send button in the purple accent. Clicking the model name opens the model and effort popover.
- In an active conversation the composer becomes sticky at the bottom with a fade-out gradient above it.

### 2.6 Model and effort selector (component `ModelPopover.tsx`, new)

Clicking the model name opens a popover:

- Model list: Opus 4.8 (default for launch quality), Sonnet 4.6 (fast and cheap balance), Haiku 4.5 (cheapest and fastest), plus an "Auto" option that lets the server router choose. A "More models" expansion is optional.
- A four-level effort selector under the model: Low, Medium, High (labeled Default), Max. This maps to the Anthropic `output_config.effort` field (`low`, `medium`, `high`, `max`).
- An Extended Thinking toggle. When on, the server sends `thinking: { type: "adaptive", display: "summarized" }` so a "Thinking" indicator with content can render. Note for Opus 4.8: do not send `budget_tokens`, `temperature`, `top_p`, or `top_k` (they 400); control depth only via effort. Default `thinking.display` is omitted on Opus 4.8, so a naive thinking indicator renders empty unless `display: "summarized"` is set.
- Model, effort, and thinking can change mid-conversation and apply to the next turn.

### 2.7 Active chat view

The greeting and chips are replaced by the message transcript. Messages render with serif body, 1.65 line height, no avatars, borders not shadows. Assistant text streams in token by token. When Extended Thinking is on, a collapsible "Thinking" section with a timer appears above the answer. Citations render as inline superscripts or highlighted spans; clicking a citation opens the cited source attachment at the cited page (PDF `page_location`) or scrolls to the cited character range (text `char_location`). The composer is sticky at the bottom with a stop-generating control while streaming.

### 2.8 Artifacts and split view

When the assistant produces an artifact or a preview (generated document, table, code, or a run evidence screenshot), it opens in a right-docked split panel (chat left, artifact right). The artifact panel has copy, download, and view-source controls in its lower-right and a version selector to switch iterations. The sidebar Artifacts entry lists all artifacts across conversations.

### 2.9 Agent mode (automation, runs, and the run timeline)

Switching the top tab to **Agent** keeps the same chat surface but enables the automation tools and surfaces a two-surface model from the Claude Code research:

1. A live **Run view**. When a message triggers automation, the assistant first presents a plain-language plan ("Here is what I will do: 1, 2, 3") with Approve, Edit, and Cancel for the first run of any new task (plan mode). During execution a live task checklist with a sticky progress bar (percentage plus active step) ticks off human-readable steps ("Open Chrome", "Go to the report page", "Download the file"). Per-action approval prompts gate sensitive or write actions, with an "always allow for this routine" memory. Persistent Pause and Stop remain visible (the existing `automation:stop` IPC is the basis).
2. A **Routines library** (sidebar Routines). Saved configurations of prompt plus scope plus schedule plus permission policy. Each routine has a detail page with Run now, Active or Paused toggle, Edit, an "Always allowed" reviewable and revocable permissions panel, run history with honest status (succeeded, ran with issues, skipped with reason), and Delete.

Run sessions group in the sidebar (analogous to Claude's agent view) by state: Needs input, Working, Completed, Failed or Skipped, with at-a-glance status dots (animated for working, yellow for needs input, green for done, red for failed, grey for stopped). A "peek" interaction shows the latest step or the pending question without opening the full transcript.

### 2.10 Auth and paywall screens

These already exist as `AuthScreen` and `Paywall` in `App.tsx` and are well structured. Keep them but restyle to the new dense palette and type scale, drop the oversized paywall hero clamp to a calmer size, and ensure they actually appear by turning off the dev bypass flags (section 5.6). The phase machine in `App.tsx` (`loading`, `auth`, `paywall`, `workspace`) already routes correctly: unauthenticated to auth, authenticated but inactive entitlement to paywall, active to workspace.

### 2.11 Settings, account, permissions

Account, billing portal, usage, permissions center, and settings open as panels or dialogs over the chat surface so the app reads as one page. The existing `AccountDialog`, `PermissionsPanel`, `HistoryPanel`, `WorkflowsPanel`, `ScheduledPanel` components are the seeds. Workflows and Scheduled merge into Routines. History merges into Recents and run history. Permissions becomes the consent and scope center (browser profile consent, per-routine scopes, network policy).

---

## 3. Information architecture and navigation

Primary axis is the top mode tab: **Chat** (default) and **Agent**. Within each, the left sidebar is the navigation spine.

- Chat as primary. New chat, Search, Projects, Artifacts, Recents.
- Agent mode adds Routines and the grouped Run sessions section, and enables automation tools inside the conversation.
- Projects: a named grouping of conversations and uploaded files (folder-like). A project can carry default attachments (reused via the Files API) and a default model.
- Artifacts: cross-conversation list of generated outputs and saved run evidence.
- Routines: saved recurring automations (local-only execution by default), each with a detail page.
- History and Recents: conversations in Recents; run sessions in the grouped Agent section; a unified run-and-chat history is reachable from Search.
- Settings: model defaults, theme, notifications, telemetry consent, data retention controls.
- Account: email, plan tier, billing portal, sign out, device list, account deletion request.
- Paywall: shown whenever the server reports an inactive entitlement; offers Pro and Ultra only.

Routing in the renderer stays state-driven (no router library needed). Extend the `Phase` and `PanelView` unions in `App.tsx`: add a top-level `mode: "chat" | "agent"` state, and extend `PanelView` to `"chat" | "projects" | "artifacts" | "routines" | "runs" | "search" | "permissions"`.

---

## 4. Full feature list

Chat and documents:
1. Streamed chat with Opus 4.8 default, Sonnet 4.6 and Haiku 4.5 selectable, plus Auto routing.
2. Effort selector (Low, Medium, High, Max) and Extended Thinking toggle.
3. Multi-turn conversations persisted server-side (stateless API, full message array resent each turn).
4. File upload and chat-with-your-files: PDF (native document blocks), images, and converted-to-text for docx, md, txt, csv, xlsx.
5. Citations grounded to source pages or character ranges, rendered as clickable links.
6. Drag-drop, + button, and clipboard-paste attachment entry points.
7. Per-attachment redaction toggle for sensitive files.
8. Projects: group conversations and reusable files.
9. Artifacts: right-docked split view with copy, download, view-source, version selector.
10. Search across conversations.
11. Token and cost estimate before sending large files (count_tokens), never silent truncation.

Automation (Agent mode):
12. Real headed Playwright on the user's actual Chrome with saved logins (connectOverCDP).
13. Native Windows automation via the existing pywinauto helper.
14. Mixed workflows (browser then file move then desktop app then summary).
15. Plan-first approval for the first run of any new task.
16. Live run timeline with task checklist and progress bar.
17. Per-action approval with "always allow for this routine" memory, reviewable and revocable.
18. Pause and Stop.
19. Honest run status and reviewable run sessions with evidence screenshots.

Routines (recurring):
20. Save a task as a routine.
21. Preset-first scheduling (Manual, Hourly, Daily, Weekdays, Weekly) plus plain-language custom and one-off.
22. Local-only execution with a clear statement that routines fire only while the app runs and the PC is awake.
23. Single catch-up on wake for the most recently missed occurrence.
24. Desktop notification per run; run history with skip reasons.
25. Active or Paused toggle, Edit, Delete, Run now.
26. Per-routine permission policy (Plan first, Ask each action, Run automatically) and scope (apps, folders, sites, network).

Account, billing, security:
27. Real sign up, email verification, sign in, sign out, password reset (Supabase-shaped, swappable).
28. Hard paywall, Pro and Ultra, simulated payment now and Stripe later.
29. Server-side budget ledger per plan with reservation and settlement (already built).
30. Usage meter (amount used, remaining, reset date).
31. Permissions and consent center, including explicit consent to drive the real Chrome profile.
32. Local redaction and untrusted-page-content handling.
33. Encrypted local session storage (already built via Electron safeStorage).

---

## 5. Technical architecture: how it reuses and extends the current code

The monorepo is unchanged in shape: `apps/api` (Fastify, libSQL, Zod), `apps/desktop` (Electron main, preload, renderer), `packages/contracts` (Zod schemas), `python/windows-agent` (pywinauto helper). Below, each change references the exact existing file.

### 5.1 Shared contracts (`packages/contracts/src/index.ts`)

Add chat and attachment schemas alongside the existing automation schemas. Keep all existing exports (planIds, plan catalog, automation action union, run schemas) intact; do not break `apps/api/src/server.ts` or the preload imports.

Add:
- `messageRoleSchema = z.enum(["user", "assistant"])`.
- `attachmentRefSchema` describing an uploaded file the renderer references by id: `{ attachmentId, filename, mimeType, sizeBytes, kind: z.enum(["pdf","image","text"]), redact: z.boolean().default(false) }`.
- `chatSendSchema = z.object({ conversationId: z.string().uuid().optional(), text: z.string().max(200_000), attachments: z.array(attachmentRefSchema).max(20).default([]), model: modelTierSchema.default("opus" as any) , effort: z.enum(["low","medium","high","max"]).default("high"), thinking: z.boolean().default(false) }).strict()`. Note: extend `modelTierSchema` default handling; the chat default is Opus.
- `conversationSummarySchema`, `messageSchema` (with a `contentJson` passthrough for full Anthropic content blocks including citations and thinking), and an SSE envelope type used for documentation only.
- Routine schemas: `routineScheduleSchema` (preset enum plus optional cron and one-off timestamp), `routinePermissionSchema = z.enum(["plan_first","ask_each","auto"])`, `routineScopeSchema`, `createRoutineSchema`, `updateRoutineSchema`.
- Entitlement: keep `SubscriptionState`. Add a `status` value space that uses Stripe's exact vocabulary (`active`, `trialing`, `past_due`, `canceled`, `incomplete`, `incomplete_expired`, `unpaid`) so the simulated and real billing paths write identical values.

### 5.2 Backend chat and streaming (`apps/api`)

Today the model path is the automation tool loop in `apps/api/src/anthropic.ts` (non-streaming `fetch` to `/v1/messages`, custom `parseAction`, mock mode). Extend, do not replace:

1. Replace the raw `fetch` with the official `@anthropic-ai/sdk` (`new Anthropic()` reading `ANTHROPIC_API_KEY` from env, server-side only). Keep the mock path for tests behind `config.mockAi` and `NODE_ENV !== production`.
2. Add a streaming chat service `apps/api/src/chat.ts`: load conversation messages from libSQL, append the new user turn (building document and image content blocks from attachments, text document blocks for converted formats, citations enabled per document block), open `client.messages.stream({ model, max_tokens: 64000, system, messages, thinking?, output_config: { effort } })`, and re-emit SSE frames to the client. Append the full `response.content` (text, thinking, tool_use blocks) back into the stored message array so multi-turn and the tool loop stay coherent.
3. Add a chat route group in `apps/api/src/server.ts`:
   - `POST /v1/chat` (SSE). Sets `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`. Streams `text_delta`, `thinking_delta`, `citations_delta`, and a final `done` frame carrying usage and the persisted message id. Runs behind the same entitlement guard.
   - `GET /v1/conversations` and `GET /v1/conversations/:id` for Recents and reload.
   - `POST /v1/attachments` for upload (stores metadata, optionally uploads to the Files API by `sha256` dedupe, keeps bytes on disk in the desktop userData dir and only metadata server-side; see 6).
4. Keep the existing budget reservation and settlement (`apps/api/src/budget.ts`) on the chat path: reserve worst-case cost from input upper bound plus `max_tokens` before the stream, settle actual usage from the final `message_delta` usage. The reservation and ledger code needs no change beyond being called from `chat.ts`. Prompt caching: put `cache_control: { type: "ephemeral" }` on the frozen system prompt and tool list; keep the system prompt byte-stable (no timestamps or ids interpolated).
5. The automation tool loop stays in `anthropic.ts` and `server.ts` (`POST /v1/runs`, `POST /v1/runs/:runId/next`) for Agent mode and routines, now driven from inside a conversation rather than a separate composer. Wrap pywinauto and Playwright actions as the existing custom tools; keep the manual loop (not the auto tool runner) so the backend and desktop can gate destructive actions.

Model registry (`apps/api/src/model-registry.ts`): keep as the single source of truth. Default chat tier becomes Opus 4.8. Pricing and ids stay configuration-driven. Add a startup assertion that the configured Opus id resolves.

### 5.3 Desktop main process (`apps/desktop/src/main`)

- `index.ts`: add IPC handlers for chat streaming, conversations, attachments, projects, and routines (section 7). Keep the existing single-instance lock, deep-link registration, permission handlers, and the `WORKCREW_CAPTURE` path. Streaming from the API SSE endpoint to the renderer is done in main: open the SSE response with `fetch`, read the stream, and forward each frame to the renderer over an `ipcRenderer` event channel (`chat:delta`) keyed by a request id. The renderer subscribes via a preload-exposed callback.
- New `chrome-cdp.ts` replacing the fragile `browser-cli.ts` path as the primary browser driver (keep `browser-cli.ts` only as a fallback). See 5.5.
- `windows-agent.ts`: unchanged in mechanism (local helper, per-launch token, validated JSON). It already resets cleanly on crash and probes health.
- `auth-vault.ts` and `api-client.ts`: unchanged. The vault already encrypts the Supabase session with `safeStorage` and refreshes tokens; the API client already attaches the bearer token.

### 5.4 Desktop renderer (`apps/desktop/src/renderer/src`)

Restructure `App.tsx` into a shell plus feature components. New components: `Sidebar.tsx`, `ModeTabs.tsx`, `ChatView.tsx`, `Composer.tsx`, `ModelPopover.tsx`, `MessageList.tsx`, `AttachmentChip.tsx`, `ArtifactPanel.tsx`, `RunTimeline.tsx`, `RoutinesPanel.tsx`, `RoutineDetail.tsx`. Reuse `ApprovalModal.tsx`, `AccountDialog.tsx`, `PermissionsPanel.tsx`. The streaming consumer lives in a `useChatStream` hook that subscribes to the `chat:delta` channel and appends deltas to the active assistant message. Apply the dense type scale and palette from section 2 in `styles.css`.

### 5.5 Real headed Playwright on the user's Chrome (`apps/desktop/src/main/chrome-cdp.ts`, new)

This is the central automation change. The research is explicit: do not use `launchPersistentContext` on the live default profile (unsupported, fights the profile lock, can corrupt the profile), and the Playwright CLI subprocess is the source of the "too many arguments" daemon failure. The reliable approach is `chromium.connectOverCDP` against the user's real Chrome started with `--remote-debugging-port`.

Implementation:
1. Detect the user's Chrome profile path (`%LOCALAPPDATA%/Google/Chrome/User Data` plus the active Profile folder).
2. Probe whether a CDP endpoint already exists (`GET http://127.0.0.1:<port>/json/version`). If yes, `connectOverCDP` and skip launching.
3. If not, and Chrome is already running on that profile without the debug port (detect via `SingletonLock` in the user-data-dir), present a single friendly consent dialog: "WorkCrew needs to connect to your Chrome. Click Restart Chrome to continue (your tabs will reopen)." Then close Chrome cleanly and relaunch it with `--remote-debugging-port=<ephemeral random port>` and an explicit `--user-data-dir=<their profile>` (Chrome 136+ blocks the debug port on the default profile unless `--user-data-dir` is explicit).
4. `chromium.connectOverCDP("http://127.0.0.1:<port>")`, take `browser.contexts()[0]`, drive the existing pages. This inherits all live cookies, logins, and extensions, is truly headed (it is the user's window), and never triggers the profile lock.
5. Fallback that needs no restart: drive a copied profile (copy user-data-dir to an app-owned dir, `launchPersistentContext` on the copy). Note this drifts from the live session and misses later logins.

Security: bind the debug port to 127.0.0.1 only, use a fresh random ephemeral port per session, open it only for the duration of the automation and tear it down after, and gate the whole capability behind explicit per-session consent (section 9). Map the existing `browserActionSchema` commands onto Playwright `Page` and accessibility-locator calls rather than CLI args. Keep the existing `browserActionSchema` allowlist; reject any command not on it.

### 5.6 Turning OFF the dev bypass flags so auth and paywall appear

Today the app is demoable because three flags short-circuit the gates:
- `WORKCREW_DEV_AUTH=true` makes `AuthVault.getSession()` return an authenticated dev user and `authenticate()` accept the dev token (`apps/api/src/auth.ts`, `apps/desktop/src/main/auth-vault.ts`).
- `WORKCREW_DEV_BILLING=true` exposes `POST /v1/dev/activate` and the Paywall "Activate test" button (`apps/api/src/server.ts`, `App.tsx` `Paywall`).
- `WORKCREW_MOCK_AI=true` returns canned model responses (`apps/api/src/anthropic.ts` `mockResponse`).

To make auth and the paywall actually appear:
1. In the dev and demo run profile, set all three to unset or `false`. The app then routes: no session to the auth screen, authenticated but no active entitlement to the paywall, active to the workspace. `apps/api/src/config.ts` already throws in production if any bypass is set, and `requireActive()` in `server.ts` already enforces the entitlement at run creation. Keep that.
2. For local testing without real Stripe, the simulated billing provider (section 8) replaces `dev/activate`: a local checkout screen that writes a Stripe-shaped entitlement row through the same handler the real webhook will use. This is real-feeling (the paywall appears, the user "pays", entitlement flips to active) without a paid API. Mock AI stays available only for automated tests, never for the demo build.
3. Document a `.env` profile `demo` that leaves the bypasses off and uses simulated billing plus a real (funded) Anthropic key for the live chat demo, or mock AI only when explicitly testing offline.

---

## 6. Data model additions

All new tables are added to `apps/api/src/db.ts` `initializeDatabase()` using the same `CREATE TABLE IF NOT EXISTS` plus `addColumnIfMissing` migration style already in the file. Keep money in integer microdollars. Keep Stripe field names verbatim. Existing tables (`subscriptions`, `usage_ledger`, `runs`, `stripe_events`) are unchanged.

New and extended tables:

1. `users` (only needed when auth moves local; while Supabase owns identity, the `sub` claim is the user id and no local user row is required). For the swappable local-auth provider: `users(id, email UNIQUE, email_verified INTEGER, password_hash, created_at_ms)`.
2. `sessions(id, user_id, created_at_ms, last_seen_at_ms, expires_at_ms, revoked_at_ms)` and `refresh_tokens(id, session_id, token_hash, created_at_ms, used_at_ms, replaced_by)` for the local auth provider (argon2id password hashing, single-use rotating refresh tokens, whole-session revoke on reuse, about 10s grace). These mirror Supabase semantics so `SupabaseAuthProvider` is a drop-in.
3. `entitlements` reuses the existing `subscriptions` table; ensure its `status` column accepts the full Stripe vocabulary and keep `current_period_end_ms`, `cancel_at_period_end` (add column), `customer_id`, `subscription_id`.
4. `conversations(id, user_id, project_id, title, model, created_at_ms, updated_at_ms)`.
5. `messages(id, conversation_id, role, content_json, created_at_ms)` storing the full Anthropic content block array so citations and thinking blocks survive reload.
6. `attachments(id, conversation_id, message_id, filename, mime_type, size_bytes, sha256, local_path, anthropic_file_id, page_count, redacted INTEGER, created_at_ms)`. Bytes stay on disk in the Electron userData dir; only metadata in libSQL. Dedupe by `sha256` to reuse one Files API `file_id`.
7. `projects(id, user_id, name, default_model, created_at_ms)`.
8. `routines(id, user_id, name, description, instructions, schedule_kind, schedule_cron, schedule_at_ms, permission_mode, scope_json, model, active INTEGER, created_at_ms, updated_at_ms)`.
9. `routine_runs(id, routine_id, started_at_ms, ended_at_ms, status, skip_reason, run_id, evidence_json)` where `status` is honest (`succeeded`, `ran_with_issues`, `skipped`, `failed`) and `run_id` links to the existing `runs` table so ad-hoc and scheduled runs share one record shape.
10. `routine_permissions(id, routine_id, tool_signature, granted_at_ms)` for the reviewable and revocable "always allowed" panel.
11. `processed_billing_events(event_id PRIMARY KEY, type, received_at_ms)` already exists as `stripe_events`; keep it and use it for both simulated and real billing idempotency.

All user-owned rows must filter by `user_id` (the existing `getRun` already does this). Define every new table as a Zod schema in `packages/contracts` and reuse server-side and renderer-side.

---

## 7. IPC surface and backend endpoint surface

### 7.1 Preload IPC (`apps/desktop/src/preload/index.ts`, extend the `workcrew` object)

Keep all existing groups (`app`, `auth`, `api.entitlement`, `api.checkout`, `api.portal`, `api.createRun`, `api.nextRun`, `automation`). Add:

- `chat.send(payload: ChatSend): Promise<{ requestId: string }>` starts a streamed turn; deltas arrive on a subscription.
- `chat.onDelta(cb: (frame: ChatDeltaFrame) => void): () => void` subscribes to `chat:delta` (text, thinking, citation, done, error). Returns an unsubscribe.
- `chat.stop(requestId: string)` cancels an in-flight stream.
- `conversations.list()`, `conversations.get(id)`, `conversations.delete(id)`.
- `attachments.add(files: LocalFileRef[]): Promise<AttachmentRef[]>` hashes, classifies, extracts text for non-PDF formats, optionally uploads to the Files API, returns refs.
- `projects.list()`, `projects.create(name)`.
- `routines.list()`, `routines.get(id)`, `routines.create(input)`, `routines.update(id, input)`, `routines.delete(id)`, `routines.runNow(id)`, `routines.setActive(id, active)`, `routines.permissions(id)`, `routines.revoke(id, toolSignature)`.
- `browser.connectConsent(): Promise<{ granted: boolean }>` triggers the Chrome connect consent dialog (section 5.5).

All payloads are validated with the contracts Zod schemas in main before the API call, exactly as the existing handlers do with `createCheckoutSchema` and `createRunSchema`.

### 7.2 Backend HTTP surface (`apps/api/src/server.ts`)

Existing, unchanged: `GET /health`, `GET /v1/entitlement`, `POST /v1/billing/checkout`, `POST /v1/billing/portal`, `POST /v1/billing/webhook`, `POST /v1/runs`, `POST /v1/runs/:runId/next`. The dev-only `POST /v1/dev/activate` is replaced by the simulated billing provider's `POST /v1/billing/simulate` (see 8), still gated to non-production.

New, all behind the existing `authenticate` plus `requireActive` entitlement guard registered as a Fastify `preHandler` on the protected group:

- `POST /v1/chat` (SSE streaming). Reserves budget, opens the Anthropic stream, re-emits frames, settles on completion, persists the assistant message.
- `GET /v1/conversations`, `GET /v1/conversations/:id`, `DELETE /v1/conversations/:id`.
- `POST /v1/attachments` (metadata registration and optional Files API upload), `DELETE /v1/attachments/:id` (also deletes the Files API entry to free the org quota).
- `GET /v1/projects`, `POST /v1/projects`.
- `GET /v1/routines`, `GET /v1/routines/:id`, `POST /v1/routines`, `PATCH /v1/routines/:id`, `DELETE /v1/routines/:id`, `POST /v1/routines/:id/run`, `GET /v1/routines/:id/runs`, `GET /v1/routines/:id/permissions`, `DELETE /v1/routines/:id/permissions/:sig`.

The entitlement guard re-reads the DB on every protected request (it already does via `getSubscription` plus `requireActive`). The renderer only ever receives 200 with data or 402 or 403; it holds no key and no unlock flag. The Anthropic key is reachable only after the guard passes (it lives only in `apps/api`).

---

## 8. Phased, dependency-ordered build plan

Each phase is independently testable and ends with a concrete acceptance check. Within a phase, the parallel workstreams touch disjoint file areas so multiple agents can run concurrently. Phases are ordered by dependency.

### Phase 0: Contracts and palette foundation (no runtime risk, unblocks everyone)

Workstream A (contracts): in `packages/contracts/src/index.ts` add the chat, attachment, conversation, message, project, and routine schemas from 5.1 and 6. Do not modify existing exports. Acceptance: `npm run typecheck` passes; existing api and desktop builds still compile.

Workstream B (design tokens): in `apps/desktop/src/renderer/src/styles.css` add the dense type-scale variables, the warm-neutral palette, and the serif and sans font tokens from section 2. Set base font 14px and remove the chat hero clamp. Acceptance: `WORKCREW_CAPTURE` screenshot at 1440x920 shows a modest greeting and tighter density versus the current build.

These two are fully disjoint and can run in parallel.

### Phase 1: Real auth and paywall appear (turn the gates on)

Depends on Phase 0 contracts.

Workstream A (server gating): confirm `requireActive` runs on every protected route; register it as a `preHandler` on a protected group rather than per-route. Add the simulated billing provider `apps/api/src/billing-simulated.ts` and `POST /v1/billing/simulate` (non-production only) that writes a Stripe-shaped entitlement row (`status: "active"`, `current_period_end_ms = now + 30 days`) through the same upsert the webhook uses. Keep `dev/activate` removed.

Workstream B (desktop config and renderer): create the `.env` profiles (`demo` leaves bypasses off and uses simulated billing). Restyle `AuthScreen` and `Paywall` to the new tokens; wire the Paywall to `POST /v1/billing/simulate` when in demo mode and to `POST /v1/billing/checkout` otherwise. Acceptance: launching with bypasses off shows the auth screen, sign up and sign in work against Supabase (or local provider), an unpaid account sees the paywall, simulated payment flips entitlement to active and unlocks the workspace, and the budget ledger denies model calls when exhausted.

These workstreams are disjoint (server billing files versus renderer auth and paywall components).

### Phase 2: Streaming chat over SSE (the core of the new product)

Depends on Phase 0 contracts and Phase 1 gating (chat is behind the paywall).

Workstream A (backend chat): add `@anthropic-ai/sdk`; write `apps/api/src/chat.ts` (stream, reserve, settle, persist), add `POST /v1/chat` SSE plus `GET /v1/conversations` routes in `server.ts`, add `conversations` and `messages` tables to `db.ts`. Default Opus 4.8, prompt caching on the frozen system prompt. Acceptance: a curl against `POST /v1/chat` streams `text_delta` frames and settles a ledger row; multi-turn resends the full message array.

Workstream B (desktop streaming bridge and chat UI): add `chat:send`, `chat:delta`, `chat:stop` IPC in `index.ts` and preload; build `ChatView.tsx`, `Composer.tsx`, `MessageList.tsx`, `ModelPopover.tsx`, and the `useChatStream` hook. Render streamed text in serif with thinking and effort controls. Acceptance: typing a message streams an answer token by token in the UI, model and effort switch mid-conversation, Recents lists the conversation.

Disjoint: backend chat files versus renderer chat components plus the main-process bridge (the bridge is new code, not a conflict with the chat backend).

### Phase 3: File upload and chat-with-your-files

Depends on Phase 2.

Workstream A (backend attachments): add the `attachments` table, `POST /v1/attachments`, Files API upload by `sha256` dedupe, the format-to-transport dispatcher (PDF native document block, images, text document blocks for docx, md, txt, csv, xlsx), citations enabled per document block, and `count_tokens` pre-estimate. Acceptance: uploading a PDF and asking a question returns a citation-grounded answer; a docx is converted to text and cited by character range.

Workstream B (desktop upload UX): `AttachmentChip.tsx`, drag-drop, + button, clipboard paste, per-attachment redaction toggle, client-side text extraction (mammoth for docx, a CSV and XLSX to text parser), client-side redaction on extracted text, and the citation click-through (open source at cited page or range). Acceptance: all three entry points add attachments; a sensitive file marked for redaction sends scrubbed text; clicking a citation opens the source.

Disjoint: backend attachment service versus renderer upload and redaction.

### Phase 4: Real headed Playwright on the user's Chrome

Depends on Phase 2 (Agent mode lives inside chat) and the existing run loop.

Workstream A (Chrome CDP driver): write `apps/desktop/src/main/chrome-cdp.ts` (detect profile, probe or relaunch with ephemeral debug port and explicit user-data-dir, `connectOverCDP`, map `browserActionSchema` to Playwright Page and accessibility-locator calls, ephemeral port teardown). Add the `browser:connect-consent` IPC and consent dialog. Acceptance: with the user's Chrome logged in, a browser run drives their real window and reuses their logins, then tears down the port.

Workstream B (run timeline and approvals UI): `RunTimeline.tsx` (live checklist plus progress bar), plan-first approval for new tasks, per-action approval with "always allow for this routine", Pause and Stop, honest status, evidence screenshots. Reuse `ApprovalModal.tsx` and the existing `automation:stop` IPC. Acceptance: a multi-step automation shows a plan, ticks off steps, gates a write action, and records a reviewable run.

Disjoint: main-process browser driver versus renderer run UI.

### Phase 5: Routines (recurring local automations)

Depends on Phase 4.

Workstream A (backend routines): add `routines`, `routine_runs`, `routine_permissions` tables and the routine CRUD plus run-now and run-history routes. Acceptance: a routine can be created, listed, paused, run now, and its runs recorded with honest status.

Workstream B (desktop scheduler and UI): a local scheduler in main that fires routines while the app runs and the PC is awake, single catch-up on wake for the most recently missed occurrence, desktop notifications, and the `RoutinesPanel.tsx` plus `RoutineDetail.tsx` UI (preset-first scheduling, plain-language custom, permission policy, always-allowed panel, run history). Merge the existing `WorkflowsPanel` and `ScheduledPanel` into Routines. Acceptance: a Daily routine fires at its time, notifies, and produces a reviewable run; a missed occurrence triggers exactly one catch-up on wake.

Disjoint: backend routine service versus renderer routines plus the main-process scheduler.

### Phase 6: Projects, Artifacts, Search, and polish

Depends on Phases 2 to 5.

Workstream A: backend projects and search endpoints, artifact persistence. Workstream B: `Sidebar.tsx`, `ModeTabs.tsx`, `ArtifactPanel.tsx` split view, Search UI, account and settings polish, accessibility pass. Acceptance: projects group conversations and files; artifacts open in the right-docked panel with version selector; search finds conversations.

### Phase 7: Hardening and swap readiness

Stripe adapter behind the same `BillingProvider` interface (config flag `BILLING_MODE=simulated|stripe`), Supabase or local auth behind `AuthProvider` (`AUTH_MODE`), idempotent billing-event handling (reuse `stripe_events`), security tests (token theft, forged deep links, hostile page content, budget races, debug-port hijack), and the launch acceptance gates from MVP_PLAN section 18 relevant to this milestone.

---

## 9. Security model updates

1. Explicit consent for the real Chrome profile. Driving the user's live Chrome grants the automation full authenticated control of everything they are logged into. Before the first browser automation in a session, show a consent dialog naming the capability and, where the workflow allows, offer a dedicated automation profile instead of the primary identity. Re-consent per session. Bind the debug port to 127.0.0.1 on a fresh random ephemeral port, open it only while needed, and tear it down after. This is new code in `chrome-cdp.ts` plus a renderer consent dialog.
2. Redaction. Run redaction on extracted text client-side before sending (the renderer already has `redactResult` in `security.ts`; extend it into a detector pipeline for emails, phone numbers, IDs, card numbers via Luhn, and secrets, with placeholders and an in-app redaction map). Make redaction an explicit per-attachment toggle; surface that redacting a PDF forces the text-extraction path and loses native-PDF visual understanding and page citations.
3. Untrusted page and document content. The system prompt already instructs the planner to treat page and document content as untrusted data, never as instructions (`apps/api/src/anthropic.ts`). Keep and strengthen this. Page content cannot widen permissions or override user grants; the local policy and the per-routine scopes are authoritative. The action allowlist (`browserActionSchema`, `windowsActionSchema`) rejects anything not enumerated, and write actions require visible approval (existing `actionNeedsApproval`).
4. Server-side hard-paywall enforcement. Entitlement is re-read from the DB on every protected request via `authenticate` plus `requireActive`. The renderer holds no unlock flag and no key. The Anthropic key lives only in `apps/api` and is used only after the guard and the budget reservation pass. Inactive Stripe states (incomplete, unpaid, canceled, paused, disputed, expired) lock model use; the default policy denies on `past_due`. Simulated and real billing write identical `status` values so the gate behaves the same in both modes.
5. Secrets and storage. Anthropic and Stripe secrets only in the backend (already enforced by `config.ts` production checks). Desktop session encrypted with Electron `safeStorage` (already in `auth-vault.ts`). For the local auth provider, argon2id with an OS-keychain pepper, never in the DB.
6. Turn the dev bypasses off. `WORKCREW_DEV_AUTH`, `WORKCREW_DEV_BILLING`, `WORKCREW_MOCK_AI` unset in any build a user touches; `config.ts` already refuses to start in production with any set.

---

## 10. Owner-only items and exactly what to request, and when

These require legal identity, banking, contracts, or owner authority and cannot be done by an agent. Request them at the phase where they unblock work.

1. Anthropic API key (funded, production). Request before Phase 2 (streaming chat) so the live demo and real chat work. The agent can build and test the entire chat path against mock mode, but a real key is needed for a real demo and for cost-accurate budget settlement. Provide as `ANTHROPIC_API_KEY` to the backend secret store only.
2. Supabase project (URL and anon key) for real auth, or approval to ship the local auth provider for the demo. Request before Phase 1. The agent builds both behind the `AuthProvider` interface; the owner provides the Supabase project values.
3. Stripe account with completed identity, company, tax, bank, and beneficial-owner verification, plus the four price ids (Pro and Ultra, monthly and yearly) and the webhook secret. Request before Phase 7 (Stripe swap). Until then the simulated billing provider drives the paywall. Note the MVP_PLAN flag: if the operating company is in Lebanon, Stripe is a launch blocker; the owner must use a supported jurisdiction or approve another provider.
4. Windows code-signing identity. Request before any public installer (Phase 7 packaging). Unsigned local installers are fine for internal testing.
5. Domain, transactional email sender (Resend or Postmark), legal documents (Terms, Privacy, Acceptable Use, Refund, Security overview), and a monitored security contact. Request before a public or paid beta.
6. Approval of final name and brand clearance (trademark and domain), prices, and refund and tax treatment. Request before public launch.

The agent will, in the meantime, build everything to interfaces and config flags so each owner deliverable is a config-and-credentials change, not a code rewrite.

---

## 11. Risks and open questions

1. Desktop automation cannot run with the PC off. Routines fire only while the app runs and the PC is awake. The UI must say this plainly and must not promise cloud-style always-on behavior.
2. Live-Chrome automation is high blast radius. It acts as the real user across every logged-in account. Defaulting to plan-first and ask-each-action, offering a dedicated automation profile, and tearing down the debug port are the mitigations. WorkCrew has no equivalent of Anthropic's auto-mode safety classifier, so unattended "run automatically" should be opt-in per routine and scoped to least privilege.
3. Chrome 136+ restricts the debug port on the default profile. Always pass an explicit `--user-data-dir`. Validate against current stable Chrome before the demo.
4. Profile lock and corruption. Never spawn a second Chrome on the live profile. The connect-or-restart flow plus the copied-profile fallback are required; the copied profile drifts and misses later logins.
5. Honest run status. A green check must not imply success, only that the session ran. Build outcome verification or at least an explicit "review this run" nudge.
6. Anthropic API caveats. Append full `response.content` (including thinking and tool_use) back into the message array or multi-turn and the tool loop break. Each `tool_result` must carry the matching `tool_use_id`. On Opus 4.8 do not send `budget_tokens`, `temperature`, `top_p`, or `top_k`, and set `thinking.display: "summarized"` if showing thinking. Branch on `stop_reason` (including `refusal` and `pause_turn`) before reading content. Prompt-cache invalidation is silent if the system prompt or tool set changes.
7. Citations and structured outputs are mutually exclusive (400). Any feature needing strict JSON plus grounded citations must split into two calls. Scanned image-only PDFs are not citable; detect low extracted-text ratio and either fall back to native-PDF Q and A without citations or run OCR.
8. pywinauto constraints. Elevated targets need an elevated helper; the UAC Secure Desktop, lock, and login screens are not automatable; custom canvas controls need coordinate fallback; DPI awareness must be enabled; the interactive desktop is a single shared resource and must be serialized.
9. Stripe jurisdiction. The Lebanon question is unresolved and blocks real billing; simulated billing covers the interim, but real revenue waits on this owner decision.

Open questions for the owner: (a) Is the chat surface the headline product now, with automation as a mode, or do you want automation equally prominent in the top tabs? (b) Real Supabase for the demo, or local auth provider acceptable until Stripe is sorted? (c) Should the first browser-automation consent default to the primary Chrome profile or to a dedicated automation profile? (d) Confirm Opus 4.8 as the default chat model given its cost ($5 input, $25 output per MTok) against the Pro plan's $6.75 monthly Claude allowance, since heavy Opus chat can exhaust Pro quickly; Sonnet 4.6 may be the better Pro default with Opus reserved for Auto-routed hard tasks.

Key files this spec extends (all under `D:\worker pc app`): `packages/contracts/src/index.ts`; `apps/api/src/server.ts`, `anthropic.ts`, `db.ts`, `config.ts`, `model-registry.ts`, `billing.ts`, `budget.ts`, `auth.ts`; new `apps/api/src/chat.ts` and `billing-simulated.ts`; `apps/desktop/src/main/index.ts`, `windows-agent.ts`, `auth-vault.ts`, `api-client.ts`; new `apps/desktop/src/main/chrome-cdp.ts`; `apps/desktop/src/preload/index.ts`; `apps/desktop/src/renderer/src/App.tsx`, `styles.css`, `security.ts`, and the new renderer components listed in section 5.4.