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
  release(): void;
}
interface PgPoolLike extends PgClientLike {
  connect(): Promise<PgPoolClientLike>;
}
type PgPoolOptions = {
  connectionString?: string;
  max?: number;
  ssl?: boolean | { rejectUnauthorized?: boolean };
  connectionTimeoutMillis?: number;
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

function createPostgresClient(): DatabaseClient {
  // The pool is created lazily on first use so the SQLite path never loads the
  // pg driver, and so importing this module has no side effects.
  let poolPromise: Promise<PgPoolLike> | null = null;
  async function getPool(): Promise<PgPoolLike> {
    if (!poolPromise) {
      // A specifier typed as a plain string keeps TypeScript from resolving pg's
      // type declarations at build time; Node resolves the package at runtime.
      const specifier: string = "pg";
      const connectionString = config.databaseUrl ?? "";
      // A hosted Postgres (Supabase) requires TLS. We skip certificate
      // verification because the managed provider terminates TLS with its own CA;
      // the connection is still encrypted. A local Postgres is left plain.
      const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])/.test(connectionString);
      poolPromise = import(specifier).then((mod: { default?: PgModule } & PgModule) => {
        const Pool = (mod.default ?? mod).Pool;
        return new Pool({
          connectionString,
          max: 8,
          ssl: isLocal ? undefined : { rejectUnauthorized: false },
          // Fail a stuck connection in ten seconds with a clear error instead of
          // hanging, so a bad URL surfaces in the logs rather than looping.
          connectionTimeoutMillis: 10_000
        });
      });
    }
    return poolPromise;
  }

  const run = async (executor: PgClientLike, statement: DbStatement): Promise<DbResult> => {
    const { sql, args } = statementParts(statement);
    const result = await executor.query(toPostgresText(sql), args);
    return { rows: result.rows ?? [], rowsAffected: result.rowCount ?? 0 };
  };

  return {
    dialect: "postgres",
    async execute(statement) {
      const pool = await getPool();
      return run(pool, statement);
    },
    async batch(statements) {
      const pool = await getPool();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const results: DbResult[] = [];
        for (const statement of statements) results.push(await run(client, statement));
        await client.query("COMMIT");
        return results;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
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
