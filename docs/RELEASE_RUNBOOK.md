# WorkCrew update and release runbook

This is the plain-English process for shipping an update to the WorkCrew backend or
desktop app, the same steps we have been using. Keep it in the repo so any future
Claude Code chat (or developer) can follow it. Convert relative dates to absolute
when you read it later.

If you are starting a fresh Claude Code chat, paste the "Starter prompt" at the
bottom so the assistant has the context it needs.

---

## 1. The one thing to understand first: two separate update channels

WorkCrew has two parts that update through completely different paths.

- **Backend** (`apps/api`, runs on Render at `workcrew-backend.onrender.com`). This
  holds all the logic and secrets: billing, usage caps, auth, Stripe. It updates
  the moment code lands on the `main` branch, because Render automatically
  redeploys `main`. **Users do not download anything.** Backend changes reach
  everyone within a few minutes of the merge.

- **Desktop app** (`apps/desktop`, the Windows program users install). It updates by
  publishing a new **GitHub Release** with a new installer. Each installed app
  checks the release feed and auto-updates itself (downloads the new installer).
  This is the only path for changes to screens, buttons, the usage wheel, etc.

Rule of thumb: **logic/pricing/security/limits are almost always backend (no app
download needed). Anything the user SEES change on screen is desktop (needs a new
release).** Many updates touch both.

---

## 2. The standard flow (what we do every time)

1. **Describe the change** to Claude Code in plain words (what is wrong, what you
   want). Attach screenshots if it is a visual issue.

2. **Claude implements it and tests it locally.** For any code change we run:
   - `npm run typecheck` (the TypeScript compiler is our linter; there is no ESLint)
   - the affected workspace tests (for example `apps/api` and `apps/desktop`)
   Nothing is considered done until typecheck is clean and tests pass.

3. **Open a Pull Request (PR) on GitHub** against `main` in the canonical repo
   `workcrewlabs/worker-pc-app`. A PR is a proposed change that can be reviewed
   before it goes live.

4. **CodeRabbit reviews the PR automatically.** CodeRabbit is a bot connected to the
   repo; a minute or two after the PR opens it posts review comments inline on the
   PR. Read its summary. For each comment, either:
   - ask Claude Code to address it (paste the comment), or
   - reply/resolve it if it is a false alarm or intentional.
   Re-run happens automatically when new commits are pushed to the PR branch.

5. **You review and merge the PR.** Open the PR page, read the description and the
   CodeRabbit summary, then click **Squash and merge** and **Confirm**. (See section
   5 for why this click is yours and not the assistant's.)

6. **Deploy happens from the merge:**
   - Backend: Render redeploys `main` automatically (a few minutes). Done.
   - Desktop: if the change touched the app UI, publish a new release (section 4).

7. **Verify** the change is live (test in the installed app, or check the health
   endpoint / release page).

---

## 3. Backend update: exact steps

1. Claude makes the code change on a branch and pushes it to the canonical repo.
   Note: a worktree's git `origin` may point at a personal fork
   (`nazihbizriai-lab`); pushes must go to `workcrewlabs/worker-pc-app`.
2. Claude opens a PR to `main`. CodeRabbit reviews it.
3. **You merge the PR** (Squash and merge).
4. Render auto-deploys `main`. Wait a few minutes.
5. Verify: `https://workcrew-backend.onrender.com/health` should report `mode: live`,
   `billingMode: stripe`. The change is now live for all users, no app update.

There is no installer and no download for backend changes.

---

## 4. Desktop app update: exact steps (this is the slow one)

Only needed when the app's own screens/behavior change.

1. **Bump the version** in `apps/desktop/package.json` (for example `0.1.14`).
2. **Build the installer** (from `apps/desktop`). The reliable offline recipe
   (because the build's downloads are flaky on this machine):
   - Seed the electron-builder tool archives into the local cache and use the
     already-installed Electron runtime, then:
     `npm run build` then
     `ELECTRON_BUILDER_BINARIES_MIRROR="https://registry.npmmirror.com/-/binary/electron-builder-binaries/" npx electron-builder --win nsis -c.electronDist=../../node_modules/electron/dist -c.electronVersion=<installed electron version>`
   - Output: `apps/desktop/dist/{WorkCrew-Setup.exe, WorkCrew-Setup.exe.blockmap, latest.yml}`.
   - Full details and the flaky-download fix are in `reference-desktop-release-build`
     (Claude's memory) and can be reproduced by asking Claude.
3. **Publish a GitHub Release** on `workcrewlabs/worker-pc-app`: create the release
   with tag `v0.1.x`, upload the three files above, then mark it the latest release.
   The installer is large (~200 MB) and your upstream upload is slow, so the upload
   can take 45 to 90 minutes; upload the two small files first, then the installer.
4. Installed apps pick up the new release and auto-update.

**Important open question about the desktop update feed (needs your decision, see
section 6):** the app currently checks a *different* GitHub account for updates than
the website downloads from. Resolve that before relying on desktop auto-updates.

---

## 5. Things only YOU can do (the assistant cannot, by design)

- **Merge a PR.** Safety rules stop an AI from merging its own unreviewed code to
  production. You click **Squash and merge** on the PR page. This is one click.
- **Anything in the Stripe dashboard** (webhook endpoints, keys, products).
- **Anything in the Render dashboard** (env vars, plan, restarts).
- **Buying/installing a code-signing certificate** (see section 6).
- **GitHub org/account settings** (who owns the repo, 2FA, access).

The assistant will always call these out and give you step-by-step instructions.

---

## 6. Known items that need your decision or action (as of this runbook)

These came out of the security audit and the release setup:

1. **Stripe test-mode webhook noise.** A *test-mode* webhook endpoint points at the
   *live* backend, which correctly rejects it, so Stripe keeps emailing about failed
   deliveries. Fix in the Stripe Dashboard (test mode): Developers -> Webhooks ->
   open the endpoint for `.../v1/billing/webhook` -> delete it (production uses live
   mode). Confirm a **live-mode** endpoint for that same URL exists and is healthy.
2. **Desktop update feed vs canonical repo.** The app's auto-update publish target
   (`apps/desktop/package.json`) and the website's download link must point at the
   same GitHub org. Decide the single authoritative org (`workcrewlabs`), make sure
   releases are published there, and cut a release so installed clients repoint.
3. **Code signing.** The Windows installer is unsigned, so auto-updates are trusted
   only via the release feed's checksum. Buy a Windows code-signing certificate, add
   it to the build as a secret, and enable signing.

---

## 7. Starter prompt for a new Claude Code chat

Paste this to begin an update session:

> I want to update the WorkCrew app or backend. Repo is `workcrewlabs/worker-pc-app`
> (canonical); backend deploys from `main` via Render, desktop ships via GitHub
> Releases. Follow `docs/RELEASE_RUNBOOK.md`. Here is what I want changed: <describe
> the change, attach screenshots if visual>. Implement it, run typecheck and the
> affected tests, then open a PR to `main` so CodeRabbit can review it, and tell me
> exactly what I need to click or do (merge, Stripe, Render, release build) with
> step-by-step instructions.
