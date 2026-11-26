/**
 * Behavioural proof of the 14 database-level integrity rules (Step 2 §3.4) plus MIG-05 and MIG-08.
 *
 * Every test inserts data with plain SQL (as the Step 5+ services will) and asserts that PostgreSQL
 * itself — not application code — rejects the bad write, naming the SQLSTATE and the constraint.
 * Each scenario violates exactly ONE rule: the surrounding rows are valid, so a pass cannot be caused
 * by an unrelated error. Tests run inside rolled-back transactions and leave no data behind.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  expectDbError,
  expectInsertError,
  insert,
  mkAdmin,
  mkHold,
  mkOrder,
  mkOrderItem,
  mkPayment,
  mkQuota,
  mkRefund,
  mkSeat,
  mkSession,
  mkSessionSeat,
  mkSubject,
  mkTicket,
  mkVenue,
  mkWorld,
  PG,
  update,
  confirmOrder,
  testOrderNumber,
} from "./helpers/fixtures";
import { cloneTestDb, destroyTestDb, resolveTestServer, type TestDb } from "./helpers/pg";

const server = resolveTestServer();
let db: TestDb;
beforeAll(async () => {
  db = await cloneTestDb(server, inject("templateDb"));
});
afterAll(() => destroyTestDb(db));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** order + item (+ optional hold) for a world seat; returns the rows. */
async function bookSeat(
  c: Parameters<typeof mkOrder>[0],
  w: Awaited<ReturnType<typeof mkWorld>>,
  who: "u1" | "u2",
  seat = w.s1a,
  withHold = true,
) {
  const order = await mkOrder(c, who === "u1" ? w.ref(w.u1, w.is1) : w.ref(w.u2, w.is2));
  const item = await mkOrderItem(c, { orderId: order.id, sessionId: w.s1.id, sessionSeatId: seat.id });
  const hold = withHold ? await mkHold(c, { orderId: order.id, orderItemId: item.id, sessionSeatId: seat.id }) : null;
  return { order, item, hold };
}

describe("rule 1 — at most one live hold per seat", () => {
  it("rejects a second ACTIVE or CONFIRMING hold on the same seat; terminal holds do not block", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const a = await bookSeat(c, w, "u1");
      const b = await bookSeat(c, w, "u2", w.s1a, false);
      const dup = () => mkHold(c, { orderId: b.order.id, orderItemId: b.item.id, sessionSeatId: w.s1a.id });

      await expectInsertError(c, dup, { code: PG.uniqueViolation, constraint: "seat_holds_active_seat_uq" });

      await update(c, "seat_holds", a.hold!.id, { status: "CONFIRMING" }); // CONFIRMING protects the seat too
      await expectInsertError(c, dup, { code: PG.uniqueViolation, constraint: "seat_holds_active_seat_uq" });

      await update(c, "seat_holds", a.hold!.id, { status: "EXPIRED", ended_at: new Date() });
      const second = await dup(); // seat is free again
      expect(second.status).toBe("ACTIVE");

      // re-activating the old hold would create a second live hold: the UPDATE path is guarded as well
      await expectDbError(c, `UPDATE seat_holds SET status = 'ACTIVE' WHERE id = $1`, [a.hold!.id], {
        code: PG.uniqueViolation,
        constraint: "seat_holds_active_seat_uq",
      });
    }));

  it("serialises two real concurrent connections: the second INSERT waits for the first and then fails", async () => {
    // Committed fixtures (this file's database is private to the test file).
    const w = await mkWorld(db);
    const a = await bookSeat(db, w, "u1", w.s1a, false);
    const b = await bookSeat(db, w, "u2", w.s1a, false);

    const c1 = await db.pool.connect();
    const c2 = await db.pool.connect();
    try {
      await c1.query("BEGIN");
      await c2.query("BEGIN");
      await mkHold(c1, { orderId: a.order.id, orderItemId: a.item.id, sessionSeatId: w.s1a.id }); // uncommitted

      let settled = false;
      const second = mkHold(c2, { orderId: b.order.id, orderItemId: b.item.id, sessionSeatId: w.s1a.id }).then(
        () => {
          settled = true;
          return null;
        },
        (e: Error & { code?: string; constraint?: string }) => {
          settled = true;
          return e;
        },
      );
      await sleep(400);
      expect(settled, "c2 must block on c1's uncommitted unique entry").toBe(false);

      await c1.query("COMMIT");
      const err = await second;
      expect(err?.code).toBe(PG.uniqueViolation);
      expect(err?.constraint).toBe("seat_holds_active_seat_uq");
      await c2.query("ROLLBACK");
    } finally {
      c1.release();
      c2.release();
    }
  });
});

