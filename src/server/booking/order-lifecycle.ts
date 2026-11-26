/**
 * Ending a PENDING order: expiry (DATABASE.md §11.4 `expireOrder`) and user cancellation (§11.5), A-020 / A-029.
 *
 * ONE booking transaction per order, global lock order (§13.2):
 *   0. read the order's (subject, show session) without a lock — both are immutable for an order
 *   1. purchase_quotas (subject, session)  FOR UPDATE
 *   2. orders                              FOR UPDATE, then re-check the state with statements run AFTER the locks
 *   3. payments of the order               FOR UPDATE
 *   6. seat_holds of the order             UPDATE (ACTIVE → EXPIRED / RELEASED)
 * Session seats (step 5) are not touched: an ended hold simply stops being live; the seat row stays AVAILABLE.
 *
 * Protection (D-003, A-001 — never released here):
 *   - an order that is not PENDING (PAYMENT_CONFIRMING / PAYMENT_UNKNOWN / REVIEW_REQUIRED / PAID / …) — the payment
 *     state machine (Step 6) and the admin procedures own it;
 *   - a PENDING order that nevertheless has a payment in CONFIRMING / UNKNOWN / SUCCEEDED or a CONFIRMING hold (an
 *     inconsistent state): left untouched and reported, never forced.
 *   A READY payment (checkout opened, server confirm never called → no money moved, A-001) is set to CANCELED in the
 *   same transaction, as §11.4 / §11.5 / §12.2 define. No provider call happens here.
 *
 * Effects on success: holds ended, order EXPIRED / CANCELED with closed_at, counted_seats -= number of holds that were
 * ACTIVE (exactly once: a second run finds the order no longer PENDING), order status log, payment status log for a
 * canceled READY payment, outbox event ORDER_EXPIRED / ORDER_CANCELED (next aggregate version). All or nothing.
 */
import type { SqlExecutor } from "../db/sql";
import { AppError } from "../lib/errors";
import { lockBookingSession } from "./session-lock";
import { runBookingTx, type BookingTxDeps } from "./tx";

export type OrderEndSource = "API" | "EXPIRY_JOB" | "SYSTEM";

export type ExpireOutcome =
  | { kind: "expired"; orderId: string; seats: number }
  | { kind: "not_found"; orderId: string }
  | { kind: "not_pending"; orderId: string; status: string }
  | { kind: "not_due"; orderId: string }
  | { kind: "needs_review"; orderId: string; reason: "payment_in_progress" | "confirming_hold" };

export interface OrderSummary {
  orderId: string;
  orderNumber: string;
  status: string;
}

interface OrderRef {
  identity_subject_id: string;
  show_session_id: string;
}
interface LockedOrder {
  status: string;
  order_number: string;
  due: boolean;
}

/** Steps 0–2: lock quota then order; returns the order re-read under the locks (null if it does not exist). */
async function lockOrder(tx: SqlExecutor, orderId: string): Promise<(LockedOrder & OrderRef) | null> {
  const [ref] = await tx<OrderRef>(`SELECT "identity_subject_id", "show_session_id" FROM "orders" WHERE "id" = $1::uuid`, [orderId]);
  if (!ref) return null;
  await tx(
    `SELECT 1 AS "locked" FROM "purchase_quotas" WHERE "identity_subject_id" = $1::uuid AND "show_session_id" = $2::uuid FOR UPDATE`,
    [ref.identity_subject_id, ref.show_session_id],
  );
  const [o] = await tx<LockedOrder>(
    `SELECT "status", "order_number", ("hold_expires_at" <= now()) AS "due" FROM "orders" WHERE "id" = $1::uuid FOR UPDATE`,
    [orderId],
  );
  return o ? { ...o, ...ref } : null;
}

