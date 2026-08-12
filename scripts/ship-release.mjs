#!/usr/bin/env node
// Ship a WorkCrew desktop release.
//
// Everything the runbook describes by hand (check the tree, run the tests, build
// the installer with the flags this machine needs, publish the GitHub release the
// installed apps update from) happens here, in that order, as one command. It is
// written to be run by a person or by WorkCrew itself, so it explains what it is
// doing, refuses to continue when something is not right, and never leaves a
// half-published release behind.
//
//   npm run ship               build and verify, publish nothing
//   npm run ship -- --publish  the same, then publish the release
//
// The publish is deliberately behind its own flag. Publishing pushes a download
// to every installed app and cannot be taken back, so it is never a side effect
// of asking for a build.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { request } from "node:https";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = join(ROOT, "apps", "desktop");
const DIST = join(DESKTOP, "dist");
const HELPER_EXE = join(ROOT, "python", "windows-agent", "dist", "workcrew-windows-agent.exe");
const HELPER_SOURCE = join(ROOT, "python", "windows-agent", "agent.py");

// The installer is uploaded last on purpose: see publish().
const ARTIFACTS = ["latest.yml", "WorkCrew-Setup.exe.blockmap", "WorkCrew-Setup.exe"];

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const argValue = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
};
const PUBLISH = flags.has("--publish");
const SKIP_TESTS = flags.has("--skip-tests");
const SKIP_BUILD = flags.has("--skip-build");

let step = 0;
const log = (message) => console.log(message);
const heading = (message) => console.log(`\n[${++step}] ${message}`);
const note = (message) => console.log(`    ${message}`);
function fail(message, hint) {
  console.error(`\nStopped: ${message}`);
  if (hint) console.error(`\n${hint}`);
  process.exit(1);
}

// Commands are run through the shell as one string, because npm and npx are batch
// files on Windows and cannot be spawned any other way. Every command here is
// built from literals in this file, never from anything a caller supplies.
function run(command, args, options = {}) {
  const line = [command, ...args].join(" ");
  note(`> ${line}`);
  const result = spawnSync(line, {
    cwd: options.cwd ?? ROOT,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, ...(options.env ?? {}) }
  });
  if (result.status !== 0) {
    fail(options.failMessage ?? `\`${line}\` failed with exit code ${result.status ?? "unknown"}.`);
  }
}

function capture(command, args) {
  const result = spawnSync([command, ...args].join(" "), { cwd: ROOT, encoding: "utf8", shell: true });
  return result.status === 0 ? (result.stdout ?? "").trim() : "";
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function humanSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

// ---------------------------------------------------------------------------
// What is being shipped
// ---------------------------------------------------------------------------

const desktopPackage = readJson(join(DESKTOP, "package.json"));
const version = desktopPackage.version;
const tag = `v${version}`;
const publishConfig = desktopPackage.build?.publish?.[0] ?? {};
const repo = `${publishConfig.owner ?? "workcrewlabs"}/${publishConfig.repo ?? "worker-pc-app"}`;

log(`WorkCrew ${version}  ->  ${repo}  (${PUBLISH ? "build and PUBLISH" : "build only"})`);
log(`This is the feed installed apps update from, so the version and the repository must both be right.`);

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

heading("Checking the repository");

const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
const dirty = capture("git", ["status", "--porcelain"]);
note(`branch: ${branch || "unknown"}`);
if (dirty) note(`uncommitted changes:\n${dirty.split("\n").map((l) => `      ${l}`).join("\n")}`);

if (PUBLISH) {
  // A release is cut from what is on main and nowhere else. Shipping a build made
  // from a branch, or from edits that exist only on this machine, produces an
  // installer nobody can ever reproduce or roll back to.
  if (branch !== "main") {
    fail(`releases are cut from main, and this is "${branch}".`,
      "Merge the change into main first, then pull main and run this again.");
  }
  if (dirty) {
    fail("there are uncommitted changes, so this build would not match any commit.",
      "Commit or stash them, or run without --publish to just build.");
  }
  run("git", ["fetch", "origin", "main", "--quiet"], { failMessage: "could not reach GitHub to check main is up to date." });
  const behind = capture("git", ["rev-list", "--count", "HEAD..origin/main"]);
  if (behind && behind !== "0") {
    fail(`main on GitHub is ${behind} commit(s) ahead of this copy.`, "Run: git pull, then run this again.");
  }
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    fail("no GitHub token, so the release cannot be published.",
      "Set GH_TOKEN to a token with Contents write access to the repository, then run this again.");
  }
} else if (branch !== "main") {
  note(`not on main. That is fine for a build; publishing would be refused.`);
}

