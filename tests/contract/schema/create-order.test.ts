/**
 * CO-01~CO-22 (Step 5, DATABASE §11.2, API §4.4) — createOrder against a REAL PostgreSQL 16 through the Prisma adapter
 * and the booking runner: rows written, DB prices, sales condition, session rules, seat states, idempotency replay and
 * access renewal, rate limits on the same transaction, concurrency, and fault injection at every write (rollback).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { PrismaClient } from "../../../src/generated/prisma/client";
import { loadDbPoolConfig } from "../../../src/server/config/db-pool-config";
import { buildPgPoolConfig } from "../../../src/server/db/pg-adapter";
import { accessCookieName, createOrder, parseCreateOrderBody, type CreateOrderDeps } from "../../../src/server/booking/create-order";
import { idempotencyKeyHash } from "../../../src/server/booking/idempotency";
import { DEFAULT_RETRY_POLICY } from "../../../src/server/booking/tx";
import { sha256Hex } from "../../../src/server/lib/crypto/hmac";
import { decryptPii, encryptPii } from "../../../src/server/lib/crypto/pii";
import { parseKeyring, type Keyring } from "../../../src/server/lib/secrets";
import { parsePolicyOverrides } from "../../../src/server/rate-limit/policies";
import { mkSeat, mkSessionSeat, mkSubject, mkVenue, insert } from "./helpers/fixtures";
import { cloneTestDb, destroyTestDb, resolveTestServer, type TestDb } from "./helpers/pg";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const server = resolveTestServer();
let db: TestDb;
let prisma: PrismaClient;
const ring = (p: string): Keyring => parseKeyring({ [`${p}_KEYS`]: `v1:${randomBytes(32).toString("base64url")}`, [`${p}_KEY_CURRENT`]: "v1" }, p, [])!;
const piiKeys = ring("PII");
const rlKeys = ring("RL");
const q = async <T = Row>(sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as T[];
let logs: string[] = [];

function deps(policies = "order.create.session=1000/1800,order.create.subject_session=1000/3600"): CreateOrderDeps {
  return {
    tx: {
      startTx: (fn, options) => prisma.$transaction((tx) => fn(tx), options),
      limits: { txMaxWaitMs: 10000, txTimeoutMs: 20000, statementTimeoutMs: 15000, lockTimeoutMs: 10000 },
      retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 3 },
    },
    piiKeys,
    rateLimit: { keys: rlKeys, policies: parsePolicyOverrides({ NAZIR_RATE_LIMIT_POLICIES: policies }) },
  };
}

beforeAll(async () => {
  db = await cloneTestDb(server, inject("templateDb"));
  prisma = new PrismaClient({ adapter: new PrismaPg(buildPgPoolConfig(db.url, "DATABASE_URL", { ...loadDbPoolConfig({}, "test"), poolMax: 20 })) });
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

interface World {
  sessionId: string;
  showId: string;
  seats: string[];
}
async function world(o: { show?: Row; session?: Row; prices?: number[] } = {}): Promise<World> {
  const v = await mkVenue(db);
  const show = await insert(db, "shows", { venue_id: v.id, title: "t", slug: `s-${randomUUID()}`, status: "PUBLISHED", ...o.show });
  const sess = await insert(db, "show_sessions", {
    show_id: show.id,
    venue_id: v.id,
    starts_at: new Date(Date.now() + 30 * 86400_000),
    ends_at: new Date(Date.now() + 30 * 86400_000 + 3 * 3600_000),
    sales_status: "ON_SALE",
    ...o.session,
  });
  const seats: string[] = [];
  for (const [i, price] of (o.prices ?? [110000, 150000, 110000, 90000, 90000, 90000]).entries()) {
    const seat = await mkSeat(db, v.id, { section_name: "R", row_label: "A", seat_number: String(i + 1) });
    seats.push((await mkSessionSeat(db, sess.id, seat.id, v.id, { price })).id);
  }
  return { sessionId: sess.id, showId: show.id, seats };
}

interface Person {
  subjectId: string;
  sessionId: string;
  token: string;
  binding: string;
}
async function person(o: { purpose?: "BOOKING" | "LOOKUP"; expiresInMs?: number; subjectId?: string; name?: string } = {}): Promise<Person> {
  const subjectId = o.subjectId ?? (await mkSubject(db)).id;
  const token = randomBytes(32).toString("base64url");
  const binding = randomBytes(32).toString("base64url");
  const purpose = o.purpose ?? "BOOKING";
  const [s] = await q(
    `WITH v AS (
       INSERT INTO identity_verifications (purpose, provider, provider_transaction_id, browser_binding_hash, state_nonce_hash, status, identity_subject_id, expires_at, verified_name, verified_phone, verified_at)
       VALUES ($1, 'MOCK', $2, $3, $4, 'CONSUMED', $5, now() + interval '10 min', $6, $7, now()) RETURNING id)
     INSERT INTO identity_sessions (identity_verification_id, identity_subject_id, purpose, token_hash, browser_binding_hash, status, expires_at)
     SELECT v.id, $5, $1, $8, $3, 'ACTIVE', now() + $9::int * interval '1 millisecond' FROM v RETURNING id`,
    [
      purpose,
      `t-${randomUUID()}`,
      sha256Hex(binding),
      `n-${randomUUID()}`,
      subjectId,
      encryptPii(piiKeys, "identity_verifications.verified_name", o.name ?? "홍길동"),
      encryptPii(piiKeys, "identity_verifications.verified_phone", "01012345678"),
      sha256Hex(token),
      o.expiresInMs ?? 30 * 60_000,
    ],
  );
  return { subjectId, sessionId: s.id, token, binding };
}

const order = (p: Person, w: World, seats: string[], key: string = randomUUID(), d: CreateOrderDeps = deps()) =>
  createOrder(d, {
    sessionTokenHash: sha256Hex(p.token),
    bindingHash: sha256Hex(p.binding),
    idempotencyKeyHash: idempotencyKeyHash(key),
    request: parseCreateOrderBody({ sessionId: w.sessionId, sessionSeatIds: seats }),
  });
const fail = (p: Promise<unknown>) => p.then(() => "ok", (e) => e?.code ?? String(e));

/** Everything the transaction could have written for this subject / these seats. */
async function footprint(p: Person, w: World) {
  const [r] = await q(
    `SELECT (SELECT count(*)::int FROM orders WHERE identity_subject_id = $1) AS orders,
            (SELECT count(*)::int FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.identity_subject_id = $1) AS items,
            (SELECT count(*)::int FROM seat_holds h JOIN orders o ON o.id = h.order_id WHERE o.identity_subject_id = $1 AND h.session_seat_id = ANY($2::uuid[]) AND h.status IN ('ACTIVE','CONFIRMING')) AS live_holds,
            (SELECT coalesce(sum(counted_seats), 0)::int FROM purchase_quotas WHERE identity_subject_id = $1) AS counted,
            (SELECT count(*)::int FROM order_access_sessions a JOIN orders o ON o.id = a.order_id WHERE o.identity_subject_id = $1) AS access,
            (SELECT count(*)::int FROM order_status_logs l JOIN orders o ON o.id = l.order_id WHERE o.identity_subject_id = $1) AS logs,
            (SELECT count(*)::int FROM outbox_events e JOIN orders o ON o.id = e.aggregate_id WHERE o.identity_subject_id = $1) AS outbox,
            (SELECT count(*)::int FROM idempotency_records WHERE resource_id IN (SELECT id FROM orders WHERE identity_subject_id = $1)) AS idem`,
    [p.subjectId, w.seats],
  );
  return r;
}
const EMPTY = { orders: 0, items: 0, live_holds: 0, counted: 0, access: 0, logs: 0, outbox: 0, idem: 0 };
const rlHits = async () => (await q<{ n: number }>(`SELECT coalesce(sum(count), 0)::int AS n FROM rate_limit_counters WHERE policy LIKE 'order.create.%'`))[0].n;

