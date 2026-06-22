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

const connectionString = stripSslQueryParams(normalizePostgresUrl(raw));

const pg = await import("pg");
const Pool = (pg.default ?? pg).Pool;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 12_000 });

console.log("\n--- Trying to connect ---");
try {
  const result = await pool.query("select 1 as ok");
  console.log("SUCCESS: connected and ran a query. ok =", result.rows[0].ok);
  console.log("=> Your DATABASE_URL is CORRECT. If Render still fails, Render has a different value than this.\n");
} catch (error) {
  console.log("FAILED:", error.code || "", "-", error.message);
  if (error.code === "28P01") {
    console.log("=> 28P01 means the password in this string does NOT match this Supabase project right now.\n");
  } else if (error.code === "ENOTFOUND" || error.code === "ETIMEDOUT" || error.code === "ECONNREFUSED" || error.code === "ENETUNREACH") {
    console.log("=> The host could not be reached from this PC (network/firewall or wrong host).\n");
  } else {
    console.log("");
  }
} finally {
  await pool.end().catch(() => {});
}
