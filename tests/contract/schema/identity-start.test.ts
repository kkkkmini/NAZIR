/**
 * START-01~20 (A-049): POST /api/v1/identity-verifications handler against a real PostgreSQL server, with the real
 * rate limiter, CSRF check, Mock provider and provider-context encryption. Only the provider is swapped in a few tests.
 */
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import type { SqlExecutor, TxRunner } from "../../../src/server/db/sql";
import { MockIdentityProvider } from "../../../src/server/identity/providers/mock";
import { ProviderRejectedError, ProviderUnavailableError, type IdentityProvider } from "../../../src/server/identity/providers/types";
import { IDENTITY_START_TTL_MS, handleStartVerification, type StartDeps } from "../../../src/server/identity/start";
import { BINDING_COOKIE } from "../../../src/server/lib/cookies";
import { sha256Hex } from "../../../src/server/lib/crypto/hmac";
import { openProviderContext } from "../../../src/server/lib/crypto/provider-context";
import { issueCsrfToken } from "../../../src/server/lib/csrf";
import { loadSecurityConfig, parseKeyring } from "../../../src/server/lib/secrets";
import { parsePolicyOverrides } from "../../../src/server/rate-limit/policies";
import { RateLimiter } from "../../../src/server/rate-limit/service";
import { cloneTestDb, destroyTestDb, resolveTestServer, type TestDb } from "./helpers/pg";

const server = resolveTestServer();
let db: TestDb;
let pool: Pool;
beforeAll(async () => {
  db = await cloneTestDb(server, inject("templateDb"));
  pool = new Pool({ connectionString: db.url, max: 20 });
});
afterAll(async () => {
  await pool.end();
  await destroyTestDb(db);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.query(`DELETE FROM rate_limit_counters`);
});

