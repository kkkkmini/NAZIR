/**
 * EX-01~EX-12 (Step 5, DATABASE §11.4) — expireOrder against a REAL PostgreSQL 16 through the Prisma adapter and the
 * booking runner. Orders are created by the real createOrder; "waiting 7 minutes" is moving hold_expires_at back.
 */
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { PrismaClient } from "../../../src/generated/prisma/client";
import { loadDbPoolConfig } from "../../../src/server/config/db-pool-config";
import { buildPgPoolConfig } from "../../../src/server/db/pg-adapter";
import { expireOrder } from "../../../src/server/booking/order-lifecycle";
import { bookingFixtures } from "./helpers/booking";
import { mkPayment } from "./helpers/fixtures";
import { cloneTestDb, destroyTestDb, resolveTestServer, type TestDb } from "./helpers/pg";

const server = resolveTestServer();
let db: TestDb;
let prisma: PrismaClient;
let fx: ReturnType<typeof bookingFixtures>;
beforeAll(async () => {
  db = await cloneTestDb(server, inject("templateDb"));
  prisma = new PrismaClient({ adapter: new PrismaPg(buildPgPoolConfig(db.url, "DATABASE_URL", { ...loadDbPoolConfig({}, "test"), poolMax: 20 })) });
  fx = bookingFixtures(db, () => prisma);
});
afterAll(async () => {
  await prisma.$disconnect();
  await destroyTestDb(db);
});
afterEach(() => vi.restoreAllMocks());
const quiet = () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
};

async function pending(seats = 2) {
  const w = await fx.world();
  const p = await fx.person();
  const r = await fx.createFor(p, w, w.seats.slice(0, seats));
  return { w, p, orderId: r.body.orderId, total: r.body.totalAmount };
}

