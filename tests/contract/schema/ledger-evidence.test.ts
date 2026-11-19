/**
 * PR #2 technical review follow-up, proven on a real PostgreSQL:
 *
 *   P1-a  The approval record of a SUCCEEDED payment (PRIMARY and EXCESS) cannot be rewritten; operational columns still can.
 *   P1-b  The monetary core of a refund cannot be rewritten after creation; the status lifecycle and metadata still can,
 *         and a SEAT refund's total always equals the sum of its items (checked at COMMIT).
 *
 * Every scenario that must be rejected has a matching scenario that must still work. Deferred rules use
 * `expectCommitError` (statements accepted, COMMIT refused) and real COMMITs on committed data.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { DB_CONSTRAINT } from "../../../src/server/db/constants";
import {
  checkAtCommit,
  confirmOrder,
  expectCommitError,
  expectDbError,
  expectInsertError,
  insert,
  mkAdmin,
  mkOrder,
  mkOrderItem,
  mkPayment,
  mkRefund,
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

type C = Parameters<typeof insert>[0];
type World = Awaited<ReturnType<typeof mkWorld>>;
const orderFor = (c: C, w: World, who: "u1" | "u2" = "u1") => mkOrder(c, who === "u1" ? w.ref(w.u1, w.is1) : w.ref(w.u2, w.is2));
const row = async (c: C, table: string, id: string) => (await c.query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0] as Record<string, unknown>;

// ═════════════════════════════ P1-a: the approval record of a SUCCEEDED payment ═════════════════════════════

describe("P1 — a SUCCEEDED payment's approval record is immutable", () => {
  const evidence = { code: PG.restrictViolation, constraint: DB_CONSTRAINT.approvedPaymentEvidenceImmutable, message: /approval record is immutable/ };
  // (provider, pg_transaction_id) and (provider, provider_payment_id) are unique: every approved payment gets its own ids
  let seq = 0;
  const APPROVAL = {
    approved_amount: 100000,
    approved_at: new Date("2026-11-01T10:00:00Z"),
    card_company: "SHINHAN",
    provider_method_raw: "카드",
  };
  const ids = () => ({ provider_payment_id: `pk_original_${++seq}`, pg_transaction_id: `tx_original_${++seq}` });

  /** A SUCCEEDED payment of either role with every evidence column filled in. */
  async function approved(c: C, role: "PRIMARY" | "EXCESS") {
    const w = await mkWorld(c);
    const order = await orderFor(c, w);
    const payment = role === "PRIMARY" ? await confirmOrder(c, order, { ...APPROVAL, ...ids() }) : await mkPayment(c, order.id, { status: "SUCCEEDED", role: "EXCESS", ...APPROVAL, ...ids() });
    const other = await orderFor(c, w, "u2"); // same total: lets order_id be changed without tripping the composite FK first
    return { w, order, other, payment };
  }

  // [column, new value, roles for which the OTHER constraints let the statement through (so that this trigger is what refuses it)]
  const CHANGES: [string, unknown, ("PRIMARY" | "EXCESS")[]][] = [
    ["approved_at", new Date("2026-11-02T00:00:00Z"), ["PRIMARY", "EXCESS"]],
    ["method_type", "EASY_PAY", ["PRIMARY", "EXCESS"]],
    ["provider_method_raw", "간편결제", ["PRIMARY", "EXCESS"]],
    ["provider_method_raw", null, ["PRIMARY", "EXCESS"]],
    ["easy_pay_provider", "TOSSPAY", ["PRIMARY", "EXCESS"]],
    ["card_company", "KB", ["PRIMARY", "EXCESS"]],
    ["card_company", null, ["PRIMARY", "EXCESS"]],
    ["merchant_payment_ref", "changed-ref", ["PRIMARY", "EXCESS"]],
    ["provider_payment_id", "pk_other", ["PRIMARY", "EXCESS"]],
    ["provider_payment_id", null, ["PRIMARY", "EXCESS"]],
    ["pg_transaction_id", "tx_other", ["PRIMARY", "EXCESS"]],
    ["pg_transaction_id", null, ["PRIMARY", "EXCESS"]],
    ["provider", "TOSS", ["PRIMARY", "EXCESS"]],
    ["currency", "USD", ["PRIMARY", "EXCESS"]],
    ["approved_amount", 99999, ["EXCESS"]], // for PRIMARY payments_primary_amount_ck answers first (consistency.test.ts)
  ];

  it.each(CHANGES.flatMap(([col, value, roles]) => roles.map((role) => [role, col, value] as const)))(
    "%s payment: changing %s to %j is rejected (single row), the row stays as approved",
    (role, col, value) =>
      db.rolledBack(async (c) => {
        const f = await approved(c, role);
        const before = await row(c, "payments", f.payment.id);
        await expectDbError(c, `UPDATE payments SET ${col} = $2 WHERE id = $1`, [f.payment.id, value], evidence);
        expect(await row(c, "payments", f.payment.id)).toEqual(before);
      }),
  );

  it("EXCESS payment: moving it to another order is rejected (order_id), also in combination with allowed columns", () =>
    db.rolledBack(async (c) => {
      const f = await approved(c, "EXCESS");
      await expectDbError(c, `UPDATE payments SET order_id = $2 WHERE id = $1`, [f.payment.id, f.other.id], evidence);
      await expectDbError(c, `UPDATE payments SET order_id = $2, last_verified_at = now(), requery_count = 5 WHERE id = $1`, [f.payment.id, f.other.id], evidence);
    }));

  it.each(["PRIMARY", "EXCESS"] as const)(
    "%s payment: requested_amount is already fixed by the composite FK to the order total (the trigger lists it as well, defence in depth)",
    (role) =>
      db.rolledBack(async (c) => {
        const f = await approved(c, role);
        // PRIMARY: its approved = requested CHECK answers first; EXCESS: the composite FK (requested_amount = orders.total_amount)
        const expected = role === "PRIMARY" ? { code: PG.checkViolation, constraint: DB_CONSTRAINT.paymentPrimaryAmountCheck } : { code: PG.foreignKeyViolation, constraint: DB_CONSTRAINT.paymentOrderTotalFk };
        await expectDbError(c, `UPDATE payments SET requested_amount = 50000 WHERE id = $1`, [f.payment.id], expected);
        // and the order total cannot move under an existing payment either
        await expectDbError(c, `UPDATE orders SET total_amount = 50000 WHERE id = $1`, [f.order.id], { code: PG.foreignKeyViolation, constraint: DB_CONSTRAINT.paymentOrderTotalFk });
      }),
  );

  it("bulk UPDATE of approval columns is rejected as a whole (one rejected row aborts the statement)", () =>
    db.rolledBack(async (c) => {
      const a = await approved(c, "EXCESS");
      const b = await approved(c, "PRIMARY");
      await expectDbError(c, `UPDATE payments SET approved_at = approved_at + interval '1 day' WHERE status = 'SUCCEEDED'`, [], evidence);
      await expectDbError(c, `UPDATE payments SET pg_transaction_id = 'x' || id::text`, [], evidence);
      expect((await row(c, "payments", a.payment.id)).approved_at).toEqual(APPROVAL.approved_at);
      expect((await row(c, "payments", b.payment.id)).approved_at).toEqual(APPROVAL.approved_at);
    }));

  it.each(["PRIMARY", "EXCESS"] as const)("%s payment: SUCCEEDED can not be demoted to FAILED or CANCELED (the approval is not erased)", (role) =>
    db.rolledBack(async (c) => {
      const f = await approved(c, role);
      const before = await row(c, "payments", f.payment.id);
      for (const to of ["FAILED", "CANCELED", "READY", "CONFIRMING", "UNKNOWN"]) {
        await expectDbError(c, `UPDATE payments SET status = $2, role = NULL WHERE id = $1`, [f.payment.id, to], evidence);
      }
      // together with a wiped approval, as the cheapest way to make the row look like it never succeeded
      await expectDbError(
        c,
        `UPDATE payments SET status = 'FAILED', role = NULL, approved_amount = NULL, approved_at = NULL, pg_transaction_id = NULL WHERE id = $1`,
        [f.payment.id],
        evidence,
      );
      expect(await row(c, "payments", f.payment.id)).toEqual(before);
    }));

  it.each(["PRIMARY", "EXCESS"] as const)("%s payment: operational columns keep working (refunds, re-verification, requery bookkeeping, failure notes)", (role) =>
    db.rolledBack(async (c) => {
      const f = await approved(c, role);
      const before = await row(c, "payments", f.payment.id);
      await c.query(
        `UPDATE payments SET refunded_amount = 40000, last_verified_at = now(), requery_count = requery_count + 1,
                next_requery_at = now() + interval '1 minute', unknown_since = now(), confirm_started_at = now(),
                failure_code = 'NOTE', failure_message = 'late webhook, no change', updated_at = now() WHERE id = $1`,
        [f.payment.id],
      );
      await c.query(`UPDATE payments SET refunded_amount = 100000 WHERE id = $1`, [f.payment.id]); // fully refunded: still SUCCEEDED
      // writing a frozen column with the value it already has is not a change
      await c.query(
        `UPDATE payments SET approved_amount = approved_amount, approved_at = approved_at, method_type = method_type, status = status,
                pg_transaction_id = pg_transaction_id, merchant_payment_ref = merchant_payment_ref WHERE id = $1`,
        [f.payment.id],
      );
      const after = await row(c, "payments", f.payment.id);
      expect(after).toMatchObject({ refunded_amount: "100000", status: "SUCCEEDED", role, approved_amount: "100000", pg_transaction_id: before.pg_transaction_id });
      await checkAtCommit(c); // PRIMARY <-> order stays consistent
    }));

  it("the transition INTO SUCCEEDED is untouched: every evidence column is written by the one UPDATE that approves the payment", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      const p = await mkPayment(c, order.id, { requested_method_type: "CARD", method_type: "CARD" });
      await c.query(`UPDATE payments SET status = 'CONFIRMING', confirm_started_at = now(), provider_payment_id = 'pk_1' WHERE id = $1`, [p.id]);
      await c.query(`UPDATE payments SET status = 'UNKNOWN', unknown_since = now() WHERE id = $1`, [p.id]);
      await c.query(
        `UPDATE payments SET status = 'SUCCEEDED', role = 'EXCESS', approved_amount = 100000, approved_at = now(), method_type = 'EASY_PAY',
                provider_method_raw = '간편결제', easy_pay_provider = 'TOSSPAY', card_company = NULL, pg_transaction_id = 'tx_1',
                provider_payment_id = 'pk_final', merchant_payment_ref = merchant_payment_ref WHERE id = $1`,
        [p.id],
      );
      expect(await row(c, "payments", p.id)).toMatchObject({ status: "SUCCEEDED", method_type: "EASY_PAY", pg_transaction_id: "tx_1", provider_payment_id: "pk_final" });
      await expectDbError(c, `UPDATE payments SET pg_transaction_id = 'tx_2' WHERE id = $1`, [p.id], evidence); // ... and it is final now
    }));

  it("payments that are not approved yet (READY, CONFIRMING, UNKNOWN, FAILED, CANCELED) keep every column writable", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      for (const status of ["READY", "CONFIRMING", "UNKNOWN", "FAILED", "CANCELED"]) {
        await c.query("SAVEPOINT s");
        const p = await mkPayment(c, order.id, { status });
        await c.query(
          `UPDATE payments SET provider_payment_id = 'pk', pg_transaction_id = 'tx', card_company = 'KB', easy_pay_provider = 'NAVERPAY',
                  provider_method_raw = '카드', approved_amount = NULL, merchant_payment_ref = merchant_payment_ref || '-x',
                  currency = 'KRW', provider = 'MOCK' WHERE id = $1`,
          [p.id],
        );
        await c.query("ROLLBACK TO SAVEPOINT s");
      }
    }));

  it("really committed: an approved payment cannot be rewritten by an autocommit statement, but its refund bookkeeping persists", async () => {
    const setup = await db.pool.connect();
    let payment: Record<string, unknown>;
    try {
      await setup.query("BEGIN"); // PRIMARY payment + PAID order are one transaction (S3)
      payment = (await approved(setup, "PRIMARY")).payment;
      await setup.query("COMMIT");
    } finally {
      setup.release();
    }
    await expect(db.query(`UPDATE payments SET approved_amount = 1 WHERE id = $1`, [payment.id])).rejects.toMatchObject({ code: PG.checkViolation }); // PRIMARY amount rule answers first
    await expect(db.query(`UPDATE payments SET approved_at = now() WHERE id = $1`, [payment.id])).rejects.toMatchObject({ code: PG.restrictViolation, constraint: DB_CONSTRAINT.approvedPaymentEvidenceImmutable });
    await expect(db.query(`UPDATE payments SET status = 'CANCELED', role = NULL WHERE id = $1`, [payment.id])).rejects.toMatchObject({ code: PG.restrictViolation });
    await db.query(`UPDATE payments SET refunded_amount = 25000, last_verified_at = now(), requery_count = 3 WHERE id = $1`, [payment.id]);
    expect(await row(db, "payments", payment.id as string)).toMatchObject({ refunded_amount: "25000", requery_count: 3, approved_amount: "100000", pg_transaction_id: payment.pg_transaction_id });
  });
});