const ORIGIN = "http://localhost:3000";
const notUsed = async (): Promise<never> => {
  throw new Error("completeVerification is not used by the start tests");
};
const key = () => randomBytes(32).toString("base64url");
const CSRF_KEY = key();
const security = loadSecurityConfig({ NAZIR_APP_ORIGIN: ORIGIN, NAZIR_CSRF_KEYS: `v1:${CSRF_KEY}`, NAZIR_CSRF_KEY_CURRENT: "v1" }, "test");
const rlKeys = parseKeyring({ R_KEYS: `v1:${key()}`, R_KEY_CURRENT: "v1" }, "R", [])!;
const ctxKeys = parseKeyring({ C_KEYS: `v1:${key()}`, C_KEY_CURRENT: "v1" }, "C", [])!;
const exec = (c: { query: Pool["query"] }): SqlExecutor => async (sql, params) => (await c.query(sql, params)).rows;
const tx: TxRunner = async (fn) => {
  const c = await pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const r = await fn(exec(c as never));
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
};
// confirmed A-047 values (no overrides)
const limiter = (rlExec: SqlExecutor = exec(pool)) => new RateLimiter({ exec: rlExec, keys: rlKeys, policies: parsePolicyOverrides({}) });
let ipCounter = 1;
const freshIp = () => `198.51.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

function deps(o: { rl?: RateLimiter; provider?: IdentityProvider; providerFactory?: () => IdentityProvider; random?: (n: number) => Buffer } = {}): StartDeps {
  const provider = o.provider ?? new MockIdentityProvider("test", ORIGIN);
  return {
    security: () => security,
    rateLimit: () => ({ limiter: o.rl ?? limiter(), ipSource: { kind: "vercel" } }),
    provider: o.providerFactory ?? (() => provider),
    contextKeys: () => ctxKeys,
    tx,
    random: o.random,
  };
}
const newBinding = () => randomBytes(32).toString("base64url");
function req(o: { binding?: string | null; ip?: string; body?: unknown; origin?: string | null; token?: string | null; contentType?: string; rawBody?: string } = {}) {
  const binding = o.binding === undefined ? newBinding() : o.binding;
  const h: Record<string, string> = { "content-type": o.contentType ?? "application/json", "x-vercel-forwarded-for": o.ip ?? freshIp() };
  if (binding) h.cookie = `${BINDING_COOKIE}=${binding}`;
  if (o.origin !== null) h.origin = o.origin ?? ORIGIN;
  const token = o.token === undefined ? (binding ? issueCsrfToken(security.csrfKeys, binding) : null) : o.token;
  if (token) h["x-csrf-token"] = token;
  return { request: new Request(`${ORIGIN}/api/v1/identity-verifications`, { method: "POST", headers: h, body: o.rawBody ?? JSON.stringify(o.body ?? { purpose: "BOOKING" }) }), binding };
}
const call = async (r: { request: Request }, d = deps()) => {
  const res = await handleStartVerification(r.request, d);
  return { res, status: res.status, body: await res.json(), cc: res.headers.get("cache-control"), retry: res.headers.get("retry-after") };
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const row = async (id: string): Promise<any> => (await db.query(`SELECT * FROM identity_verifications WHERE id = $1`, [id])).rows[0];
const counters = async () => (await db.query(`SELECT count(*)::int n FROM rate_limit_counters`)).rows[0].n;

describe("START success", () => {
  it("START-01 valid request → 200, PENDING row bound to the browser, state stored as hash only, context encrypted, no-store", async () => {
    const r = req({ body: { purpose: "BOOKING" } });
    const { status, body, cc } = await call(r);
    expect(status).toBe(200);
    expect(cc).toBe("no-store");
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "launch", "purpose", "verificationId"]);
    expect(body.launch.type).toBe("redirect");
    expect(new URL(body.launch.url).origin).toBe(ORIGIN);
    const v = await row(body.verificationId);
    expect(v).toMatchObject({ status: "PENDING", provider: "MOCK", purpose: "BOOKING", browser_binding_hash: sha256Hex(r.binding!), identity_subject_id: null });
    expect(v.provider_transaction_id).toMatch(/^mock_/);
    expect(v.state_nonce_hash).toMatch(/^[0-9a-f]{64}$/);
    // the context holds the server-decided callback URL with the raw state; the DB only has its hash
    const ctx = openProviderContext(ctxKeys, v.id, v.provider_context_encrypted);
    const cb = new URL(ctx.returnUrl);
    expect(cb.origin + cb.pathname).toBe(`${ORIGIN}/api/v1/identity-verifications/callback/mock`);
    expect(sha256Hex(cb.searchParams.get("state")!)).toBe(v.state_nonce_hash);
    expect(v.provider_context_encrypted).not.toContain(cb.searchParams.get("state"));
    expect(JSON.stringify(body)).not.toContain(cb.searchParams.get("state"));
    // TTL from DB time
    const ttl = (await db.query(`SELECT extract(epoch FROM expires_at - created_at) * 1000 AS ms FROM identity_verifications WHERE id = $1`, [v.id])).rows[0].ms;
    expect(Number(ttl)).toBe(IDENTITY_START_TTL_MS);
    expect(new Date(body.expiresAt).getTime()).toBe(Math.floor(new Date(v.expires_at).getTime()));
  });

  it("START-02 LOOKUP purpose works and is kept apart from BOOKING", async () => {
    const binding = newBinding();
    const a = await call(req({ binding, body: { purpose: "BOOKING" } }));
    const b = await call(req({ binding, body: { purpose: "LOOKUP" } }));
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await row(a.body.verificationId)).status).toBe("PENDING");
    expect((await row(b.body.verificationId)).purpose).toBe("LOOKUP");
  });
});

describe("START request validation and browser binding", () => {
  it.each([
    ["missing purpose", { body: {} }],
    ["unknown purpose", { body: { purpose: "ADMIN" } }],
    ["extra returnUrl (client may not choose the callback)", { body: { purpose: "BOOKING", returnUrl: "https://evil.example" } }],
    ["array body", { body: ["BOOKING"] }],
    ["not JSON", { rawBody: "purpose=BOOKING" }],
    ["wrong content type", { contentType: "text/plain" }],
    ["oversized body", { rawBody: JSON.stringify({ purpose: "BOOKING", x: "a".repeat(2000) }) }],
  ])("START-03 %s → 400 VALIDATION_FAILED, nothing written", async (_, o) => {
    const before = (await db.query(`SELECT count(*)::int n FROM identity_verifications`)).rows[0].n;
    const { status, body, cc } = await call(req(o));
    expect([status, body.error.code, cc]).toEqual([400, "VALIDATION_FAILED", "no-store"]);
    expect((await db.query(`SELECT count(*)::int n FROM identity_verifications`)).rows[0].n).toBe(before);
    expect(await counters()).toBe(0);
  });

  it.each([
    ["missing", null],
    ["tampered (bad characters)", "!".repeat(43)],
    ["too short", "abc"],
  ])("START-04 binding cookie %s → 401 BROWSER_BINDING_REQUIRED before CSRF and rate limit", async (_, binding) => {
    const { status, body } = await call(req({ binding, token: "v1.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }));
    expect([status, body.error.code]).toEqual([401, "BROWSER_BINDING_REQUIRED"]);
    expect(await counters()).toBe(0);
  });
});

describe("START CSRF", () => {
  it.each([
    ["token missing", { token: null }],
    ["token for another browser", { token: issueCsrfToken(security.csrfKeys, randomBytes(32).toString("base64url")) }],
    ["token tampered", { token: "v1." + "A".repeat(43) }],
    ["Origin missing", { origin: null }],
    ["Origin other site", { origin: "https://evil.example.com" }],
    ["Origin null", { origin: "null" }],
  ])("START-05 %s → 403 CSRF_REJECTED, no rate-limit counter touched", async (_, o) => {
    const { status, body } = await call(req(o as never));
    expect([status, body.error.code]).toEqual([403, "CSRF_REJECTED"]);
    expect(await counters()).toBe(0);
  });
});

describe("START rate limits (A-047: IP 60/10min, binding 5/10min)", () => {
  it("START-06 the 6th start from one browser → 429 with Retry-After; IP counter still counted", async () => {
    const binding = newBinding();
    const ip = freshIp();
    const out = [];
    for (let i = 0; i < 6; i++) out.push(await call(req({ binding, ip })));
    expect(out.slice(0, 5).map((x) => x.status)).toEqual([200, 200, 200, 200, 200]);
    expect([out[5].status, out[5].body.error.code]).toEqual([429, "RATE_LIMITED"]);
    expect(Number(out[5].retry)).toBeGreaterThanOrEqual(1);
    expect(Number(out[5].retry)).toBeLessThanOrEqual(600);
    expect(out[5].body.error.details.retryAfterSeconds).toBe(Number(out[5].retry));
    // superseded starts: only the newest is PENDING (one PENDING per binding+purpose)
    const { rows } = await db.query(`SELECT status, failure_code FROM identity_verifications WHERE browser_binding_hash = $1 ORDER BY created_at`, [sha256Hex(binding)]);
    expect(rows.map((r) => r.status)).toEqual(["EXPIRED", "EXPIRED", "EXPIRED", "EXPIRED", "PENDING"]);
    expect(rows[0].failure_code).toBe("SUPERSEDED");
  });

  it("START-07 IP limit is checked first: over the IP limit, the browser counter is not touched", async () => {
    const ip = freshIp();
    for (let i = 0; i < 12; i++) for (let j = 0; j < 5; j++) expect((await call(req({ binding: undefined, ip }))).status).toBe(200);
    const binding = newBinding();
    const r = await call(req({ binding, ip }));
    expect([r.status, r.body.error.code]).toEqual([429, "RATE_LIMITED"]);
    expect(r.retry).not.toBeNull();
    // 60 IP hits + 61st = 1 IP row; 60 distinct browsers; the new browser never got a counter
    expect((await db.query(`SELECT policy, count(*)::int n FROM rate_limit_counters GROUP BY policy ORDER BY policy`)).rows).toEqual([
      { policy: "identity.start.binding", n: 60 },
      { policy: "identity.start.ip", n: 1 },
    ]);
  });

  it("START-08 rate limit store failure → 503 RATE_LIMIT_UNAVAILABLE (not 429), no verification row", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = limiter(async () => {
      throw new Error("db down");
    });
    const before = (await db.query(`SELECT count(*)::int n FROM identity_verifications`)).rows[0].n;
    const { status, body, retry } = await call(req(), deps({ rl: broken }));
    expect([status, body.error.code, retry]).toEqual([503, "RATE_LIMIT_UNAVAILABLE", null]);
    expect((await db.query(`SELECT count(*)::int n FROM identity_verifications`)).rows[0].n).toBe(before);
  });

  it("START-09 no trusted client IP header → 503 RATE_LIMIT_UNAVAILABLE (fail-closed, spoofable headers ignored)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = req();
    r.request.headers.delete("x-vercel-forwarded-for");
    r.request.headers.set("x-forwarded-for", "203.0.113.1");
    const { status, body } = await call(r);
    expect([status, body.error.code]).toEqual([503, "RATE_LIMIT_UNAVAILABLE"]);
  });
});

describe("START provider failures", () => {
  const failing = (err: Error): IdentityProvider => ({ name: "MOCK", completeVerification: notUsed, startVerification: async () => { throw err; } });

  it("START-10 provider unavailable → 503 PROVIDER_UNAVAILABLE; the row is FAILED with no context", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = req();
    const { status, body } = await call(r, deps({ provider: failing(new ProviderUnavailableError("timeout")) }));
    expect([status, body.error.code]).toEqual([503, "PROVIDER_UNAVAILABLE"]);
    const { rows } = await db.query(`SELECT status, failure_code, provider_context_encrypted FROM identity_verifications WHERE browser_binding_hash = $1`, [sha256Hex(r.binding!)]);
    expect(rows).toEqual([{ status: "FAILED", failure_code: "PROVIDER_UNAVAILABLE", provider_context_encrypted: null }]);
  });

  it("START-11 provider rejects / returns unusable data → 502 IDENTITY_START_FAILED", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = (launchUrl: string, txn = "mock_abc"): IdentityProvider => ({
      name: "MOCK",
      completeVerification: notUsed,
      startVerification: async () => ({ providerTransactionId: txn, launch: { type: "redirect", url: launchUrl }, validForMs: null, context: {} }),
    });
    for (const p of [failing(new ProviderRejectedError("denied")), bad("https://evil.example/phish"), bad("javascript:alert(1)"), bad(`${ORIGIN}/x`, "bad id with spaces")]) {
      const { status, body } = await call(req(), deps({ provider: p }));
      expect([status, body.error.code]).toEqual([502, "IDENTITY_START_FAILED"]);
    }
    expect((await db.query(`SELECT count(*)::int n FROM identity_verifications WHERE failure_code = 'PROVIDER_REJECTED'`)).rows[0].n).toBeGreaterThanOrEqual(4);
  });

  it("START-12 an unexpected provider exception is treated as unavailable and leaks nothing", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, body } = await call(req(), deps({ provider: failing(new Error("client_secret=SECRET-MARKER 010-0000-0000")) }));
    expect([status, body.error.code]).toEqual([503, "PROVIDER_UNAVAILABLE"]);
    const logged = JSON.stringify(err.mock.calls);
    expect(logged).not.toContain("SECRET-MARKER");
    expect(JSON.stringify(body)).not.toContain("SECRET-MARKER");
  });

  it("START-13 the provider factory refusing (e.g. Mock outside local/test) → 503, nothing written", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const before = (await db.query(`SELECT count(*)::int n FROM identity_verifications`)).rows[0].n;
    const { status, body } = await call(req(), deps({ providerFactory: () => new MockIdentityProvider("production", ORIGIN) }));
    expect([status, body.error.code]).toEqual([503, "PROVIDER_UNAVAILABLE"]);
    expect((await db.query(`SELECT count(*)::int n FROM identity_verifications`)).rows[0].n).toBe(before);
  });
});

describe("START duplicates, expiry and state", () => {
  it("START-14 concurrent double start from one browser: one succeeds, the other gets 409 REQUEST_IN_PROGRESS", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const slow: IdentityProvider = {
      name: "MOCK",
      completeVerification: notUsed,
      startVerification: async (i) => {
        calls++;
        await gate;
        return new MockIdentityProvider("test", ORIGIN).startVerification(i);
      },
    };
    const binding = newBinding();
    const first = call(req({ binding }), deps({ provider: slow }));
    // wait until the first request's PENDING row exists, then send the second
    for (let t = 0; t < 100; t++) {
      const n = (await db.query(`SELECT count(*)::int n FROM identity_verifications WHERE browser_binding_hash = $1`, [sha256Hex(binding)])).rows[0].n;
      if (n === 1) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const second = await call(req({ binding }), deps({ provider: slow }));
    release();
    const a = await first;
    expect([a.status, second.status, second.body.error.code]).toEqual([200, 409, "REQUEST_IN_PROGRESS"]);
    expect(calls).toBe(1); // the provider was not called twice
  });

  it("START-15 truly simultaneous starts (no gate) never leave two PENDING rows for one binding+purpose", async () => {
    const binding = newBinding();
    const results = await Promise.all(Array.from({ length: 5 }, () => call(req({ binding }))));
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    for (const r of results) expect([200, 409]).toContain(r.status);
    const { rows } = await db.query(`SELECT count(*)::int n FROM identity_verifications WHERE browser_binding_hash = $1 AND status = 'PENDING'`, [sha256Hex(binding)]);
    expect(rows[0].n).toBe(1);
  });

  it("START-16 the database refuses a second PENDING for the same binding+purpose and a reused state hash", async () => {
    const r = req();
    const { body } = await call(r);
    const v = await row(body.verificationId);
    const ins = (binding: string, state: string) =>
      db.query(`INSERT INTO identity_verifications (purpose, provider, browser_binding_hash, state_nonce_hash, status, expires_at) VALUES ('BOOKING', 'MOCK', $1, $2, 'PENDING', now() + interval '1 minute')`, [binding, state]);
    await expect(ins(v.browser_binding_hash, sha256Hex(newBinding()))).rejects.toMatchObject({ code: "23505", constraint: "identity_verifications_pending_binding_uq" });
    await expect(ins(sha256Hex(newBinding()), v.state_nonce_hash)).rejects.toMatchObject({ code: "23505", constraint: "identity_verifications_state_nonce_uq" });
  });

  it("START-17 every start gets a fresh unpredictable state; the same state is never stored twice", async () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const { body } = await call(req());
      hashes.add((await row(body.verificationId)).state_nonce_hash);
    }
    expect(hashes.size).toBe(5);
    // with a forced constant random source the second start collides and fails (no silent reuse)
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fixed = (n: number) => Buffer.alloc(n, 9);
    expect((await call(req(), deps({ random: fixed }))).status).toBe(200);
    expect((await call(req(), deps({ random: fixed }))).status).toBe(500);
  });

  it("START-18 a start whose provider answer arrives after expiry is not stored as usable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const late: IdentityProvider = {
      name: "MOCK",
      completeVerification: notUsed,
      startVerification: async (i) => {
        await db.query(`UPDATE identity_verifications SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' WHERE id = $1`, [i.verificationId]);
        return new MockIdentityProvider("test", ORIGIN).startVerification(i);
      },
    };
    const r = req();
    const { status, body } = await call(r, deps({ provider: late }));
    expect([status, body.error.code]).toEqual([409, "REQUEST_IN_PROGRESS"]);
    const { rows } = await db.query(`SELECT provider_transaction_id FROM identity_verifications WHERE browser_binding_hash = $1`, [sha256Hex(r.binding!)]);
    expect(rows[0].provider_transaction_id).toBeNull();
  });

  it("START-19 an old stalled PENDING (provider never answered) does not block a new start; it is superseded", async () => {
    const binding = newBinding();
    await db.query(`INSERT INTO identity_verifications (purpose, provider, browser_binding_hash, state_nonce_hash, status, expires_at, created_at) VALUES ('BOOKING', 'MOCK', $1, $2, 'PENDING', now() + interval '5 minutes', now() - interval '1 minute')`, [sha256Hex(binding), sha256Hex(newBinding())]);
    const { status } = await call(req({ binding }));
    expect(status).toBe(200);
    const { rows } = await db.query(`SELECT status, failure_code FROM identity_verifications WHERE browser_binding_hash = $1 ORDER BY created_at`, [sha256Hex(binding)]);
    expect(rows).toEqual([{ status: "EXPIRED", failure_code: "SUPERSEDED" }, { status: "PENDING", failure_code: null }]);
  });

  it("START-20 nothing sensitive in logs: binding, state, CSRF key, IP", async () => {
    const logs: string[] = [];
    for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(JSON.stringify(a)));
    const ip = freshIp();
    const r = req({ ip });
    await call(r);
    await call(req({ ip }), deps({ provider: { name: "MOCK", completeVerification: notUsed, startVerification: async () => { throw new Error("boom " + r.binding); } } }));
    const all = logs.join("\n");
    for (const s of [r.binding!, CSRF_KEY, ip]) expect(all).not.toContain(s);
  });
});