describe("rule 2 — at most one active order per (identity subject, session)", () => {
  it("blocks a second order while one is PENDING / CONFIRMING / UNKNOWN / REVIEW_REQUIRED", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const ref = w.ref(w.u1, w.is1);
      const protectedUntil = new Date(Date.now() + 180_000);
      const cases: [string, Record<string, unknown>][] = [
        ["PENDING", {}],
        ["PAYMENT_CONFIRMING", { confirm_protected_until: protectedUntil }],
        ["PAYMENT_UNKNOWN", { confirm_protected_until: protectedUntil }],
        ["REVIEW_REQUIRED", {}],
      ];
      for (const [status, extra] of cases) {
        await c.query("SAVEPOINT s");
        await mkOrder(c, ref, { status, ...extra });
        await expectInsertError(c, () => mkOrder(c, ref), {
          code: PG.uniqueViolation,
          constraint: "orders_active_subject_session_uq",
        });
        await c.query("ROLLBACK TO SAVEPOINT s");
      }
    }));

  it("allows any number of inactive orders, other sessions and other subjects", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const ref = w.ref(w.u1, w.is1);
      for (const status of ["CANCELED", "EXPIRED", "UNFULFILLED", "REFUNDED"]) await mkOrder(c, ref, { status });
      await mkOrder(c, ref); // one active order is fine next to the history
      await mkOrder(c, w.ref(w.u1, w.is1, w.s2)); // same subject, other session
      await mkOrder(c, w.ref(w.u2, w.is2)); // other subject, same session
      await expectInsertError(c, () => mkOrder(c, ref), { code: PG.uniqueViolation, constraint: "orders_active_subject_session_uq" });
    }));

  it("D-014: RELEASE_SEATS (REVIEW_REQUIRED -> UNFULFILLED) frees the slot; re-activating an old order is refused", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const ref = w.ref(w.u2, w.is2);
      const review = await mkOrder(c, ref, { status: "REVIEW_REQUIRED" });
      await expectInsertError(c, () => mkOrder(c, ref), { code: PG.uniqueViolation, constraint: "orders_active_subject_session_uq" });

      await update(c, "orders", review.id, { status: "UNFULFILLED" });
      const fresh = await mkOrder(c, ref); // allowed now

      await expectDbError(c, `UPDATE orders SET status = 'PENDING' WHERE id = $1`, [review.id], {
        code: PG.uniqueViolation,
        constraint: "orders_active_subject_session_uq",
      });
      expect(fresh.status).toBe("PENDING");
    }));
});

describe("rule 3 — at most one in-flight payment per order", () => {
  it("rejects a second READY / CONFIRMING / UNKNOWN payment; finished payments coexist", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await mkOrder(c, w.ref(w.u1, w.is1));
      await mkPayment(c, order.id); // READY
      for (const status of ["READY", "CONFIRMING", "UNKNOWN"]) {
        await expectInsertError(c, () => mkPayment(c, order.id, { status }), {
          code: PG.uniqueViolation,
          constraint: "payments_in_progress_order_uq",
        });
      }
      await mkPayment(c, order.id, { status: "FAILED" });
      await mkPayment(c, order.id, { status: "CANCELED" });
      await mkPayment(c, order.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000 });

      const other = await mkOrder(c, w.ref(w.u2, w.is2));
      await mkPayment(c, other.id); // another order has its own slot
    }));
});

describe("rules 4 & 5 (MIG-08) — an order sells only seats of its own session and venue", () => {
  it("rule 4: an item whose session differs from the order's session is rejected", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await mkOrder(c, w.ref(w.u1, w.is1)); // session S1
      // item says S2 (and uses S2's seat): the (order_id, show_session_id) pair does not exist
      await expectInsertError(
        c,
        () => mkOrderItem(c, { orderId: order.id, sessionId: w.s2.id, sessionSeatId: w.s2a.id }),
        { code: PG.foreignKeyViolation, constraint: "order_items_order_session_fk" },
      );
      // item says S1 but points at S2's seat: the (session_seat_id, show_session_id) pair does not exist
      await expectInsertError(
        c,
        () => mkOrderItem(c, { orderId: order.id, sessionId: w.s1.id, sessionSeatId: w.s2a.id }),
        { code: PG.foreignKeyViolation, constraint: "order_items_seat_session_fk" },
      );
      await mkOrderItem(c, { orderId: order.id, sessionId: w.s1.id, sessionSeatId: w.s1a.id }); // control
    }));

  it("rule 5: a session seat must use a seat of the session's own venue", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      // seat belongs to venue V2, session to venue V1
      await expectInsertError(c, () => mkSessionSeat(c, w.s1.id, w.seatV2.id, w.v1.id), {
        code: PG.foreignKeyViolation,
        constraint: "session_seats_seat_venue_fk",
      });
      // row claims V2: session S1 is not a V2 session (the V2 seat itself would be fine)
      await expectInsertError(c, () => mkSessionSeat(c, w.s1.id, w.seatV2.id, w.v2.id), {
        code: PG.foreignKeyViolation,
        constraint: "session_seats_session_venue_fk",
      });
      // a session's venue must equal its show's venue
      await expectInsertError(c, () => mkSession(c, w.show.id, w.v2.id), {
        code: PG.foreignKeyViolation,
        constraint: "show_sessions_show_venue_fk",
      });
      const extra = await mkSeat(c, w.v1.id);
      await mkSessionSeat(c, w.s1.id, extra.id, w.v1.id); // control
    }));
});

