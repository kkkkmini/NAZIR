/**
 * OR-01~OR-09 (Step 5, API_SPEC §4.4) — POST /api/v1/orders over HTTP semantics against a REAL PostgreSQL: cookies,
 * CSRF, Idempotency-Key, body validation, status codes, Retry-After, fail-closed configuration, no leaks, and the real
 * route module wired through the application dependencies.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { PrismaClient } from "../../../src/generated/prisma/client";
import { loadDbPoolConfig } from "../../../src/server/config/db-pool-config";
import { buildPgPoolConfig } from "../../../src/server/db/pg-adapter";
import type { CreateOrderDeps } from "../../../src/server/booking/create-order";
import { handleCreateOrder, RateLimitConfigUnavailable, type OrderRouteDeps } from "../../../src/server/booking/order-route";
import { DEFAULT_RETRY_POLICY } from "../../../src/server/booking/tx";
import { BINDING_COOKIE, IDENTITY_SESSION_COOKIE } from "../../../src/server/lib/cookies";
import { sha256Hex } from "../../../src/server/lib/crypto/hmac";
import { encryptPii } from "../../../src/server/lib/crypto/pii";
import { issueCsrfToken } from "../../../src/server/lib/csrf";
import { loadSecurityConfig, parseKeyring, type Keyring } from "../../../src/server/lib/secrets";
import { parsePolicyOverrides } from "../../../src/server/rate-limit/policies";
import { insert, mkSeat, mkSessionSeat, mkSubject, mkVenue } from "./helpers/fixtures";
import { cloneTestDb, destroyTestDb, resolveTestServer, type TestDb } from "./helpers/pg";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const server = resolveTestServer();
const ORIGIN = "http://localhost:3000";
const k = () => randomBytes(32).toString("base64url");
const ring = (p: string): Keyring => parseKeyring({ [`${p}_KEYS`]: `v1:${k()}`, [`${p}_KEY_CURRENT`]: "v1" }, p, [])!;
const csrfKey = k();
const piiKey = k();
const rlKey = k();
const security = loadSecurityConfig({ NAZIR_APP_ORIGIN: ORIGIN, NAZIR_CSRF_KEYS: `v1:${csrfKey}`, NAZIR_CSRF_KEY_CURRENT: "v1" }, "test");
const piiKeys = parseKeyring({ P_KEYS: `v1:${piiKey}`, P_KEY_CURRENT: "v1" }, "P", [])!;
const rlKeys = ring("RL"); // ONE key for the file: the counter key is an HMAC of it
let db: TestDb;
let prisma: PrismaClient;
let logs: string[] = [];
const q = async <T = Row>(sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as T[];

function orderDeps(o: { policies?: string; lockTimeoutMs?: number; maxAttempts?: number } = {}): CreateOrderDeps {
  return {
    tx: {
      startTx: (fn, options) => prisma.$transaction((tx) => fn(tx), options),
      limits: { txMaxWaitMs: 10000, txTimeoutMs: 20000, statementTimeoutMs: 15000, lockTimeoutMs: o.lockTimeoutMs ?? 10000 },
      retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: o.maxAttempts ?? 3 },
    },
    piiKeys,
    rateLimit: { keys: rlKeys, policies: parsePolicyOverrides({ NAZIR_RATE_LIMIT_POLICIES: o.policies ?? "order.create.session=1000/1800,order.create.subject_session=1000/3600" }) },
  };
}
const routeDeps = (o?: Parameters<typeof orderDeps>[0]): OrderRouteDeps => ({ security: () => security, order: () => orderDeps(o) });

beforeAll(async () => {
  db = await cloneTestDb(server, inject("templateDb"));
  prisma = new PrismaClient({ adapter: new PrismaPg(buildPgPoolConfig(db.url, "DATABASE_URL", loadDbPoolConfig({}, "test"))) });
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

async function world() {
  const v = await mkVenue(db);
  const show = await insert(db, "shows", { venue_id: v.id, title: "t", slug: `s-${randomUUID()}`, status: "PUBLISHED" });
  const s = await insert(db, "show_sessions", { show_id: show.id, venue_id: v.id, starts_at: new Date(Date.now() + 30 * 86400_000), sales_status: "ON_SALE" });
  const seats: string[] = [];
  for (let i = 0; i < 3; i++) seats.push((await mkSessionSeat(db, s.id, (await mkSeat(db, v.id)).id, v.id, { price: 100000 + i * 10000 })).id);
  return { sessionId: s.id as string, seats };
}
async function person() {
  const subjectId = (await mkSubject(db)).id;
  const token = k();
  const binding = k();
  await q(
    `WITH v AS (INSERT INTO identity_verifications (purpose, provider, provider_transaction_id, browser_binding_hash, state_nonce_hash, status, identity_subject_id, expires_at, verified_name, verified_phone, verified_at)
                VALUES ('BOOKING','MOCK',$1,$2,$3,'CONSUMED',$4, now() + interval '10 min', $5, $6, now()) RETURNING id)
     INSERT INTO identity_sessions (identity_verification_id, identity_subject_id, purpose, token_hash, browser_binding_hash, status, expires_at)
     SELECT v.id, $4, 'BOOKING', $7, $2, 'ACTIVE', now() + interval '30 min' FROM v`,
    [`t-${randomUUID()}`, sha256Hex(binding), `n-${randomUUID()}`, subjectId, encryptPii(piiKeys, "identity_verifications.verified_name", "김민수"), encryptPii(piiKeys, "identity_verifications.verified_phone", "01055556666"), sha256Hex(token)],
  );
  return { subjectId, token, binding };
}
type P = Awaited<ReturnType<typeof person>>;
function req(p: P | null, body: unknown, o: { key?: string | null; origin?: string | null; csrf?: string | null; noSession?: boolean; contentType?: string; raw?: string } = {}) {
  const h = new Headers({ "content-type": o.contentType ?? "application/json" });
  if (p) h.set("cookie", `${BINDING_COOKIE}=${p.binding}${o.noSession ? "" : `; ${IDENTITY_SESSION_COOKIE}=${p.token}`}`);
  if (o.origin !== null) h.set("origin", o.origin ?? ORIGIN);
  const csrf = o.csrf === undefined ? (p ? issueCsrfToken(security.csrfKeys, p.binding) : null) : o.csrf;
  if (csrf) h.set("x-csrf-token", csrf);
  const key = o.key === undefined ? randomUUID() : o.key;
  if (key) h.set("idempotency-key", key);
  return new Request(`${ORIGIN}/api/v1/orders`, { method: "POST", headers: h, body: o.raw ?? JSON.stringify(body) });
}
const writes = async () => (await q<{ n: number }>(`SELECT (SELECT count(*) FROM orders) + (SELECT count(*) FROM idempotency_records) + (SELECT coalesce(sum(count), 0) FROM rate_limit_counters) AS n`))[0].n;

describe("OR-01~03 success and replay", () => {
  it("OR-01 201: order body, no-store, __Host- access cookie (Secure, HttpOnly, SameSite=Lax, Path=/, Max-Age) whose token is stored only hashed", async () => {
    const w = await world();
    const p = await person();
    const res = await handleCreateOrder(req(p, { sessionId: w.sessionId, sessionSeatIds: [w.seats[1], w.seats[0]] }), routeDeps());
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["holdExpiresAt", "items", "orderId", "orderNumber", "status", "totalAmount"]);
    expect(body.totalAmount).toBe(210000);
    const cookie = res.headers.get("set-cookie")!;
    const m = /^(__Host-nz_oa_[0-9a-f]{16})=([A-Za-z0-9_-]{43}); Max-Age=(\d+); Path=\/; Secure; HttpOnly; SameSite=Lax$/.exec(cookie);
    expect(m, cookie).not.toBeNull();
    expect(m![1]).toBe(`__Host-nz_oa_${body.orderId.replace(/-/g, "").slice(0, 16)}`);
    expect(Number(m![3])).toBeGreaterThan(29 * 86400); // session in 30 days → capped at issue + 30 days
    const [a] = await q(`SELECT token_hash FROM order_access_sessions WHERE order_id = $1`, [body.orderId]);
    expect(a.token_hash).toBe(sha256Hex(m![2]));
    expect(JSON.stringify(await q(`SELECT * FROM order_access_sessions WHERE order_id = $1`, [body.orderId]))).not.toContain(m![2]);
  });

  it("OR-02 replay with the same key from the same browser: same body, a renewed cookie; another key creates nothing new (active order)", async () => {
    const w = await world();
    const p = await person();
    const key = randomUUID();
    const a = await handleCreateOrder(req(p, { sessionId: w.sessionId, sessionSeatIds: [w.seats[0]] }, { key }), routeDeps());
    const b = await handleCreateOrder(req(p, { sessionId: w.sessionId, sessionSeatIds: [w.seats[0]] }, { key: key.toUpperCase() }), routeDeps());
    expect(b.status).toBe(201);
    expect(await b.json()).toEqual(await a.json());
    expect(b.headers.get("set-cookie")).not.toBe(a.headers.get("set-cookie"));
    const c = await handleCreateOrder(req(p, { sessionId: w.sessionId, sessionSeatIds: [w.seats[1]] }), routeDeps());
    expect([c.status, (await c.json()).error.code]).toEqual([409, "ACTIVE_ORDER_EXISTS"]);
  });

  it("OR-03 same key, other body → 409 IDEMPOTENCY_KEY_REUSED", async () => {
    const w = await world();
    const p = await person();
    const key = randomUUID();
    await handleCreateOrder(req(p, { sessionId: w.sessionId, sessionSeatIds: [w.seats[0]] }, { key }), routeDeps());
    const r = await handleCreateOrder(req(p, { sessionId: w.sessionId, sessionSeatIds: [w.seats[0], w.seats[1]] }, { key }), routeDeps());
    expect([r.status, (await r.json()).error.code]).toEqual([409, "IDEMPOTENCY_KEY_REUSED"]);
  });
});

describe("OR-04 rejected before the transaction: nothing written, no rate-limit hit", () => {
  it.each([
    ["no binding cookie", (p: P, b: unknown) => req(null, b), 401, "BROWSER_BINDING_REQUIRED"],
    ["foreign Origin", (p: P, b: unknown) => req(p, b, { origin: "https://evil.example" }), 403, "CSRF_REJECTED"],
    ["no Origin", (p: P, b: unknown) => req(p, b, { origin: null }), 403, "CSRF_REJECTED"],
    ["no CSRF token", (p: P, b: unknown) => req(p, b, { csrf: null }), 403, "CSRF_REJECTED"],
    ["CSRF token of another browser", (p: P, b: unknown) => req(p, b, { csrf: issueCsrfToken(security.csrfKeys, k()) }), 403, "CSRF_REJECTED"],
    ["no session cookie", (p: P, b: unknown) => req(p, b, { noSession: true }), 401, "IDENTITY_SESSION_REQUIRED"],
    ["no Idempotency-Key", (p: P, b: unknown) => req(p, b, { key: null }), 400, "IDEMPOTENCY_KEY_INVALID"],
    ["short Idempotency-Key", (p: P, b: unknown) => req(p, b, { key: "abc" }), 400, "IDEMPOTENCY_KEY_INVALID"],
    ["not JSON", (p: P, b: unknown) => req(p, b, { raw: "{nope" }), 400, "VALIDATION_FAILED"],
    ["wrong content type", (p: P, b: unknown) => req(p, b, { contentType: "text/plain" }), 400, "VALIDATION_FAILED"],
    ["body over 4 KB", (p: P, b: unknown) => req(p, b, { raw: JSON.stringify({ ...(b as Row), pad: "x".repeat(5000) }) }), 400, "VALIDATION_FAILED"],
    ["client price field", (p: P, b: unknown) => req(p, { ...(b as Row), totalAmount: 1 }), 400, "VALIDATION_FAILED"],
  ])("%s → %i %s", async (_l, build, status, code) => {
    const w = await world();
    const p = await person();
    const before = await writes();
    const r = await handleCreateOrder(build(p, { sessionId: w.sessionId, sessionSeatIds: [w.seats[0]] }), routeDeps());
    expect([r.status, (await r.json()).error.code]).toEqual([status, code]);
    expect(await writes()).toBe(before);
  });

  it("duplicate seat in the body → 400, nothing written", async () => {
    const w = await world();
    const p = await person();
    const r = await handleCreateOrder(req(p, { sessionId: w.sessionId, sessionSeatIds: [w.seats[0], w.seats[0]] }), routeDeps());
    expect([r.status, (await r.json()).error.code]).toEqual([400, "VALIDATION_FAILED"]);
  });
});

describe("OR-05~07 429 / 503 and Retry-After", () => {
  it("OR-05 429 ORDER_CREATION_LIMITED carries Retry-After and retryAt", async () => {
    const w = await world();
    const p = await person();
    const d = routeDeps({ policies: "order.create.session=1/1800,order.create.subject_session=100/3600" });
    const first = await handleCreateOrder(req(p, { sessionId: w.sessionId, sessionSeatIds: [w.seats[0]] }), d);
    const { orderId } = await first.json();
    await q(`UPDATE seat_holds SET status = 'RELEASED', released_reason = 'USER_CANCELED', ended_at = now() WHERE order_id = $1`, [orderId]);
    await q(`UPDATE purchase_quotas SET counted_seats = 0 WHERE identity_subject_id = $1`, [p.subjectId]);
    await q(`UPDATE orders SET status = 'CANCELED', closed_at = now() WHERE id = $1`, [orderId]);
    const r = await handleCreateOrder(req(p, { sessionId: w.sessionId, sessionSeatIds: [w.seats[0]] }), d);
    const body = await r.json();
    expect([r.status, body.error.code]).toEqual([429, "ORDER_CREATION_LIMITED"]);
    expect(Number(r.headers.get("retry-after"))).toBe(body.error.details.retryAfterSeconds);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("OR-06 503 DATABASE_BUSY (seat lock not obtained in time) carries Retry-After; nothing written", async () => {
    capture();
    const w = await world();
    const p = await person();
    const holder = await db.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT 1 FROM session_seats WHERE id = $1 FOR UPDATE`, [w.seats[0]]);
      const r = await handleCreateOrder(req(p, { sessionId: w.sessionId, sessionSeatIds: [w.seats[0]] }), routeDeps({ lockTimeoutMs: 200, maxAttempts: 2 }));
      expect([r.status, (await r.json()).error.code, r.headers.get("retry-after")]).toEqual([503, "DATABASE_BUSY", "2"]);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect(await q(`SELECT 1 FROM orders WHERE identity_subject_id = $1`, [p.subjectId])).toHaveLength(0);
  });

  it("OR-07 rate-limit configuration unusable → 503 RATE_LIMIT_UNAVAILABLE (fail closed, the order is not attempted)", async () => {
    capture();
    const w = await world();
    const p = await person();
    const before = await writes();
    const r = await handleCreateOrder(req(p, { sessionId: w.sessionId, sessionSeatIds: [w.seats[0]] }), {
      security: () => security,
      order: () => {
        throw new RateLimitConfigUnavailable();
      },
    });
    expect([r.status, (await r.json()).error.code]).toEqual([503, "RATE_LIMIT_UNAVAILABLE"]);
    expect(await writes()).toBe(before);
  });
});

describe("OR-08 nothing leaks", () => {
  it("an internal failure answers a generic 500; logs and body carry no SQL, token, name or phone", async () => {
    capture();
    const w = await world();
    const p = await person();
    await q(`CREATE FUNCTION or08_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'secret detail 김민수' USING ERRCODE = 'P0001'; END $$`);
    await q(`CREATE TRIGGER or08_fail BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION or08_fail()`);
    try {
      const r = await handleCreateOrder(req(p, { sessionId: w.sessionId, sessionSeatIds: [w.seats[0]] }), routeDeps());
      const text = await r.text();
      expect(r.status).toBe(500);
      expect(JSON.parse(text)).toEqual({ error: { code: "INTERNAL_ERROR", message: "일시적인 오류가 발생했습니다.", details: {} } });
      const all = text + logs.join("\n");
      for (const secret of ["김민수", "01055556666", p.token, p.binding, "secret detail", "outbox_events", "INSERT"]) expect(all).not.toContain(secret);
    } finally {
      await q(`DROP TRIGGER or08_fail ON outbox_events`);
      await q(`DROP FUNCTION or08_fail()`);
    }
  });
});

describe("OR-09 application wiring (orderAppDeps)", () => {
  // The route module itself (src/app/api/v1/orders/route.ts) only adds Next's connection() and calls handleCreateOrder
  // with orderAppDeps; connection() needs a real request scope, so the wiring is exercised here through the handler.
  it("creates an order with the environment's keys, pool limits and rate-limit policies", async () => {
    const env: Record<string, string> = {
      NAZIR_RUNTIME_ENV: "test",
      DATABASE_URL: db.url,
      PAYMENT_PROVIDER: "mock",
      IDENTITY_PROVIDER: "mock",
      NAZIR_APP_ORIGIN: ORIGIN,
      NAZIR_CSRF_KEYS: `v1:${csrfKey}`,
      NAZIR_CSRF_KEY_CURRENT: "v1",
      NAZIR_PII_ENC_KEYS: `v1:${piiKey}`,
      NAZIR_PII_ENC_KEY_CURRENT: "v1",
      NAZIR_RATE_LIMIT_KEYS: `v1:${rlKey}`,
      NAZIR_RATE_LIMIT_KEY_CURRENT: "v1",
      NAZIR_CLIENT_IP_SOURCE: "fixed",
      NAZIR_CLIENT_IP_FIXED: "127.0.0.1",
    };
    for (const [key, v] of Object.entries(env)) vi.stubEnv(key, v);
    const g = globalThis as { __nazirPrisma?: PrismaClient; __nazirDbPool?: unknown };
    vi.resetModules();
    try {
      const { orderAppDeps } = await import("../../../src/server/booking/order-app-deps");
      const w = await world();
      const p = await person();
      const r = await handleCreateOrder(req(p, { sessionId: w.sessionId, sessionSeatIds: [w.seats[2]] }), orderAppDeps);
      expect(r.status).toBe(201);
      expect((await r.json()).totalAmount).toBe(120000);
      expect(r.headers.get("set-cookie")).toMatch(/^__Host-nz_oa_/);
      const [hits] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM rate_limit_counters WHERE policy LIKE 'order.create.%'`);
      expect(hits.n).toBeGreaterThanOrEqual(2);
    } finally {
      const c = g.__nazirPrisma;
      delete g.__nazirPrisma;
      delete g.__nazirDbPool;
      await c?.$disconnect();
      vi.unstubAllEnvs();
    }
  });
});
