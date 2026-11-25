/**
 * CB-01~22 (A-050): Mock page control + identity callback against a real PostgreSQL server. The full chain is driven
 * through the real handlers: start (A-049) → mock complete (control route) → callback.
 */
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import type { SqlExecutor, TxRunner } from "../../../src/server/db/sql";
import { CLAIM_WINDOW_MS, handleIdentityCallback, type CallbackDeps } from "../../../src/server/identity/callback";
import { handleMockComplete, loadMockTransaction, type MockControlDeps } from "../../../src/server/identity/mock-control";
import { MockIdentityProvider } from "../../../src/server/identity/providers/mock";
import { MOCK_PERSONAS } from "../../../src/server/identity/providers/mock-personas";
import { ProviderUnavailableError, type IdentityProvider } from "../../../src/server/identity/providers/types";
import { handleStartVerification } from "../../../src/server/identity/start";
import { BINDING_COOKIE } from "../../../src/server/lib/cookies";
import { sha256Hex } from "../../../src/server/lib/crypto/hmac";
import { decryptPii } from "../../../src/server/lib/crypto/pii";
import { subjectKeyCandidates } from "../../../src/server/lib/crypto/subject-key";
import { issueCsrfToken } from "../../../src/server/lib/csrf";
import { loadSecurityConfig, parseKeyring, type Keyring } from "../../../src/server/lib/secrets";
import { parsePolicyOverrides } from "../../../src/server/rate-limit/policies";
import { RateLimiter } from "../../../src/server/rate-limit/service";
import { cloneTestDb, destroyTestDb, resolveTestServer, type TestDb } from "./helpers/pg";

const server = resolveTestServer();
let db: TestDb;
let pool: Pool;
beforeAll(async () => {
  db = await cloneTestDb(server, inject("templateDb"));
  pool = new Pool({ connectionString: db.url, max: 30 });
});
afterAll(async () => {
  await pool.end();
  await destroyTestDb(db);
});
let logs: string[] = [];
beforeAll(() => {
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(JSON.stringify(a)));
});
afterEach(() => {
  logs = logs.slice(-500);
});

const ORIGIN = "http://localhost:3000";
const k = () => randomBytes(32).toString("base64url");
const ring = (p: string): Keyring => parseKeyring({ [`${p}_KEYS`]: `v1:${k()}`, [`${p}_KEY_CURRENT`]: "v1" }, p, [])!;
const security = loadSecurityConfig({ NAZIR_APP_ORIGIN: ORIGIN, NAZIR_CSRF_KEYS: `v1:${k()}`, NAZIR_CSRF_KEY_CURRENT: "v1" }, "test");
const rlKeys = ring("R");
const ctxKeys = ring("C");
const subjectKeys = ring("S");
const piiKeys = ring("P");
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
const mock = new MockIdentityProvider("test", ORIGIN);
const cbDeps = (o: Partial<CallbackDeps> = {}): CallbackDeps => ({
  appOrigin: () => ORIGIN,
  provider: () => mock,
  contextKeys: () => ctxKeys,
  subjectKeys: () => subjectKeys,
  piiKeys: () => piiKeys,
  tx,
  ...o,
});
const mockDeps = (o: Partial<MockControlDeps> = {}): MockControlDeps => ({ enabled: () => true, appOrigin: () => ORIGIN, contextKeys: () => ctxKeys, tx, ...o });
let n = 1;