describe("rule 6 — SOLD status and the owning order item agree", () => {
  it("rejects SOLD without owner, owner without SOLD, and an owner item of another seat", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const { item } = await bookSeat(c, w, "u1", w.s1a, false);

      const spare = await mkSeat(c, w.v1.id);
      await expectInsertError(c, () => mkSessionSeat(c, w.s1.id, spare.id, w.v1.id, { status: "SOLD" }), {
        code: PG.checkViolation,
        constraint: "session_seats_sold_owner_ck",
      });
      await expectDbError(c, `UPDATE session_seats SET sold_order_item_id = $1 WHERE id = $2`, [item.id, w.s1a.id], {
        code: PG.checkViolation,
        constraint: "session_seats_sold_owner_ck",
      });
      // SOLD + an owner that belongs to a different seat (seat b cannot be owned by an item for seat a)
      await expectDbError(c, `UPDATE session_seats SET status = 'SOLD', sold_order_item_id = $1 WHERE id = $2`, [item.id, w.s1b.id], {
        code: PG.foreignKeyViolation,
        constraint: "session_seats_sold_item_seat_fk",
      });
      // the legitimate sale (circular FK works: the item exists first)
      await c.query(`UPDATE session_seats SET status = 'SOLD', sold_order_item_id = $1 WHERE id = $2`, [item.id, w.s1a.id]);
      const { rows } = await c.query(`SELECT status, sold_order_item_id FROM session_seats WHERE id = $1`, [w.s1a.id]);
      expect(rows[0]).toMatchObject({ status: "SOLD", sold_order_item_id: item.id });
      // releasing ownership while still SOLD is refused
      await expectDbError(c, `UPDATE session_seats SET sold_order_item_id = NULL WHERE id = $1`, [w.s1a.id], {
        code: PG.checkViolation,
        constraint: "session_seats_sold_owner_ck",
      });
      // HELD is never a stored status
      await expectDbError(c, `UPDATE session_seats SET status = 'HELD' WHERE id = $1`, [w.s1b.id], {
        code: PG.checkViolation,
        constraint: "session_seats_status_ck",
      });
    }));
});

describe("rule 7 — at most one valid ticket per seat; one ticket per order item", () => {
  it("rejects a second ISSUED/USED ticket on the same seat; VOID tickets are history", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const a = await bookSeat(c, w, "u1", w.s1a, false);
      const b = await bookSeat(c, w, "u2", w.s1a, false);
      const t1 = await mkTicket(c, { orderItemId: a.item.id, sessionSeatId: w.s1a.id });

      for (const status of ["ISSUED", "USED"]) {
        await expectInsertError(c, () => mkTicket(c, { orderItemId: b.item.id, sessionSeatId: w.s1a.id }, { status }), {
          code: PG.uniqueViolation,
          constraint: "tickets_valid_seat_uq",
        });
      }
      const voided = await mkTicket(c, { orderItemId: b.item.id, sessionSeatId: w.s1a.id }, { status: "VOID", voided_at: new Date() });
      expect(voided.status).toBe("VOID");

      // un-voiding while another valid ticket exists is refused
      await expectDbError(c, `UPDATE tickets SET status = 'ISSUED' WHERE id = $1`, [voided.id], {
        code: PG.uniqueViolation,
        constraint: "tickets_valid_seat_uq",
      });
      // one ticket per order item, whatever its status
      await expectInsertError(c, () => mkTicket(c, { orderItemId: a.item.id, sessionSeatId: w.s1a.id }, { status: "VOID" }), {
        code: PG.uniqueViolation,
        constraint: "tickets_order_item_id_uq",
      });
      expect(t1.status).toBe("ISSUED");
    }));

  it("rule 13: a ticket's seat must be its order item's seat", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const a = await bookSeat(c, w, "u1", w.s1a, false);
      await expectInsertError(c, () => mkTicket(c, { orderItemId: a.item.id, sessionSeatId: w.s1b.id }), {
        code: PG.foreignKeyViolation,
        constraint: "tickets_item_seat_fk",
      });
    }));
});

