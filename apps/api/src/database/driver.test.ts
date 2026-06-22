import { describe, expect, it } from "vitest";
import { createDatabaseClient, normalizePostgresUrl, toPostgresText } from "./driver.js";

describe("normalizePostgresUrl", () => {
  it("percent-encodes a password with URL-significant characters", () => {
    const raw = "postgresql://postgres.abcdef:p?ss#wo/rd@aws-0-eu.pooler.supabase.com:5432/postgres";
    const out = normalizePostgresUrl(raw);
    expect(out).toBe("postgresql://postgres.abcdef:p%3Fss%23wo%2Frd@aws-0-eu.pooler.supabase.com:5432/postgres");
  });

  it("leaves a simple password unchanged", () => {
    const raw = "postgresql://postgres.abcdef:WorkCrew2026@aws-0-eu.pooler.supabase.com:5432/postgres";
    expect(normalizePostgresUrl(raw)).toBe(raw);
  });

  it("keeps the host, port, database, and the project-ref user intact", () => {
    const out = normalizePostgresUrl("postgres://postgres.proj:a@b@host:6543/db?sslmode=require");
    expect(out).toContain("@host:6543/db?sslmode=require");
    expect(out).toContain("postgres.proj:");
  });

  it("returns a non-matching string unchanged", () => {
    expect(normalizePostgresUrl("file:workcrew.db")).toBe("file:workcrew.db");
  });
});

describe("toPostgresText", () => {
  it("numbers placeholders left to right", () => {
    expect(toPostgresText("INSERT INTO t(a, b, c) VALUES (?, ?, ?)")).toBe(
      "INSERT INTO t(a, b, c) VALUES ($1, $2, $3)"
    );
  });

  it("leaves SQL without placeholders untouched", () => {
    expect(toPostgresText("SELECT * FROM t WHERE id = '5'")).toBe("SELECT * FROM t WHERE id = '5'");
  });

  it("handles a single placeholder", () => {
    expect(toPostgresText("SELECT * FROM t WHERE id = ?")).toBe("SELECT * FROM t WHERE id = $1");
  });
});

describe("createDatabaseClient", () => {
  it("uses the SQLite/libSQL driver in the test environment", () => {
    // The test suite never sets DATABASE_URL, so the local SQLite driver is used.
    expect(createDatabaseClient().dialect).toBe("sqlite");
  });
});