async function start(purpose = "BOOKING") {
  const binding = randomBytes(32).toString("base64url");
  const res = await handleStartVerification(
    new Request(`${ORIGIN}/api/v1/identity-verifications`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${BINDING_COOKIE}=${binding}`,
        origin: ORIGIN,
        "x-csrf-token": issueCsrfToken(security.csrfKeys, binding),
        "x-vercel-forwarded-for": `192.0.2.${n++ % 250}`,
      },
      body: JSON.stringify({ purpose }),
    }),
    {
      security: () => security,
      rateLimit: () => ({ limiter: new RateLimiter({ exec: exec(pool), keys: rlKeys, policies: parsePolicyOverrides({ NAZIR_RATE_LIMIT_POLICIES: "identity.start.ip=100000/600,identity.start.binding=100000/600" }) }), ipSource: { kind: "vercel" } }),
      provider: () => mock,
      contextKeys: () => ctxKeys,
      tx,
    },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  const txn = new URL(body.launch.url).searchParams.get("txn")!;
  return { binding, id: body.verificationId as string, txn, launch: body.launch.url as string };
}
async function complete(txn: string, outcome: string, origin: string | null = ORIGIN) {
  const form = new URLSearchParams({ txn, outcome });
  const h: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (origin) h.origin = origin;
  return handleMockComplete(new Request(`${ORIGIN}/api/v1/mock/identity/complete`, { method: "POST", headers: h, body: form }), mockDeps());
}
const callback = async (url: string, provider = "mock", deps = cbDeps()) => handleIdentityCallback(new Request(url), { provider }, deps);
const row = async (id: string) => (await db.query(`SELECT * FROM identity_verifications WHERE id = $1`, [id])).rows[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function flow(outcome = "success:A") {
  const s = await start();
  const c = await complete(s.txn, outcome);
  expect(c.status).toBe(303);
  return { ...s, callbackUrl: c.headers.get("location")! };
}
const subjectCount = async (): Promise<number> => (await db.query<{ n: number }>(`SELECT count(*)::int n FROM identity_subjects`)).rows[0].n;

describe("Mock page and control route", () => {
  it("CB-01 the page loads only a PENDING MOCK transaction; unknown/garbage txn → null; disabled env → null", async () => {
    const s = await start();
    expect(await loadMockTransaction(mockDeps(), s.txn)).toEqual({ id: s.id, purpose: "BOOKING" });
    expect(await loadMockTransaction(mockDeps(), "mock_" + "x".repeat(22))).toBeNull();
    expect(await loadMockTransaction(mockDeps(), "not-a-txn")).toBeNull();
    expect(await loadMockTransaction(mockDeps({ enabled: () => false }), s.txn)).toBeNull();
  });

  it("CB-02 production/staging (disabled): control route answers 404 and changes nothing", async () => {
    const s = await start();
    const res = await handleMockComplete(new Request(`${ORIGIN}/x`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ txn: s.txn, outcome: "success:A" }) }), mockDeps({ enabled: () => false }));
    expect(res.status).toBe(404);
    expect(() => new MockIdentityProvider("production", ORIGIN)).toThrow();
    expect((await row(s.id)).status).toBe("PENDING");
  });

  it("CB-03 control route: foreign Origin 403, bad outcome/persona 400, second completion 410; redirect goes only to the stored callback", async () => {
    const s = await start();
    expect((await complete(s.txn, "success:A", "https://evil.example")).status).toBe(403);
    expect((await complete(s.txn, "success:A", null)).status).toBe(403);
    expect((await complete(s.txn, "success:Z")).status).toBe(400);
    expect((await complete(s.txn, "di=MOCK-DI-anyone")).status).toBe(400);
    const ok = await complete(s.txn, "success:A");
    const loc = new URL(ok.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(`${ORIGIN}/api/v1/identity-verifications/callback/mock`);
    expect(loc.searchParams.get("mock_result")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect((await complete(s.txn, "success:B")).status).toBe(410);
    expect(await loadMockTransaction(mockDeps(), s.txn)).toBeNull();
  });
});

describe("Callback outcomes", () => {
  it("CB-04 success → VERIFIED: subject from DI HMAC, name/phone AES-GCM, verified_at, claim window, context cleared, binding kept; 303 without state", async () => {
    const f = await flow("success:A");
    const before = await row(f.id);
    const { response, result } = await callback(f.callbackUrl);
    expect(result).toBe("VERIFIED");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/identity/complete?vid=${f.id}`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const v = await row(f.id);
    expect(v).toMatchObject({ status: "VERIFIED", provider: "MOCK", provider_context_encrypted: null, failure_code: null, browser_binding_hash: sha256Hex(f.binding) });
    expect(v.browser_binding_hash).toBe(before.browser_binding_hash);
    expect(v.verified_at).toBeInstanceOf(Date);
    const win = (await db.query(`SELECT extract(epoch FROM claim_expires_at - verified_at) * 1000 ms FROM identity_verifications WHERE id = $1`, [f.id])).rows[0].ms;
    expect(Number(win)).toBe(CLAIM_WINDOW_MS);
    expect(v.verified_name).not.toContain("테스트");
    expect(decryptPii(piiKeys, "identity_verifications.verified_name", v.verified_name)).toBe(MOCK_PERSONAS.A.name);
    expect(decryptPii(piiKeys, "identity_verifications.verified_phone", v.verified_phone)).toBe(MOCK_PERSONAS.A.phone);
    const subj = (await db.query(`SELECT * FROM identity_subjects WHERE id = $1`, [v.identity_subject_id])).rows[0];
    expect(subj).toMatchObject({ subject_key_type: "DI", key_version: 1, subject_key_hash: subjectKeyCandidates(subjectKeys, MOCK_PERSONAS.A.di)[0].hash });
    const dump = (await db.query(`SELECT row_to_json(v)::text t FROM identity_verifications v WHERE id = $1`, [f.id])).rows[0].t + JSON.stringify(subj);
    for (const m of [MOCK_PERSONAS.A.di, MOCK_PERSONAS.A.name, MOCK_PERSONAS.A.phone]) expect(dump).not.toContain(m);
  });

  it("CB-05 cancel → FAILED USER_CANCELED; CB-06 fail → FAILED PROVIDER_FAILED; no subject, no PII", async () => {
    for (const [outcome, code] of [["cancel", "USER_CANCELED"], ["fail", "PROVIDER_FAILED"]] as const) {
      const before = await subjectCount();
      const f = await flow(outcome);
      const { result, response } = await callback(f.callbackUrl);
      expect(result).toBe(outcome === "cancel" ? "CANCELED" : "FAILED");
      expect(response.headers.get("location")).toBe(`${ORIGIN}/identity/complete?vid=${f.id}`);
      expect(await row(f.id)).toMatchObject({ status: "FAILED", failure_code: code, identity_subject_id: null, verified_name: null, verified_phone: null, provider_context_encrypted: null });
      expect(await subjectCount()).toBe(before);
    }
  });

  it("CB-07 the same person verified twice gets the same subject; another persona another subject", async () => {
    const a1 = await flow("success:B");
    await callback(a1.callbackUrl);
    const a2 = await flow("success:B");
    await callback(a2.callbackUrl);
    const c = await flow("success:C");
    await callback(c.callbackUrl);
    const [r1, r2, r3] = [await row(a1.id), await row(a2.id), await row(c.id)];
    expect(r1.identity_subject_id).toBe(r2.identity_subject_id);
    expect(r3.identity_subject_id).not.toBe(r1.identity_subject_id);
  });
});

