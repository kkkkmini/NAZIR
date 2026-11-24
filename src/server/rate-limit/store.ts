/**
 * PostgreSQL rate limit counter store (A-045, DATABASE.md §3.28).
 *
 * One statement per hit — `INSERT … ON CONFLICT (policy, key_hash) DO UPDATE … RETURNING`. PostgreSQL guarantees that
 * concurrent upserts of the same key either insert or lock-and-update the one row, so no increment is lost and two
 * requests can never both see the same count (verified under real concurrent transactions, RL-09).
 *
 * Fixed window, all times DB `now()`: a window starts at the first hit and ends at `expires_at`. A hit at or after
 * `expires_at` restarts the window at count 1 (boundary: `expires_at <= now()` counts as expired). Rejected hits are
 * counted too (capped at limit + 1), so hammering does not slip extra attempts through; the window is never extended
 * by rejected hits, so `retryAt` is stable.
 *
 * `now()` is the transaction start time: call `hit` outside a long transaction (or in its own) so the window uses the
 * request's time.
 */

/** Parameterised SQL executor. Implemented by node-pg clients and by Prisma ($queryRawUnsafe). */
export type SqlExecutor = <T>(sql: string, params: unknown[]) => Promise<T[]>;

export interface HitResult {
  count: number;
  nowMs: number;
  expiresAtMs: number;
}

const HIT_SQL = `
INSERT INTO "rate_limit_counters" AS c ("policy", "key_hash", "window_started_at", "expires_at", "count")
VALUES ($1, $2, now(), now() + $3::int * interval '1 millisecond', 1)
ON CONFLICT ("policy", "key_hash") DO UPDATE SET
  "count"             = CASE WHEN c."expires_at" <= now() THEN 1 ELSE LEAST(c."count" + 1, $4::int) END,
  "window_started_at" = CASE WHEN c."expires_at" <= now() THEN now() ELSE c."window_started_at" END,
  "expires_at"        = CASE WHEN c."expires_at" <= now() THEN now() + $3::int * interval '1 millisecond' ELSE c."expires_at" END,
  "updated_at"        = now()
RETURNING "count",
  floor(extract(epoch FROM now()) * 1000)::bigint AS "nowMs",
  floor(extract(epoch FROM "expires_at") * 1000)::bigint AS "expiresAtMs"`;

const toMs = (v: unknown): number => {
  const n = typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isSafeInteger(n)) throw new Error("rate limit store returned an invalid timestamp");
  return n;
};

export async function hitCounter(
  exec: SqlExecutor,
  policy: string,
  keyHash: string,
  windowMs: number,
  limit: number,
): Promise<HitResult> {
  const rows = await exec<{ count: unknown; nowMs: unknown; expiresAtMs: unknown }>(HIT_SQL, [
    policy,
    keyHash,
    windowMs,
    limit + 1,
  ]);
  if (rows.length !== 1) throw new Error("rate limit upsert did not return exactly one row");
  return { count: Number(rows[0].count), nowMs: toMs(rows[0].nowMs), expiresAtMs: toMs(rows[0].expiresAtMs) };
}

/**
 * Deletes up to `batchSize` expired counters (expires_at <= now()). Safe to run concurrently with hits: a hit on a
 * deleted key just starts a new window, which is exactly what an expired row would do. Returns the number deleted.
 */
export async function deleteExpiredCounters(exec: SqlExecutor, batchSize = 1000): Promise<number> {
  const rows = await exec<{ n: unknown }>(
    `WITH gone AS (
       DELETE FROM "rate_limit_counters" WHERE ctid IN (
         SELECT ctid FROM "rate_limit_counters" WHERE "expires_at" <= now() LIMIT $1::int FOR UPDATE SKIP LOCKED)
       RETURNING 1)
     SELECT count(*)::int AS n FROM gone`,
    [batchSize],
  );
  return Number(rows[0]?.n ?? 0);
}
