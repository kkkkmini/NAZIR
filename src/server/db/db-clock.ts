/**
 * DbClock — the database's notion of "now" (DATABASE.md §1.2, DECISIONS A-023).
 *
 * Expiry, sales-window and payment-protection decisions use DB time, not the web server's clock, so every
 * server instance agrees with the timestamps the database itself writes (`DEFAULT now()`).
 *
 * The class depends only on a `$queryRaw` executor, never on the global client, so it can be bound to:
 *   - the application Prisma client (`getAppClock()` in ./app-clock.ts) for request-scoped reads, or
 *   - an interactive transaction client (`new DbClock(tx)`). PostgreSQL `now()` is the START time of the current
 *     transaction, so inside one transaction every read returns the same instant — a single consistent "now" for all
 *     decisions taken in that transaction. Outside a transaction each call is its own statement and returns a fresh time.
 *
 * Failure policy (fail-closed): a database error is propagated unchanged and there is NO fallback to the system clock.
 * Falling back would silently make time-based decisions on a different clock (A-023). Route handlers turn the error
 * into a generic 500 through `toErrorResponse`, which never leaks internal error text.
 *
 * Tests control time by injecting `FixedClock` (src/server/lib/clock.ts) wherever a `Clock` is expected; DbClock itself
 * is verified against a real PostgreSQL server (tests/contract/schema/db-clock.test.ts, DB-03).
 *
 * Next.js Cache Components: reading the clock is a dynamic, request-time operation. Call it only after the request has
 * become dynamic (e.g. `await connection()`), and never inside a `'use cache'` scope, or the build would freeze a time.
 *
 * No `server-only` import here on purpose: this file holds no credentials and is unit-tested in plain Node with a fake
 * executor. The factory that touches the real client (./app-clock.ts) is server-only.
 */
import type { Clock } from "../lib/clock";

/** The one Prisma capability DbClock needs. Satisfied by PrismaClient and by an interactive transaction client. */
export interface RawQueryExecutor {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<T>;
}

/** The database answered, but not with a usable timestamp. Indicates a driver/adapter contract change, not user input. */
export class DbClockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbClockError";
  }
}

export class DbClock implements Clock {
  constructor(private readonly db: RawQueryExecutor) {}

  async now(): Promise<Date> {
    // Read now() as epoch milliseconds, NOT as a timestamptz value: @prisma/adapter-pg decodes a timestamptz as if the
    // session were UTC, so under `TimeZone=Asia/Seoul` the instant would come back 9 hours off (DB-03). App connections
    // are pinned to UTC (./pg-adapter.ts, TZ-02), and the epoch read keeps the clock correct even on a connection that
    // is not — e.g. a transaction that ran `SET LOCAL TIME ZONE`. An epoch number has no time zone to misread.
    // floor() keeps millisecond precision deterministic (now() has microseconds; Date has milliseconds).
    const rows = await this.db.$queryRaw<unknown>`SELECT floor(extract(epoch FROM now()) * 1000)::bigint AS "epochMs"`;
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new DbClockError("SELECT now() did not return exactly one row");
    }
    const value = (rows[0] as { epochMs?: unknown } | null)?.epochMs;
    const ms = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : Number.NaN;
    if (!Number.isSafeInteger(ms)) {
      throw new DbClockError("SELECT now() did not return a valid timestamp");
    }
    const now = new Date(ms);
    if (Number.isNaN(now.getTime())) {
      throw new DbClockError("SELECT now() did not return a valid timestamp");
    }
    return now;
  }
}
