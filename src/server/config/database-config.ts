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
 *  - DATABASE_URL (pooled, app runtime) and DATABASE_URL_UNPOOLED (direct, Prisma CLI + seed) must both pass these rules
 *    and name the same database (`selectDirectDatabaseUrl`).
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

/** Throws when the URL (DATABASE_URL, or `label`) points at a database that does not belong to `runtimeEnv`. */
export function assertDatabaseMatchesEnv(runtimeEnv: RuntimeEnv, raw: string | undefined, label = "DATABASE_URL"): DatabaseInfo {
  const info = parseDatabaseUrl(raw, label);
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

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
/** Neon serves the same endpoint directly and through its pooler: `ep-x-pooler.<region>.neon.tech` ≡ `ep-x.<region>.neon.tech`. */
const NEON_DOMAIN = ".neon.tech";
const NEON_POOLER_SUFFIX = "-pooler";

/** The server a host name denotes: loopback spellings are one host, and a Neon pooler host is its endpoint's host. */
export function canonicalDatabaseHost(host: string): string {
  const h = host.toLowerCase();
  if (LOOPBACK_HOSTS.has(h)) return "localhost";
  if (h.endsWith(NEON_DOMAIN)) {
    const [endpoint, ...rest] = h.split(".");
    if (endpoint.endsWith(NEON_POOLER_SUFFIX) && endpoint.length > NEON_POOLER_SUFFIX.length) {
      return [endpoint.slice(0, -NEON_POOLER_SUFFIX.length), ...rest].join(".");
    }
  }
  return h;
}

/**
 * True when both URLs name the same database on the same server: loopback spellings count as one host, a Neon pooled
 * host (`…-pooler.….neon.tech`) and its direct host count as one host, credentials and query parameters are irrelevant.
 * Used for (1) the Prisma shadow database, which the CLI resets, so it must never be a main database under any spelling,
 * and (2) DATABASE_URL / DATABASE_URL_UNPOOLED, which must be the same database reached two ways.
 */
export function isSameDatabase(a: DatabaseInfo, b: DatabaseInfo): boolean {
  return canonicalDatabaseHost(a.host) === canonicalDatabaseHost(b.host) && a.port === b.port && a.database === b.database;
}

export const POOLED_URL_VAR = "DATABASE_URL";
export const DIRECT_URL_VAR = "DATABASE_URL_UNPOOLED";
export type DatabaseUrlVar = typeof POOLED_URL_VAR | typeof DIRECT_URL_VAR;

export interface DatabaseUrlSelection {
  /** The variable whose URL is used: DATABASE_URL_UNPOOLED when it is set, otherwise DATABASE_URL. */
  variable: DatabaseUrlVar;
  /** The URL to connect with, trimmed — exactly the string that was validated. May hold a password: never log it. */
  url: string;
  database: DatabaseInfo;
}

const isBlank = (v: string | undefined) => v === undefined || v.trim() === "";

/**
 * Pooled / direct connection pair (Neon: DATABASE_URL = pooled, for the app at runtime; DATABASE_URL_UNPOOLED = direct,
 * for the Prisma CLI and the seed, which need session features a transaction-mode pooler does not offer).
 *
 *  - Each variable that is set (non-blank) must belong to `runtimeEnv` (same rule as `assertDatabaseMatchesEnv`).
 *  - When both are set they must name the SAME database (`isSameDatabase`, Neon pooler-aware): a direct URL that points
 *    elsewhere would make migrations or the seed write to a database the app does not use.
 *  - Returns the URL the CLI / seed should use: DATABASE_URL_UNPOOLED when set, otherwise DATABASE_URL (local
 *    development keeps working with DATABASE_URL alone). Returns null when neither is set.
 *  - Errors name variables and database names only, never a URL.
 */
export function selectDirectDatabaseUrl(
  runtimeEnv: RuntimeEnv,
  env: Record<string, string | undefined>,
): DatabaseUrlSelection | null {
  const rawPooled = env[POOLED_URL_VAR];
  const rawDirect = env[DIRECT_URL_VAR];
  const pooled = isBlank(rawPooled) ? null : assertDatabaseMatchesEnv(runtimeEnv, rawPooled, POOLED_URL_VAR);
  const direct = isBlank(rawDirect) ? null : assertDatabaseMatchesEnv(runtimeEnv, rawDirect, DIRECT_URL_VAR);
  if (pooled && direct && !isSameDatabase(pooled, direct)) {
    // Name what differs without printing hosts or credentials.
    const what =
      direct.database !== pooled.database
        ? `databases "${direct.database}" and "${pooled.database}"`
        : `database "${direct.database}" on different servers (host or port)`;
    throw new DatabaseConfigError(`${DIRECT_URL_VAR} and ${POOLED_URL_VAR} must name the same database (got ${what})`);
  }
  if (direct) return { variable: DIRECT_URL_VAR, url: (rawDirect as string).trim(), database: direct };
  if (pooled) return { variable: POOLED_URL_VAR, url: (rawPooled as string).trim(), database: pooled };
  return null;
}

/**
 * Database configuration check for the APP RUNTIME (server startup, `npm run check:config`). Pure — no connection.
 *
 * The app connects with DATABASE_URL only (pooled); DATABASE_URL_UNPOOLED is for the Prisma CLI and the seed. So:
 *  - DATABASE_URL_UNPOOLED set without DATABASE_URL → refused: the app would have no database while looking configured.
 *    (The CLI and the seed may still run with DATABASE_URL_UNPOOLED alone — they use `selectDirectDatabaseUrl`.)
 *  - DATABASE_URL set → it must belong to `runtimeEnv`; if DATABASE_URL_UNPOOLED is set too, it must also belong to
 *    `runtimeEnv` and name the same database (`selectDirectDatabaseUrl`).
 *  - Neither set → null (a database is not required at startup yet).
 * Blank handling is unchanged from the startup check: an empty DATABASE_URL counts as unset, a whitespace-only one is
 * refused; a blank DATABASE_URL_UNPOOLED counts as unset. Errors name variables and databases only, never a URL.
 */
export function assertRuntimeDatabaseConfig(
  runtimeEnv: RuntimeEnv,
  env: Record<string, string | undefined>,
): { pooled: DatabaseInfo; direct: DatabaseInfo | null } | null {
  const rawPooled = env[POOLED_URL_VAR];
  const hasDirect = !isBlank(env[DIRECT_URL_VAR]);
  if (!rawPooled) {
    if (hasDirect) {
      throw new DatabaseConfigError(
        `${DIRECT_URL_VAR} is set but ${POOLED_URL_VAR} is not: the app connects only with ${POOLED_URL_VAR} ` +
          `(the pooled URL); ${DIRECT_URL_VAR} is for the Prisma CLI and the seed`,
      );
    }
    return null;
  }
  const pooled = assertDatabaseMatchesEnv(runtimeEnv, rawPooled, POOLED_URL_VAR);
  const direct = hasDirect ? (selectDirectDatabaseUrl(runtimeEnv, env) as DatabaseUrlSelection).database : null;
  return { pooled, direct };
}