/** Ends an order like a cancellation would (fixture only: the cancel API is a later unit), so the subject may order again. */
async function endOrder(orderId: string) {
  await q(`UPDATE seat_holds SET status = 'RELEASED', released_reason = 'USER_CANCELED', ended_at = now(), updated_at = now() WHERE order_id = $1`, [orderId]);
  await q(
    `UPDATE purchase_quotas q SET counted_seats = counted_seats - (SELECT count(*) FROM order_items WHERE order_id = $1), updated_at = now()
       FROM orders o WHERE o.id = $1 AND q.identity_subject_id = o.identity_subject_id AND q.show_session_id = o.show_session_id`,
    [orderId],
  );
  await q(`UPDATE orders SET status = 'CANCELED', closed_at = now(), updated_at = now() WHERE id = $1`, [orderId]);
}

describe("CO-01~03 a created order", () => {
  it("CO-01 single seat: every row is written in one transaction, DB price, 7-minute hold, hashed access token, no PII in outbox", async () => {
    capture();
    const w = await world();
    const p = await person();
    const r = await order(p, w, [w.seats[1]]);
    expect(r.status).toBe(201);
    expect(r.replayed).toBe(false);
    expect(r.body).toMatchObject({ status: "PENDING", totalAmount: 150000, items: [{ sessionSeatId: w.seats[1], seatLabel: "R A열 2번", price: 150000 }] });
    expect(r.body.orderNumber).toMatch(/^NZ-[0-9]{6}-[0-9]{6,}$/);
    expect(await footprint(p, w)).toEqual({ orders: 1, items: 1, live_holds: 1, counted: 1, access: 1, logs: 1, outbox: 1, idem: 1 });
    const [o] = await q(
      `SELECT order_number, status, total_amount::text, customer_name, customer_phone, (hold_expires_at - created_at) = interval '7 minutes' AS seven,
              to_char(created_at AT TIME ZONE 'Asia/Seoul', 'YYYYMM') AS kst FROM orders WHERE id = $1`,
      [r.body.orderId],
    );
    expect(o).toMatchObject({ order_number: r.body.orderNumber, status: "PENDING", total_amount: "150000", seven: true });
    expect(r.body.orderNumber.split("-")[1]).toBe(o.kst);
    expect(decryptPii(piiKeys, "orders.customer_name", o.customer_name)).toBe("홍길동");
    expect(decryptPii(piiKeys, "orders.customer_phone", o.customer_phone)).toBe("01012345678");
    const [a] = await q(`SELECT token_hash, browser_binding_hash, scope, status FROM order_access_sessions WHERE order_id = $1`, [r.body.orderId]);
    expect(a).toEqual({ token_hash: sha256Hex(r.access!.token), browser_binding_hash: sha256Hex(p.binding), scope: "CONFIRMATION_VIEW", status: "ACTIVE" });
    expect(r.access!.cookieName).toBe(accessCookieName(r.body.orderId));
    const [e] = await q(`SELECT event_type, aggregate_type, aggregate_version::int AS v, payload, status FROM outbox_events WHERE aggregate_id = $1`, [r.body.orderId]);
    expect(e).toMatchObject({ event_type: "ORDER_CREATED", aggregate_type: "ORDER", v: 1, status: "PENDING" });
    expect(JSON.stringify(e.payload)).not.toMatch(/홍길동|01012345678/);
    const [l] = await q(`SELECT from_status, to_status, source FROM order_status_logs WHERE order_id = $1`, [r.body.orderId]);
    expect(l).toEqual({ from_status: null, to_status: "PENDING", source: "API" });
    const [s] = await q(`SELECT last_used_at IS NOT NULL AS used FROM identity_sessions WHERE id = $1`, [p.sessionId]);
    expect(s.used).toBe(true);
    expect(logs.join("\n")).not.toMatch(new RegExp(`홍길동|01012345678|${r.access!.token}`));
  });

  it("CO-02 multiple seats: total = sum of DB prices, items in canonical order, one hold per seat, counter += n", async () => {
    const w = await world();
    const p = await person();
    const r = await order(p, w, [w.seats[3], w.seats[0], w.seats[1]]);
    const sorted = [w.seats[3], w.seats[0], w.seats[1]].sort();
    expect(r.body.items.map((i) => i.sessionSeatId)).toEqual(sorted);
    expect(r.body.totalAmount).toBe(110000 + 150000 + 90000);
    expect(await footprint(p, w)).toMatchObject({ items: 3, live_holds: 3, counted: 3 });
    const holds = await q(`SELECT h.session_seat_id, i.price::int AS price FROM seat_holds h JOIN order_items i ON i.id = h.order_item_id WHERE h.order_id = $1 ORDER BY 1`, [r.body.orderId]);
    expect(holds.map((h) => h.session_seat_id)).toEqual(sorted);
  });

  it("CO-03 the access session expiry is min(session end + 24 h, issue + 30 days), DB time; a NULL end uses the start", async () => {
    const near = await world({ session: { starts_at: new Date(Date.now() + 2 * 86400_000), ends_at: new Date(Date.now() + 2 * 86400_000 + 3600_000) } });
    const far = await world({ session: { starts_at: new Date(Date.now() + 60 * 86400_000), ends_at: new Date(Date.now() + 60 * 86400_000 + 3600_000) } });
    const noEnd = await world({ session: { starts_at: new Date(Date.now() + 2 * 86400_000), ends_at: null } });
    const check = async (w: World, sql: string) => {
      const r = await order(await person(), w, [w.seats[0]]);
      const [x] = await q(`SELECT ${sql} AS ok FROM order_access_sessions a JOIN orders o ON o.id = a.order_id JOIN show_sessions s ON s.id = o.show_session_id WHERE a.order_id = $1`, [r.body.orderId]);
      expect(x.ok, sql).toBe(true);
    };
    await check(near, `a.expires_at = s.ends_at + interval '24 hours'`);
    await check(far, `a.expires_at = a.created_at + interval '30 days'`);
    await check(noEnd, `a.expires_at = s.starts_at + interval '24 hours'`);
  });
});