/** Steps 3 + inconsistency guard. Returns the READY payment ids to cancel, or a reason the order must not be ended. */
async function lockPayments(tx: SqlExecutor, orderId: string): Promise<{ ready: string[] } | { blocked: "payment_in_progress" | "confirming_hold" }> {
  const pays = await tx<{ id: string; status: string }>(`SELECT "id", "status" FROM "payments" WHERE "order_id" = $1::uuid ORDER BY "id" FOR UPDATE`, [orderId]);
  if (pays.some((p) => p.status === "CONFIRMING" || p.status === "UNKNOWN" || p.status === "SUCCEEDED")) return { blocked: "payment_in_progress" };
  const [c] = await tx<{ n: number }>(`SELECT count(*)::int AS "n" FROM "seat_holds" WHERE "order_id" = $1::uuid AND "status" = 'CONFIRMING'`, [orderId]);
  if (Number(c.n) > 0) return { blocked: "confirming_hold" };
  return { ready: pays.filter((p) => p.status === "READY").map((p) => p.id) };
}

/** Steps 3–6 writes for a PENDING order whose payments were checked. */
async function endPending(
  tx: SqlExecutor,
  orderId: string,
  o: LockedOrder & OrderRef,
  readyPayments: string[],
  to: "EXPIRED" | "CANCELED",
  source: OrderEndSource,
): Promise<number> {
  for (const pid of readyPayments) {
    await tx(`UPDATE "payments" SET "status" = 'CANCELED', "canceled_at" = now(), "updated_at" = now() WHERE "id" = $1::uuid AND "status" = 'READY'`, [pid]);
    await tx(`INSERT INTO "payment_status_logs" ("payment_id", "from_status", "to_status", "source", "note") VALUES ($1::uuid, 'READY', 'CANCELED', $2, $3)`, [
      pid,
      source === "API" ? "API" : "SYSTEM",
      to === "EXPIRED" ? "order expired" : "order canceled",
    ]);
  }
  const holds =
    to === "EXPIRED"
      ? await tx<{ id: string }>(
          `UPDATE "seat_holds" SET "status" = 'EXPIRED', "ended_at" = now(), "updated_at" = now() WHERE "order_id" = $1::uuid AND "status" = 'ACTIVE' RETURNING "id"`,
          [orderId],
        )
      : await tx<{ id: string }>(
          `UPDATE "seat_holds" SET "status" = 'RELEASED', "released_reason" = 'USER_CANCELED', "ended_at" = now(), "updated_at" = now()
            WHERE "order_id" = $1::uuid AND "status" = 'ACTIVE' RETURNING "id"`,
          [orderId],
        );
  const n = holds.length;
  if (n > 0) {
    await tx(
      `UPDATE "purchase_quotas" SET "counted_seats" = "counted_seats" - $3::int, "version" = "version" + 1, "updated_at" = now()
        WHERE "identity_subject_id" = $1::uuid AND "show_session_id" = $2::uuid`,
      [o.identity_subject_id, o.show_session_id, n],
    );
  }
  await tx(`UPDATE "orders" SET "status" = $2, "closed_at" = now(), "updated_at" = now() WHERE "id" = $1::uuid AND "status" = 'PENDING'`, [orderId, to]);
  await tx(`INSERT INTO "order_status_logs" ("order_id", "from_status", "to_status", "source") VALUES ($1::uuid, 'PENDING', $2, $3)`, [orderId, to, source]);
  await tx(
    `INSERT INTO "outbox_events" ("event_type", "aggregate_type", "aggregate_id", "aggregate_version", "payload", "status")
     SELECT $2, 'ORDER', $1::uuid, COALESCE(max("aggregate_version"), 0) + 1, $3::jsonb, 'PENDING'
       FROM "outbox_events" WHERE "aggregate_type" = 'ORDER' AND "aggregate_id" = $1::uuid`,
    [orderId, to === "EXPIRED" ? "ORDER_EXPIRED" : "ORDER_CANCELED", JSON.stringify({ orderNumber: o.order_number, status: to, releasedSeats: n })],
  );
  return n;
}