// ---------------------------------------------------------------------------
// The Windows helper, which the installer bundles
// ---------------------------------------------------------------------------

heading("Checking the Windows helper");

if (!existsSync(HELPER_EXE)) {
  note("missing, building it now (this needs Python and PyInstaller).");
  run("npm", ["run", "build:helper", "-w", "@workcrew/desktop"],
    { failMessage: "the Windows helper could not be built, and the installer cannot be packaged without it." });
} else if (existsSync(HELPER_SOURCE) && statSync(HELPER_SOURCE).mtimeMs > statSync(HELPER_EXE).mtimeMs) {
  // The helper is a compiled copy of agent.py. Shipping an older copy than the
  // source is the kind of fault that only shows up on a user's machine.
  note("older than agent.py, rebuilding it so the shipped helper matches the source.");
  run("npm", ["run", "build:helper", "-w", "@workcrew/desktop"],
    { failMessage: "the Windows helper is out of date and could not be rebuilt." });
} else {
  note(`up to date (${humanSize(statSync(HELPER_EXE).size)}).`);
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

if (SKIP_TESTS) {
  heading("Skipping typecheck and tests (--skip-tests)");
  note("Only do this when you have just run them yourself.");
} else {
  heading("Typechecking every workspace");
  run("npm", ["run", "typecheck"]);
  heading("Running every workspace's tests");
  run("npm", ["test"]);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

if (SKIP_BUILD) {
  heading("Skipping the build (--skip-build), using what is already in apps/desktop/dist");
} else {
  heading("Building the app");
  run("npm", ["run", "build", "-w", "@workcrew/desktop"]);

  heading("Packaging the installer");
  // Two things this machine needs, both learned the hard way. The mirror is
  // because electron-builder's own downloads fail here often enough to waste an
  // afternoon, and pointing it at the already-installed Electron stops it
  // fetching a second copy of a 100 MB runtime it does not need.
  const electronVersion = readJson(join(ROOT, "node_modules", "electron", "package.json")).version;
  note(`using the installed Electron ${electronVersion} instead of downloading another copy.`);
  run("npx", [
    "electron-builder", "--win", "nsis", "--publish", "never",
    "-c.electronDist=../../node_modules/electron/dist",
    `-c.electronVersion=${electronVersion}`
  ], {
    cwd: DESKTOP,
    env: { ELECTRON_BUILDER_BINARIES_MIRROR: "https://registry.npmmirror.com/-/binary/electron-builder-binaries/" }
  });
}

// ---------------------------------------------------------------------------
// Check what was built before anyone can download it
// ---------------------------------------------------------------------------

heading("Checking the built files");

for (const name of ARTIFACTS) {
  const path = join(DIST, name);
  if (!existsSync(path)) fail(`${name} is missing from apps/desktop/dist.`, "Run again without --skip-build.");
  note(`${name}  ${humanSize(statSync(path).size)}`);
}

const feed = readFileSync(join(DIST, "latest.yml"), "utf8");
const feedValue = (key) => (new RegExp(`^${key}:\\s*(.+)$`, "m").exec(feed)?.[1] ?? "").trim();

// latest.yml is the file every installed app reads to decide whether to update
// and what to trust. If it names a different version, or a checksum that does not
// match the installer next to it, every user's update fails after a 200 MB
// download. It costs seconds to check here and cannot be checked at all later.
if (feedValue("version") !== version) {
  fail(`latest.yml says version ${feedValue("version")}, but this release is ${version}.`,
    "The dist folder holds an older build. Run again without --skip-build.");
}

const installer = join(DIST, "WorkCrew-Setup.exe");
const digest = await new Promise((done, error) => {
  const hash = createHash("sha512");
  createReadStream(installer).on("data", (chunk) => hash.update(chunk)).on("error", error)
    .on("end", () => done(hash.digest("base64")));
});
if (feedValue("sha512") !== digest) {
  fail("the checksum in latest.yml does not match the installer beside it.",
    "Every app that downloaded this would reject it. Run again without --skip-build so both are made together.");
}
note("latest.yml matches the installer, version and checksum.");

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

function api(method, path, body) {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "workcrew-ship",
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  }).then(async (response) => {
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const detail = payload.message ?? response.statusText;
      if (response.status === 403 || response.status === 401) {
        fail(`GitHub refused the request (${response.status}: ${detail}).`,
          "The token needs Contents write access to the repository. Fix the token, or publish the release by hand from apps/desktop/dist.");
      }
      fail(`GitHub returned ${response.status}: ${detail} for ${method} ${path}`);
    }
    return payload;
  });
}