describe("CO-04~09 rejections (nothing is written)", () => {
  it("CO-04 purchase limit: counted + n over the snapshot limit → 422 with remaining; more than the session maximum → 422", async () => {
    const w = await world();
    const p = await person();
    const first = await order(p, w, [w.seats[0], w.seats[1], w.seats[2]]);
    await q(`UPDATE seat_holds SET status = 'CONVERTED', ended_at = now(), updated_at = now() WHERE order_id = $1`, [first.body.orderId]); // the 3 seats stay counted (A-053, §5.7)
    await q(`UPDATE orders SET status = 'EXPIRED', closed_at = now(), updated_at = now() WHERE id = $1`, [first.body.orderId]); // inactive, counter untouched
    const e = await order(p, w, [w.seats[3], w.seats[4]]).catch((x) => x);
    expect([e.code, e.details]).toEqual(["PURCHASE_LIMIT_EXCEEDED", { remaining: 1 }]);
    expect((await order(p, w, [w.seats[3]])).status).toBe(201); // exactly up to 4
    const other = await person();
    const five = await order(other, w, w.seats.slice(0, 5)).catch((x) => x);
    expect([five.code, five.details]).toEqual(["PURCHASE_LIMIT_EXCEEDED", { remaining: 4 }]);
    expect(await footprint(other, w)).toMatchObject({ orders: 0 });
  });

  it("CO-05 an active order of the same subject and session → 409 ACTIVE_ORDER_EXISTS with its id", async () => {
    const w = await world();
    const p = await person();
    const a = await order(p, w, [w.seats[0]]);
    const e = await order(p, w, [w.seats[1]]).catch((x) => x);
    expect([e.code, e.details]).toEqual(["ACTIVE_ORDER_EXISTS", { activeOrderId: a.body.orderId }]);
    expect(await footprint(p, w)).toMatchObject({ orders: 1, counted: 1 });
  });

  it.each([
    ["DRAFT show (not public)", { show: { status: "DRAFT" } }, "NOT_FOUND"],
    ["CLOSED show", { show: { status: "CLOSED" } }, "SALES_NOT_OPEN"],
    ["PAUSED session", { session: { sales_status: "PAUSED" } }, "SALES_NOT_OPEN"],
    ["CLOSED session", { session: { sales_status: "CLOSED" } }, "SALES_NOT_OPEN"],
    ["CANCELED session", { session: { sales_status: "CANCELED" } }, "SALES_NOT_OPEN"],
    ["session already started", { session: { starts_at: new Date(Date.now() - 60_000), ends_at: null } }, "SALES_NOT_OPEN"],
    ["sales not open yet", { show: { sales_opens_at: new Date(Date.now() + 3600_000) } }, "SALES_NOT_OPEN"],
    ["sales closed", { show: { sales_closes_at: new Date(Date.now() - 1000) } }, "SALES_NOT_OPEN"],
  ])("CO-06 %s → %s", async (_l, o, code) => {
    const w = await world(o as Row);
    const p = await person();
    expect(await fail(order(p, w, [w.seats[0]]))).toBe(code);
    expect(await footprint(p, w)).toEqual(EMPTY);
  });

  it("CO-06b unknown show session → 404", async () => {
    const w = await world();
    const p = await person();
    expect(await fail(order(p, { ...w, sessionId: randomUUID() }, [w.seats[0]]))).toBe("NOT_FOUND");
  });

  it("CO-07 session remaining time: >= 10 min accepted, < 10 min → 422 IDENTITY_SESSION_TIME_INSUFFICIENT", async () => {
    const w = await world();
    const ok = await person({ expiresInMs: 10 * 60_000 + 5_000 });
    expect((await order(ok, w, [w.seats[0]])).status).toBe(201);
    const short = await person({ expiresInMs: 10 * 60_000 - 1_000 });
    expect(await fail(order(short, w, [w.seats[1]]))).toBe("IDENTITY_SESSION_TIME_INSUFFICIENT");
    expect(await footprint(short, w)).toEqual(EMPTY);
  });

  it("CO-08 session problems: none / LOOKUP / other browser / expired / revoked", async () => {
    const w = await world();
    const none: Person = { subjectId: randomUUID(), sessionId: randomUUID(), token: randomBytes(32).toString("base64url"), binding: randomBytes(32).toString("base64url") };
    expect(await fail(order(none, w, [w.seats[0]]))).toBe("IDENTITY_SESSION_REQUIRED");
    expect(await fail(order(await person({ purpose: "LOOKUP" }), w, [w.seats[0]]))).toBe("SESSION_PURPOSE_MISMATCH");
    const p = await person();
    expect(await fail(order({ ...p, binding: randomBytes(32).toString("base64url") }, w, [w.seats[0]]))).toBe("BROWSER_BINDING_MISMATCH");
    const expired = await person();
    await q(`UPDATE identity_sessions SET expires_at = now() WHERE id = $1`, [expired.sessionId]);
    expect(await fail(order(expired, w, [w.seats[0]]))).toBe("IDENTITY_SESSION_REQUIRED");
    const revoked = await person();
    await q(`UPDATE identity_sessions SET status = 'REVOKED', revoked_at = now() WHERE id = $1`, [revoked.sessionId]);
    expect(await fail(order(revoked, w, [w.seats[0]]))).toBe("IDENTITY_SESSION_REQUIRED");
    expect(await q(`SELECT 1 FROM orders WHERE show_session_id = $1`, [w.sessionId])).toHaveLength(0);
  });

  it("CO-09 seats: SOLD, BLOCKED, held by another live order, another session's seat, unknown id → 409 with the ids; a seat held by an EXPIRED order is freed by pre-cleanup", async () => {
    const w = await world();
    const w2 = await world();
    const holder = await person();
    const h = await order(holder, w, [w.seats[2]]);
    const expiredHolder = await person();
    const eh = await order(expiredHolder, w, [w.seats[3]]);
    await q(`UPDATE orders SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [eh.body.orderId]); // expired, not yet processed
    const buyer = await person();
    const sold = await order(buyer, w, [w.seats[0]]);
    await q(`UPDATE seat_holds SET status = 'CONVERTED', ended_at = now() WHERE order_id = $1`, [sold.body.orderId]);
    const [item] = await q(`SELECT id FROM order_items WHERE order_id = $1`, [sold.body.orderId]);
    await q(`UPDATE session_seats SET status = 'SOLD', sold_order_item_id = $2 WHERE id = $1`, [w.seats[0], item.id]);
    await q(`UPDATE session_seats SET status = 'BLOCKED' WHERE id = $1`, [w.seats[1]]);
    const p = await person();
    const ghost = randomUUID();
    for (const seat of [w.seats[0], w.seats[1], w.seats[2], w2.seats[0], ghost]) {
      const e = await order(p, w, [seat, w.seats[5]]).catch((x) => x);
      expect([e.code, e.details], seat).toEqual(["SEAT_UNAVAILABLE", { unavailableSeatIds: [seat] }]);
    }
    expect(await footprint(p, w)).toEqual(EMPTY);
    expect(h.status).toBe(201);
    // the expired (not yet processed) holder: pre-cleanup ends it through expireOrder, then the seat is booked
    const freed = await order(p, w, [w.seats[3]]);
    expect(freed.status).toBe(201);
    const [old] = await q(`SELECT o.status, array_agg(l.to_status || ':' || l.source ORDER BY l.created_at) AS logs FROM orders o JOIN order_status_logs l ON l.order_id = o.id WHERE o.id = $1 GROUP BY o.status`, [eh.body.orderId]);
    expect(old).toEqual({ status: "EXPIRED", logs: ["PENDING:API", "EXPIRED:SYSTEM"] });
  });

  it("CO-09b request validation: duplicate seat, empty list, extra field, bad ids → 400 before any database work", () => {
    const s = randomUUID();
    const a = randomUUID();
    for (const body of [
      { sessionId: s, sessionSeatIds: [a, a.toUpperCase()] },
      { sessionId: s, sessionSeatIds: [] },
      { sessionId: s, sessionSeatIds: [a], price: 1 },
      { sessionId: "x", sessionSeatIds: [a] },
      { sessionId: s, sessionSeatIds: ["x"] },
      { sessionId: s, sessionSeatIds: Array.from({ length: 11 }, () => randomUUID()) },
      [],
      null,
    ]) {
      expect(() => parseCreateOrderBody(body), JSON.stringify(body)).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    }
  });
});

describe("CO-10~15 idempotency and rate limits", () => {
  it("CO-10 same key + same body: replay of the same order, renewed access token (old one invalid), no rate-limit hit", async () => {
    const w = await world();
    const p = await person();
    const key = randomUUID();
    const a = await order(p, w, [w.seats[0], w.seats[1]], key);
    const hits = await rlHits();
    const b = await order(p, w, [w.seats[1], w.seats[0]], key); // same seats, other order: same canonical request
    expect(b.replayed).toBe(true);
    expect(b.body).toEqual(a.body);
    expect(b.access!.token).not.toBe(a.access!.token);
    const [acc] = await q(`SELECT token_hash, expires_at FROM order_access_sessions WHERE order_id = $1`, [a.body.orderId]);
    expect(acc.token_hash).toBe(sha256Hex(b.access!.token)); // one row, rotated
    expect(await rlHits()).toBe(hits);
    expect(await footprint(p, w)).toMatchObject({ orders: 1, access: 1 });
  });

  it("CO-10b replay with a revoked access session: the order body is returned, no cookie renewed", async () => {
    const w = await world();
    const p = await person();
    const key = randomUUID();
    const a = await order(p, w, [w.seats[0]], key);
    await q(`UPDATE order_access_sessions SET status = 'REVOKED', revoked_at = now() WHERE order_id = $1`, [a.body.orderId]);
    const b = await order(p, w, [w.seats[0]], key);
    expect([b.replayed, b.access, b.body]).toEqual([true, null, a.body]);
  });

  it("CO-10c replay after re-authentication (old session revoked as a claim does, new session, same browser) works; another browser does not replay", async () => {
    const w = await world();
    const p = await person();
    const key = randomUUID();
    const a = await order(p, w, [w.seats[0]], key);
    // re-authentication in the SAME browser: the claim revokes the old ACTIVE session first (A-051, one per binding)
    await q(`UPDATE identity_sessions SET status = 'REVOKED', revoked_at = now(), updated_at = now() WHERE id = $1`, [p.sessionId]);
    const token = randomBytes(32).toString("base64url");
    await q(
      `WITH v AS (INSERT INTO identity_verifications (purpose, provider, provider_transaction_id, browser_binding_hash, state_nonce_hash, status, identity_subject_id, expires_at, verified_name, verified_phone, verified_at)
                  VALUES ('BOOKING','MOCK',$1,$2,$3,'CONSUMED',$4, now() + interval '10 min', $5, $6, now()) RETURNING id)
       INSERT INTO identity_sessions (identity_verification_id, identity_subject_id, purpose, token_hash, browser_binding_hash, status, expires_at)
       SELECT v.id, $4, 'BOOKING', $7, $2, 'ACTIVE', now() + interval '30 min' FROM v`,
      [`t-${randomUUID()}`, sha256Hex(p.binding), `n-${randomUUID()}`, p.subjectId, encryptPii(piiKeys, "identity_verifications.verified_name", "홍길동"), encryptPii(piiKeys, "identity_verifications.verified_phone", "01012345678"), sha256Hex(token)],
    );
    const b = await order({ ...p, token }, w, [w.seats[0]], key);
    expect([b.replayed, b.body.orderId]).toEqual([true, a.body.orderId]);
    expect(b.access).not.toBeNull(); // same browser: its access session is renewed
    // another browser of the same person with the same key: a NEW request (other owner) → the active order blocks it
    const otherBrowser = await person({ subjectId: p.subjectId });
    expect(await fail(order(otherBrowser, w, [w.seats[0]], key))).toBe("ACTIVE_ORDER_EXISTS");
  });

  it("CO-11 same key + different body → 409 IDEMPOTENCY_KEY_REUSED", async () => {
    const w = await world();
    const p = await person();
    const key = randomUUID();
    await order(p, w, [w.seats[0]], key);
    expect(await fail(order(p, w, [w.seats[1]], key))).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("CO-12 8 concurrent identical requests: one order, 7 replays of it, exactly one hit per policy", async () => {
    const w = await world();
    const p = await person();
    const key = randomUUID();
    const hits = await rlHits();
    const res = await Promise.all(Array.from({ length: 8 }, () => order(p, w, [w.seats[0], w.seats[1]], key)));
    expect(res.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(res.map((r) => r.body.orderId)).size).toBe(1);
    expect((await rlHits()) - hits).toBe(2); // session + subject_session, once
    expect(await footprint(p, w)).toMatchObject({ orders: 1, live_holds: 2, counted: 2 });
  });

  it("CO-13 a rejected request is not stored: the same key is re-evaluated later and then succeeds", async () => {
    const w = await world();
    const other = await person();
    const blocking = await order(other, w, [w.seats[0]]);
    const p = await person();
    const key = randomUUID();
    const hits = await rlHits();
    expect(await fail(order(p, w, [w.seats[0]], key))).toBe("SEAT_UNAVAILABLE");
    expect(await rlHits()).toBe(hits); // rolled back with the rejection
    await endOrder(blocking.body.orderId);
    const ok = await order(p, w, [w.seats[0]], key);
    expect(ok.replayed).toBe(false);
  });

  it("CO-14 order.create.session 3/30 min: the 4th new key → 429 with Retry-After; replays still answer at the limit", async () => {
    const d = deps("order.create.session=3/1800,order.create.subject_session=100/3600");
    const w = await world();
    const p = await person();
    const keys = [randomUUID(), randomUUID(), randomUUID()];
    const done = [];
    for (const k of keys) {
      const r = await order(p, w, [w.seats[0]], k, d);
      done.push(r);
      await endOrder(r.body.orderId);
    }
    const e = await order(p, w, [w.seats[0]], randomUUID(), d).catch((x) => x);
    expect(e.code).toBe("ORDER_CREATION_LIMITED");
    expect(e.status).toBe(429);
    expect(e.details.retryAfterSeconds).toBeGreaterThan(0);
    const replay = await order(p, w, [w.seats[0]], keys[0], d);
    expect([replay.replayed, replay.body.orderId]).toEqual([true, done[0].body.orderId]);
  });

  it("CO-15 order.create.subject_session 5/hour counts per subject and show session across sessions", async () => {
    const d = deps("order.create.session=100/1800,order.create.subject_session=2/3600");
    const w = await world();
    const p1 = await person();
    const p2 = await person({ subjectId: p1.subjectId }); // second browser, same person
    const a = await order(p1, w, [w.seats[0]], randomUUID(), d);
    await endOrder(a.body.orderId);
    const b = await order(p2, w, [w.seats[0]], randomUUID(), d);
    await endOrder(b.body.orderId);
    expect(await fail(order(p1, w, [w.seats[0]], randomUUID(), d))).toBe("ORDER_CREATION_LIMITED");
    const other = await world();
    expect((await order(p1, other, [other.seats[0]], randomUUID(), d)).status).toBe(201); // other show session: own counter
  });
});

describe("CO-16~19 concurrency on seats and quota", () => {
  it("CO-16 8 subjects, same seat, different keys: exactly one order; the others SEAT_UNAVAILABLE", async () => {
    const w = await world();
    const people = await Promise.all(Array.from({ length: 8 }, () => person()));
    const res = await Promise.all(people.map((p) => fail(order(p, w, [w.seats[0]]))));
    expect(res.filter((x) => x === "ok")).toHaveLength(1);
    expect(res.filter((x) => x !== "ok")).toEqual(Array(7).fill("SEAT_UNAVAILABLE"));
    expect((await q(`SELECT count(*)::int AS n FROM seat_holds WHERE session_seat_id = $1 AND status = 'ACTIVE'`, [w.seats[0]]))[0].n).toBe(1);
  });

  it("CO-17 one subject, 5 concurrent orders on different seats (3+2 and others): exactly one; counter = its seats", async () => {
    const w = await world();
    const p = await person();
    const picks = [[0, 1, 2], [3, 4], [5], [1], [4]];
    const res = await Promise.all(picks.map((pk) => order(p, w, pk.map((i) => w.seats[i])).then((r) => r, (e) => e)));
    const ok = res.filter((r) => r.status === 201);
    expect(ok).toHaveLength(1);
    expect(res.filter((r) => r.status !== 201).map((r) => r.code)).toEqual(Array(4).fill("ACTIVE_ORDER_EXISTS"));
    expect((await footprint(p, w)).counted).toBe(ok[0].body.items.length);
  });

  it("CO-18 overlapping multi-seat requests from 10 subjects: no deadlock, all-or-nothing, one live hold per seat at most", async () => {
    capture();
    const w = await world();
    const picks = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [0, 3], [1, 4], [2, 5], [3, 0]];
    const people = await Promise.all(picks.map(() => person()));
    const res = await Promise.all(picks.map((pk, i) => order(people[i], w, pk.map((k) => w.seats[k])).then((r) => r, (e) => e)));
    expect(res.filter((r) => !(r.status === 201) && r.code !== "SEAT_UNAVAILABLE")).toEqual([]);
    for (const r of res.filter((x) => x.status === 201)) {
      expect((await q(`SELECT count(*)::int AS n FROM seat_holds WHERE order_id = $1 AND status = 'ACTIVE'`, [r.body.orderId]))[0].n).toBe(2);
    }
    const per = await q<{ n: number }>(`SELECT count(*)::int AS n FROM seat_holds WHERE session_seat_id = ANY($1::uuid[]) AND status = 'ACTIVE' GROUP BY session_seat_id`, [w.seats]);
    for (const x of per) expect(x.n).toBe(1);
    expect(logs.filter((l) => /deadlock|lock_timeout/.test(l))).toEqual([]);
  });

  it("CO-19 the quota row does not exist yet and two browsers of one person order concurrently: one order, counter consistent", async () => {
    const w = await world();
    const p1 = await person();
    const p2 = await person({ subjectId: p1.subjectId });
    const res = await Promise.all([order(p1, w, [w.seats[0], w.seats[1], w.seats[2]]), order(p2, w, [w.seats[3], w.seats[4]])].map((x) => x.then((r) => r, (e) => e)));
    const ok = res.filter((r) => r.status === 201);
    expect(ok).toHaveLength(1);
    expect((await footprint(p1, w)).counted).toBe(ok[0].body.items.length);
  });
});

describe("CO-20~22 atomicity: a failure at any write leaves nothing behind", () => {
  const injectFailure = async (sql: string) => q(sql);
  it.each([
    ["orders INSERT", "BEFORE INSERT ON orders"],
    ["order_items INSERT", "BEFORE INSERT ON order_items"],
    ["seat_holds INSERT", "BEFORE INSERT ON seat_holds"],
    ["order_status_logs INSERT", "BEFORE INSERT ON order_status_logs"],
    ["order_access_sessions INSERT", "BEFORE INSERT ON order_access_sessions"],
    ["outbox_events INSERT", "BEFORE INSERT ON outbox_events"],
    ["idempotency COMPLETED UPDATE", "BEFORE UPDATE ON idempotency_records"],
  ])("CO-20 %s fails → 500, no order / item / hold / counter / session / log / outbox / record / rate-limit hit", async (_l, when) => {
    capture();
    const w = await world();
    const p = await person();
    const hits = await rlHits();
    const trig = `co20_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    await injectFailure(`CREATE FUNCTION ${trig}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected' USING ERRCODE = 'P0001'; END $$`);
    await injectFailure(`CREATE TRIGGER ${trig} ${when} FOR EACH ROW EXECUTE FUNCTION ${trig}()`);
    try {
      const e = await order(p, w, [w.seats[0], w.seats[1]]).catch((x) => x);
      expect([e.code, e.status]).toEqual(["INTERNAL_ERROR", 500]);
    } finally {
      await q(`DROP TRIGGER ${trig} ON ${when.split(" ON ")[1]}`);
      await q(`DROP FUNCTION ${trig}()`);
    }
    expect(await footprint(p, w)).toEqual(EMPTY);
    expect(await q(`SELECT 1 FROM purchase_quotas WHERE identity_subject_id = $1`, [p.subjectId])).toHaveLength(0);
    expect(await rlHits()).toBe(hits);
    expect(await q(`SELECT 1 FROM idempotency_records WHERE status = 'PROCESSING'`)).toHaveLength(0);
  });

  it("CO-21 COMMIT fails (deferred constraint trigger) → everything rolled back", async () => {
    capture();
    const w = await world();
    const p = await person();
    const trig = `co21_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    await q(`CREATE FUNCTION ${trig}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'commit-time' USING ERRCODE = 'check_violation'; END $$`);
    await q(`CREATE CONSTRAINT TRIGGER ${trig} AFTER INSERT ON orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${trig}()`);
    try {
      const e = await order(p, w, [w.seats[0]]).catch((x) => x);
      expect([e.code, e.status]).toEqual(["INTERNAL_ERROR", 500]); // 23514 is not mapped in the order transaction (backstop = bug)
      expect(logs.join("\n")).toContain("kind=constraint sqlstate=23514");
    } finally {
      await q(`DROP TRIGGER ${trig} ON orders`);
      await q(`DROP FUNCTION ${trig}()`);
    }
    expect(await footprint(p, w)).toEqual(EMPTY);
  });

  it("CO-22 after any failure the same key works normally (nothing half-done blocks it)", async () => {
    const w = await world();
    const p = await person();
    const key = randomUUID();
    const trig = `co22_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    await q(`CREATE FUNCTION ${trig}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'x' USING ERRCODE = 'P0001'; END $$`);
    await q(`CREATE TRIGGER ${trig} BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION ${trig}()`);
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await fail(order(p, w, [w.seats[0]], key))).toBe("INTERNAL_ERROR");
    } finally {
      await q(`DROP TRIGGER ${trig} ON outbox_events`);
      await q(`DROP FUNCTION ${trig}()`);
    }
    expect((await order(p, w, [w.seats[0]], key)).replayed).toBe(false);
  });
});