describe("Callback validation (fail-closed)", () => {
  it.each([
    ["missing", (u: URL) => u.searchParams.delete("state")],
    ["malformed", (u: URL) => u.searchParams.set("state", "abc")],
    ["duplicated", (u: URL) => u.searchParams.append("state", u.searchParams.get("state")!)],
  ])("CB-08 state %s → 303 without vid, row unchanged", async (_, mutate) => {
    const f = await flow();
    const u = new URL(f.callbackUrl);
    mutate(u);
    const { result, response } = await callback(u.toString());
    expect(result).toBe("INVALID_REQUEST");
    expect(response.headers.get("location")).toBe(`${ORIGIN}/identity/complete`);
    expect((await row(f.id)).status).toBe("PENDING");
  });

  it("CB-09 a well-formed but unknown state → UNKNOWN_STATE, nothing changes", async () => {
    const f = await flow();
    const u = new URL(f.callbackUrl);
    u.searchParams.set("state", randomBytes(32).toString("base64url"));
    expect((await callback(u.toString())).result).toBe("UNKNOWN_STATE");
    expect((await row(f.id)).status).toBe("PENDING");
  });

  it("CB-10 other provider in the path, or a row of another provider → PROVIDER_MISMATCH, nothing changes", async () => {
    const f = await flow();
    const u = new URL(f.callbackUrl);
    u.pathname = "/api/v1/identity-verifications/callback/nice";
    expect((await callback(u.toString(), "nice")).result).toBe("PROVIDER_MISMATCH");
    const g = await flow();
    await db.query(`UPDATE identity_verifications SET provider = 'NICE' WHERE id = $1`, [g.id]);
    expect((await callback(g.callbackUrl)).result).toBe("PROVIDER_MISMATCH");
    expect((await row(f.id)).status).toBe("PENDING");
    expect((await row(g.id)).status).toBe("PENDING");
  });

  it("CB-11 forged callback: right state but missing / wrong mock_result → FAILED INTEGRITY_FAILED", async () => {
    const f = await flow();
    const u = new URL(f.callbackUrl);
    u.searchParams.set("mock_result", randomBytes(32).toString("base64url"));
    expect((await callback(u.toString())).result).toBe("INTEGRITY_FAILED");
    expect(await row(f.id)).toMatchObject({ status: "FAILED", failure_code: "INTEGRITY_FAILED", identity_subject_id: null });
    // the right state without the result token is rejected as well
    const g = await flow();
    const v = new URL(g.callbackUrl);
    v.searchParams.delete("mock_result");
    expect((await callback(v.toString())).result).toBe("INTEGRITY_FAILED");
  });

  it("CB-12 an expired transaction → EXPIRED (DB time), context cleared, no subject", async () => {
    const f = await flow();
    await db.query(`UPDATE identity_verifications SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 second' WHERE id = $1`, [f.id]);
    const before = await subjectCount();
    expect((await callback(f.callbackUrl)).result).toBe("EXPIRED");
    expect(await row(f.id)).toMatchObject({ status: "EXPIRED", failure_code: "EXPIRED_BEFORE_CALLBACK", provider_context_encrypted: null });
    expect(await subjectCount()).toBe(before);
  });

  it("CB-13 replay after success / after failure → ALREADY_PROCESSED, same 303, nothing re-applied", async () => {
    const f = await flow("success:A");
    await callback(f.callbackUrl);
    const snap = await row(f.id);
    const again = await callback(f.callbackUrl);
    expect(again.result).toBe("ALREADY_PROCESSED");
    expect(again.response.headers.get("location")).toBe(`${ORIGIN}/identity/complete?vid=${f.id}`);
    expect(await row(f.id)).toEqual(snap);
    const g = await flow("cancel");
    await callback(g.callbackUrl);
    expect((await callback(g.callbackUrl)).result).toBe("ALREADY_PROCESSED");
  });
});