// ═════════════════════════════ P1-b: the monetary core of a refund ═════════════════════════════

describe("P1 — a refund keeps its status lifecycle but its core is fixed at creation", () => {
  const core = { code: PG.restrictViolation, constraint: DB_CONSTRAINT.refundCoreImmutable, message: /core of a refund is immutable/ };

  /** A confirmed order (PRIMARY payment), a SEAT refund with its item, and a payment-excess refund without items. */
  async function refunds(c: C) {
    const w = await mkWorld(c);
    const order = await orderFor(c, w);
    const item = await mkOrderItem(c, { orderId: order.id, sessionId: w.s1.id, sessionSeatId: w.s1a.id });
    const primary = await confirmOrder(c, order);
    const excess = await mkPayment(c, order.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000 });
    const admin = await mkAdmin(c);
    const admin2 = await mkAdmin(c);
    const seat = await mkRefund(c, { orderId: order.id, paymentId: primary.id }, { requested_by_admin_id: admin.id });
    await insert(c, "refund_items", { refund_id: seat.id, order_id: order.id, order_item_id: item.id, amount: 100000 });
    const extra = await mkRefund(c, { orderId: order.id, paymentId: excess.id }, { refund_type: "PAYMENT_EXCESS" });
    // another confirmed order whose payment is a valid FK target for order_id / payment_id changes
    const other = await orderFor(c, w, "u2");
    const otherPayment = await confirmOrder(c, other);
    return { w, order, item, primary, excess, admin, admin2, seat, extra, other, otherPayment };
  }

  it.each([
    ["total_amount", "50000", "seat"],
    ["refund_type", "'PAYMENT_EXCESS'", "seat"],
    ["refund_type", "'SEAT'", "extra"],
    ["provider", "'TOSS'", "seat"],
    ["requested_by_admin_id", "$A", "extra"], // NULL -> admin
    ["requested_by_admin_id", "$B", "seat"], // admin -> another admin
    ["requested_by_admin_id", "NULL", "seat"], // admin -> NULL
    ["created_at", "created_at - interval '1 day'", "seat"],
    ["payment_id", "$EXCESS", "seat"], // another payment of the same order (FK satisfied)
    ["id", "gen_random_uuid()", "extra"], // an unreferenced refund (items would trip the FK first)
  ] as const)("%s = %s on the %s refund is rejected (single row), the row stays as created", (col, expr, which) =>
    db.rolledBack(async (c) => {
      const f = await refunds(c);
      const target = which === "seat" ? f.seat : f.extra;
      const sql = expr.replace("$A", `'${f.admin.id}'`).replace("$B", `'${f.admin2.id}'`).replace("$EXCESS", `'${f.excess.id}'`);
      const before = await row(c, "refunds", target.id);
      await expectDbError(c, `UPDATE refunds SET ${col} = ${sql} WHERE id = $1`, [target.id], core);
      expect(await row(c, "refunds", target.id)).toEqual(before);
    }),
  );

  it("order_id (together with the matching payment_id) cannot be moved to another order", () =>
    db.rolledBack(async (c) => {
      const f = await refunds(c);
      await expectDbError(c, `UPDATE refunds SET order_id = $2, payment_id = $3 WHERE id = $1`, [f.extra.id, f.other.id, f.otherPayment.id], core);
      // order_id alone is answered by the composite FK (payment and refund must share the order)
      await expectDbError(c, `UPDATE refunds SET order_id = $2 WHERE id = $1`, [f.extra.id, f.other.id], { code: PG.foreignKeyViolation, constraint: "refunds_payment_order_fk" });
    }));

  it("bulk UPDATE of a core column is rejected as a whole", () =>
    db.rolledBack(async (c) => {
      const f = await refunds(c);
      await expectDbError(c, `UPDATE refunds SET total_amount = total_amount + 1`, [], core);
      await expectDbError(c, `UPDATE refunds SET provider = 'TOSS'`, [], core);
      await expectDbError(c, `UPDATE refunds SET refund_type = 'SEAT' WHERE refund_type = 'PAYMENT_EXCESS'`, [], core);
      expect((await row(c, "refunds", f.seat.id)).total_amount).toBe("100000");
    }));

  it("the status lifecycle and operational metadata still update (REQUESTED -> VERIFYING -> FAILED -> VERIFYING -> COMPLETED, WITHDRAWN)", () =>
    db.rolledBack(async (c) => {
      const f = await refunds(c);
      await update(c, "refunds", f.seat.id, { status: "VERIFYING", pg_executed_by_admin_id: f.admin.id, provider_refund_id: "pg-refund-1" });
      await update(c, "refunds", f.seat.id, { status: "FAILED", failure_reason: "not found at the PG", reason: "customer request (note)" });
      await update(c, "refunds", f.seat.id, { status: "VERIFYING", failure_reason: null, pg_executed_by_admin_id: f.admin2.id });
      await update(c, "refunds", f.seat.id, { status: "COMPLETED", verified_at: new Date(), completed_at: new Date(), updated_at: new Date() });
      await update(c, "refunds", f.extra.id, { status: "WITHDRAWN" });
      // writing a core column with the value it already has is not a change
      await c.query(
        `UPDATE refunds SET total_amount = total_amount, refund_type = refund_type, provider = provider, order_id = order_id,
                payment_id = payment_id, requested_by_admin_id = requested_by_admin_id, created_at = created_at WHERE id = $1`,
        [f.seat.id],
      );
      expect(await row(c, "refunds", f.seat.id)).toMatchObject({ status: "COMPLETED", provider_refund_id: "pg-refund-1", total_amount: "100000" });
      // and the core stays fixed after completion
      await expectDbError(c, `UPDATE refunds SET total_amount = 1 WHERE id = $1`, [f.seat.id], core);
      await checkAtCommit(c);
    }));

  it("really committed: a core change is refused in autocommit, the status lifecycle persists", async () => {
    const setup = await db.pool.connect();
    let f: Awaited<ReturnType<typeof refunds>>;
    try {
      await setup.query("BEGIN");
      f = await refunds(setup);
      await setup.query("COMMIT");
    } finally {
      setup.release();
    }
    await expect(db.query(`UPDATE refunds SET total_amount = 1 WHERE id = $1`, [f.seat.id])).rejects.toMatchObject({ code: PG.restrictViolation, constraint: DB_CONSTRAINT.refundCoreImmutable });
    await expect(db.query(`UPDATE refunds SET payment_id = $2 WHERE id = $1`, [f.seat.id, f.excess.id])).rejects.toMatchObject({ code: PG.restrictViolation });
    await db.query(`UPDATE refunds SET status = 'VERIFYING', provider_refund_id = 'pg-r-1', pg_executed_by_admin_id = $2 WHERE id = $1`, [f.seat.id, f.admin.id]);
    await db.query(`UPDATE refunds SET status = 'COMPLETED', verified_at = now(), completed_at = now() WHERE id = $1`, [f.seat.id]);
    expect(await row(db, "refunds", f.seat.id)).toMatchObject({ status: "COMPLETED", total_amount: "100000", provider: "MOCK" });
  });
});