describe("rules 8 & 9 — confirmed payment belongs to the order; PAID needs one", () => {
  it("rule 8: orders.confirmed_payment_id must reference a payment of the SAME order", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const o1 = await mkOrder(c, w.ref(w.u1, w.is1));
      const o2 = await mkOrder(c, w.ref(w.u2, w.is2));
      // another order's (approved, not confirming) payment
      const p2 = await mkPayment(c, o2.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000 });

      await expectDbError(c, `UPDATE orders SET confirmed_payment_id = $1 WHERE id = $2`, [p2.id, o1.id], {
        code: PG.foreignKeyViolation,
        constraint: "orders_confirmed_payment_fk",
      });
      const p1 = await confirmOrder(c, o1); // own SUCCEEDED PRIMARY payment: fine
      // p1 is already o1's confirmed payment: a second order cannot claim it. PostgreSQL checks the
      // unique index while writing the row (before the FK trigger), so UNIQUE is what reports it; the
      // FK would reject it too (p1 belongs to o1), as the first assertion above proves in isolation.
      await expectDbError(c, `UPDATE orders SET confirmed_payment_id = $1 WHERE id = $2`, [p1.id, o2.id], {
        code: PG.uniqueViolation,
        constraint: "orders_confirmed_payment_id_uq",
      });
    }));

  it("rule 9: status PAID requires confirmed_payment_id", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await mkOrder(c, w.ref(w.u1, w.is1));
      await expectInsertError(c, () => mkOrder(c, w.ref(w.u2, w.is2), { status: "PAID" }), {
        code: PG.checkViolation,
        constraint: "orders_paid_requires_confirmed_payment_ck",
      });
      await expectDbError(c, `UPDATE orders SET status = 'PAID', paid_at = now() WHERE id = $1`, [order.id], {
        code: PG.checkViolation,
        constraint: "orders_paid_requires_confirmed_payment_ck",
      });
      const payment = await mkPayment(c, order.id, { status: "SUCCEEDED", role: "PRIMARY", approved_amount: 100000 });
      await c.query(`UPDATE orders SET status = 'PAID', confirmed_payment_id = $1, paid_at = now() WHERE id = $2`, [payment.id, order.id]);
      // and the confirmed payment cannot be detached from a PAID order
      await expectDbError(c, `UPDATE orders SET confirmed_payment_id = NULL WHERE id = $1`, [order.id], {
        code: PG.checkViolation,
        constraint: "orders_paid_requires_confirmed_payment_ck",
      });
    }));

  it("D-003: CONFIRMING / UNKNOWN orders must record the protection deadline", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      for (const status of ["PAYMENT_CONFIRMING", "PAYMENT_UNKNOWN"]) {
        await expectInsertError(c, () => mkOrder(c, w.ref(w.u1, w.is1), { status }), {
          code: PG.checkViolation,
          constraint: "orders_confirm_protected_until_ck",
        });
      }
      await mkOrder(c, w.ref(w.u1, w.is1), { status: "PAYMENT_CONFIRMING", confirm_protected_until: new Date() });
    }));
});

describe("rule 10 — cumulative refunds never exceed the approved amount", () => {
  it("rejects refunded_amount > approved_amount, negatives and refunds on unapproved payments", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await mkOrder(c, w.ref(w.u1, w.is1));
      // EXCESS payment: its approved amount may legitimately differ from the order total, so the refund cap is
      // exercised in isolation (a PRIMARY payment's approved amount is pinned by payments_primary_amount_ck).
      const p = await mkPayment(c, order.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000 });

      await expectDbError(c, `UPDATE payments SET refunded_amount = 100001 WHERE id = $1`, [p.id], {
        code: PG.checkViolation,
        constraint: "payments_refunded_amount_ck",
      });
      await expectDbError(c, `UPDATE payments SET refunded_amount = -1 WHERE id = $1`, [p.id], {
        code: PG.checkViolation,
        constraint: "payments_refunded_amount_ck",
      });
      await c.query(`UPDATE payments SET refunded_amount = 100000 WHERE id = $1`, [p.id]); // exactly the approved amount
      await expectDbError(c, `UPDATE payments SET approved_amount = 50000 WHERE id = $1`, [p.id], {
        code: PG.checkViolation,
        constraint: "payments_refunded_amount_ck",
      });
      await expectInsertError(c, () => mkPayment(c, order.id, { status: "FAILED", refunded_amount: 1 }), {
        code: PG.checkViolation,
        constraint: "payments_refunded_amount_ck",
      });
    }));

  it("amount sanity: payments > 0, refunds > 0, refund items > 0, card/easy-pay only (D-005)", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await mkOrder(c, w.ref(w.u1, w.is1));
      await expectInsertError(c, () => mkPayment(c, order.id, { requested_amount: 0 }), { code: PG.checkViolation, constraint: "payments_requested_amount_ck" });
      await expectInsertError(c, () => mkPayment(c, order.id, { method_type: "VIRTUAL_ACCOUNT" }), { code: PG.checkViolation, constraint: "payments_method_type_ck" });
      await expectInsertError(c, () => mkPayment(c, order.id, { status: "SUCCEEDED", approved_amount: 100000 }), { code: PG.checkViolation, constraint: "payments_succeeded_role_ck" });
      // approved_amount is set so that payments_primary_amount_ck is satisfied and only the role/status rule is violated
      await expectInsertError(c, () => mkPayment(c, order.id, { status: "READY", role: "PRIMARY", approved_amount: 100000 }), { code: PG.checkViolation, constraint: "payments_succeeded_role_ck" });
      const p = await mkPayment(c, order.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000 });
      await expectInsertError(c, () => mkRefund(c, { orderId: order.id, paymentId: p.id }, { total_amount: 0 }), { code: PG.checkViolation, constraint: "refunds_total_amount_ck" });
      const r = await mkRefund(c, { orderId: order.id, paymentId: p.id }); // SEAT refund: its item (below) makes the total consistent
      const orderItem = await mkOrderItem(c, { orderId: order.id, sessionId: w.s1.id, sessionSeatId: w.s1b.id });
      await expectInsertError(
        c,
        () => insert(c, "refund_items", { refund_id: r.id, order_id: order.id, order_item_id: orderItem.id, amount: 0 }),
        { code: PG.checkViolation, constraint: "refund_items_amount_ck" },
      );
      await insert(c, "refund_items", { refund_id: r.id, order_id: order.id, order_item_id: orderItem.id, amount: 100000 }); // control: SUM(items) = total_amount
    }));
});