describe("Concurrency and rollback", () => {
  it("CB-14 20 simultaneous callbacks with the same state: exactly one VERIFIED, one subject, the rest ALREADY_PROCESSED", async () => {
    const f = await flow("success:C");
    const before = await subjectCount();
    const results = await Promise.all(Array.from({ length: 20 }, () => callback(f.callbackUrl)));
    expect(results.filter((r) => r.result === "VERIFIED")).toHaveLength(1);
    expect(results.filter((r) => r.result === "ALREADY_PROCESSED")).toHaveLength(19);
    expect(await subjectCount()).toBeLessThanOrEqual(before + 1);
    expect((await row(f.id)).status).toBe("VERIFIED");
  });

  it("CB-15 two different transactions of the SAME new person completing at once create one subject", async () => {
    const persona = "success:A";
    const fresh = ring("S2"); // a keyring under which persona A is new
    const flows = await Promise.all(Array.from({ length: 6 }, () => flow(persona)));
    const res = await Promise.all(flows.map((f) => callback(f.callbackUrl, "mock", cbDeps({ subjectKeys: () => fresh }))));
    expect(res.every((r) => r.result === "VERIFIED")).toBe(true);
    const ids = new Set(await Promise.all(flows.map(async (f) => (await row(f.id)).identity_subject_id)));
    expect(ids.size).toBe(1);
  });

  it("CB-16 an error inside the transition transaction rolls everything back: still PENDING, no subject, retry succeeds", async () => {
    const f = await flow("success:B");
    const fresh = ring("S3");
    const before = await subjectCount();
    const broken = cbDeps({ subjectKeys: () => fresh, piiKeys: () => { throw new Error("pii key missing"); } });
    const r = await callback(f.callbackUrl, "mock", broken);
    expect(r.result).toBe("PROVIDER_UNAVAILABLE");
    expect(await row(f.id)).toMatchObject({ status: "PENDING", identity_subject_id: null });
    expect(await subjectCount()).toBe(before); // the subject INSERT was rolled back
    expect((await callback(f.callbackUrl, "mock", cbDeps({ subjectKeys: () => fresh }))).result).toBe("VERIFIED");
  });

  it("CB-17 provider unavailable at completion → row stays PENDING (no state change)", async () => {
    const f = await flow();
    const down: IdentityProvider = { name: "MOCK", startVerification: mock.startVerification.bind(mock), completeVerification: async () => { throw new ProviderUnavailableError("down"); } };
    expect((await callback(f.callbackUrl, "mock", cbDeps({ provider: () => down }))).result).toBe("PROVIDER_UNAVAILABLE");
    expect((await row(f.id)).status).toBe("PENDING");
  });

  it("CB-18 no DI in the provider result → FAILED DI_UNAVAILABLE, no CI/phone fallback, no subject", async () => {
    const f = await flow();
    const noDi: IdentityProvider = { name: "MOCK", startVerification: mock.startVerification.bind(mock), completeVerification: async () => ({ kind: "VERIFIED", di: "", name: "테스트", phone: "01000000009" }) };
    const before = await subjectCount();
    expect((await callback(f.callbackUrl, "mock", cbDeps({ provider: () => noDi }))).result).toBe("FAILED");
    expect(await row(f.id)).toMatchObject({ status: "FAILED", failure_code: "DI_UNAVAILABLE", identity_subject_id: null, verified_name: null });
    expect(await subjectCount()).toBe(before);
  });

  it("CB-19 malformed identity fields from a provider are an integrity failure", async () => {
    const f = await flow();
    const bad: IdentityProvider = { name: "MOCK", startVerification: mock.startVerification.bind(mock), completeVerification: async () => ({ kind: "VERIFIED", di: "MOCK-DI-X-NOT-REAL", name: "", phone: "123" }) };
    expect((await callback(f.callbackUrl, "mock", cbDeps({ provider: () => bad }))).result).toBe("INTEGRITY_FAILED");
  });
});