describe("P1 — a SEAT refund's total_amount equals the sum of its refund_items (checked at COMMIT)", () => {
  const seatTotal = { code: PG.checkViolation, constraint: DB_CONSTRAINT.refundSeatItemsTotal };
  const excessItems = { code: PG.checkViolation, constraint: DB_CONSTRAINT.refundExcessNoItems };

  async function base(c: C) {
    const w = await mkWorld(c);
    const order = await orderFor(c, w);
    const item1 = await mkOrderItem(c, { orderId: order.id, sessionId: w.s1.id, sessionSeatId: w.s1a.id }, { price: 60000 });
    const item2 = await mkOrderItem(c, { orderId: order.id, sessionId: w.s1.id, sessionSeatId: w.s1b.id }, { price: 40000 });
    const payment = await confirmOrder(c, order);
    const add = (refundId: string, itemId: string, amount: number) => insert(c, "refund_items", { refund_id: refundId, order_id: order.id, order_item_id: itemId, amount });
    return { w, order, item1, item2, payment, add };
  }

  it("a SEAT refund whose items add up to its total is accepted (one item, several items, items inserted after the refund)", () =>
    db.rolledBack(async (c) => {
      const f = await base(c);
      const one = await mkRefund(c, { orderId: f.order.id, paymentId: f.payment.id }, { total_amount: 60000 });
      await f.add(one.id, f.item1.id, 60000);
      const two = await mkRefund(c, { orderId: f.order.id, paymentId: f.payment.id }, { total_amount: 100000 });
      await f.add(two.id, f.item1.id, 60000);
      await f.add(two.id, f.item2.id, 40000);
      await checkAtCommit(c);
    }));

  it.each([
    ["no item at all", 100000, []],
    ["items add up to less", 100000, [60000]],
    ["items add up to more", 50000, [60000]],
    ["items add up to more (two)", 90000, [60000, 40000]],
  ] as const)("a SEAT refund with %s is rejected at COMMIT", (_label, total, amounts) =>
    db.rolledBack(async (c) => {
      const f = await base(c);
      await expectCommitError(
        c,
        async () => {
          const r = await mkRefund(c, { orderId: f.order.id, paymentId: f.payment.id }, { total_amount: total });
          for (const [i, amount] of amounts.entries()) await f.add(r.id, i === 0 ? f.item1.id : f.item2.id, amount);
        },
        seatTotal,
      );
    }),
  );

  it("an extra item added to a consistent refund breaks the sum and is rejected at COMMIT; a PAYMENT_EXCESS refund cannot have items", () =>
    db.rolledBack(async (c) => {
      const f = await base(c);
      const r = await mkRefund(c, { orderId: f.order.id, paymentId: f.payment.id }, { total_amount: 60000 });
      await f.add(r.id, f.item1.id, 60000);
      await checkAtCommit(c);
      await expectCommitError(c, () => f.add(r.id, f.item2.id, 40000), seatTotal);

      const excess = await mkPayment(c, f.order.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000 });
      const e = await mkRefund(c, { orderId: f.order.id, paymentId: excess.id }, { refund_type: "PAYMENT_EXCESS" });
      await checkAtCommit(c); // without items it is fine
      await expectCommitError(c, () => f.add(e.id, f.item2.id, 100000), excessItems);
    }));

  it("the total cannot be edited to dodge the rule (total_amount is immutable), and items cannot be edited or removed (append-only)", () =>
    db.rolledBack(async (c) => {
      const f = await base(c);
      const r = await mkRefund(c, { orderId: f.order.id, paymentId: f.payment.id }, { total_amount: 60000 });
      const i1 = await f.add(r.id, f.item1.id, 60000);
      await expectDbError(c, `UPDATE refunds SET total_amount = 100000 WHERE id = $1`, [r.id], { code: PG.restrictViolation, constraint: DB_CONSTRAINT.refundCoreImmutable });
      await expectDbError(c, `UPDATE refund_items SET amount = 1 WHERE id = $1`, [i1.id], { code: PG.restrictViolation });
      await expectDbError(c, `DELETE FROM refund_items WHERE id = $1`, [i1.id], { code: PG.restrictViolation });
      await checkAtCommit(c);
    }));

  it("really committed: a consistent refund commits, an inconsistent one fails AT COMMIT and leaves nothing behind", async () => {
    const setup = await db.pool.connect();
    let f: Awaited<ReturnType<typeof base>>;
    try {
      await setup.query("BEGIN");
      f = await base(setup);
      await setup.query("COMMIT");
    } finally {
      setup.release();
    }

    // consistent: refund first, items after, one transaction
    const good = await db.pool.connect();
    let goodRefund: Record<string, unknown>;
    try {
      await good.query("BEGIN");
      goodRefund = await mkRefund(good, { orderId: f.order.id, paymentId: f.payment.id }, { total_amount: 100000 });
      await insert(good, "refund_items", { refund_id: goodRefund.id, order_id: f.order.id, order_item_id: f.item1.id, amount: 60000 });
      await insert(good, "refund_items", { refund_id: goodRefund.id, order_id: f.order.id, order_item_id: f.item2.id, amount: 40000 });
      await good.query("COMMIT");
    } finally {
      good.release();
    }
    expect(await row(db, "refunds", goodRefund.id as string)).toMatchObject({ total_amount: "100000" });

    // inconsistent: the COMMIT is refused and nothing is persisted
    const bad = await db.pool.connect();
    let badId = "";
    try {
      await bad.query("BEGIN");
      const r = await mkRefund(bad, { orderId: f.order.id, paymentId: f.payment.id }, { total_amount: 100000 });
      badId = r.id as string;
      await insert(bad, "refund_items", { refund_id: r.id, order_id: f.order.id, order_item_id: f.item1.id, amount: 60000 });
      await expect(bad.query("COMMIT")).rejects.toMatchObject({ code: PG.checkViolation, constraint: DB_CONSTRAINT.refundSeatItemsTotal });
    } finally {
      await bad.query("ROLLBACK").catch(() => undefined); // a failed COMMIT already ended the transaction
      bad.release();
    }
    expect((await db.query(`SELECT count(*)::int n FROM refunds WHERE id = $1`, [badId])).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int n FROM refund_items WHERE refund_id = $1`, [badId])).rows[0].n).toBe(0);

    // an autocommit item that would break an existing, committed refund is refused by its own COMMIT
    await expect(
      db.query(`INSERT INTO refund_items (refund_id, order_id, order_item_id, amount) VALUES ($1, $2, $3, 1)`, [goodRefund.id, f.order.id, f.item1.id]),
    ).rejects.toMatchObject({ code: PG.uniqueViolation }); // (refund, item) is unique: use a new item instead
    const item3 = await mkOrderItem(db, { orderId: f.order.id, sessionId: f.w.s1.id, sessionSeatId: f.w.s1c.id });
    await expect(
      db.query(`INSERT INTO refund_items (refund_id, order_id, order_item_id, amount) VALUES ($1, $2, $3, 1)`, [goodRefund.id, f.order.id, item3.id]),
    ).rejects.toMatchObject({ code: PG.checkViolation, constraint: DB_CONSTRAINT.refundSeatItemsTotal });
    expect((await db.query(`SELECT count(*)::int n FROM refund_items WHERE refund_id = $1`, [goodRefund.id])).rows[0].n).toBe(2);
  });

  it("INSERT-level sanity: a refund of an unknown type is still refused by its CHECK before any deferred rule", () =>
    db.rolledBack(async (c) => {
      const f = await base(c);
      await expectInsertError(c, () => mkRefund(c, { orderId: f.order.id, paymentId: f.payment.id }, { refund_type: "OTHER" }), { code: PG.checkViolation });
    }));
});