describe("rule 11 — purchase quota counters stay within 0..limit (≤ 4)", () => {
  it("rejects counted_seats outside 0..seat_limit on INSERT and UPDATE", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      await expectInsertError(c, () => mkQuota(c, w.u1.id, w.s1.id, { counted_seats: 5 }), { code: PG.checkViolation, constraint: "purchase_quotas_counted_seats_ck" });
      await expectInsertError(c, () => mkQuota(c, w.u1.id, w.s1.id, { counted_seats: -1 }), { code: PG.checkViolation, constraint: "purchase_quotas_counted_seats_ck" });
      await expectInsertError(c, () => mkQuota(c, w.u1.id, w.s1.id, { seat_limit: 2, counted_seats: 3 }), { code: PG.checkViolation, constraint: "purchase_quotas_counted_seats_ck" });

      await mkQuota(c, w.u1.id, w.s1.id, { counted_seats: 4 }); // exactly at the limit is allowed
      const where = [w.u1.id, w.s1.id];
      await expectDbError(c, `UPDATE purchase_quotas SET counted_seats = counted_seats + 1 WHERE identity_subject_id = $1 AND show_session_id = $2`, where, {
        code: PG.checkViolation,
        constraint: "purchase_quotas_counted_seats_ck",
      });
      await c.query(`UPDATE purchase_quotas SET counted_seats = counted_seats - 4 WHERE identity_subject_id = $1 AND show_session_id = $2`, where);
      await expectDbError(c, `UPDATE purchase_quotas SET counted_seats = counted_seats - 1 WHERE identity_subject_id = $1 AND show_session_id = $2`, where, {
        code: PG.checkViolation,
        constraint: "purchase_quotas_counted_seats_ck",
      });
    }));

  it("limits: seat_limit and show_sessions.max_seats_per_identity are 1..4 (D-006); one counter row per subject+session", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      for (const bad of [0, 5]) {
        await expectInsertError(c, () => mkQuota(c, w.u2.id, w.s2.id, { seat_limit: bad }), { code: PG.checkViolation, constraint: "purchase_quotas_seat_limit_ck" });
        await expectInsertError(c, () => mkSession(c, w.show.id, w.v1.id, { max_seats_per_identity: bad }), {
          code: PG.checkViolation,
          constraint: "show_sessions_max_seats_per_identity_ck",
        });
      }
      await mkQuota(c, w.u2.id, w.s2.id, { seat_limit: 1 });
      await expectInsertError(c, () => mkQuota(c, w.u2.id, w.s2.id), { code: PG.uniqueViolation, constraint: "purchase_quotas_pkey" });
      // lowering the limit below the counter is refused (counter would exceed the limit)
      await c.query(`UPDATE purchase_quotas SET counted_seats = 1 WHERE identity_subject_id = $1 AND show_session_id = $2`, [w.u2.id, w.s2.id]);
      await expectDbError(c, `UPDATE purchase_quotas SET seat_limit = 1, counted_seats = 2 WHERE identity_subject_id = $1 AND show_session_id = $2`, [w.u2.id, w.s2.id], {
        code: PG.checkViolation,
        constraint: "purchase_quotas_counted_seats_ck",
      });
    }));
});

describe("rule 12 — an order's identity session belongs to the order's subject", () => {
  it("rejects an order that borrows another subject's identity session", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      await expectInsertError(c, () => mkOrder(c, w.ref(w.u1, w.is2)), {
        code: PG.foreignKeyViolation,
        constraint: "orders_identity_session_subject_fk",
      });
      await mkOrder(c, w.ref(w.u1, w.is1)); // control
      await expectInsertError(c, () => mkOrder(c, w.ref(w.u2, w.is1), { order_number: testOrderNumber() }), {
        code: PG.foreignKeyViolation,
        constraint: "orders_identity_session_subject_fk",
      });
    }));
});