describe("EX expireOrder", () => {
  it("EX-01 a due PENDING order: holds EXPIRED, order EXPIRED, counter -n, status log, outbox v2; the seats can be booked again", async () => {
    const { w, orderId } = await pending(2);
    await fx.makeDue(orderId);
    expect(await expireOrder(fx.txDeps(), orderId)).toEqual({ kind: "expired", orderId, seats: 2 });
    expect(await fx.state(orderId)).toEqual({
      status: "EXPIRED",
      closed: true,
      holds: ["EXPIRED", "EXPIRED"],
      counted: 0,
      logs: ["PENDING:API", "EXPIRED:EXPIRY_JOB"],
      outbox: ["ORDER_CREATED:1", "ORDER_EXPIRED:2"],
    });
    const [s] = await fx.q(`SELECT array_agg(DISTINCT status) AS st FROM session_seats WHERE id = ANY($1::uuid[])`, [w.seats.slice(0, 2)]);
    expect(s.st).toEqual(["AVAILABLE"]);
    const [h] = await fx.q(`SELECT bool_and(ended_at IS NOT NULL AND released_reason IS NULL) AS ok FROM seat_holds WHERE order_id = $1`, [orderId]);
    expect(h.ok).toBe(true);
    const again = await fx.createFor(await fx.person(), w, w.seats.slice(0, 2));
    expect(again.status).toBe(201);
  });

  it("EX-02 before hold_expires_at (DB time): nothing happens", async () => {
    const { orderId } = await pending(1);
    const before = await fx.state(orderId);
    expect(await expireOrder(fx.txDeps(), orderId)).toEqual({ kind: "not_due", orderId });
    expect(await fx.state(orderId)).toEqual(before);
  });

  it("EX-03 already EXPIRED / run twice / unknown id: no second decrement, no second log or event", async () => {
    const { orderId } = await pending(2);
    await fx.makeDue(orderId);
    await expireOrder(fx.txDeps(), orderId);
    const after = await fx.state(orderId);
    expect(await expireOrder(fx.txDeps(), orderId)).toEqual({ kind: "not_pending", orderId, status: "EXPIRED" });
    expect(await expireOrder(fx.txDeps(), orderId)).toEqual({ kind: "not_pending", orderId, status: "EXPIRED" });
    expect(await fx.state(orderId)).toEqual(after);
    const ghost = randomUUID();
    expect(await expireOrder(fx.txDeps(), ghost)).toEqual({ kind: "not_found", orderId: ghost });
  });

  it.each([["PAYMENT_CONFIRMING"], ["PAYMENT_UNKNOWN"]])("EX-04 %s (hold CONFIRMING, past every deadline) is never expired or released", async (status) => {
    const { orderId, total } = await pending(2);
    await mkPayment(db, orderId, { status: status === "PAYMENT_CONFIRMING" ? "CONFIRMING" : "UNKNOWN", requested_amount: total });
    await fx.q(`UPDATE seat_holds SET status = 'CONFIRMING', updated_at = now() WHERE order_id = $1`, [orderId]);
    await fx.q(`UPDATE orders SET status = $2, confirm_protected_until = now() - interval '1 minute', hold_expires_at = now() - interval '10 minutes' WHERE id = $1`, [orderId, status]);
    const before = await fx.state(orderId);
    expect(await expireOrder(fx.txDeps(), orderId)).toEqual({ kind: "not_pending", orderId, status });
    expect(await fx.state(orderId)).toEqual(before);
    expect(before.holds).toEqual(["CONFIRMING", "CONFIRMING"]);
  });

  it("EX-05 an inconsistent PENDING order (CONFIRMING payment, or a CONFIRMING hold) is left untouched and reported", async () => {
    quiet();
    const a = await pending(1);
    await mkPayment(db, a.orderId, { status: "CONFIRMING", requested_amount: a.total });
    await fx.makeDue(a.orderId);
    const beforeA = await fx.state(a.orderId);
    expect(await expireOrder(fx.txDeps(), a.orderId)).toEqual({ kind: "needs_review", orderId: a.orderId, reason: "payment_in_progress" });
    expect(await fx.state(a.orderId)).toEqual(beforeA);
    const b = await pending(1);
    await fx.q(`UPDATE seat_holds SET status = 'CONFIRMING' WHERE order_id = $1`, [b.orderId]);
    await fx.makeDue(b.orderId);
    expect(await expireOrder(fx.txDeps(), b.orderId)).toEqual({ kind: "needs_review", orderId: b.orderId, reason: "confirming_hold" });
    expect((await fx.state(b.orderId)).status).toBe("PENDING");
  });

  it("EX-06 a READY payment (checkout opened, never confirmed) is CANCELED in the same transaction, with its status log", async () => {
    const { orderId, total } = await pending(1);
    const pay = await mkPayment(db, orderId, { status: "READY", requested_amount: total });
    await fx.makeDue(orderId);
    expect((await expireOrder(fx.txDeps(), orderId)).kind).toBe("expired");
    const [p] = await fx.q(`SELECT status, canceled_at IS NOT NULL AS c FROM payments WHERE id = $1`, [pay.id]);
    expect(p).toEqual({ status: "CANCELED", c: true });
    const logs = await fx.q(`SELECT from_status, to_status, source FROM payment_status_logs WHERE payment_id = $1`, [pay.id]);
    expect(logs).toEqual([{ from_status: "READY", to_status: "CANCELED", source: "SYSTEM" }]);
  });

  it("EX-07 ten concurrent workers on the same order: exactly one expiry, counter decremented once", async () => {
    const { orderId } = await pending(3);
    await fx.makeDue(orderId);
    const res = await Promise.all(Array.from({ length: 10 }, () => expireOrder(fx.txDeps(), orderId)));
    expect(res.filter((r) => r.kind === "expired")).toEqual([{ kind: "expired", orderId, seats: 3 }]);
    expect(res.filter((r) => r.kind !== "expired")).toEqual(Array(9).fill({ kind: "not_pending", orderId, status: "EXPIRED" }));
    expect(await fx.state(orderId)).toMatchObject({ counted: 0, logs: ["PENDING:API", "EXPIRED:EXPIRY_JOB"], outbox: ["ORDER_CREATED:1", "ORDER_EXPIRED:2"] });
  });

  it("EX-08 the counter drops by exactly this order's seats (other counted seats of the subject stay)", async () => {
    const w = await fx.world();
    const p = await fx.person();
    const first = await fx.createFor(p, w, [w.seats[0], w.seats[1]]);
    await fx.q(`UPDATE seat_holds SET status = 'CONVERTED', ended_at = now() WHERE order_id = $1`, [first.body.orderId]); // stays counted
    await fx.q(`UPDATE orders SET status = 'EXPIRED', closed_at = now() WHERE id = $1`, [first.body.orderId]); // inactive (fixture)
    const second = await fx.createFor(p, w, [w.seats[2], w.seats[3]]);
    expect((await fx.state(second.body.orderId)).counted).toBe(4); // at the limit
    await fx.makeDue(second.body.orderId);
    await expireOrder(fx.txDeps(), second.body.orderId);
    expect((await fx.state(second.body.orderId)).counted).toBe(2);
  });

  it("EX-09 multi-seat (4 seats, the per-person maximum)", async () => {
    const { orderId } = await pending(4);
    await fx.makeDue(orderId);
    expect(await expireOrder(fx.txDeps(), orderId)).toEqual({ kind: "expired", orderId, seats: 4 });
    expect((await fx.state(orderId)).holds).toEqual(["EXPIRED", "EXPIRED", "EXPIRED", "EXPIRED"]);
  });

  it("EX-10 COMMIT fails (deferred trigger): the order stays PENDING with its holds and counter; a later run succeeds", async () => {
    quiet();
    const { orderId } = await pending(2);
    await fx.makeDue(orderId);
    const before = await fx.state(orderId);
    await fx.q(`CREATE FUNCTION ex10() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'x' USING ERRCODE = 'check_violation'; END $$`);
    await fx.q(`CREATE CONSTRAINT TRIGGER ex10 AFTER UPDATE ON orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ex10()`);
    try {
      const e = await expireOrder(fx.txDeps(), orderId).catch((x) => x);
      expect([e.code, e.status]).toEqual(["INTERNAL_ERROR", 500]);
    } finally {
      await fx.q(`DROP TRIGGER ex10 ON orders`);
      await fx.q(`DROP FUNCTION ex10()`);
    }
    expect(await fx.state(orderId)).toEqual(before);
    expect((await expireOrder(fx.txDeps(), orderId)).kind).toBe("expired");
  });

  it.each([
    ["the outbox insert", "BEFORE INSERT ON outbox_events"],
    ["the status log insert", "BEFORE INSERT ON order_status_logs"],
    ["the quota update", "BEFORE UPDATE ON purchase_quotas"],
    ["the hold update", "BEFORE UPDATE ON seat_holds"],
  ])("EX-11 %s fails: everything rolls back", async (_l, when) => {
    quiet();
    const { orderId, total } = await pending(2);
    const pay = await mkPayment(db, orderId, { status: "READY", requested_amount: total });
    await fx.makeDue(orderId);
    const before = await fx.state(orderId);
    const t = `ex11_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    await fx.q(`CREATE FUNCTION ${t}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'x' USING ERRCODE = 'P0001'; END $$`);
    await fx.q(`CREATE TRIGGER ${t} ${when} FOR EACH ROW EXECUTE FUNCTION ${t}()`);
    try {
      expect((await expireOrder(fx.txDeps(), orderId).catch((x) => x)).code).toBe("INTERNAL_ERROR");
    } finally {
      await fx.q(`DROP TRIGGER ${t} ON ${when.split(" ON ")[1]}`);
      await fx.q(`DROP FUNCTION ${t}()`);
    }
    expect(await fx.state(orderId)).toEqual(before);
    expect((await fx.q(`SELECT status FROM payments WHERE id = $1`, [pay.id]))[0].status).toBe("READY");
  });

  it("EX-12 lock order: expireOrder waits for a transaction holding the subject's quota row (quota → order), never the reverse", async () => {
    const { p, w, orderId } = await pending(1);
    await fx.makeDue(orderId);
    const holder = await db.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT 1 FROM purchase_quotas WHERE identity_subject_id = $1 AND show_session_id = $2 FOR UPDATE`, [p.subjectId, w.sessionId]);
      const e = await expireOrder(fx.txDeps({ lockTimeoutMs: 200 }, 1), orderId).catch((x) => x);
      quiet();
      expect(e.code).toBe("DATABASE_BUSY"); // waited on the quota row, did not lock the order first
      const [o] = await holder.query(`SELECT 1 FROM orders WHERE id = $1 FOR UPDATE NOWAIT`, [orderId]).then((r) => r.rows);
      expect(o).toBeDefined(); // the order row was not left locked
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });
});
