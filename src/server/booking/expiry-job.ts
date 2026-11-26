/**
 * Periodic hold-expiry job (ARCHITECTURE.md §8 "hold 만료", DATABASE.md §11.4).
 *
 * 1. Read-only candidate scan: PENDING orders with hold_expires_at <= now() (DB time), oldest first, bounded batch.
 *    No row lock is taken by the scan, so it can never invert the quota → order lock order (no SKIP LOCKED needed).
 * 2. Each candidate is ended by expireOrder in its OWN transaction (quota → order locks, full re-check, CONFIRMING never
 *    touched). Concurrent or repeated runs are safe: a second run on the same order finds it no longer PENDING.
 * 3. Errors are isolated per order and counted; a failed order stays PENDING and is picked up by the next run.
 * Logs carry counts, order ids and error codes only — never personal data, tokens or SQL.
 */
import { AppError } from "../lib/errors";
import { classifyDbError } from "../db/errors";
import { expireOrder, type ExpireOutcome } from "./order-lifecycle";
import { runBookingTx, type BookingTxDeps } from "./tx";

export const EXPIRY_BATCH_DEFAULT = 100;
export const EXPIRY_BATCH_MAX = 500;

export interface ExpiryRunSummary {
  scanned: number;
  expired: number;
  releasedSeats: number;
  alreadyEnded: number;
  notDue: number;
  needsReview: number;
  failed: number;
}

export async function runExpiryBatch(deps: BookingTxDeps, batchSize = EXPIRY_BATCH_DEFAULT): Promise<ExpiryRunSummary> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > EXPIRY_BATCH_MAX) throw new Error("invalid expiry batch size");
  const ids = await runBookingTx(deps, {
    name: "order.expire.scan",
    fn: async (tx) =>
      (
        await tx<{ id: string }>(
          `SELECT "id" FROM "orders" WHERE "status" = 'PENDING' AND "hold_expires_at" <= now() ORDER BY "hold_expires_at", "id" LIMIT $1::int`,
          [batchSize],
        )
      ).map((r) => r.id),
  });
  const s: ExpiryRunSummary = { scanned: ids.length, expired: 0, releasedSeats: 0, alreadyEnded: 0, notDue: 0, needsReview: 0, failed: 0 };
  for (const id of ids) {
    let r: ExpireOutcome;
    try {
      r = await expireOrder(deps, id, "EXPIRY_JOB");
    } catch (e) {
      s.failed++;
      const reason = e instanceof AppError ? e.code : (classifyDbError(e)?.kind ?? (e instanceof Error ? e.name : typeof e));
      console.error(`[order-expiry-job] order=${id} failed: ${reason}`);
      continue;
    }
    if (r.kind === "expired") {
      s.expired++;
      s.releasedSeats += r.seats;
    } else if (r.kind === "not_pending" || r.kind === "not_found") s.alreadyEnded++;
    else if (r.kind === "not_due") s.notDue++;
    else s.needsReview++;
  }
  console.info(`[order-expiry-job] ${JSON.stringify(s)}`);
  return s;
}
