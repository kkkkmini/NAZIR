/**
 * JOB-01~JOB-07 (Step 5, ARCHITECTURE §8) — the periodic expiry job against a REAL PostgreSQL: batch bounds, concurrent
 * runs, CONFIRMING never touched, per-order error isolation, no personal data in logs, and the authenticated route.
 */
import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { PrismaClient } from "../../../src/generated/prisma/client";
import { loadDbPoolConfig } from "../../../src/server/config/db-pool-config";
import { buildPgPoolConfig } from "../../../src/server/db/pg-adapter";
import { runExpiryBatch } from "../../../src/server/booking/expiry-job";
import { handleExpireOrdersJob } from "../../../src/server/booking/expiry-job-route";
import { bookingFixtures } from "./helpers/booking";
import { mkPayment } from "./helpers/fixtures";
import { cloneTestDb, destroyTestDb, resolveTestServer, type TestDb } from "./helpers/pg";

const server = resolveTestServer();
let db: TestDb;
let prisma: PrismaClient;
let fx: ReturnType<typeof bookingFixtures>;
let logs: string[] = [];
beforeAll(async () => {
  db = await cloneTestDb(server, inject("templateDb"));
  prisma = new PrismaClient({ adapter: new PrismaPg(buildPgPoolConfig(db.url, "DATABASE_URL", { ...loadDbPoolConfig({}, "test"), poolMax: 20 })) });
  fx = bookingFixtures(db, () => prisma);
});
afterAll(async () => {
  await prisma.$disconnect();
  await destroyTestDb(db);
});
afterEach(() => {
  vi.restoreAllMocks();
  logs = [];
});
const capture = () => {
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
};
/** Ends every PENDING order still around from earlier tests, so each test counts only its own candidates. */
const drain = async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  await fx.q(`UPDATE orders SET hold_expires_at = now() - interval '1 second' WHERE status = 'PENDING'`);
  while ((await runExpiryBatch(fx.txDeps(), 500)).scanned > 0);
  vi.restoreAllMocks();
};

async function orders(n: number, o: { due?: boolean } = {}) {
  const w = await fx.world({ prices: Array(n).fill(100000) });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await fx.createFor(await fx.person(), w, [w.seats[i]]);
    if (o.due !== false) await fx.makeDue(r.body.orderId);
    ids.push(r.body.orderId);
  }
  return { w, ids };
}

