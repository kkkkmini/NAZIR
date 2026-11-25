/**
 * PostgreSQL driver configuration for Prisma 7 (`@prisma/adapter-pg` over `pg`) — every application connection
 * runs with the session TimeZone fixed to UTC.
 *
 * Why (TEST_PLAN §2.3 S11, DATABASE.md §19.5 · §19.12):
 *   `@prisma/adapter-pg` 7.10.1 assumes the session TimeZone is UTC in BOTH directions:
 *   - read: it REPLACES the offset PostgreSQL sends with `+00:00` (`normalize_timestamptz`). On a server/database/role
 *     whose default TimeZone is e.g. `Asia/Seoul`, `… 12:04:05+09` becomes `…T12:04:05+00:00`: 9 hours late, for model
 *     reads and raw queries alike;
 *   - write: it sends a `Date` as UTC wall-clock text WITHOUT an offset (`formatDateTime`), which PostgreSQL interprets
 *     in the session TimeZone: stored 9 hours early.
 *   The two errors cancel out in the app's own write→read round trip, so the bug is silent there, while the stored
 *   instant — and every comparison with SQL `now()`, other clients, and correctly written rows — is wrong.
 *
 * How:
 *   `pg`'s typed `ClientConfig.options` field is sent as the libpq `options` startup parameter in the startup packet of
 *   EVERY connection the pool opens (pg 8.23.1 `lib/client.js` getStartupConf). `-c TimeZone=UTC` therefore applies to
 *   each new pooled connection before its first query, whatever default the provider, database or role configures. It
 *   is not a per-connection `SET` that a pool could lose. A session may still run `SET [LOCAL] TIME ZONE` explicitly;
 *   application code must not (it would bring the misreading back for that session).
 *
 * Guard: `pg` merges the connection string OVER the config object, so a DATABASE_URL carrying its own `options=`
 * query parameter would silently replace ours. Such a URL is refused instead of being rewritten.
 *
 * Whitespace: leading/trailing whitespace (e.g. a newline pasted into a hosting env var) is trimmed, and the TRIMMED
 * string is both the one validated here and the one handed to `pg` — never two different strings. This matches
 * `parseDatabaseUrl()` (src/server/config/database-config.ts), which also trims before checking the database name.
 * Nothing else in the string is changed.
 *
 * Pure (no I/O, no `server-only`): shared by the app client (./client.ts) and unit tests.
 */
import type { PoolConfig } from "pg";
import { DatabaseConfigError } from "../config/database-config";
import type { DbPoolConfig } from "../config/db-pool-config";

/** libpq startup `options` value applied to every application connection. */
export const PG_SESSION_OPTIONS = "-c TimeZone=UTC";

/**
 * `pool` (review M8): pool size and connection/idle limits from `loadDbPoolConfig`. Omitted only by callers that open a
 * short-lived pool of their own (scripts, tests); the application client always passes it (./client.ts).
 */
export function buildPgPoolConfig(connectionString: string | undefined, label = "DATABASE_URL", pool?: DbPoolConfig): PoolConfig {
  const normalized = connectionString?.trim();
  if (!normalized) {
    throw new DatabaseConfigError(`${label} is not set`);
  }
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new DatabaseConfigError(`${label} is not a valid URL`); // never echo the value: it may hold a password
  }
  for (const key of url.searchParams.keys()) {
    if (key.toLowerCase() === "options") {
      throw new DatabaseConfigError(
        `${label} must not set the "options" connection parameter: the application fixes the session TimeZone to UTC ` +
          `through it, and a URL value would silently override that (see src/server/db/pg-adapter.ts)`,
      );
    }
  }
  const base: PoolConfig = { connectionString: normalized, options: PG_SESSION_OPTIONS };
  if (!pool) return base;
  return { ...base, max: pool.poolMax, connectionTimeoutMillis: pool.connectionTimeoutMs, idleTimeoutMillis: pool.idleTimeoutMs };
}
