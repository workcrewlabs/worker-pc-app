// Local, instant Postgres connection tester. Reads DATABASE_URL from the
// repo-root .env (gitignored, stays on this machine), applies the exact same
// normalization the backend uses, and tries to connect. Prints SUCCESS or the
// precise failure, so we can iterate in seconds without a Render deploy.
//
// Run from the repo root:  node scripts/test-db.mjs
import "dotenv/config";

function normalizePostgresUrl(raw) {
  const trimmed = (raw || "").trim();
  const m = /^(postgres(?:ql)?:\/\/)([^:@/]+):([\s\S]*)@([^@]+)$/.exec(trimmed);
  if (!m) return trimmed;
  return `${m[1]}${m[2]}:${encodeURIComponent(m[3])}@${m[4]}`;
}

function stripSslQueryParams(url) {
  const q = url.indexOf("?");
  if (q === -1) return url;
  const base = url.slice(0, q);
  const keys = new Set(["sslmode", "ssl", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"]);
  const kept = url
    .slice(q + 1)
    .split("&")
    .filter((p) => !keys.has((p.split("=")[0] || "").toLowerCase()));
  return kept.length ? `${base}?${kept.join("&")}` : base;
}

const raw = process.env.DATABASE_URL;
if (!raw) {
  console.log("\nNO DATABASE_URL found in your .env file. Add a line DATABASE_URL=... and save, then run again.\n");
  process.exit(1);
}

// Safe diagnostic on the raw value (no password printed).
const d = /^(postgres(?:ql)?:\/\/)([^:@/]+):([\s\S]*)@([^@/]+)/.exec(raw.trim());
console.log("\n--- What is in your .env ---");
console.log("user        =", d ? d[2] : "(could not parse)");
console.log("host        =", d ? d[4] : "(could not parse)");
console.log("passwordChars =", d ? d[3].length : 0);

const baseString = stripSslQueryParams(normalizePostgresUrl(raw));

const pg = await import("pg");
const Pool = (pg.default ?? pg).Pool;

// Try the connection as given, then on a network/timeout error try the other
// Supabase pooler port (5432 session <-> 6543 transaction), since some networks
// block one but allow the other.
async function tryConnect(connectionString, portLabel) {
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 12_000 });
  try {
    const result = await pool.query("select 1 as ok");
    console.log(`SUCCESS on ${portLabel}: connected and ran a query. ok = ${result.rows[0].ok}`);
    console.log("=> Your password and string are CORRECT. If Render still fails it is a Render-side value or a temporary Supabase block, not your password.");
    return "ok";
  } catch (error) {
    const code = error.code || "";
    console.log(`FAILED on ${portLabel}: ${code} - ${error.message}`);
    if (code === "28P01") return "auth";
    return "network";
  } finally {
    await pool.end().catch(() => {});
  }
}

console.log("\n--- Trying to connect ---");
const firstPort = baseString.includes(":6543/") ? "6543" : "5432";
let outcome = await tryConnect(baseString, `port ${firstPort}`);

if (outcome === "network") {
  const altString = baseString.includes(":5432/")
    ? baseString.replace(":5432/", ":6543/")
    : baseString.replace(":6543/", ":5432/");
  const altPort = firstPort === "5432" ? "6543" : "5432";
  console.log(`\n--- Port ${firstPort} was blocked or unreachable; trying port ${altPort} ---`);
  outcome = await tryConnect(altString, `port ${altPort}`);
}

console.log("");
if (outcome === "auth") {
  console.log("=> 28P01: the database REACHED, but the password in this string does NOT match Supabase right now. Reset once, paste the new generated password here, run again.");
} else if (outcome === "network") {
  console.log("=> Both database ports timed out from this PC (your internet blocks them). We cannot test the password from here; we will verify via Render instead.");
}