describe("rule 13 (MIG-08) — order / hold / item / ticket / refund ownership agrees", () => {
  it("a hold must match its order item's order and seat; one hold per item", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const a = await bookSeat(c, w, "u1", w.s1a, false);
      const b = await bookSeat(c, w, "u2", w.s1b, false);

      // hold names another order's id (but item a)
      await expectInsertError(c, () => mkHold(c, { orderId: b.order.id, orderItemId: a.item.id, sessionSeatId: w.s1a.id }), {
        code: PG.foreignKeyViolation,
        constraint: "seat_holds_item_order_seat_fk",
      });
      // hold names another seat
      await expectInsertError(c, () => mkHold(c, { orderId: a.order.id, orderItemId: a.item.id, sessionSeatId: w.s1b.id }), {
        code: PG.foreignKeyViolation,
        constraint: "seat_holds_item_order_seat_fk",
      });
      await mkHold(c, { orderId: a.order.id, orderItemId: a.item.id, sessionSeatId: w.s1a.id }); // control
      await expectInsertError(c, () => mkHold(c, { orderId: a.order.id, orderItemId: a.item.id, sessionSeatId: w.s1a.id }, { status: "EXPIRED" }), {
        code: PG.uniqueViolation,
        constraint: "seat_holds_order_item_id_uq",
      });
    }));

  it("a refund and its payment must belong to the same order; refund items must belong to the refund's order", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const a = await bookSeat(c, w, "u1", w.s1a, false);
      const b = await bookSeat(c, w, "u2", w.s1b, false);
      const pa = await confirmOrder(c, a.order);
      const pb = await confirmOrder(c, b.order);

      await expectInsertError(c, () => mkRefund(c, { orderId: a.order.id, paymentId: pb.id }), {
        code: PG.foreignKeyViolation,
        constraint: "refunds_payment_order_fk",
      });
      const ra = await mkRefund(c, { orderId: a.order.id, paymentId: pa.id }); // control
      const rb = await mkRefund(c, { orderId: b.order.id, paymentId: pb.id });
      await insert(c, "refund_items", { refund_id: rb.id, order_id: b.order.id, order_item_id: b.item.id, amount: 100000 }); // control: rb is a consistent SEAT refund

      // item of order B inside a refund of order A
      await expectInsertError(
        c,
        () => insert(c, "refund_items", { refund_id: ra.id, order_id: a.order.id, order_item_id: b.item.id, amount: 100000 }),
        { code: PG.foreignKeyViolation, constraint: "refund_items_item_order_fk" },
      );
      // item of order B, but the row claims refund A while saying order B
      await expectInsertError(
        c,
        () => insert(c, "refund_items", { refund_id: ra.id, order_id: b.order.id, order_item_id: b.item.id, amount: 100000 }),
        { code: PG.foreignKeyViolation, constraint: "refund_items_refund_order_fk" },
      );
      await insert(c, "refund_items", { refund_id: ra.id, order_id: a.order.id, order_item_id: a.item.id, amount: 100000 }); // control
      await expectInsertError(
        c,
        () => insert(c, "refund_items", { refund_id: ra.id, order_id: a.order.id, order_item_id: a.item.id, amount: 1 }),
        { code: PG.uniqueViolation, constraint: "refund_items_refund_item_uq" },
      );
      expect(rb.status).toBe("REQUESTED");
    }));
});

describe("rule 14 — order_items are immutable after insert", () => {
  it("rejects every UPDATE (including a no-op) and leaves the row untouched", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const { item } = await bookSeat(c, w, "u1", w.s1a, false);
      const immutable = /immutable/;

      await expectDbError(c, `UPDATE order_items SET price = price + 1 WHERE id = $1`, [item.id], { code: PG.restrictViolation, message: immutable });
      await expectDbError(c, `UPDATE order_items SET price = price WHERE id = $1`, [item.id], { code: PG.restrictViolation, message: immutable });
      await expectDbError(c, `UPDATE order_items SET session_seat_id = $2 WHERE id = $1`, [item.id, w.s1b.id], { code: PG.restrictViolation, message: immutable });
      await expectDbError(c, `UPDATE order_items SET order_id = $2 WHERE id = $1`, [item.id, w.s1b.id], { code: PG.restrictViolation, message: immutable });

      const { rows } = await c.query(`SELECT price, session_seat_id FROM order_items WHERE id = $1`, [item.id]);
      expect(rows[0]).toMatchObject({ price: "100000", session_seat_id: w.s1a.id });
      await mkOrderItem(c, { orderId: item.order_id, sessionId: w.s1.id, sessionSeatId: w.s1c.id }); // INSERT still works
    }));

  it("an item referenced by a hold cannot be deleted either (the trigger fires before ON DELETE RESTRICT)", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const { item } = await bookSeat(c, w, "u1");
      await expectDbError(c, `DELETE FROM order_items WHERE id = $1`, [item.id], {
        code: PG.restrictViolation,
        message: /immutable: DELETE rejected/,
      });
    }));
});