describe("Binding relation, Mock fence and logs", () => {
  it("CB-20 the verified row keeps the starting browser's binding: a session for another browser is refused by the DB", async () => {
    const f = await flow("success:A");
    await callback(f.callbackUrl);
    const v = await row(f.id);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`UPDATE identity_verifications SET status = 'CONSUMED' WHERE id = $1`, [f.id]);
      await expect(
        c.query(`INSERT INTO identity_sessions (identity_verification_id, identity_subject_id, purpose, token_hash, browser_binding_hash, status, expires_at) VALUES ($1, $2, 'BOOKING', $3, $4, 'ACTIVE', now() + interval '30 minutes')`, [f.id, v.identity_subject_id, sha256Hex(k()), sha256Hex(k())]),
      ).rejects.toMatchObject({ code: "23503" });
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("CB-21 a callback never sets a cookie or reads one", async () => {
    const f = await flow();
    const r = await handleIdentityCallback(new Request(f.callbackUrl, { headers: { cookie: `${BINDING_COOKIE}=${randomBytes(32).toString("base64url")}` } }), { provider: "mock" }, cbDeps());
    expect(r.response.headers.get("set-cookie")).toBeNull();
    expect(r.result).toBe("VERIFIED");
  });

  it("CB-22 logs contain no state, result token, DI, name or phone", async () => {
    logs = [];
    const f = await flow("success:A");
    await callback(f.callbackUrl);
    await callback(f.callbackUrl);
    const u = new URL(f.callbackUrl);
    const all = logs.join("\n");
    for (const s of [u.searchParams.get("state")!, u.searchParams.get("mock_result")!, MOCK_PERSONAS.A.di, MOCK_PERSONAS.A.name, MOCK_PERSONAS.A.phone]) expect(all).not.toContain(s);
    expect(all).toContain("VERIFIED");
  });
});

describe("Through the application Prisma client", () => {
  it("CB-23 start + mock complete + callback work over Prisma interactive transactions (regression: void columns)", async () => {
    vi.stubEnv("NAZIR_RUNTIME_ENV", "test");
    vi.stubEnv("DATABASE_URL", db.url);
    vi.stubEnv("PAYMENT_PROVIDER", "mock");
    vi.stubEnv("IDENTITY_PROVIDER", "mock");
    vi.resetModules();
    const { getPrisma } = await import("../../../src/server/db/client");
    const prisma = getPrisma();
    const ptx: TxRunner = (fn) => prisma.$transaction((t) => fn((sql, params) => t.$queryRawUnsafe(sql, ...params)), { isolationLevel: "ReadCommitted" });
    try {
      const binding = randomBytes(32).toString("base64url");
      const res = await handleStartVerification(
        new Request(`${ORIGIN}/api/v1/identity-verifications`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: `${BINDING_COOKIE}=${binding}`, origin: ORIGIN, "x-csrf-token": issueCsrfToken(security.csrfKeys, binding), "x-vercel-forwarded-for": "192.0.2.250" },
          body: JSON.stringify({ purpose: "BOOKING" }),
        }),
        {
          security: () => security,
          rateLimit: () => ({ limiter: new RateLimiter({ exec: (sql, p) => prisma.$queryRawUnsafe(sql, ...p), keys: rlKeys, policies: parsePolicyOverrides({}) }), ipSource: { kind: "vercel" } }),
          provider: () => mock,
          contextKeys: () => ctxKeys,
          tx: ptx,
        },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      const txn = new URL(body.launch.url).searchParams.get("txn")!;
      const done = await handleMockComplete(
        new Request(`${ORIGIN}/x`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ txn, outcome: "success:B" }) }),
        mockDeps({ tx: ptx }),
      );
      expect(done.status).toBe(303);
      const r = await handleIdentityCallback(new Request(done.headers.get("location")!), { provider: "mock" }, cbDeps({ tx: ptx }));
      expect(r.result).toBe("VERIFIED");
      expect((await row(body.verificationId)).status).toBe("VERIFIED");
    } finally {
      await prisma.$disconnect();
      delete (globalThis as { __nazirPrisma?: unknown }).__nazirPrisma;
      vi.unstubAllEnvs();
    }
  });
});