describe("JOB periodic expiry", () => {
  it("JOB-01 expires due PENDING orders only; not-due and CONFIRMING orders are untouched", async () => {
    await drain();
    capture();
    const due = await orders(5);
    const fresh = await orders(2, { due: false });
    const c = await orders(1);
    await mkPayment(db, c.ids[0], { status: "CONFIRMING", requested_amount: 100000 });
    await fx.q(`UPDATE seat_holds SET status = 'CONFIRMING' WHERE order_id = $1`, [c.ids[0]]);
    await fx.q(`UPDATE orders SET status = 'PAYMENT_CONFIRMING', confirm_protected_until = now() - interval '1 minute' WHERE id = $1`, [c.ids[0]]);
    const s = await runExpiryBatch(fx.txDeps(), 100);
    expect(s).toEqual({ scanned: 5, expired: 5, releasedSeats: 5, alreadyEnded: 0, notDue: 0, needsReview: 0, failed: 0 });
    for (const id of due.ids) expect((await fx.state(id)).logs).toEqual(["PENDING:API", "EXPIRED:EXPIRY_JOB"]);
    for (const id of fresh.ids) expect((await fx.state(id)).status).toBe("PENDING");
    expect(await fx.state(c.ids[0])).toMatchObject({ status: "PAYMENT_CONFIRMING", holds: ["CONFIRMING"] });
  });

  it("JOB-02 the batch size bounds one run; the next run continues where it stopped", async () => {
    await drain();
    capture();
    await orders(5);
    expect((await runExpiryBatch(fx.txDeps(), 2)).expired).toBe(2);
    expect((await runExpiryBatch(fx.txDeps(), 2)).expired).toBe(2);
    expect((await runExpiryBatch(fx.txDeps(), 2)).expired).toBe(1);
    expect((await runExpiryBatch(fx.txDeps(), 2)).scanned).toBe(0);
    await expect(runExpiryBatch(fx.txDeps(), 0)).rejects.toThrow();
    await expect(runExpiryBatch(fx.txDeps(), 501)).rejects.toThrow();
  });

  it("JOB-03 four concurrent runs over the same candidates: every order expired exactly once", async () => {
    await drain();
    capture();
    const { ids } = await orders(8);
    const runs = await Promise.all(Array.from({ length: 4 }, () => runExpiryBatch(fx.txDeps(), 100)));
    expect(runs.reduce((a, r) => a + r.expired, 0)).toBe(8);
    expect(runs.reduce((a, r) => a + r.failed, 0)).toBe(0);
    for (const id of ids) expect((await fx.state(id)).logs).toEqual(["PENDING:API", "EXPIRED:EXPIRY_JOB"]);
    const [q] = await fx.q(`SELECT coalesce(sum(counted_seats), 0)::int AS n FROM purchase_quotas q JOIN orders o ON o.identity_subject_id = q.identity_subject_id AND o.show_session_id = q.show_session_id WHERE o.id = ANY($1::uuid[])`, [ids]);
    expect(q.n).toBe(0);
  });

  it("JOB-04 one order fails: the others are expired, the failure is counted and retried by the next run", async () => {
    await drain();
    capture();
    const { ids } = await orders(3);
    const bad = ids[1];
    await fx.q(`CREATE FUNCTION job04() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.id = '${bad}'::uuid THEN RAISE EXCEPTION 'x' USING ERRCODE = 'P0001'; END IF; RETURN NEW; END $f$`);
    await fx.q(`CREATE TRIGGER job04 BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION job04()`);
    try {
      expect(await runExpiryBatch(fx.txDeps(), 100)).toMatchObject({ scanned: 3, expired: 2, failed: 1 });
      expect((await fx.state(bad)).status).toBe("PENDING");
      expect(logs.join("\n")).toContain(`order=${bad} failed: INTERNAL_ERROR`);
    } finally {
      await fx.q(`DROP TRIGGER job04 ON orders`);
      await fx.q(`DROP FUNCTION job04()`);
    }
    expect(await runExpiryBatch(fx.txDeps(), 100)).toMatchObject({ scanned: 1, expired: 1, failed: 0 });
  });

  it("JOB-05 logs carry counts, ids and codes only — no names, phones, tokens", async () => {
    await drain();
    capture();
    await orders(2);
    await runExpiryBatch(fx.txDeps(), 100);
    expect(logs.join("\n")).not.toMatch(/홍길동|01012345678|token|binding/i);
  });

  it("JOB-06 the route: correct Bearer → 200 summary (no-store); wrong / missing → 401; no secret → 503; neither of the last two runs the job", async () => {
    await drain();
    capture();
    const secret = randomBytes(32).toString("base64url");
    const deps = (s: string | undefined) => ({ cronSecret: () => s, tx: () => fx.txDeps() });
    const { ids } = await orders(2);
    const call = (auth: string | null, s: string | undefined) =>
      handleExpireOrdersJob(new Request("http://localhost:3000/api/v1/internal/jobs/expire-orders", { headers: auth ? { authorization: auth } : {} }), deps(s));
    const unauthorized = await call("Bearer nope", secret);
    expect([unauthorized.status, (await unauthorized.json()).error.code]).toEqual([401, "JOB_UNAUTHORIZED"]);
    expect((await call(null, secret)).status).toBe(401);
    const unavailable = await call(`Bearer ${secret}`, undefined);
    expect([unavailable.status, (await unavailable.json()).error.code]).toEqual([503, "JOB_UNAVAILABLE"]);
    for (const id of ids) expect((await fx.state(id)).status).toBe("PENDING"); // nothing ran
    const ok = await call(`Bearer ${secret}`, secret);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.json()).toMatchObject({ scanned: 2, expired: 2, failed: 0 });
    expect(logs.join("\n")).not.toContain(secret);
  });

  it("JOB-07 the job and a cancellation-style competing writer on the same subject serialise on the quota row", async () => {
    await drain();
    capture();
    const { ids } = await orders(1);
    const [o] = await fx.q(`SELECT identity_subject_id, show_session_id FROM orders WHERE id = $1`, [ids[0]]);
    const holder = await db.pool.connect();
    await holder.query("BEGIN");
    await holder.query(`SELECT 1 FROM purchase_quotas WHERE identity_subject_id = $1 AND show_session_id = $2 FOR UPDATE`, [o.identity_subject_id, o.show_session_id]);
    const run = runExpiryBatch(fx.txDeps(), 100);
    await new Promise((r) => setTimeout(r, 200));
    expect((await fx.state(ids[0])).status).toBe("PENDING"); // waiting on the quota lock
    await holder.query("ROLLBACK");
    holder.release();
    expect((await run).expired).toBe(1);
  });
});