// Upload one asset over a plain request rather than fetch, so a 200 MB body can
// stream from disk for as long as it takes with no buffering and no timeout, and
// so progress can be reported while it goes.
function uploadAsset(uploadUrl, name) {
  const path = join(DIST, name);
  const size = statSync(path).size;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const url = new URL(`${uploadUrl.split("{")[0]}?name=${encodeURIComponent(name)}`);
  return new Promise((done, error) => {
    const req = request({
      method: "POST",
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "workcrew-ship",
        "content-type": "application/octet-stream",
        "content-length": size
      }
    }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) return done(JSON.parse(text || "{}"));
        error(new Error(`upload of ${name} failed (${response.statusCode}): ${text.slice(0, 300)}`));
      });
    });
    req.on("error", error);

    let sent = 0;
    let reported = 0;
    const stream = createReadStream(path);
    stream.on("data", (chunk) => {
      sent += chunk.length;
      // A line every 5% keeps a long upload visibly alive, both for the person
      // watching and for WorkCrew, which stops a command that has gone silent.
      const percent = Math.floor((sent / size) * 100);
      if (percent >= reported + 5) {
        reported = percent;
        note(`${name}: ${percent}% (${humanSize(sent)} of ${humanSize(size)})`);
      }
    });
    stream.pipe(req);
  });
}

if (!PUBLISH) {
  heading("Built, not published");
  log(`\nEverything is ready in apps/desktop/dist for WorkCrew ${version}.`);
  log(`To publish it to every installed app, run:\n\n    npm run ship -- --publish\n`);
  process.exit(0);
}

heading(`Publishing ${tag}`);

const existing = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
  headers: { authorization: `Bearer ${process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN}`, "user-agent": "workcrew-ship" }
});
if (existing.status === 200) {
  fail(`${tag} has already been released.`,
    `Bump the version in apps/desktop/package.json, merge that to main, then run this again.`);
}

const notesArg = argValue("--notes");
const previousTag = capture("git", ["describe", "--tags", "--abbrev=0", "HEAD^"]);
const commits = capture("git", ["log", previousTag ? `${previousTag}..HEAD` : "-20", "--no-merges", "--format=%s"]);
const notes = notesArg ?? (commits
  ? commits.split("\n").filter(Boolean).map((line) => `- ${line}`).join("\n")
  : `WorkCrew ${version}`);

// Created as a draft, and only made visible once every file is uploaded. A
// release that exists before its installer does is one that installed apps will
// try to download and fail on.
const release = await api("POST", `/repos/${repo}/releases`, {
  tag_name: tag,
  name: `WorkCrew ${version}`,
  body: notes,
  draft: true,
  prerelease: false
});
note(`draft created (${release.id}).`);

for (const name of ARTIFACTS) {
  note(`uploading ${name}...`);
  await uploadAsset(release.upload_url, name);
}

// By id, not by tag: a draft release has no tag on GitHub yet, so it cannot be
// addressed by one until this call publishes it.
const published = await api("PATCH", `/repos/${repo}/releases/${release.id}`, { draft: false, make_latest: "true" });

heading("Done");
log(`\nWorkCrew ${version} is live: ${published.html_url}`);
log(`Installed apps will pick it up on their next update check.`);