describe("MIG-05 — seats: UNIQUE NULLS NOT DISTINCT (venue, section, row, number)", () => {
  it("rejects duplicate seats whose section/row are NULL; keeps genuinely different seats", () =>
    db.rolledBack(async (c) => {
      const v1 = await mkVenue(c);
      const v2 = await mkVenue(c);
      const base = { section_name: null, row_label: null, seat_number: "7" };
      await insert(c, "seats", { venue_id: v1.id, svg_seat_id: "s-1", ...base });

      await expectInsertError(c, () => insert(c, "seats", { venue_id: v1.id, svg_seat_id: "s-2", ...base }), {
        code: PG.uniqueViolation,
        constraint: "seats_venue_section_row_number_nnd_uq",
      });
      // section set, row NULL: still a duplicate
      await insert(c, "seats", { venue_id: v1.id, svg_seat_id: "s-3", section_name: "A", row_label: null, seat_number: "7" });
      await expectInsertError(c, () => insert(c, "seats", { venue_id: v1.id, svg_seat_id: "s-4", section_name: "A", row_label: null, seat_number: "7" }), {
        code: PG.uniqueViolation,
        constraint: "seats_venue_section_row_number_nnd_uq",
      });

      await insert(c, "seats", { venue_id: v1.id, svg_seat_id: "s-5", ...base, seat_number: "8" }); // other number
      await insert(c, "seats", { venue_id: v2.id, svg_seat_id: "s-1", ...base }); // other venue
      await insert(c, "seats", { venue_id: v1.id, svg_seat_id: "s-6", section_name: "", row_label: null, seat_number: "7" }); // '' is not NULL
      await expectInsertError(c, () => insert(c, "seats", { venue_id: v1.id, svg_seat_id: "s-1", section_name: "Z", row_label: "9", seat_number: "9" }), {
        code: PG.uniqueViolation,
        constraint: "seats_venue_svg_seat_uq",
      });
    }));
});

describe("identity, idempotency, webhook and review-case uniqueness", () => {
  it("an identity verification yields at most one session; a provider transaction is used once", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const { rows } = await c.query(`SELECT identity_verification_id AS v FROM identity_sessions WHERE id = $1`, [w.is1.id]);
      await expectInsertError(
        c,
        () =>
          insert(c, "identity_sessions", {
            identity_verification_id: rows[0].v,
            identity_subject_id: w.u1.id,
            purpose: "BOOKING",
            token_hash: "another-token",
            browser_binding_hash: "b",
            status: "ACTIVE",
            expires_at: new Date(Date.now() + 60_000),
          }),
        { code: PG.uniqueViolation, constraint: "identity_sessions_verification_uq" },
      );

      const v = (txn: string | null) =>
        insert(c, "identity_verifications", {
          purpose: "BOOKING", provider: "NICE", provider_transaction_id: txn, browser_binding_hash: `b-${Math.random()}`,
          state_nonce_hash: `n-${Math.random()}`, status: "PENDING", expires_at: new Date(Date.now() + 60_000),
        });
      await v("txn-1");
      await expectInsertError(c, () => v("txn-1"), { code: PG.uniqueViolation, constraint: "identity_verifications_provider_txn_uq" });
      await v(null);
      await v(null); // NULL transaction ids never collide
      await expectInsertError(
        c,
        () => insert(c, "identity_verifications", {
          purpose: "BOOKING", provider: "NICE", browser_binding_hash: "b", state_nonce_hash: `n-${Math.random()}`, status: "VERIFIED",
          expires_at: new Date(Date.now() + 60_000),
        }),
        { code: PG.checkViolation, constraint: "identity_verifications_verified_subject_ck" },
      );
    }));

  it("subjects are unique per (key type, key version, hash); idempotency keys per (scope, owner, key)", () =>
    db.rolledBack(async (c) => {
      await mkSubject(c, { subject_key_hash: "h", subject_key_type: "DI", key_version: 1 });
      await expectInsertError(c, () => mkSubject(c, { subject_key_hash: "h", subject_key_type: "DI", key_version: 1 }), {
        code: PG.uniqueViolation,
        constraint: "identity_subjects_key_uq",
      });
      await mkSubject(c, { subject_key_hash: "h", subject_key_type: "DI", key_version: 2 }); // key rotation is a new row

      const idem = (owner: string) =>
        insert(c, "idempotency_records", {
          scope: "POST /orders", owner_key_hash: owner, idempotency_key_hash: "k", request_hash: "r", status: "PROCESSING",
          expires_at: new Date(Date.now() + 60_000),
        });
      await idem("ownerA");
      await expectInsertError(c, () => idem("ownerA"), { code: PG.uniqueViolation, constraint: "idempotency_records_scope_owner_key_uq" });
      await idem("ownerB"); // same key, another owner: independent record (A-010)
    }));

  it("webhook events dedupe per (provider, key); payments refs are unique; PG ids ignore NULLs", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await mkOrder(c, w.ref(w.u1, w.is1));
      const ev = (key: string) =>
        insert(c, "payment_webhook_events", {
          provider: "TOSS", deduplication_key: key, event_type: "PAYMENT_STATUS_CHANGED", signature_verified: false,
          payload_hash: "h", status: "RECEIVED",
        });
      await ev("k1");
      await expectInsertError(c, () => ev("k1"), { code: PG.uniqueViolation, constraint: "payment_webhook_events_dedup_uq" });

      await mkPayment(c, order.id, { merchant_payment_ref: "ref-1", status: "FAILED" });
      await expectInsertError(c, () => mkPayment(c, order.id, { merchant_payment_ref: "ref-1", status: "FAILED" }), {
        code: PG.uniqueViolation,
        constraint: "payments_merchant_payment_ref_uq",
      });
      await mkPayment(c, order.id, { status: "FAILED", provider_payment_id: "pk-1", pg_transaction_id: "tx-1" });
      await mkPayment(c, order.id, { status: "FAILED" }); // NULL provider ids do not collide
      await mkPayment(c, order.id, { status: "FAILED" });
      await expectInsertError(c, () => mkPayment(c, order.id, { status: "FAILED", provider_payment_id: "pk-1" }), {
        code: PG.uniqueViolation,
        constraint: "payments_provider_payment_id_uq",
      });
      await expectInsertError(c, () => mkPayment(c, order.id, { status: "FAILED", pg_transaction_id: "tx-1" }), {
        code: PG.uniqueViolation,
        constraint: "payments_provider_pg_txn_uq",
      });
    }));

  it("review cases: one OPEN/IN_PROGRESS case per (type, dedupe key); RESOLVED history may repeat", () =>
    db.rolledBack(async (c) => {
      const rc = (status: string, dedupe = "d1", type = "EXCESS_PAYMENT") =>
        insert(c, "review_cases", { case_type: type, severity: "WARN", status, dedupe_key: dedupe });
      const open = await rc("OPEN");
      await expectInsertError(c, () => rc("OPEN"), { code: PG.uniqueViolation, constraint: "review_cases_open_dedupe_uq" });
      await expectInsertError(c, () => rc("IN_PROGRESS"), { code: PG.uniqueViolation, constraint: "review_cases_open_dedupe_uq" });
      await rc("RESOLVED");
      await rc("RESOLVED");
      await rc("OPEN", "d2"); // other key
      await rc("OPEN", "d1", "AMOUNT_MISMATCH"); // other type
      await update(c, "review_cases", open.id, { status: "RESOLVED", resolved_at: new Date() });
      await rc("OPEN"); // reopened after resolution
      await expectInsertError(c, () => rc("OPEN", "d9", "NOT_A_TYPE"), { code: PG.checkViolation, constraint: "review_cases_case_type_ck" });
    }));
});

