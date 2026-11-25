/**
 * Step 2 hardening: the database itself must refuse wrong booking / payment states, whatever the application does.
 *
 *   S3   order <-> payment consistency (PRIMARY / EXCESS / confirmed payment / amounts)
 *   S4   an order needs its purchase_quotas row
 *   Q-022 payments.method_type = OTHER (approved but not allowed)
 *   Q-023 order_items: UPDATE and DELETE are rejected
 *   Q-024 identity session = its verification's subject and purpose
 *
 * Two kinds of assertions:
 *   - immediate  : the statement itself fails (CHECK / UNIQUE / FK);
 *   - at commit  : the deferred constraint triggers reject the FINAL state of the transaction (`expectCommitError`;
 *                  statements are accepted one by one so that the legitimate atomic order<->payment transition can
 *                  perform its writes in any order). A few tests use a real COMMIT on committed data.
 * Tests also try to get around each rule with UPDATE, not only INSERT.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { DB_CONSTRAINT, PAYMENT_METHOD_TYPE, PAYMENT_REQUEST_METHOD_TYPE } from "../../../src/server/db/constants";
import {
  checkAtCommit,
  confirmOrder,
  ensureQuota,
  expectCommitError,
  expectDbError,
  expectInsertError,
  insert,
  mkIdentitySession,
  mkOrder,
  mkOrderItem,
  mkPayment,
  mkSubject,
  mkWorld,
  PG,
  update,
} from "./helpers/fixtures";
import { cloneTestDb, destroyTestDb, resolveTestServer, type TestDb } from "./helpers/pg";

const server = resolveTestServer();
let db: TestDb;
beforeAll(async () => {
  db = await cloneTestDb(server, inject("templateDb"));
});
afterAll(() => destroyTestDb(db));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type World = Awaited<ReturnType<typeof mkWorld>>;
const orderFor = (c: Parameters<typeof mkOrder>[0], w: World, who: "u1" | "u2" = "u1", session: "s1" | "s2" = "s1") =>
  mkOrder(c, who === "u1" ? w.ref(w.u1, w.is1, w[session]) : w.ref(w.u2, w.is2, w[session]));

// ───────────────────────────────────────── S3 ─────────────────────────────────────────

describe("S3 — order <-> payment consistency", () => {
  describe("allowed: the normal confirmation (DATABASE.md §11.7)", () => {
    it("PRIMARY payment + PAID order, payment written first", () =>
      db.rolledBack(async (c) => {
        const w = await mkWorld(c);
        const order = await orderFor(c, w);
        const payment = await confirmOrder(c, order); // INSERT payment (PRIMARY), then UPDATE order -> PAID
        await checkAtCommit(c);
        const { rows } = await c.query(`SELECT status, confirmed_payment_id FROM orders WHERE id = $1`, [order.id]);
        expect(rows[0]).toMatchObject({ status: "PAID", confirmed_payment_id: payment.id });
      }));

    it("the same transition with the ORDER written first (atomic: statement order must not matter)", () =>
      db.rolledBack(async (c) => {
        const w = await mkWorld(c);
        const order = await orderFor(c, w);
        const payment = await mkPayment(c, order.id); // READY
        // the order already points at the payment while it is still READY ...
        await update(c, "orders", order.id, { status: "PAID", confirmed_payment_id: payment.id, paid_at: new Date() });
        // ... and becomes PRIMARY afterwards, in the same transaction
        await update(c, "payments", payment.id, { status: "SUCCEEDED", role: "PRIMARY", approved_amount: 100000, approved_at: new Date() });
        await checkAtCommit(c);
      }));

    it("many EXCESS payments (duplicate approvals) are kept next to the one PRIMARY payment", () =>
      db.rolledBack(async (c) => {
        const w = await mkWorld(c);
        const order = await orderFor(c, w);
        await mkPayment(c, order.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000 });
        await mkPayment(c, order.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 99000 }); // amount mismatch is allowed for EXCESS
        await mkPayment(c, order.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100001, method_type: "OTHER" });
        await confirmOrder(c, order);
        await mkPayment(c, order.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000 }); // late duplicate on a PAID order
        await checkAtCommit(c);
        const { rows } = await c.query(`SELECT role, count(*)::int n FROM payments WHERE order_id = $1 GROUP BY role ORDER BY role`, [order.id]);
        expect(rows).toEqual([{ role: "EXCESS", n: 4 }, { role: "PRIMARY", n: 1 }]);
      }));

    it("swapping the confirming payment atomically (demote old, promote new, re-point) is allowed", () =>
      db.rolledBack(async (c) => {
        const w = await mkWorld(c);
        const order = await orderFor(c, w);
        const p1 = await confirmOrder(c, order);
        const p2 = await mkPayment(c, order.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000 });
        await update(c, "payments", p1.id, { role: "EXCESS" }); // briefly: the order points at a non-PRIMARY payment
        await update(c, "payments", p2.id, { role: "PRIMARY" });
        await update(c, "orders", order.id, { confirmed_payment_id: p2.id });
        await checkAtCommit(c);
      }));
  });

  describe("rejected at COMMIT: the final state is inconsistent (statements alone are accepted)", () => {
    it.each([
      ["READY", { status: "READY" }],
      ["CONFIRMING", { status: "CONFIRMING" }],
      ["UNKNOWN", { status: "UNKNOWN" }],
      ["FAILED", { status: "FAILED" }],
      ["CANCELED", { status: "CANCELED" }],
      ["SUCCEEDED but EXCESS", { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000 }],
    ])("an order cannot be confirmed by a %s payment", (_label, payment) =>
      db.rolledBack(async (c) => {
        const w = await mkWorld(c);
        const order = await orderFor(c, w);
        const p = await mkPayment(c, order.id, payment);
        // the payment already exists in a consistent state (as it does in production: an earlier transaction)
        await checkAtCommit(c);
        await expectCommitError(
          c,
          () => update(c, "orders", order.id, { status: "PAID", confirmed_payment_id: p.id, paid_at: new Date() }),
          { code: PG.checkViolation, constraint: DB_CONSTRAINT.confirmedPaymentNotPrimary },
        );
      }),
    );

    it("a PRIMARY payment that its order does not confirm (INSERT and promotion by UPDATE)", () =>
      db.rolledBack(async (c) => {
        const w = await mkWorld(c);
        const order = await orderFor(c, w);
        await expectCommitError(c, () => mkPayment(c, order.id, { status: "SUCCEEDED", role: "PRIMARY", approved_amount: 100000 }), {
          code: PG.checkViolation,
          constraint: DB_CONSTRAINT.primaryPaymentNotConfirmed,
        });
        const excess = await mkPayment(c, order.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000 });
        await expectCommitError(c, () => update(c, "payments", excess.id, { role: "PRIMARY" }), {
          code: PG.checkViolation,
          constraint: DB_CONSTRAINT.primaryPaymentNotConfirmed,
        });
      }));

    it("demoting or un-succeeding the confirmed payment (UPDATE bypass attempts)", () =>
      db.rolledBack(async (c) => {
        const w = await mkWorld(c);
        const order = await orderFor(c, w);
        const p = await confirmOrder(c, order);
        await checkAtCommit(c);
        const bad = { code: PG.checkViolation, constraint: DB_CONSTRAINT.confirmedPaymentDemoted };
        await expectCommitError(c, () => update(c, "payments", p.id, { role: "EXCESS" }), bad);
        // Leaving SUCCEEDED is refused right away since the approval record became immutable (payments_approved_evidence_no_change,
        // PR #2 review); before that it was only caught by the deferred trigger at COMMIT.
        const evidence = { code: PG.restrictViolation, constraint: DB_CONSTRAINT.approvedPaymentEvidenceImmutable };
        await expectDbError(c, `UPDATE payments SET status = 'FAILED', role = NULL WHERE id = $1`, [p.id], evidence);
        await expectDbError(c, `UPDATE payments SET status = 'CANCELED', role = NULL WHERE id = $1`, [p.id], evidence);
      }));

    it("re-pointing the order at a non-PRIMARY payment, or detaching it while the payment stays PRIMARY", () =>
      db.rolledBack(async (c) => {
        const w = await mkWorld(c);
        const order = await orderFor(c, w);
        const p1 = await confirmOrder(c, order);
        const p2 = await mkPayment(c, order.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000 });
        await checkAtCommit(c);

        await expectCommitError(c, () => update(c, "orders", order.id, { confirmed_payment_id: p2.id }), {
          code: PG.checkViolation,
          constraint: DB_CONSTRAINT.confirmedPaymentNotPrimary,
        });
        await expectCommitError(c, () => update(c, "orders", order.id, { status: "CANCELED", confirmed_payment_id: null }), {
          code: PG.checkViolation,
          constraint: DB_CONSTRAINT.confirmedPaymentDetached,
        });
        // detaching is fine when the payment is demoted in the same transaction (e.g. an administrative correction)
        await update(c, "payments", p1.id, { role: "EXCESS" });
        await update(c, "orders", order.id, { status: "CANCELED", confirmed_payment_id: null });
        await checkAtCommit(c);
      }));
  });

  describe("rejected immediately", () => {
    it("a second PRIMARY payment for the same order (INSERT and promotion by UPDATE)", () =>
      db.rolledBack(async (c) => {
        const w = await mkWorld(c);
        const order = await orderFor(c, w);
        await confirmOrder(c, order);
        const bad = { code: PG.uniqueViolation, constraint: DB_CONSTRAINT.primaryPaymentUnique };
        await expectInsertError(c, () => mkPayment(c, order.id, { status: "SUCCEEDED", role: "PRIMARY", approved_amount: 100000 }), bad);
        const excess = await mkPayment(c, order.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000 });
        await expectDbError(c, `UPDATE payments SET role = 'PRIMARY' WHERE id = $1`, [excess.id], bad);
        // a PRIMARY payment of ANOTHER order is of course fine
        const other = await orderFor(c, w, "u2");
        await confirmOrder(c, other);
        await checkAtCommit(c);
      }));

    it("PRIMARY approved amount must equal the order total (INSERT, UPDATE, NULL); EXCESS may differ", () =>
      db.rolledBack(async (c) => {
        const w = await mkWorld(c);
        const order = await orderFor(c, w);
        const bad = { code: PG.checkViolation, constraint: DB_CONSTRAINT.paymentPrimaryAmountCheck };
        await expectInsertError(c, () => mkPayment(c, order.id, { status: "SUCCEEDED", role: "PRIMARY", approved_amount: 99999 }), bad);
        await expectInsertError(c, () => mkPayment(c, order.id, { status: "SUCCEEDED", role: "PRIMARY", approved_amount: 100001 }), bad);
        await expectInsertError(c, () => mkPayment(c, order.id, { status: "SUCCEEDED", role: "PRIMARY", approved_amount: null }), bad); // NULL-safe
        const p = await confirmOrder(c, order);
        await expectDbError(c, `UPDATE payments SET approved_amount = 50000 WHERE id = $1`, [p.id], bad);
        await expectDbError(c, `UPDATE payments SET approved_amount = NULL WHERE id = $1`, [p.id], bad);
        for (const approved of [1, 99999, 100001]) {
          await mkPayment(c, order.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: approved });
        }
        await checkAtCommit(c);
      }));

    it("requested_amount must equal the order total (INSERT, UPDATE of the payment, UPDATE of the order)", () =>
      db.rolledBack(async (c) => {
        const w = await mkWorld(c);
        const order = await orderFor(c, w);
        const fk = { code: PG.foreignKeyViolation, constraint: DB_CONSTRAINT.paymentOrderTotalFk };
        await expectInsertError(c, () => mkPayment(c, order.id, { requested_amount: 99999 }), fk);
        await expectInsertError(c, () => mkPayment(c, order.id, { requested_amount: 100001, status: "FAILED" }), fk);
        const p = await mkPayment(c, order.id);
        await expectDbError(c, `UPDATE payments SET requested_amount = 1 WHERE id = $1`, [p.id], fk);
        // the order total is frozen as soon as a payment exists ...
        await expectDbError(c, `UPDATE orders SET total_amount = 1 WHERE id = $1`, [order.id], fk);
        // ... but can still be corrected on an order that has no payment yet
        const fresh = await orderFor(c, w, "u2");
        await c.query(`UPDATE orders SET total_amount = 120000 WHERE id = $1`, [fresh.id]);
        await mkPayment(c, fresh.id, { requested_amount: 120000 });
      }));

    it("a payment of another order cannot be the confirmed payment; a confirmed payment cannot be moved away", () =>
      db.rolledBack(async (c) => {
        const w = await mkWorld(c);
        const a = await orderFor(c, w, "u1");
        const b = await orderFor(c, w, "u2");
        const pb = await mkPayment(c, b.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000 });
        await expectDbError(c, `UPDATE orders SET confirmed_payment_id = $1 WHERE id = $2`, [pb.id, a.id], {
          code: PG.foreignKeyViolation,
          constraint: "orders_confirmed_payment_fk",
        });
        const pa = await confirmOrder(c, a);
        await expectDbError(c, `UPDATE payments SET order_id = $1 WHERE id = $2`, [b.id, pa.id], {
          code: PG.foreignKeyViolation,
          constraint: "orders_confirmed_payment_fk",
        });
        await checkAtCommit(c);
      }));
  });

  describe("real COMMIT on committed data", () => {
    it("a consistent confirmation commits; an inconsistent one fails AT COMMIT and leaves nothing behind", async () => {
      const w = await mkWorld(db);
      const good = await orderFor(db, w, "u1");
      const bad = await orderFor(db, w, "u2");
      const failed = await mkPayment(db, bad.id, { status: "FAILED" }); // committed FAILED payment

      const c = await db.pool.connect();
      try {
        // consistent: payment first, then order, one transaction
        await c.query("BEGIN");
        await confirmOrder(c, good);
        await c.query("COMMIT");
        const ok = await db.query(`SELECT status FROM orders WHERE id = $1`, [good.id]);
        expect(ok.rows[0].status).toBe("PAID");

        // inconsistent: the statements succeed (state is visible inside the transaction) but COMMIT is rejected
        await c.query("BEGIN");
        await update(c, "orders", bad.id, { status: "PAID", confirmed_payment_id: failed.id, paid_at: new Date() });
        const inside = await c.query(`SELECT status FROM orders WHERE id = $1`, [bad.id]);
        expect(inside.rows[0].status).toBe("PAID");
        await expect(c.query("COMMIT")).rejects.toMatchObject({
          code: PG.checkViolation,
          constraint: DB_CONSTRAINT.confirmedPaymentNotPrimary,
        });
      } finally {
        c.release();
      }
      const after = await db.query(`SELECT status, confirmed_payment_id FROM orders WHERE id = $1`, [bad.id]);
      expect(after.rows[0]).toMatchObject({ status: "PENDING", confirmed_payment_id: null });
    });
  });
});

// ───────────────────────────────────────── S4 ─────────────────────────────────────────

describe("S4 — an order must have its purchase_quotas row", () => {
  const rawOrder = (c: Parameters<typeof insert>[0], ref: { sessionId: string; subjectId: string; identitySessionId: string }, n: string) =>
    insert(c, "orders", {
      order_number: n,
      show_session_id: ref.sessionId,
      identity_subject_id: ref.subjectId,
      identity_session_id: ref.identitySessionId,
      status: "PENDING",
      customer_name: "n",
      customer_phone: "p",
      total_amount: 100000,
      hold_expires_at: new Date(Date.now() + 420_000),
    });

  it("no quota row => rejected; wrong subject => rejected; wrong session => rejected; matching row => accepted", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const u1s1 = w.ref(w.u1, w.is1, w.s1);
      const fk = { code: PG.foreignKeyViolation, constraint: DB_CONSTRAINT.orderQuotaFk };

      await expectInsertError(c, () => rawOrder(c, u1s1, "NZ-S4-1"), fk); // no row at all

      await insert(c, "purchase_quotas", { identity_subject_id: w.u1.id, show_session_id: w.s1.id, seat_limit: 4 });
      await expectInsertError(c, () => rawOrder(c, w.ref(w.u2, w.is2, w.s1), "NZ-S4-2"), fk); // row exists for u1, not u2
      await expectInsertError(c, () => rawOrder(c, w.ref(w.u1, w.is1, w.s2), "NZ-S4-3"), fk); // row exists for s1, not s2
      const ok = await rawOrder(c, u1s1, "NZ-S4-4");
      expect(ok.status).toBe("PENDING");
    }));

  it("the quota row cannot be deleted or re-keyed while orders reference it", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      await orderFor(c, w);
      const fk = { code: PG.foreignKeyViolation, constraint: DB_CONSTRAINT.orderQuotaFk };
      await expectDbError(c, `DELETE FROM purchase_quotas WHERE identity_subject_id = $1 AND show_session_id = $2`, [w.u1.id, w.s1.id], fk);
      await expectDbError(c, `UPDATE purchase_quotas SET show_session_id = $3 WHERE identity_subject_id = $1 AND show_session_id = $2`, [w.u1.id, w.s1.id, w.s2.id], fk);
      // moving an order to a session/subject without a quota row is refused as well
      const order = await orderFor(c, w, "u2");
      await expectDbError(c, `UPDATE orders SET show_session_id = $2 WHERE id = $1`, [order.id, w.s2.id], { code: PG.foreignKeyViolation });
    }));

  // DATABASE.md §11.2 steps 1-3 as raw SQL on two real connections, with the new FK in place.
  async function reserve(c: import("pg").PoolClient, subject: string, session: string, seats: number, applicationCheck: boolean) {
    await c.query("BEGIN");
    await c.query(
      `INSERT INTO purchase_quotas (identity_subject_id, show_session_id, seat_limit) VALUES ($1, $2, 4) ON CONFLICT DO NOTHING`,
      [subject, session],
    );
    const { rows } = await c.query(
      `SELECT counted_seats, seat_limit FROM purchase_quotas WHERE identity_subject_id = $1 AND show_session_id = $2 FOR UPDATE`,
      [subject, session],
    );
    if (applicationCheck && rows[0].counted_seats + seats > rows[0].seat_limit) {
      await c.query("ROLLBACK");
      return "LIMIT_EXCEEDED" as const;
    }
    await c.query(
      `UPDATE purchase_quotas SET counted_seats = counted_seats + $3, version = version + 1 WHERE identity_subject_id = $1 AND show_session_id = $2`,
      [subject, session, seats],
    );
    return "RESERVED" as const;
  }

  it.each([
    ["with the application-level limit check (422 PURCHASE_LIMIT_EXCEEDED)", true],
    ["without it: the CHECK constraint is the last line of defence", false],
  ])("QTA-07/20 at DB level, quota row absent, 3 seats vs 2 seats concurrently %s", async (_label, applicationCheck) => {
    const w = await mkWorld(db);
    const subject = await mkSubject(db);
    const identity = await mkIdentitySession(db, subject.id);
    const c1 = await db.pool.connect();
    const c2 = await db.pool.connect();
    try {
      expect(await reserve(c1, subject.id, w.s1.id, 3, applicationCheck)).toBe("RESERVED"); // inserts the row, uncommitted
      await mkOrder(c1, { sessionId: w.s1.id, subjectId: subject.id, identitySessionId: identity.id }); // orders_quota_fk satisfied by the same tx

      let settled = false;
      const second = reserve(c2, subject.id, w.s1.id, 2, applicationCheck).then(
        (v) => ((settled = true), { value: v }),
        (e: Error & { code?: string; constraint?: string }) => ((settled = true), { error: e }),
      );
      await sleep(400);
      expect(settled, "the second request must wait on the first one's uncommitted quota row").toBe(false);

      await c1.query("COMMIT");
      const result = await second;
      if (applicationCheck) {
        expect(result).toEqual({ value: "LIMIT_EXCEEDED" }); // judged on the COMMITTED counter (3 + 2 > 4)
      } else {
        expect(result).toMatchObject({ error: { code: PG.checkViolation, constraint: DB_CONSTRAINT.quotaCountedSeatsCheck } });
        await c2.query("ROLLBACK");
      }
      const { rows } = await db.query(`SELECT counted_seats::int n, version::int v FROM purchase_quotas WHERE identity_subject_id = $1 AND show_session_id = $2`, [subject.id, w.s1.id]);
      expect(rows[0]).toEqual({ n: 3, v: 1 });
    } finally {
      c1.release();
      c2.release();
    }
  });

  it("the active-order rule still holds next to the quota FK (second order for the same subject + session)", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      await orderFor(c, w);
      await expectInsertError(c, () => orderFor(c, w), { code: PG.uniqueViolation, constraint: DB_CONSTRAINT.activeOrderUnique });
    }));
});

// ───────────────────────────────────────── Q-022 ─────────────────────────────────────────

describe("Q-022 — payments.method_type OTHER", () => {
  it("vocabulary: CARD / EASY_PAY / OTHER; a payment is REQUESTED only as CARD or EASY_PAY", () => {
    expect([...PAYMENT_METHOD_TYPE]).toEqual(["CARD", "EASY_PAY", "OTHER"]);
    expect([...PAYMENT_REQUEST_METHOD_TYPE]).toEqual(["CARD", "EASY_PAY"]);
  });

  it("an approved payment with an unallowed method / issuer is recorded as it happened (SUCCEEDED + EXCESS + OTHER)", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      const p = await mkPayment(c, order.id, {
        status: "SUCCEEDED",
        role: "EXCESS",
        method_type: "OTHER",
        approved_amount: 100000,
        card_company: "SOME_UNLISTED_CARD", // free text: the DB does not allow-list issuers (D4)
        easy_pay_provider: "NOT_A_PHASE1_WALLET",
      });
      expect(p).toMatchObject({ method_type: "OTHER", role: "EXCESS", status: "SUCCEEDED" });
      for (const m of PAYMENT_REQUEST_METHOD_TYPE) await mkPayment(c, order.id, { status: "FAILED", method_type: m });
    }));

  it("the transition READY(CARD) -> approved OTHER is one UPDATE; the method cannot change on its own", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      const p = await mkPayment(c, order.id, { method_type: "CARD" });
      const bad = { code: PG.checkViolation, constraint: DB_CONSTRAINT.paymentMethodOtherCheck };
      await expectDbError(c, `UPDATE payments SET method_type = 'OTHER' WHERE id = $1`, [p.id], bad); // still READY
      await c.query(`UPDATE payments SET status = 'CONFIRMING', confirm_started_at = now() WHERE id = $1`, [p.id]);
      await expectDbError(c, `UPDATE payments SET method_type = 'OTHER' WHERE id = $1`, [p.id], bad); // still CONFIRMING
      await c.query(
        `UPDATE payments SET status = 'SUCCEEDED', role = 'EXCESS', method_type = 'OTHER', provider_method_raw = '가상계좌',
                          approved_amount = 100000, approved_at = now() WHERE id = $1`,
        [p.id],
      );
    }));

  it("OTHER can never be in-flight, failed, canceled, or PRIMARY (it cannot fulfil an order)", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      const bad = { code: PG.checkViolation, constraint: DB_CONSTRAINT.paymentMethodOtherCheck };
      for (const status of ["READY", "CONFIRMING", "UNKNOWN", "FAILED", "CANCELED"]) {
        await expectInsertError(c, () => mkPayment(c, order.id, { status, method_type: "OTHER" }), bad);
      }
      await expectInsertError(c, () => mkPayment(c, order.id, { status: "SUCCEEDED", role: "PRIMARY", method_type: "OTHER", approved_amount: 100000 }), bad);
      await expectInsertError(c, () => confirmOrder(c, order, { method_type: "OTHER" }), bad);

      const excess = await mkPayment(c, order.id, { status: "SUCCEEDED", role: "EXCESS", method_type: "OTHER", approved_amount: 100000 });
      await expectDbError(c, `UPDATE payments SET role = 'PRIMARY' WHERE id = $1`, [excess.id], bad); // promotion by UPDATE
      await expectDbError(c, `UPDATE payments SET status = 'FAILED', role = NULL WHERE id = $1`, [excess.id], bad); // un-approving it
    }));

  it("everything else is still rejected (the vocabulary CHECK stays)", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      for (const m of ["VIRTUAL_ACCOUNT", "other", "DISALLOWED", ""]) {
        await expectInsertError(c, () => mkPayment(c, order.id, { method_type: m }), { code: PG.checkViolation, constraint: "payments_method_type_ck" });
      }
    }));
});

// ───────────────────────────────────────── Q-023 ─────────────────────────────────────────

describe("Q-023 — order_items: UPDATE and DELETE are rejected", () => {
  const immutable = (op: string) => ({ code: PG.restrictViolation, message: new RegExp(`immutable: ${op} rejected`) });

  it("rejects UPDATE and DELETE of a row nothing else references, and of a referenced row", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      const item = await mkOrderItem(c, { orderId: order.id, sessionId: w.s1.id, sessionSeatId: w.s1a.id }); // no hold, no ticket
      await expectDbError(c, `UPDATE order_items SET price = price + 1 WHERE id = $1`, [item.id], immutable("UPDATE"));
      await expectDbError(c, `DELETE FROM order_items WHERE id = $1`, [item.id], immutable("DELETE"));
      await expectDbError(c, `DELETE FROM order_items WHERE order_id = $1`, [order.id], immutable("DELETE"));
      await expectDbError(c, `DELETE FROM order_items`, [], immutable("DELETE")); // bulk delete too
      // the order itself cannot be removed from under its items either
      await expectDbError(c, `DELETE FROM orders WHERE id = $1`, [order.id], { code: PG.foreignKeyViolation });
      const { rows } = await c.query(`SELECT count(*)::int n FROM order_items WHERE id = $1`, [item.id]);
      expect(rows[0].n).toBe(1);
    }));

  it("a rolled-back order creation leaves no items behind (rollback is not a DELETE)", async () => {
    const w = await mkWorld(db);
    const before = (await db.query(`SELECT count(*)::int n FROM order_items`)).rows[0].n;
    const c = await db.pool.connect();
    let orderNumber = "";
    try {
      await c.query("BEGIN");
      const order = await orderFor(c, w);
      orderNumber = order.order_number;
      await mkOrderItem(c, { orderId: order.id, sessionId: w.s1.id, sessionSeatId: w.s1a.id });
      await mkOrderItem(c, { orderId: order.id, sessionId: w.s1.id, sessionSeatId: w.s1b.id });
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
    expect((await db.query(`SELECT count(*)::int n FROM order_items`)).rows[0].n).toBe(before);
    expect((await db.query(`SELECT count(*)::int n FROM orders WHERE order_number = $1`, [orderNumber])).rows[0].n).toBe(0);
  });
});

// ───────────────────────────────────────── Q-024 ─────────────────────────────────────────

describe("Q-024 — an identity session carries its verification's subject and purpose", () => {
  const verification = (c: Parameters<typeof insert>[0], subjectId: string | null, purpose: string, status = "CONSUMED") =>
    insert(c, "identity_verifications", {
      purpose,
      provider: "MOCK",
      browser_binding_hash: "b",
      state_nonce_hash: `n-${Math.random().toString(36).slice(2)}`, // A-049: state is unique
      status,
      identity_subject_id: subjectId,
      expires_at: new Date(Date.now() + 600_000),
    });
  const session = (c: Parameters<typeof insert>[0], verificationId: string, subjectId: string, purpose: string) =>
    insert(c, "identity_sessions", {
      identity_verification_id: verificationId,
      identity_subject_id: subjectId,
      purpose,
      token_hash: `t-${Math.random().toString(36).slice(2)}`,
      browser_binding_hash: "b",
      status: "ACTIVE",
      expires_at: new Date(Date.now() + 1_800_000),
    });
  const fk = { code: PG.foreignKeyViolation, constraint: DB_CONSTRAINT.identitySessionVerificationFk };

  it("rejects another person's subject, another purpose and an unverified verification; accepts a matching session", () =>
    db.rolledBack(async (c) => {
      const u1 = await mkSubject(c);
      const u2 = await mkSubject(c);
      const v = await verification(c, u1.id, "BOOKING");

      await expectInsertError(c, () => session(c, v.id, u2.id, "BOOKING"), fk); // someone else's subject
      await expectInsertError(c, () => session(c, v.id, u1.id, "LOOKUP"), fk); // a different purpose

      const pending = await verification(c, null, "BOOKING", "PENDING"); // not verified: no subject yet
      await expectInsertError(c, () => session(c, pending.id, u1.id, "BOOKING"), fk);

      const s = await session(c, v.id, u1.id, "BOOKING"); // exactly matching
      expect(s).toMatchObject({ identity_subject_id: u1.id, purpose: "BOOKING" });
      const lookup = await verification(c, u2.id, "LOOKUP");
      await session(c, lookup.id, u2.id, "LOOKUP"); // LOOKUP works the same way
    }));

  it("one verification still yields at most one session", () =>
    db.rolledBack(async (c) => {
      const u1 = await mkSubject(c);
      const v = await verification(c, u1.id, "BOOKING");
      await session(c, v.id, u1.id, "BOOKING");
      await expectInsertError(c, () => session(c, v.id, u1.id, "BOOKING"), {
        code: PG.uniqueViolation,
        constraint: "identity_sessions_verification_uq",
      });
    }));

  it("after the claim, the verification's subject and purpose can no longer be changed", () =>
    db.rolledBack(async (c) => {
      const u1 = await mkSubject(c);
      const u2 = await mkSubject(c);
      const v = await verification(c, u1.id, "BOOKING");
      await session(c, v.id, u1.id, "BOOKING");
      await expectDbError(c, `UPDATE identity_verifications SET identity_subject_id = $2 WHERE id = $1`, [v.id, u2.id], fk);
      await expectDbError(c, `UPDATE identity_verifications SET purpose = 'LOOKUP' WHERE id = $1`, [v.id], fk);
      // and the session cannot be re-pointed to another subject or purpose either
      const s = (await c.query(`SELECT id FROM identity_sessions WHERE identity_verification_id = $1`, [v.id])).rows[0];
      await expectDbError(c, `UPDATE identity_sessions SET identity_subject_id = $2 WHERE id = $1`, [s.id, u2.id], fk);
      await expectDbError(c, `UPDATE identity_sessions SET purpose = 'LOOKUP' WHERE id = $1`, [s.id], fk);
    }));

  it("orders inherit the guarantee: order subject = session subject = verification subject", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      // mkIdentitySession builds a matching verification + session pair for each subject
      const other = await mkIdentitySession(c, w.u2.id);
      await ensureQuota(c, w.u1.id, w.s1.id);
      await expectInsertError(c, () => mkOrder(c, { sessionId: w.s1.id, subjectId: w.u1.id, identitySessionId: other.id }), {
        code: PG.foreignKeyViolation,
        constraint: "orders_identity_session_subject_fk",
      });
    }));
});

// ───────────────────────────────────────── A-038 ─────────────────────────────────────────

describe("A-038 — payments is a ledger: rows are never deleted", () => {
  const ledger = { code: PG.restrictViolation, message: /payments rows are a ledger and are never deleted: DELETE rejected/ };
  const count = async (c: Parameters<typeof insert>[0], id: string) =>
    ((await c.query(`SELECT count(*)::int n FROM payments WHERE id = $1`, [id])).rows[0] as { n: number }).n;

  it.each([
    ["READY", { status: "READY" }],
    ["CONFIRMING", { status: "CONFIRMING" }],
    ["UNKNOWN", { status: "UNKNOWN" }],
    ["FAILED", { status: "FAILED" }],
    ["CANCELED", { status: "CANCELED" }],
    ["SUCCEEDED + EXCESS (approved, never used to confirm)", { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000 }],
  ])("a %s payment that nothing references cannot be deleted", (_label, payment) =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      const p = await mkPayment(c, order.id, payment); // no status log, no webhook, no refund, no review case
      await expectDbError(c, `DELETE FROM payments WHERE id = $1`, [p.id], ledger);
      expect(await count(c, p.id)).toBe(1);
    }),
  );

  it("bulk deletes are rejected too, and so is the confirmed PRIMARY payment and a payment that has status logs", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      const primary = await confirmOrder(c, order);
      const excess = await mkPayment(c, order.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000 });
      await insert(c, "payment_status_logs", { payment_id: excess.id, to_status: "SUCCEEDED", source: "API" });
      await expectDbError(c, `DELETE FROM payments WHERE order_id = $1`, [order.id], ledger);
      await expectDbError(c, `DELETE FROM payments`, [], ledger);
      await expectDbError(c, `DELETE FROM payments WHERE id = $1`, [primary.id], ledger); // the trigger fires before the FKs
      await expectDbError(c, `DELETE FROM payments WHERE id = $1`, [excess.id], ledger); // previously only an incidental FK of the log row
      expect(await count(c, primary.id)).toBe(1);
      expect(await count(c, excess.id)).toBe(1);
    }));

  it("a real (committed) DELETE attempt fails and the row survives", async () => {
    const w = await mkWorld(db);
    const order = await orderFor(db, w);
    const p = await mkPayment(db, order.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000 });
    await expect(db.query(`DELETE FROM payments WHERE id = $1`, [p.id])).rejects.toMatchObject({ code: PG.restrictViolation });
    expect((await db.query(`SELECT count(*)::int n FROM payments WHERE id = $1`, [p.id])).rows[0].n).toBe(1);
  });

  it("nothing legitimate needs DELETE: every lifecycle transition, insert and update still works; a rolled-back attempt leaves no row", async () => {
    await db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      const a = await mkPayment(c, order.id); // READY -> CONFIRMING -> UNKNOWN -> SUCCEEDED (EXCESS)
      await update(c, "payments", a.id, { status: "CONFIRMING", confirm_started_at: new Date() });
      await update(c, "payments", a.id, { status: "UNKNOWN", unknown_since: new Date() });
      await update(c, "payments", a.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000, approved_at: new Date() });
      const b = await mkPayment(c, order.id); // READY -> CANCELED (a discarded attempt is CANCELED, not deleted)
      await update(c, "payments", b.id, { status: "CANCELED", canceled_at: new Date() });
      const f = await mkPayment(c, order.id, { status: "FAILED" }); // FAILED -> SUCCEEDED (late approval found by a re-query)
      await update(c, "payments", f.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000, approved_at: new Date() });
      await confirmOrder(c, await orderFor(c, w, "u2")); // normal confirmation
    });
    const w = await mkWorld(db);
    const order = await orderFor(db, w);
    const c = await db.pool.connect();
    let ref = "";
    try {
      await c.query("BEGIN");
      const p = await mkPayment(c, order.id);
      ref = p.merchant_payment_ref;
      await c.query("ROLLBACK"); // an aborted creation transaction: the INSERT never happened, no DELETE involved
    } finally {
      c.release();
    }
    expect((await db.query(`SELECT count(*)::int n FROM payments WHERE merchant_payment_ref = $1`, [ref])).rows[0].n).toBe(0);
  });
});

describe("A-038 — a SUCCEEDED payment carries a positive approved_amount", () => {
  const bad = { code: PG.checkViolation, constraint: DB_CONSTRAINT.paymentSucceededAmountCheck };

  it("INSERT: approved_amount NULL or 0 is rejected for SUCCEEDED; any other status may have none", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      await expectInsertError(c, () => mkPayment(c, order.id, { status: "SUCCEEDED", role: "EXCESS" }), bad); // NULL (NULL-safe)
      await expectInsertError(c, () => mkPayment(c, order.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 0 }), bad);
      await mkPayment(c, order.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 1 });
      for (const status of ["READY", "CONFIRMING", "UNKNOWN", "FAILED", "CANCELED"]) {
        await c.query("SAVEPOINT s"); // in-flight statuses share one slot per order, so try each on its own
        const p = await mkPayment(c, order.id, { status });
        expect(p.approved_amount, `${status} payments have no approved amount yet`).toBeNull();
        await c.query("ROLLBACK TO SAVEPOINT s");
      }
    }));

  it("UPDATE: no way to reach SUCCEEDED without the amount, or to erase it afterwards", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      const p = await mkPayment(c, order.id);
      await expectDbError(c, `UPDATE payments SET status = 'SUCCEEDED', role = 'EXCESS', approved_at = now() WHERE id = $1`, [p.id], bad);
      await expectDbError(c, `UPDATE payments SET status = 'SUCCEEDED', role = 'EXCESS', approved_amount = 0, approved_at = now() WHERE id = $1`, [p.id], bad);
      await c.query(`UPDATE payments SET status = 'SUCCEEDED', role = 'EXCESS', approved_amount = 100000, approved_at = now() WHERE id = $1`, [p.id]); // one statement
      await expectDbError(c, `UPDATE payments SET approved_amount = NULL WHERE id = $1`, [p.id], bad);
      await expectDbError(c, `UPDATE payments SET approved_amount = 0 WHERE id = $1`, [p.id], bad);
    }));

  it("an approved payment can always be refunded in the ledger (the refund cap has a real approved amount to work with)", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      const p = await mkPayment(c, order.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000 });
      await c.query(`UPDATE payments SET refunded_amount = 100000 WHERE id = $1`, [p.id]);
    }));
});
