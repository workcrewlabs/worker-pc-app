import { createClient } from "@libsql/client";
import { config } from "../config.js";

// Minimal structural types for the slice of node-postgres this code uses. They
// let the production build compile without @types/pg (a dev dependency that is
// not guaranteed to be present in a production install). The pg package itself
// is a runtime dependency and is loaded lazily, only when Postgres is selected.
type PgQueryResult = { rows: Record<string, unknown>[]; rowCount: number | null };
interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
}
interface PgPoolClientLike extends PgClientLike {
  release(destroy?: boolean): void;
}
interface PgPoolLike extends PgClientLike {
  connect(): Promise<PgPoolClientLike>;
  on(event: "error", listener: (error: unknown) => void): void;
}
type PgPoolOptions = {
  connectionString?: string;
  max?: number;
  ssl?: boolean | { rejectUnauthorized?: boolean };
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  keepAlive?: boolean;
  allowExitOnIdle?: boolean;
};
type PgModule = { Pool: new (options: PgPoolOptions) => PgPoolLike };

// A single, minimal database surface the rest of the API codes against, so the
// same query functions run unchanged on either SQLite/libSQL (local development
// and tests) or Postgres (production, Supabase). The shape mirrors the small
// slice of the libSQL client the codebase already used: execute() and batch()
// returning rows and an affected-row count.

export type DbStatement = string | { sql: string; args?: unknown[] };
export type DbResult = { rows: Record<string, unknown>[]; rowsAffected: number };
export type DbDialect = "sqlite" | "postgres";

/**
 * Percent-encode the password inside a Postgres connection string. An
 * auto-generated database password often contains characters that are
 * significant in a URL (for example ? # @ : /). Left raw, they corrupt the
 * parsed connection and the wrong password is sent, which surfaces as
 * "password authentication failed". Encoding only the password fixes that while
 * leaving the user, host, port, database, and any query parameters untouched.
 * A string that does not look like a Postgres URL is returned unchanged.
 * Exported for direct unit testing.
 */
export function normalizePostgresUrl(raw: string): string {
  const trimmed = raw.trim();
  // protocol, user (no : @ /), password (greedy to the LAST @), then host/rest.
  const match = /^(postgres(?:ql)?:\/\/)([^:@/]+):([\s\S]*)@([^@]+)$/.exec(trimmed);
  if (!match) return trimmed;
  const [, protocol = "", user = "", password = "", hostAndRest = ""] = match;
  return `${protocol}${user}:${encodeURIComponent(password)}@${hostAndRest}`;
}