describe("status vocabularies and misc CHECKs are enforced by the database", () => {
  it("rejects values outside the documented vocabularies", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      await expectInsertError(c, () => mkOrder(c, w.ref(w.u1, w.is1), { status: "HELD" }), { code: PG.checkViolation, constraint: "orders_status_ck" });
      await expectInsertError(c, () => mkAdmin(c, { role: "ROOT" }), { code: PG.checkViolation, constraint: "admins_role_ck" });
      await expectInsertError(c, () => mkSubject(c, { subject_key_type: "SSN" }), { code: PG.checkViolation, constraint: "identity_subjects_key_type_ck" });
      await expectDbError(c, `UPDATE show_sessions SET sales_status = 'OPEN' WHERE id = $1`, [w.s1.id], { code: PG.checkViolation, constraint: "show_sessions_sales_status_ck" });
      const a = await bookSeat(c, w, "u1");
      await expectDbError(c, `UPDATE seat_holds SET status = 'HELD' WHERE id = $1`, [a.hold!.id], {
        code: PG.checkViolation,
        constraint: "seat_holds_status_ck",
      });
      await expectDbError(c, `UPDATE seat_holds SET released_reason = 'BECAUSE' WHERE id = $1`, [a.hold!.id], {
        code: PG.checkViolation,
        constraint: "seat_holds_released_reason_ck",
      });
    }));

  it("no cascading deletes anywhere: referenced rows cannot be deleted", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const a = await bookSeat(c, w, "u1");
      for (const [sql, id] of [
        [`DELETE FROM venues WHERE id = $1`, w.v1.id],
        [`DELETE FROM shows WHERE id = $1`, w.show.id],
        [`DELETE FROM show_sessions WHERE id = $1`, w.s1.id],
        [`DELETE FROM session_seats WHERE id = $1`, w.s1a.id],
        [`DELETE FROM orders WHERE id = $1`, a.order.id],
        [`DELETE FROM identity_subjects WHERE id = $1`, w.u1.id],
      ] as const) {
        await expectDbError(c, sql, [id], { code: PG.foreignKeyViolation });
      }
      await expect(
        c.query(`SELECT count(*)::int AS n FROM seat_holds WHERE id = $1`, [a.hold!.id]).then((r) => r.rows[0].n),
      ).resolves.toBe(1);
    }));
});
