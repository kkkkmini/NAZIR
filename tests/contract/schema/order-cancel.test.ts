/**
 * CN-01~CN-14 (Step 5, DATABASE §11.5, API §4.5) — cancellation and rebooking against a REAL PostgreSQL through the
 * HTTP handler and the booking runner: authorization, idempotency, payment-state protection, races with expiry,
 * with other cancellations and with new orders, rebooking with a new key, and atomicity.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { PrismaClient } from "../../../src/generated/prisma/client";
import { loadDbPoolConfig } from "../../../src/server/config/db-pool-config";
import { buildPgPoolConfig } from "../../../src/server/db/pg-adapter";
import { handleCancelOrder } from "../../../src/server/booking/cancel-route";
import { cancelOrder, expireOrder } from "../../../src/server/booking/order-lifecycle";
import { BINDING_COOKIE, IDENTITY_SESSION_COOKIE } from "../../../src/server/lib/cookies";
import { sha256Hex } from "../../../src/server/lib/crypto/hmac";
import { issueCsrfToken } from "../../../src/server/lib/csrf";
import { loadSecurityConfig } from "../../../src/server/lib/secrets";
import { bookingFixtures, type BookingPerson } from "./helpers/booking";
import { confirmOrder, mkPayment } from "./helpers/fixtures";
import { cloneTestDb, destroyTestDb, resolveTestServer, type TestDb } from "./helpers/pg";

const server = resolveTestServer();
const ORIGIN = "http://localhost:3000";
const security = loadSecurityConfig({ NAZIR_APP_ORIGIN: ORIGIN, NAZIR_CSRF_KEYS: `v1:${randomBytes(32).toString("base64url")}`, NAZIR_CSRF_KEY_CURRENT: "v1" }, "test");
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

function cancelReq(p: BookingPerson | null, orderId: string, o: { origin?: string; csrf?: string | null; body?: string; token?: string } = {}) {
  const h = new Headers();
  if (p) h.set("cookie", `${BINDING_COOKIE}=${p.binding}; ${IDENTITY_SESSION_COOKIE}=${o.token ?? p.token}`);
  h.set("origin", o.origin ?? ORIGIN);
  const csrf = o.csrf === undefined ? (p ? issueCsrfToken(security.csrfKeys, p.binding) : null) : o.csrf;
  if (csrf) h.set("x-csrf-token", csrf);
  return handleCancelOrder(new Request(`${ORIGIN}/api/v1/orders/${orderId}/cancel`, { method: "POST", headers: h, body: o.body ?? "" }), { orderId }, { security: () => security, tx: () => fx.txDeps() });
}
const http = async (r: Promise<Response>) => {
  const res = await r;
  const body = await res.json();
  return { status: res.status, body, code: body?.error?.code };
};
const direct = (p: BookingPerson, orderId: string) => cancelOrder(fx.txDeps(), orderId, { tokenHash: sha256Hex(p.token), bindingHash: sha256Hex(p.binding) });

async function pending(seats = 2) {
  const w = await fx.world();
  const p = await fx.person();
  const r = await fx.createFor(p, w, w.seats.slice(0, seats));
  return { w, p, orderId: r.body.orderId, number: r.body.orderNumber, total: r.body.totalAmount };
}

describe("CN cancellation", () => {
  it("CN-01 PENDING: 200 CANCELED; holds RELEASED (USER_CANCELED), counter -n, logs, outbox v2, READY payment CANCELED", async () => {
    const { p, orderId, number, total } = await pending(2);
    const pay = await mkPayment(db, orderId, { status: "READY", requested_amount: total });
    const r = await http(cancelReq(p, orderId));
    expect(r).toEqual({ status: 200, body: { orderId, orderNumber: number, status: "CANCELED" }, code: undefined });
    expect(await fx.state(orderId)).toEqual({
      status: "CANCELED",
      closed: true,
      holds: ["RELEASED", "RELEASED"],
      counted: 0,
      logs: ["PENDING:API", "CANCELED:API"],
      outbox: ["ORDER_CREATED:1", "ORDER_CANCELED:2"],
    });
    const [h] = await fx.q(`SELECT bool_and(released_reason = 'USER_CANCELED' AND ended_at IS NOT NULL) AS ok FROM seat_holds WHERE order_id = $1`, [orderId]);
    expect(h.ok).toBe(true);
    expect(await fx.q(`SELECT p.status, l.source FROM payments p JOIN payment_status_logs l ON l.payment_id = p.id WHERE p.id = $1`, [pay.id])).toEqual([{ status: "CANCELED", source: "API" }]);
  });

  it("CN-02 cancelling again is an idempotent 200 with the same state and no second write", async () => {
    const { p, orderId } = await pending(1);
    await http(cancelReq(p, orderId));
    const after = await fx.state(orderId);
    for (let i = 0; i < 2; i++) expect((await http(cancelReq(p, orderId))).body.status).toBe("CANCELED");
    expect(await fx.state(orderId)).toEqual(after);
  });

  it("CN-03 refused without changing anything: other person 404, no session 401, copied session 401, CSRF 403, bad id 400, body 400", async () => {
    const { p, orderId } = await pending(1);
    const before = await fx.state(orderId);
    expect((await http(cancelReq(await fx.person(), orderId))).code).toBe("NOT_FOUND");
    expect((await http(cancelReq(null, orderId))).code).toBe("BROWSER_BINDING_REQUIRED");
    expect((await http(cancelReq({ ...p, token: randomBytes(32).toString("base64url") }, orderId))).code).toBe("IDENTITY_SESSION_REQUIRED");
    const otherBrowser = { ...p, binding: randomBytes(32).toString("base64url") };
    expect((await http(cancelReq(otherBrowser, orderId))).code).toBe("BROWSER_BINDING_MISMATCH");
    expect((await http(cancelReq(p, orderId, { origin: "https://evil.example" }))).code).toBe("CSRF_REJECTED");
    expect((await http(cancelReq(p, orderId, { csrf: null }))).code).toBe("CSRF_REJECTED");
    expect((await http(cancelReq(p, "not-a-uuid"))).code).toBe("VALIDATION_FAILED");
    expect((await http(cancelReq(p, orderId, { body: '{"seat":"x"}' }))).code).toBe("VALIDATION_FAILED");
    expect((await http(cancelReq(p, randomUUID()))).code).toBe("NOT_FOUND");
    expect(await fx.state(orderId)).toEqual(before);
  });

  it("CN-03b a LOOKUP session cannot cancel (403)", async () => {
    const { p, orderId } = await pending(1);
    const token = randomBytes(32).toString("base64url");
    await fx.q(`UPDATE identity_sessions SET status = 'REVOKED', revoked_at = now() WHERE id = $1`, [p.sessionId]);
    await fx.q(
      `WITH v AS (INSERT INTO identity_verifications (purpose, provider, provider_transaction_id, browser_binding_hash, state_nonce_hash, status, identity_subject_id, expires_at, verified_at)
                  VALUES ('LOOKUP','MOCK',$1,$2,$3,'CONSUMED',$4, now() + interval '10 min', now()) RETURNING id)
       INSERT INTO identity_sessions (identity_verification_id, identity_subject_id, purpose, token_hash, browser_binding_hash, status, expires_at)
       SELECT v.id, $4, 'LOOKUP', $5, $2, 'ACTIVE', now() + interval '10 min' FROM v`,
      [`t-${randomUUID()}`, sha256Hex(p.binding), `n-${randomUUID()}`, p.subjectId, sha256Hex(token)],
    );
    expect((await http(cancelReq({ ...p, token }, orderId))).code).toBe("SESSION_PURPOSE_MISMATCH");
    expect((await fx.state(orderId)).status).toBe("PENDING");
  });

  it("CN-04 a PENDING order whose hold already ran out is ended as EXPIRED (not CANCELED), once", async () => {
    const { p, orderId } = await pending(2);
    await fx.makeDue(orderId);
    expect((await http(cancelReq(p, orderId))).body.status).toBe("EXPIRED");
    expect(await fx.state(orderId)).toMatchObject({ status: "EXPIRED", holds: ["EXPIRED", "EXPIRED"], counted: 0, logs: ["PENDING:API", "EXPIRED:API"] });
  });

  it("CN-05 an order already expired by the job: 200 EXPIRED, nothing written", async () => {
    const { p, orderId } = await pending(1);
    await fx.makeDue(orderId);
    await expireOrder(fx.txDeps(), orderId);
    const after = await fx.state(orderId);
    expect((await http(cancelReq(p, orderId))).body.status).toBe("EXPIRED");
    expect(await fx.state(orderId)).toEqual(after);
  });

  it.each([["PAYMENT_CONFIRMING", "CONFIRMING"], ["PAYMENT_UNKNOWN", "UNKNOWN"], ["REVIEW_REQUIRED", "UNKNOWN"]])("CN-06 %s → 409 PAYMENT_IN_PROGRESS, nothing released", async (status, payStatus) => {
    const { p, orderId, total } = await pending(1);
    await mkPayment(db, orderId, { status: payStatus, requested_amount: total });
    await fx.q(`UPDATE seat_holds SET status = 'CONFIRMING' WHERE order_id = $1`, [orderId]);
    await fx.q(`UPDATE orders SET status = $2, confirm_protected_until = now() + interval '1 minute' WHERE id = $1`, [orderId, status]);
    const before = await fx.state(orderId);
    expect(await http(cancelReq(p, orderId))).toMatchObject({ status: 409, code: "PAYMENT_IN_PROGRESS" });
    expect(await fx.state(orderId)).toEqual(before);
  });

  it("CN-06b PAID → 409 INVALID_STATE_TRANSITION (refunds are an admin procedure), nothing changed", async () => {
    const { p, orderId, total } = await pending(1);
    await fx.q(`UPDATE seat_holds SET status = 'CONVERTED', ended_at = now() WHERE order_id = $1`, [orderId]);
    const [o] = await fx.q(`SELECT * FROM orders WHERE id = $1`, [orderId]);
    const c = await db.pool.connect();
    try {
      await c.query("BEGIN");
      await confirmOrder(c, { ...o, total_amount: total });
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    const before = await fx.state(orderId);
    expect(await http(cancelReq(p, orderId))).toMatchObject({ status: 409, code: "INVALID_STATE_TRANSITION" });
    expect(await fx.state(orderId)).toEqual(before);
    expect(before.status).toBe("PAID");
  });

  it("CN-07 an inconsistent PENDING order (CONFIRMING payment) is not cancelled: 409, untouched", async () => {
    quiet();
    const { p, orderId, total } = await pending(1);
    await mkPayment(db, orderId, { status: "CONFIRMING", requested_amount: total });
    const before = await fx.state(orderId);
    expect((await http(cancelReq(p, orderId))).code).toBe("PAYMENT_IN_PROGRESS");
    expect(await fx.state(orderId)).toEqual(before);
  });

  it("CN-08 five concurrent cancellations: one transition, all answer CANCELED, counter decremented once", async () => {
    const { p, orderId } = await pending(3);
    const res = await Promise.all(Array.from({ length: 5 }, () => direct(p, orderId)));
    expect(res.every((r) => r.status === "CANCELED")).toBe(true);
    expect(await fx.state(orderId)).toMatchObject({ counted: 0, logs: ["PENDING:API", "CANCELED:API"], outbox: ["ORDER_CREATED:1", "ORDER_CANCELED:2"] });
  });

  it("CN-09 cancellation vs expiry at the same time (20 orders): each order ends exactly once, counter exact", async () => {
    for (let i = 0; i < 20; i++) {
      const { p, orderId } = await pending(2);
      if (i % 2 === 0) await fx.makeDue(orderId); // half due (both paths EXPIRE), half not due (cancel wins, expiry not_due)
      const [c, e] = await Promise.all([direct(p, orderId), expireOrder(fx.txDeps(), orderId)]);
      const st = await fx.state(orderId);
      expect(st.logs.filter((l: string) => !l.startsWith("PENDING"))).toHaveLength(1);
      expect(st.counted).toBe(0);
      expect(c.status).toBe(st.status);
      if (i % 2 === 0) expect(st.status).toBe("EXPIRED");
      else expect([st.status, e.kind]).toEqual(["CANCELED", e.kind === "not_due" ? "not_due" : "not_pending"]);
    }
  });

  it("CN-10 rebooking: cancel, then a NEW key for other seats → new order; the old one stays CANCELED and unreferenced", async () => {
    const { w, p, orderId } = await pending(2);
    await direct(p, orderId);
    const r = await fx.createFor(p, w, [w.seats[3]]);
    expect(r.status).toBe(201);
    expect(r.body.orderId).not.toBe(orderId);
    expect((await fx.state(orderId)).status).toBe("CANCELED");
    expect((await fx.state(r.body.orderId)).counted).toBe(1);
    // the old seats are bookable by someone else too
    expect((await fx.createFor(await fx.person(), w, [w.seats[0], w.seats[1]])).status).toBe(201);
  });

  it("CN-11 rebooking fails (the seat was taken meanwhile): the cancellation stands, nothing is restored", async () => {
    const { w, p, orderId } = await pending(1);
    await direct(p, orderId);
    await fx.createFor(await fx.person(), w, [w.seats[0]]);
    const e = await fx.createFor(p, w, [w.seats[0]]).catch((x) => x);
    expect(e.code).toBe("SEAT_UNAVAILABLE");
    expect(await fx.state(orderId)).toMatchObject({ status: "CANCELED", counted: 0 });
  });

  it("CN-12 rebooking with the ORIGINAL key replays the original response (idempotency): a rebooking must use a new key", async () => {
    const w = await fx.world();
    const p = await fx.person();
    const key = randomUUID();
    const first = await fx.createFor(p, w, [w.seats[0]], { key });
    await direct(p, first.body.orderId);
    const replay = await fx.createFor(p, w, [w.seats[0]], { key });
    expect([replay.replayed, replay.body.orderId]).toEqual([true, first.body.orderId]);
    expect(replay.body.status).toBe("PENDING"); // the stored snapshot of the creation response, not the current state
    expect(replay.access).not.toBeNull(); // cancellation does not revoke the confirmation-view access session
    expect((await fx.state(first.body.orderId)).status).toBe("CANCELED");
  });

  it("CN-13 a failure inside the cancellation (outbox insert) rolls everything back", async () => {
    quiet();
    const { p, orderId, total } = await pending(2);
    const pay = await mkPayment(db, orderId, { status: "READY", requested_amount: total });
    const before = await fx.state(orderId);
    await fx.q(`CREATE FUNCTION cn13() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'x' USING ERRCODE = 'P0001'; END $$`);
    await fx.q(`CREATE TRIGGER cn13 BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION cn13()`);
    try {
      expect((await http(cancelReq(p, orderId))).status).toBe(500);
    } finally {
      await fx.q(`DROP TRIGGER cn13 ON outbox_events`);
      await fx.q(`DROP FUNCTION cn13()`);
    }
    expect(await fx.state(orderId)).toEqual(before);
    expect((await fx.q(`SELECT status FROM payments WHERE id = $1`, [pay.id]))[0].status).toBe("READY");
  });

  it("CN-14 cancellation and a new order of the same subject at the same time (10 rounds): counter always = live holds", async () => {
    for (let i = 0; i < 10; i++) {
      const { w, p, orderId } = await pending(2);
      const [, created] = await Promise.all([direct(p, orderId), fx.createFor(p, w, [w.seats[3]]).then((r) => r.status, (e) => e.code)]);
      expect([201, "ACTIVE_ORDER_EXISTS"]).toContain(created);
      const [x] = await fx.q(
        `SELECT q.counted_seats AS counted, (SELECT count(*)::int FROM seat_holds h JOIN orders o ON o.id = h.order_id WHERE o.identity_subject_id = $1 AND h.status = 'ACTIVE') AS live
           FROM purchase_quotas q WHERE q.identity_subject_id = $1`,
        [p.subjectId],
      );
      expect(x.counted).toBe(x.live);
      expect((await fx.state(orderId)).status).toBe("CANCELED");
    }
  });
});