// Remove SSL-related query parameters from a connection string so the explicit
// pool ssl option is the single source of truth. Otherwise a sslmode=require in
// the URL is treated as verify-full and rejects the managed provider's
// certificate (self-signed in chain). Runs after normalizePostgresUrl, so the
// only remaining "?" is the real query separator. Exported for unit testing.
const SSL_QUERY_KEYS = new Set(["sslmode", "ssl", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"]);
export function stripSslQueryParams(url: string): string {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return url;
  const base = url.slice(0, queryStart);
  const kept = url
    .slice(queryStart + 1)
    .split("&")
    .filter((pair) => {
      const key = pair.split("=")[0]?.toLowerCase() ?? "";
      return key.length > 0 && !SSL_QUERY_KEYS.has(key);
    });
  return kept.length > 0 ? `${base}?${kept.join("&")}` : base;
}

export interface DatabaseClient {
  readonly dialect: DbDialect;
  execute(statement: DbStatement): Promise<DbResult>;
  batch(statements: DbStatement[], mode?: "read" | "write"): Promise<DbResult[]>;
}

/**
 * Translate libSQL-style positional placeholders (?) into the numbered form
 * Postgres expects ($1, $2, ...). The codebase never embeds a literal "?" in a
 * string literal inside its SQL, so a straight left-to-right substitution is
 * safe. Exported for direct unit testing.
 */
export function toPostgresText(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${(index += 1)}`);
}

function statementParts(statement: DbStatement): { sql: string; args: unknown[] } {
  if (typeof statement === "string") return { sql: statement, args: [] };
  return { sql: statement.sql, args: statement.args ?? [] };
}

function createLibsqlClient(): DatabaseClient {
  const client = createClient({ url: config.dataUrl, authToken: config.dataAuthToken });
  const toResult = (result: { rows: unknown; rowsAffected?: number }): DbResult => ({
    rows: result.rows as unknown as Record<string, unknown>[],
    rowsAffected: result.rowsAffected ?? 0
  });
  return {
    dialect: "sqlite",
    async execute(statement) {
      return toResult(await client.execute(statement as never));
    },
    async batch(statements, mode = "write") {
      const results = await client.batch(statements as never, mode);
      return results.map((result) => toResult(result));
    }
  };
}

/**
 * Log a safe summary of the configured DATABASE_URL so a misconfiguration is
 * visible in the deploy log without ever printing the password. It surfaces the
 * username (which carries the Supabase project ref), the host, and common
 * mistakes (empty password, leftover [brackets], unreplaced placeholder, stray
 * spaces). Diagnostics only; the password value is never logged.
 */
function logPostgresDiagnostics(raw: string): void {
  const value = raw.trim();
  const match = /^(postgres(?:ql)?:\/\/)([^:@/]+):([\s\S]*)@([^@/]+)(\/.*)?$/.exec(value);
  if (!match) {
    console.info("[WorkCrew] DATABASE_URL is set but does not look like a Postgres URL (check it begins with postgresql:// and has user:password@host).");
    return;
  }
  const user = match[2] ?? "";
  const password = match[3] ?? "";
  const host = match[4] ?? "";
  const issues: string[] = [];
  if (password.length === 0) issues.push("password is EMPTY");
  if (/[[\]]/.test(password)) issues.push("password still contains [ or ] brackets");
  if (password.includes("YOUR-PASSWORD")) issues.push("the [YOUR-PASSWORD] placeholder was not replaced");
  if (/\s/.test(value)) issues.push("the value contains a space");
  if (!host.includes("pooler.supabase.com")) issues.push("host is not the Supabase pooler (use the Session pooler string)");
  console.info(
    `[WorkCrew] Postgres target: user=${user} host=${host} passwordChars=${password.length}` +
      (issues.length ? ` ISSUES: ${issues.join("; ")}` : " (structure looks OK; if auth still fails the password value does not match this project)")
  );
}

function createPostgresClient(): DatabaseClient {
  // The pool is created lazily on first use so the SQLite path never loads the
  // pg driver, and so importing this module has no side effects.
  let poolPromise: Promise<PgPoolLike> | null = null;
  async function getPool(): Promise<PgPoolLike> {
    if (!poolPromise) {
      // A specifier typed as a plain string keeps TypeScript from resolving pg's
      // type declarations at build time; Node resolves the package at runtime.
      const specifier: string = "pg";
      logPostgresDiagnostics(config.databaseUrl ?? "");
      // Normalize the password, then strip any SSL query params so the explicit
      // ssl option below is the only thing that controls the TLS behavior.
      const connectionString = stripSslQueryParams(normalizePostgresUrl(config.databaseUrl ?? ""));
      // A hosted Postgres (Supabase) requires TLS. We skip certificate
      // verification because the managed provider terminates TLS with its own CA;
      // the connection is still encrypted. A local Postgres is left plain.
      const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])/.test(connectionString);
      poolPromise = import(specifier).then((mod: { default?: PgModule } & PgModule) => {
        const Pool = (mod.default ?? mod).Pool;
        const pool = new Pool({
          connectionString,
          max: 8,
          ssl: isLocal ? undefined : { rejectUnauthorized: false },
          // Fail a stuck connection in ten seconds with a clear error instead of
          // hanging, so a bad URL surfaces in the logs rather than looping.
          connectionTimeoutMillis: 10_000,
          // Close our own idle connections before the Supabase pooler does (it
          // drops idle ones after a short while). This stops us from ever picking
          // a connection the pooler already killed, which is the usual cause of a
          // sporadic "Connection terminated" failure on an otherwise valid query.
          idleTimeoutMillis: 30_000,
          keepAlive: true,
          allowExitOnIdle: false
        });
        // An idle pooled connection can be closed by the server at any time. pg
        // emits that as an 'error' on the pool; without a listener it would crash
        // the whole process. We log and move on; the next query opens a fresh one.
        pool.on("error", (error: unknown) => {
          console.error("[WorkCrew] idle Postgres client error (recovered):", error instanceof Error ? error.message : error);
        });
        return pool;
      });
    }
    return poolPromise;
  }

  // A dropped pooled connection surfaces as one of these. The query never ran, so
  // retrying it once on a fresh connection is safe and transparent.
  const isTransient = (error: unknown): boolean => {
    const code = (error as { code?: string })?.code ?? "";
    const message = error instanceof Error ? error.message : String(error ?? "");
    return (
      ["ECONNRESET", "EPIPE", "ETIMEDOUT", "08006", "08003", "08000", "57P01", "57P02", "57P03"].includes(code) ||
      /connection terminated|server closed the connection|connection closed|terminating connection/i.test(message)
    );
  };

  const run = async (executor: PgClientLike, statement: DbStatement): Promise<DbResult> => {
    const { sql, args } = statementParts(statement);
    const result = await executor.query(toPostgresText(sql), args);
    return { rows: result.rows ?? [], rowsAffected: result.rowCount ?? 0 };
  };

  return {
    dialect: "postgres",
    async execute(statement) {
      const pool = await getPool();
      try {
        return await run(pool, statement);
      } catch (error) {
        if (!isTransient(error)) throw error;
        // The pooled connection was dead. pool.query picks a fresh one on retry.
        console.warn("[WorkCrew] Postgres connection dropped; retrying once on a fresh connection.");
        return run(pool, statement);
      }
    },
    async batch(statements) {
      const pool = await getPool();
      const runBatch = async (): Promise<DbResult[]> => {
        const client = await pool.connect();
        let failed = false;
        try {
          await client.query("BEGIN");
          const results: DbResult[] = [];
          for (const statement of statements) results.push(await run(client, statement));
          await client.query("COMMIT");
          return results;
        } catch (error) {
          failed = true;
          try {
            await client.query("ROLLBACK");
          } catch {
            // The connection itself is gone; nothing to roll back.
          }
          throw error;
        } finally {
          // Destroy the client when the transaction failed so a possibly dead
          // connection is not returned to the pool to be handed out again.
          client.release(failed);
        }
      };
      try {
        return await runBatch();
      } catch (error) {
        if (!isTransient(error)) throw error;
        console.warn("[WorkCrew] Postgres connection dropped mid-transaction; retrying the batch once.");
        return runBatch();
      }
    }
  };
}

/**
 * Choose the database backend. Postgres is used whenever DATABASE_URL is set and
 * we are not running the test suite (tests always use the local SQLite file so
 * they need no external service). Otherwise SQLite/libSQL is used.
 */
export function createDatabaseClient(): DatabaseClient {
  const usePostgres = Boolean(config.databaseUrl) && config.nodeEnv !== "test";
  return usePostgres ? createPostgresClient() : createLibsqlClient();
}
