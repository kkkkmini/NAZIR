/**
 * Row-lock helpers for booking transactions (DATABASE.md §11.2, §13.2, review S10).
 *
 * Global lock order (A-020): purchase_quotas → orders → payments → refunds → session_seats (id ascending) → seat_holds
 * → tickets. These helpers cover steps 1 and 5. Call them only inside `runBookingTx` (READ COMMITTED), and take every
 * decision (active order, counter, seat status) from statements executed AFTER the lock (A-029 "lock, then decide").
 */
import type { SqlExecutor } from "../db/sql";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface LockedQuota {
  identitySubjectId: string;
  showSessionId: string;
  seatLimit: number;
  countedSeats: number;
  version: number;
}

/**
 * Step 1 of §11.2: makes sure the (subject, session) quota row exists, then locks it FOR UPDATE.
 *
 * - The row is created with `seat_limit` = the session's CURRENT `max_seats_per_identity` (A-029 snapshot). An existing
 *   row is never changed (`ON CONFLICT (pk) DO NOTHING`: the conflict target is the plain primary key, so no partial-
 *   index predicate is involved — S10).
 * - Concurrency (measured in the DB tests): when the row does not exist yet, a second transaction's INSERT waits on the
 *   primary-key index until the first one ends, then either skips (committed) or inserts (rolled back). Either way the
 *   following FOR UPDATE reads the committed counter.
 * - Returns null when the show session does not exist (nothing inserted, nothing locked); the caller maps it.
 */
export async function ensureAndLockQuota(tx: SqlExecutor, identitySubjectId: string, showSessionId: string): Promise<LockedQuota | null> {
  if (!UUID.test(identitySubjectId) || !UUID.test(showSessionId)) throw new Error("ensureAndLockQuota: ids must be lowercase uuids");
  await tx(
    `INSERT INTO "purchase_quotas" ("identity_subject_id", "show_session_id", "seat_limit")
     SELECT $1::uuid, s."id", s."max_seats_per_identity" FROM "show_sessions" s WHERE s."id" = $2::uuid
     ON CONFLICT ("identity_subject_id", "show_session_id") DO NOTHING`,
    [identitySubjectId, showSessionId],
  );
  const rows = await tx<{ seat_limit: number; counted_seats: number; version: bigint | number | string }>(
    `SELECT "seat_limit", "counted_seats", "version" FROM "purchase_quotas"
      WHERE "identity_subject_id" = $1::uuid AND "show_session_id" = $2::uuid FOR UPDATE`,
    [identitySubjectId, showSessionId],
  );
  const r = rows[0];
  if (!r) return null;
  return { identitySubjectId, showSessionId, seatLimit: Number(r.seat_limit), countedSeats: Number(r.counted_seats), version: Number(r.version) };
}

export interface LockedSeat {
  id: string;
  showSessionId: string;
  status: string;
  price: bigint;
  soldOrderItemId: string | null;
}

/** Validates, de-duplicates (rejects duplicates) and sorts seat ids the way PostgreSQL orders uuids. */
export function sortSeatIds(ids: readonly string[]): string[] {
  if (ids.length === 0) throw new Error("lockSeatsSorted: no seat ids");
  for (const id of ids) if (typeof id !== "string" || !UUID.test(id)) throw new Error("lockSeatsSorted: ids must be lowercase uuids");
  if (new Set(ids).size !== ids.length) throw new Error("lockSeatsSorted: duplicate seat ids");
  // Lowercase hex uuids compare in byte order as strings, which is PostgreSQL's uuid order.
  return [...ids].sort();
}

/**
 * Step 4 of §11.2 / step 5 of §13.2: locks `session_seats` rows FOR UPDATE one by one in ascending id order, so two
 * transactions asking for overlapping seats in any order acquire them in the same order (no lock cycle → no deadlock
 * between them, TEST SEAT-11). One statement per seat on purpose: the order is then guaranteed by the code, not by the
 * query plan. A booking has at most 4 seats.
 *
 * Returns the rows found, in lock order. Missing ids are simply absent: the caller compares and maps (it also checks the
 * show session and the status — the helper does not decide).
 */
export async function lockSeatsSorted(tx: SqlExecutor, sessionSeatIds: readonly string[]): Promise<LockedSeat[]> {
  const out: LockedSeat[] = [];
  for (const id of sortSeatIds(sessionSeatIds)) {
    const rows = await tx<{ id: string; show_session_id: string; status: string; price: bigint | number | string; sold_order_item_id: string | null }>(
      `SELECT "id", "show_session_id", "status", "price", "sold_order_item_id" FROM "session_seats" WHERE "id" = $1::uuid FOR UPDATE`,
      [id],
    );
    const r = rows[0];
    if (r) out.push({ id: r.id, showSessionId: r.show_session_id, status: r.status, price: BigInt(r.price), soldOrderItemId: r.sold_order_item_id });
  }
  return out;
}
