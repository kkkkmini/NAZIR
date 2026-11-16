/**
 * Database connection guard.
 *
 * Separates the development database from the test database and from anything that looks like a
 * shared environment (Step 2 requirement: "개발 DB와 테스트 DB를 분리한다", "테스트 DB를 운영 DB와
 * 절대 혼용하지 않는다"). Pure (no I/O) so it can be unit-tested and reused by scripts.
 *
 * Rules:
 *  - The database name is the last path segment of DATABASE_URL.
 *  - Test databases are recognised by a `_test` suffix.
 *  - NAZIR_RUNTIME_ENV=test  => the app may only connect to a `_test` database.
 *  - any other environment   => the app must NOT connect to a `_test` database.
 *  - Only postgresql:// URLs are accepted; the password never appears in error messages.
 */
import type { RuntimeEnv } from "./runtime-config";

export const TEST_DB_SUFFIX = "_test";

export interface DatabaseInfo {
  /** Password-free description, safe to log. */
  host: string;
  port: string;
  database: string;
  user: string;
  isTestDatabase: boolean;
}

export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigError";
  }
}

export function parseDatabaseUrl(raw: string | undefined, label = "DATABASE_URL"): DatabaseInfo {
  if (!raw || raw.trim() === "") {
    throw new DatabaseConfigError(`${label} is not set`);
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    // Never echo the raw value: it may contain a password.
    throw new DatabaseConfigError(`${label} is not a valid URL`);
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new DatabaseConfigError(`${label} must be a postgresql:// URL`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) {
    throw new DatabaseConfigError(`${label} must name a database`);
  }
  return {
    host: url.hostname,
    port: url.port || "5432",
    database,
    user: decodeURIComponent(url.username),
    isTestDatabase: database.endsWith(TEST_DB_SUFFIX),
  };
}

/** Throws when DATABASE_URL points at a database that does not belong to `runtimeEnv`. */
export function assertDatabaseMatchesEnv(runtimeEnv: RuntimeEnv, raw: string | undefined): DatabaseInfo {
  const info = parseDatabaseUrl(raw);
  if (runtimeEnv === "test" && !info.isTestDatabase) {
    throw new DatabaseConfigError(
      `NAZIR_RUNTIME_ENV=test requires a database whose name ends with "${TEST_DB_SUFFIX}" (got "${info.database}")`,
    );
  }
  if (runtimeEnv !== "test" && info.isTestDatabase) {
    throw new DatabaseConfigError(
      `A "${TEST_DB_SUFFIX}" database ("${info.database}") must not be used with NAZIR_RUNTIME_ENV=${runtimeEnv}`,
    );
  }
  return info;
}

/** Non-secret summary safe to log. */
export function describeDatabase(info: DatabaseInfo) {
  return { host: info.host, port: info.port, database: info.database, isTestDatabase: info.isTestDatabase };
}
