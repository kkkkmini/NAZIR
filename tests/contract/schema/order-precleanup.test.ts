/**
 * PC-01~PC-09 (Step 5, DATABASE §11.2 "사전 정리") — createOrder's pre-cleanup against a REAL PostgreSQL: due PENDING
 * orders that block the request are ended through expireOrder (own transaction each, ids sorted); CONFIRMING and live
 * orders are never touched; a failed cleanup leaves the main transaction conservative; races stay consistent.
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
const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => e?.code ?? String(e));

describe("PC pre-cleanup before a new order", () => {
  it("PC-01 the subject's own due PENDING order is expired first (source SYSTEM), so the new order is not blocked", async () => {
    const w = await fx.world();
    const p = await fx.person();
    const old = await fx.createFor(p, w, [w.seats[0], w.seats[1]]);
    await fx.makeDue(old.body.orderId);
    const r = await fx.createFor(p, w, [w.seats[2]]);
    expect(r.status).toBe(201);
    expect(await fx.state(old.body.orderId)).toMatchObject({ status: "EXPIRED", holds: ["EXPIRED", "EXPIRED"], logs: ["PENDING:API", "EXPIRED:SYSTEM"] });
    expect((await fx.state(r.body.orderId)).counted).toBe(1); // 2 released, 1 taken
  });

  it("PC-02 another subject's due order holding a requested seat is expired; the seat goes to the new order", async () => {
    const w = await fx.world();
    const a = await fx.createFor(await fx.person(), w, [w.seats[0]]);
    await fx.makeDue(a.body.orderId);
    const r = await fx.createFor(await fx.person(), w, [w.seats[0], w.seats[1]]);
    expect(r.status).toBe(201);
    expect((await fx.state(a.body.orderId)).status).toBe("EXPIRED");
  });

  it("PC-03 a holder whose hold is NOT due yet is untouched → 409", async () => {
    const w = await fx.world();
    const a = await fx.createFor(await fx.person(), w, [w.seats[0]]);
    const before = await fx.state(a.body.orderId);
    expect(await code(fx.createFor(await fx.person(), w, [w.seats[0]]))).toBe("SEAT_UNAVAILABLE");
    expect(await fx.state(a.body.orderId)).toEqual(before);
  });

  it("PC-04 a PAYMENT_CONFIRMING holder past every deadline is never cleaned → 409, holds stay CONFIRMING", async () => {
    const w = await fx.world();
    const a = await fx.createFor(await fx.person(), w, [w.seats[0]]);
    await mkPayment(db, a.body.orderId, { status: "CONFIRMING", requested_amount: a.body.totalAmount });
    await fx.q(`UPDATE seat_holds SET status = 'CONFIRMING' WHERE order_id = $1`, [a.body.orderId]);
    await fx.q(`UPDATE orders SET status = 'PAYMENT_CONFIRMING', confirm_protected_until = now() - interval '1 minute', hold_expires_at = now() - interval '9 minutes' WHERE id = $1`, [a.body.orderId]);
    expect(await code(fx.createFor(await fx.person(), w, [w.seats[0]]))).toBe("SEAT_UNAVAILABLE");
    expect(await fx.state(a.body.orderId)).toMatchObject({ status: "PAYMENT_CONFIRMING", holds: ["CONFIRMING"] });
  });

  it("PC-05 the cleanup fails: the request does not proceed on a guess — the seat stays unavailable, the own order still blocks; both recover later", async () => {
    quiet();
    const w = await fx.world();
    const holder = await fx.createFor(await fx.person(), w, [w.seats[0]]);
    const p = await fx.person();
    const own = await fx.createFor(p, w, [w.seats[1]]);
    await fx.makeDue(holder.body.orderId);
    await fx.makeDue(own.body.orderId);
    await fx.q(`CREATE FUNCTION pc05() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'EXPIRED' THEN RAISE EXCEPTION 'x' USING ERRCODE = 'P0001'; END IF; RETURN NEW; END $$`);
    await fx.q(`CREATE TRIGGER pc05 BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION pc05()`);
    try {
      expect(await code(fx.createFor(await fx.person(), w, [w.seats[0]]))).toBe("SEAT_UNAVAILABLE");
      expect(await code(fx.createFor(p, w, [w.seats[2]]))).toBe("ACTIVE_ORDER_EXISTS");
      expect((await fx.state(holder.body.orderId)).holds).toEqual(["ACTIVE"]);
    } finally {
      await fx.q(`DROP TRIGGER pc05 ON orders`);
      await fx.q(`DROP FUNCTION pc05()`);
    }
    expect((await fx.createFor(await fx.person(), w, [w.seats[0]])).status).toBe(201);
    expect((await fx.createFor(p, w, [w.seats[2]])).status).toBe(201);
  });

  it("PC-06 five subjects race for a seat held by a due order: the order is expired once, exactly one new order gets the seat", async () => {
    quiet();
    const w = await fx.world();
    const a = await fx.createFor(await fx.person(), w, [w.seats[0]]);
    await fx.makeDue(a.body.orderId);
    const people = await Promise.all(Array.from({ length: 5 }, () => fx.person()));
    const res = await Promise.all(people.map((p) => code(fx.createFor(p, w, [w.seats[0]]))));
    expect(res.filter((x) => x === "ok")).toHaveLength(1);
    expect(res.filter((x) => x !== "ok").every((x) => x === "SEAT_UNAVAILABLE")).toBe(true);
    expect((await fx.state(a.body.orderId)).logs).toEqual(["PENDING:API", "EXPIRED:SYSTEM"]);
    const [n] = await fx.q(`SELECT count(*)::int AS n FROM seat_holds WHERE session_seat_id = $1 AND status = 'ACTIVE'`, [w.seats[0]]);
    expect(n.n).toBe(1);
  });

  it("PC-07 pre-cleanup and the expiry worker on the same order at the same time: expired once, the new order consistent", async () => {
    const w = await fx.world();
    const a = await fx.createFor(await fx.person(), w, [w.seats[0], w.seats[1]]);
    await fx.makeDue(a.body.orderId);
    const [worker, created] = await Promise.all([expireOrder(fx.txDeps(), a.body.orderId), code(fx.createFor(await fx.person(), w, [w.seats[0]]))]);
    const st = await fx.state(a.body.orderId);
    expect(st.status).toBe("EXPIRED");
    expect(st.logs.filter((l: string) => l.startsWith("EXPIRED"))).toHaveLength(1);
    expect(["expired", "not_pending"]).toContain(worker.kind);
    // either the pre-cleanup expires it, or it waits on the worker's quota lock until the worker committed: the main
    // transaction always starts after the old holds are EXPIRED, so the request succeeds
    expect(created).toBe("ok");
    const [n] = await fx.q(`SELECT count(*)::int AS n FROM seat_holds WHERE session_seat_id = $1 AND status = 'ACTIVE'`, [w.seats[0]]);
    expect(n.n).toBe(1);
  });

  it("PC-08 two other due orders on two requested seats are both cleaned (sorted ids), then both seats are booked", async () => {
    const w = await fx.world();
    const a = await fx.createFor(await fx.person(), w, [w.seats[0]]);
    const b = await fx.createFor(await fx.person(), w, [w.seats[1]]);
    await fx.makeDue(a.body.orderId);
    await fx.makeDue(b.body.orderId);
    const r = await fx.createFor(await fx.person(), w, [w.seats[1], w.seats[0]]);
    expect(r.body.items).toHaveLength(2);
    expect([(await fx.state(a.body.orderId)).status, (await fx.state(b.body.orderId)).status]).toEqual(["EXPIRED", "EXPIRED"]);
  });

  it("PC-09 a request without a valid BOOKING session triggers no cleanup", async () => {
    const w = await fx.world();
    const a = await fx.createFor(await fx.person(), w, [w.seats[0]]);
    await fx.makeDue(a.body.orderId);
    const anon = { subjectId: randomUUID(), sessionId: randomUUID(), token: "x".repeat(43), binding: "y".repeat(43) };
    expect(await code(fx.createFor(anon, w, [w.seats[0]]))).toBe("IDENTITY_SESSION_REQUIRED");
    expect((await fx.state(a.body.orderId)).status).toBe("PENDING");
  });
});
