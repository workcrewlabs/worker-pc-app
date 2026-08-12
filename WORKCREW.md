# How to work in this repository

WorkCrew reads this file when this folder is opened as a working folder. It is the
short version of the rules; `CLAUDE.md` and `SECURITY.md` hold the full detail.

## What this is

Three parts in one repository:

- `apps/api`: the Fastify backend. It holds every secret and all the billing,
  usage, and auth logic. It is the only thing that talks to the database.
- `apps/desktop`: the Electron app users install on Windows.
- `packages/contracts`: the zod schemas and types both sides share.

## How to make a change

1. Read the code you are about to change before changing it. Use `type` to read a
   file, `dir` to list, `findstr` to search. Commands run in Windows cmd.exe, so
   unix commands (cat, ls, grep) fail.
2. Make every file edit with `write_file`, sending the whole new file. Never edit
   a file with echo, redirection, or Set-Content.
3. Match the style already in the file. Comments explain why something is done,
   not what the line says. Keep them at the density already there.
4. Put a test next to the code (`*.test.ts`) for anything with a rule in it. The
   TypeScript compiler is the linter; there is no ESLint.

## Before you say a change is done

Both of these have to pass:

    npm run typecheck
    npm test

The backend tests run one file at a time on purpose. They share one local database
file, and in parallel they fail at random for that reason alone.

If a test fails, fix it. Do not report a change as finished with a failing test,
and do not delete or skip a test to make the suite green.

## Rules that are not negotiable

These exist because this app takes people's money and runs on their computers.

- Validate every request body, query, and route parameter with a zod schema before
  using it, and bound every string, array, and number.
- Take the user id only from the verified token, never from a field the client
  sent.
- Scope every database query by the authenticated user id. Being signed in is not
  the same as owning the record.
- Never put a secret in the desktop app or the renderer. Keys live in the backend.
- Never log a password, token, key, payment detail, or the database URL.
- Do not widen the automation surface to arbitrary shell, JavaScript, or file
  access without an approval gate in front of it.

## Writing for users

No emojis anywhere: not in the app, the website, the code, or model output. No
dashes used as a pause in a sentence. Say tokens, not dollars. Never name the AI
provider in anything a user sees.

## Getting a change to the owner

Work on a branch, never on main:

    git checkout -b claude/short-name
    git add <the files you changed>
    git commit -m "One line saying what changed and why"
    git push -u origin <branch>

Then give the owner this link to open the pull request, and stop:

    https://github.com/workcrewlabs/worker-pc-app/pull/new/<branch>

Merging is the owner's click, not yours. Stage files by name. Never `git add .` or
a whole folder: this tree usually holds other work in progress, and sweeping it
into a commit publishes something nobody reviewed.

## Getting a change to users

Two separate paths, and most changes need only the first:

- **Backend.** Merging to main is the whole deploy. Render redeploys main by
  itself within a few minutes, and every user has it. Nothing to download.
- **Desktop app.** Anything the user sees on screen needs a new installer. Bump
  the version in `apps/desktop/package.json` as part of the change, and once it is
  merged into main, run from the repository root:

      npm run ship

  That checks the repository, rebuilds the Windows helper if it is out of date,
  typechecks, runs every test, builds the installer, and verifies that the update
  feed matches it. It publishes nothing. To publish, the owner runs:

      npm run ship -- --publish

  which creates the GitHub release, uploads the installer (about 200 MB, so it
  takes a while), and only then makes it visible so no app can download a
  half uploaded release. Installed apps update themselves from there.

## What only the owner can do

Do not attempt these, and say plainly when one is needed: merging a pull request,
publishing a release, anything in the Render dashboard (environment variables,
restarts), anything in the payment gateway or bank portal, and anything involving
a real card or real money.