/** The expireOrder body, for callers that already run inside a booking transaction they own entirely. */
async function expireInTx(tx: SqlExecutor, orderId: string, source: OrderEndSource): Promise<ExpireOutcome> {
  const o = await lockOrder(tx, orderId);
  if (!o) return { kind: "not_found", orderId };
  if (o.status !== "PENDING") return { kind: "not_pending", orderId, status: o.status };
  if (!o.due) return { kind: "not_due", orderId };
  const p = await lockPayments(tx, orderId);
  if ("blocked" in p) return { kind: "needs_review", orderId, reason: p.blocked };
  const seats = await endPending(tx, orderId, o, p.ready, "EXPIRED", source);
  return { kind: "expired", orderId, seats };
}

/**
 * expireOrder(orderId): idempotent, safe to run concurrently (callers serialise on the quota and order locks; the
 * second one sees the order no longer PENDING). Never expires a PENDING order before its hold_expires_at (DB time).
 */
export async function expireOrder(deps: BookingTxDeps, orderId: string, source: OrderEndSource = "EXPIRY_JOB"): Promise<ExpireOutcome> {
  const outcome = await runBookingTx(deps, { name: "order.expire", fn: (tx) => expireInTx(tx, orderId, source) });
  if (outcome.kind === "needs_review") console.error(`[order-expire] order left untouched: ${outcome.reason} order=${orderId}`);
  return outcome;
}

/**
 * cancelOrder (§11.5, API §4.5). ONE transaction: the BOOKING session row of this browser (as order creation), then
 * quota → order → payments → holds. The session's subject must own the order.
 *   PENDING, hold not expired  → CANCELED (holds RELEASED / USER_CANCELED, READY payment CANCELED)
 *   PENDING, hold expired      → EXPIRED (the order already ran out: it is ended as an expiry, not a cancellation)
 *   CANCELED / EXPIRED         → idempotent success with the current state (nothing written)
 *   PAYMENT_CONFIRMING / PAYMENT_UNKNOWN / REVIEW_REQUIRED, or an inconsistent PENDING → 409 PAYMENT_IN_PROGRESS
 *   PAID / UNFULFILLED / REFUNDED → 409 INVALID_STATE_TRANSITION (refunds are an admin procedure, Step 8)
 *   not this subject's order   → 404 NOT_FOUND (existence is not revealed); LOOKUP session → 403
 */
export async function cancelOrder(deps: BookingTxDeps, orderId: string, session: { tokenHash: string; bindingHash: string }): Promise<OrderSummary> {
  return runBookingTx(deps, {
    name: "order.cancel",
    fn: async (tx) => {
      const s = await lockBookingSession(tx, session.tokenHash, session.bindingHash);
      if (s.purpose !== "BOOKING") throw new AppError("SESSION_PURPOSE_MISMATCH", "예매용 본인인증이 필요합니다.");
      const o = await lockOrder(tx, orderId);
      if (!o || o.identity_subject_id !== s.identity_subject_id) throw new AppError("NOT_FOUND", "주문을 찾을 수 없습니다.");
      const summary = (status: string): OrderSummary => ({ orderId, orderNumber: o.order_number, status });
      if (o.status === "CANCELED" || o.status === "EXPIRED") return summary(o.status);
      if (o.status === "PAYMENT_CONFIRMING" || o.status === "PAYMENT_UNKNOWN" || o.status === "REVIEW_REQUIRED")
        throw new AppError("PAYMENT_IN_PROGRESS", "결제 확인 중인 주문은 취소할 수 없습니다.");
      if (o.status !== "PENDING") throw new AppError("INVALID_STATE_TRANSITION", "이 주문은 취소할 수 없습니다. 환불은 고객센터로 문의해 주세요.");
      const p = await lockPayments(tx, orderId);
      if ("blocked" in p) {
        console.error(`[order-cancel] order left untouched: ${p.blocked} order=${orderId}`);
        throw new AppError("PAYMENT_IN_PROGRESS", "결제 확인 중인 주문은 취소할 수 없습니다.");
      }
      const to = o.due ? "EXPIRED" : "CANCELED";
      await endPending(tx, orderId, o, p.ready, to, "API");
      return summary(to);
    },
  });
}
