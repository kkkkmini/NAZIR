/**
 * CLM-01~20, SES-01~09, M7-01~03 (A-051) against a real PostgreSQL server through the APPLICATION Prisma client
 * (interactive READ COMMITTED transactions), so statement- and COMMIT-time error shapes are the real ones.
 * Verifications are created by the real start → mock → callback chain.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import type { TxRunner } from "../../../src/server/db/sql";
import { dbConstraintOf } from "../../../src/server/db/errors";
import { handleIdentityCallback } from "../../../src/server/identity/callback";
import { handleMockComplete } from "../../../src/server/identity/mock-control";
import { MockIdentityProvider } from "../../../src/server/identity/providers/mock";
import { RECOVERY_WINDOW_MS, SESSION_TTL_MS, handleClaim, handleDeleteSession, handleGetSession, mapClaimDbError, maskName, type SessionDeps } from "../../../src/server/identity/session";
import { handleStartVerification } from "../../../src/server/identity/start";
import { BINDING_COOKIE, IDENTITY_SESSION_COOKIE } from "../../../src/server/lib/cookies";
import { sha256Hex } from "../../../src/server/lib/crypto/hmac";
import { issueCsrfToken } from "../../../src/server/lib/csrf";
import { loadSecurityConfig, parseKeyring, type Keyring } from "../../../src/server/lib/secrets";
import { parsePolicyOverrides } from "../../../src/server/rate-limit/policies";
import { RateLimiter } from "../../../src/server/rate-limit/service";
import { cloneTestDb, destroyTestDb, resolveTestServer, type TestDb } from "./helpers/pg";

const server = resolveTestServer();
let db: TestDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
let ptx: TxRunner;
let logs: string[] = [];
beforeAll(async () => {
  db = await cloneTestDb(server, inject("templateDb"));
  vi.stubEnv("NAZIR_RUNTIME_ENV", "test");
  vi.stubEnv("DATABASE_URL", db.url);
  vi.stubEnv("PAYMENT_PROVIDER", "mock");
  vi.stubEnv("IDENTITY_PROVIDER", "mock");
  vi.resetModules();
  const { getPrisma } = await import("../../../src/server/db/client");
  prisma = getPrisma();
  ptx = (fn) => prisma.$transaction((t: { $queryRawUnsafe: (s: string, ...p: unknown[]) => Promise<never> }) => fn((sql, params) => t.$queryRawUnsafe(sql, ...params)), { isolationLevel: "ReadCommitted" });
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(JSON.stringify(a)));
});
afterAll(async () => {
  await prisma.$disconnect();
  delete (globalThis as { __nazirPrisma?: unknown }).__nazirPrisma;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await destroyTestDb(db);
});

const ORIGIN = "http://localhost:3000";
const k = () => randomBytes(32).toString("base64url");
const ring = (p: string): Keyring => parseKeyring({ [`${p}_KEYS`]: `v1:${k()}`, [`${p}_KEY_CURRENT`]: "v1" }, p, [])!;
const security = loadSecurityConfig({ NAZIR_APP_ORIGIN: ORIGIN, NAZIR_CSRF_KEYS: `v1:${k()}`, NAZIR_CSRF_KEY_CURRENT: "v1" }, "test");
const [rlKeys, ctxKeys, subjectKeys, piiKeys] = [ring("R"), ring("C"), ring("S"), ring("P")];
const mock = new MockIdentityProvider("test", ORIGIN);
const deps = (o: Partial<SessionDeps> = {}): SessionDeps => ({ security: () => security, piiKeys: () => piiKeys, tx: ptx, ...o });
const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as T[];
let ipN = 1;

/** Runs start → mock → callback for a browser; returns its verification id (VERIFIED unless outcome says otherwise). */
async function verified(binding: string, outcome = "success:A", purpose = "BOOKING") {
  const res = await handleStartVerification(
    new Request(`${ORIGIN}/api/v1/identity-verifications`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${BINDING_COOKIE}=${binding}`, origin: ORIGIN, "x-csrf-token": issueCsrfToken(security.csrfKeys, binding), "x-vercel-forwarded-for": `192.0.2.${ipN++ % 250}` },
      body: JSON.stringify({ purpose }),
    }),
    {
      security: () => security,
      rateLimit: () => ({ limiter: new RateLimiter({ exec: (s, p) => prisma.$queryRawUnsafe(s, ...p), keys: rlKeys, policies: parsePolicyOverrides({ NAZIR_RATE_LIMIT_POLICIES: "identity.start.ip=100000/600,identity.start.binding=100000/600" }) }), ipSource: { kind: "vercel" } }),
      provider: () => mock,
      contextKeys: () => ctxKeys,
      tx: ptx,
    },
  );
  const body = await res.json();
  const txn = new URL(body.launch.url).searchParams.get("txn")!;
  const done = await handleMockComplete(new Request(`${ORIGIN}/x`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ txn, outcome }) }), { enabled: () => true, appOrigin: () => ORIGIN, contextKeys: () => ctxKeys, tx: ptx });
  await handleIdentityCallback(new Request(done.headers.get("location")!), { provider: "mock" }, { appOrigin: () => ORIGIN, provider: () => mock, contextKeys: () => ctxKeys, subjectKeys: () => subjectKeys, piiKeys: () => piiKeys, tx: ptx });
  return body.verificationId as string;
}
const newBinding = () => randomBytes(32).toString("base64url");
function claimReq(id: string, binding: string | null, o: { origin?: string | null; token?: string | null; body?: string } = {}) {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (binding) h.cookie = `${BINDING_COOKIE}=${binding}`;
  if (o.origin !== null) h.origin = o.origin ?? ORIGIN;
  const t = o.token === undefined ? (binding ? issueCsrfToken(security.csrfKeys, binding) : null) : o.token;
  if (t) h["x-csrf-token"] = t;
  return new Request(`${ORIGIN}/api/v1/identity-verifications/${id}/claim`, { method: "POST", headers: h, body: o.body ?? "" });
}
async function claim(id: string, binding: string | null, o: Parameters<typeof claimReq>[2] = {}, d = deps()) {
  const res = await handleClaim(claimReq(id, binding, o), { id }, d);
  const setCookie = res.headers.get("set-cookie");
  const token = setCookie?.startsWith(`${IDENTITY_SESSION_COOKIE}=`) ? setCookie.split(";")[0].split("=")[1] : null;
  return { res, status: res.status, body: await res.json(), setCookie, token };
}
const sessionReq = (method: "GET" | "DELETE", binding: string | null, token: string | null, o: { origin?: string | null } = {}) => {
  const cookies = [binding && `${BINDING_COOKIE}=${binding}`, token && `${IDENTITY_SESSION_COOKIE}=${token}`].filter(Boolean).join("; ");
  const h: Record<string, string> = {};
  if (cookies) h.cookie = cookies;
  if (method === "DELETE") {
    if (o.origin !== null) h.origin = o.origin ?? ORIGIN;
    if (binding) h["x-csrf-token"] = issueCsrfToken(security.csrfKeys, binding);
  }
  return new Request(`${ORIGIN}/api/v1/identity-session`, { method, headers: h });
};
const getSession = async (binding: string | null, token: string | null) => {
  const res = await handleGetSession(sessionReq("GET", binding, token), deps());
  return { status: res.status, body: await res.json(), cc: res.headers.get("cache-control") };
};
const verification = async (id: string) => (await q(`SELECT status FROM identity_verifications WHERE id = $1`, [id]))[0]?.status;
const sessionsOf = async (id: string) => q<{ status: string; token_hash: string; expires_at: Date; id: string }>(`SELECT id, status, token_hash, expires_at FROM identity_sessions WHERE identity_verification_id = $1`, [id]);

describe("CLM claim", () => {
  it("CLM-01 same browser claims a VERIFIED verification: CONSUMED + one ACTIVE BOOKING session, 30 min fixed, cookie attributes, token only in the cookie", async () => {
    const b = newBinding();
    const id = await verified(b, "success:A");
    const r = await claim(id, b);
    expect(r.status).toBe(200);
    expect(r.res.headers.get("cache-control")).toBe("no-store");
    expect(r.body).toMatchObject({ purpose: "BOOKING", displayName: maskName("테스트사용자A") });
    expect(r.body.displayName).toBe("테*****A");
    const attrs = r.setCookie!.split("; ").slice(1).sort();
    expect(attrs.filter((a) => !a.startsWith("Max-Age"))).toEqual(["HttpOnly", "Path=/", "SameSite=Lax", "Secure"]);
    const maxAge = Number(attrs.find((a) => a.startsWith("Max-Age"))!.split("=")[1]);
    expect(maxAge).toBeGreaterThan(SESSION_TTL_MS.BOOKING / 1000 - 5);
    expect(maxAge).toBeLessThanOrEqual(SESSION_TTL_MS.BOOKING / 1000);
    expect(r.setCookie).not.toMatch(/domain/i);
    expect(JSON.stringify(r.body)).not.toContain(r.token!);
    expect(await verification(id)).toBe("CONSUMED");
    const s = await sessionsOf(id);
    expect(s).toHaveLength(1);
    expect(s[0].status).toBe("ACTIVE");
    expect(s[0].token_hash).toBe(sha256Hex(r.token!));
    const ttl = (await q<{ ms: string }>(`SELECT extract(epoch FROM expires_at - created_at) * 1000 ms FROM identity_sessions WHERE id = $1`, [s[0].id]))[0].ms;
    expect(Number(ttl)).toBe(SESSION_TTL_MS.BOOKING);
    expect(JSON.stringify(await q(`SELECT * FROM identity_sessions`))).not.toContain(r.token!);
  });

  it("CLM-02 another browser cannot claim: 401 BROWSER_BINDING_MISMATCH, nothing changes", async () => {
    const id = await verified(newBinding());
    const r = await claim(id, newBinding());
    expect([r.status, r.body.error.code, r.setCookie]).toEqual([401, "BROWSER_BINDING_MISMATCH", null]);
    expect(await verification(id)).toBe("VERIFIED");
    expect(await sessionsOf(id)).toHaveLength(0);
  });

  it("CLM-03 not VERIFIED (PENDING / FAILED / cancelled / EXPIRED) → 422 IDENTITY_VERIFICATION_FAILED", async () => {
    const b = newBinding();
    for (const outcome of ["cancel", "fail"]) {
      const id = await verified(b, outcome);
      const r = await claim(id, b);
      expect([r.status, r.body.error.code]).toEqual([422, "IDENTITY_VERIFICATION_FAILED"]);
    }
    const b2 = newBinding();
    const id2 = await verified(b2);
    await db.query(`UPDATE identity_verifications SET status = 'EXPIRED' WHERE id = $1`, [id2]);
    expect((await claim(id2, b2)).status).toBe(422);
  });

  it("CLM-04 unknown id 404, malformed id or a body with fields 400", async () => {
    const b = newBinding();
    expect((await claim("00000000-0000-4000-8000-00000000abcd", b)).status).toBe(404);
    const bad = await handleClaim(claimReq("not-a-uuid", b), { id: "not-a-uuid" }, deps());
    expect(bad.status).toBe(400);
    const id = await verified(b);
    for (const body of ['{"subjectId":"x"}', '{"purpose":"BOOKING"}', "[]", "nope"]) expect((await claim(id, b, { body })).status).toBe(400);
    expect((await claim(id, b, { body: "{}" })).status).toBe(200);
  });

  it("CLM-05 claim window (DB time): before → ok; exactly at claim_expires_at → refused; 5 minutes later → refused", async () => {
    const b = newBinding();
    const win = (await q<{ ms: string }>(`SELECT extract(epoch FROM claim_expires_at - verified_at) * 1000 ms FROM identity_verifications WHERE id = $1`, [await verified(b)]))[0].ms;
    expect(Number(win)).toBe(5 * 60_000); // A-051: confirmed 5 minutes from verified_at
    const at = newBinding();
    const idAt = await verified(at);
    // claim_expires_at == now(): set it to the claim transaction's own now() via a trigger-free trick — a value in the past by 0 ms is not reachable
    // across transactions, so the boundary is checked with an expiry a few ms in the past and one far in the future.
    await db.query(`UPDATE identity_verifications SET verified_at = now() - interval '5 minutes', claim_expires_at = now() WHERE id = $1`, [idAt]);
    expect((await claim(idAt, at)).status).toBe(422);
    const late = newBinding();
    const idLate = await verified(late);
    await db.query(`UPDATE identity_verifications SET verified_at = now() - interval '5 minutes 1 second', claim_expires_at = now() - interval '1 second' WHERE id = $1`, [idLate]);
    expect((await claim(idLate, late)).status).toBe(422);
    expect(await verification(idLate)).toBe("VERIFIED");
    const ok = newBinding();
    const idOk = await verified(ok);
    await db.query(`UPDATE identity_verifications SET claim_expires_at = now() + interval '2 seconds' WHERE id = $1`, [idOk]);
    expect((await claim(idOk, ok)).status).toBe(200);
  });

  it("CLM-06 CSRF: missing token / wrong Origin / no binding cookie are refused before any DB change", async () => {
    const b = newBinding();
    const id = await verified(b);
    expect((await claim(id, b, { token: null })).body.error.code).toBe("CSRF_REJECTED");
    expect((await claim(id, b, { origin: "https://evil.example" })).body.error.code).toBe("CSRF_REJECTED");
    expect((await claim(id, b, { origin: null })).body.error.code).toBe("CSRF_REJECTED");
    expect((await claim(id, null)).body.error.code).toBe("BROWSER_BINDING_REQUIRED");
    expect((await claim(id, "!".repeat(43))).body.error.code).toBe("BROWSER_BINDING_REQUIRED");
    expect(await verification(id)).toBe("VERIFIED");
  });

  it("CLM-07 re-claim of a CONSUMED verification whose session was used → 422; same-browser re-auth revokes the old session (IDV-15)", async () => {
    const b = newBinding();
    const id = await verified(b);
    const first = await claim(id, b);
    expect((await getSession(b, first.token)).status).toBe(200); // used
    expect((await claim(id, b)).status).toBe(422);
    const id2 = await verified(b, "success:A");
    const second = await claim(id2, b);
    expect(second.status).toBe(200);
    expect((await sessionsOf(id))[0].status).toBe("REVOKED");
    expect((await getSession(b, first.token)).status).toBe(401);
    expect((await getSession(b, second.token)).status).toBe(200);
  });

  it("CLM-08 response lost: the same browser re-claims within the window → same session row, new token, old token dead, no extension", async () => {
    const b = newBinding();
    const id = await verified(b);
    const lost = await claim(id, b); // pretend this response never arrived
    const before = (await sessionsOf(id))[0];
    const retry = await claim(id, b);
    expect(retry.status).toBe(200);
    expect(retry.token).not.toBe(lost.token);
    const after = await sessionsOf(id);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before.id);
    expect(after[0].expires_at.getTime()).toBe(before.expires_at.getTime());
    expect((await getSession(b, lost.token)).status).toBe(401);
    expect((await getSession(b, retry.token)).status).toBe(200);
    // ...but not from another browser
    expect((await claim(id, newBinding())).status).toBe(401);
    expect(await verification(id)).toBe("CONSUMED");
  });

  it("CLM-09 recovery is refused once the session was used, revoked or expired", async () => {
    for (const how of ["used", "revoked", "expired"]) {
      const b = newBinding();
      const id = await verified(b);
      const c = await claim(id, b);
      if (how === "used") await getSession(b, c.token);
      if (how === "revoked") await handleDeleteSession(sessionReq("DELETE", b, c.token), deps());
      if (how === "expired") await db.query(`UPDATE identity_sessions SET expires_at = now() - interval '1 second', created_at = now() - interval '31 minutes' WHERE identity_verification_id = $1`, [id]);
      expect((await claim(id, b)).status, how).toBe(422);
    }
  });

  it("CLM-10 the same claim 15× at once: exactly one 200 (or 200 + recoveries of the SAME session), never two sessions", async () => {
    const b = newBinding();
    const id = await verified(b);
    const rs = await Promise.all(Array.from({ length: 15 }, () => claim(id, b)));
    for (const r of rs) expect([200, 422]).toContain(r.status);
    const s = await sessionsOf(id);
    expect(s).toHaveLength(1);
    expect(s[0].status).toBe("ACTIVE");
    // exactly one of the issued tokens is live: the one whose hash is stored
    const live = rs.filter((r) => r.token && sha256Hex(r.token) === s[0].token_hash);
    expect(live).toHaveLength(1);
    // a later request never revoked the session created by an earlier one
    expect((await q(`SELECT count(*)::int n FROM identity_sessions WHERE browser_binding_hash = $1 AND status = 'REVOKED'`, [sha256Hex(b)]))[0].n).toBe(0);
  });

  it("CLM-11 two different verifications of one browser claimed at once: one ACTIVE session at the end, no constraint error leaks", async () => {
    const b = newBinding();
    const id1 = await verified(b, "success:A");
    // a second VERIFIED one for the same browser (started after the first was verified)
    const id2 = await verified(b, "success:B");
    const [r1, r2] = await Promise.all([claim(id1, b), claim(id2, b)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 200]);
    const active = await q(`SELECT identity_verification_id FROM identity_sessions WHERE browser_binding_hash = $1 AND purpose = 'BOOKING' AND status = 'ACTIVE'`, [sha256Hex(b)]);
    expect(active).toHaveLength(1);
  });

  it("CLM-12 LOOKUP sessions are separate from BOOKING sessions of the same browser", async () => {
    const b = newBinding();
    const book = await claim(await verified(b, "success:A", "BOOKING"), b);
    const look = await claim(await verified(b, "success:A", "LOOKUP"), b);
    expect(look.body.purpose).toBe("LOOKUP");
    expect((await getSession(b, book.token)).status).toBe(200);
    expect((await getSession(b, look.token)).body.purpose).toBe("LOOKUP");
  });
});

describe("REC claim response-loss recovery (A-052)", () => {
  const sessionRow = async (id: string) =>
    (await q<{ id: string; token_hash: string; expires_at: Date; status: string }>(`SELECT id, token_hash, expires_at, status FROM identity_sessions WHERE identity_verification_id = $1`, [id]))[0];
  // move the session's creation (= first claim's transaction time) back by `ms`, keeping its 30-minute lifetime intact
  const ageSession = (id: string, ms: number) =>
    db.query(`UPDATE identity_sessions SET created_at = now() - $2::int * interval '1 millisecond' WHERE identity_verification_id = $1`, [id, ms]);

  it("REC-01 window is 5 minutes from the first claim (session created_at, DB time): 4m59s ok, exactly 5m refused, 5m01s refused", async () => {
    expect(RECOVERY_WINDOW_MS).toBe(5 * 60_000);
    for (const [ageMs, ok] of [[RECOVERY_WINDOW_MS - 1000, true], [RECOVERY_WINDOW_MS, false], [RECOVERY_WINDOW_MS + 1000, false]] as const) {
      const b = newBinding();
      const id = await verified(b);
      await claim(id, b);
      await ageSession(id, ageMs);
      expect((await claim(id, b)).status, `age ${ageMs}`).toBe(ok ? 200 : 422);
    }
  });

  it("REC-02 independent of claim_expires_at: claim_expires_at already passed but within 5 min of the claim → recovered", async () => {
    const b = newBinding();
    const id = await verified(b);
    await claim(id, b);
    await db.query(`UPDATE identity_verifications SET claim_expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
    const r = await claim(id, b);
    expect(r.status).toBe(200);
    // and the reverse: claim window still open, recovery window passed → refused
    const b2 = newBinding();
    const id2 = await verified(b2);
    await claim(id2, b2);
    await ageSession(id2, RECOVERY_WINDOW_MS + 1000);
    await db.query(`UPDATE identity_verifications SET claim_expires_at = now() + interval '1 minute' WHERE id = $1`, [id2]);
    expect((await claim(id2, b2)).status).toBe(422);
  });

  it("REC-03 recovery keeps the row, the expiry and CONSUMED; only the token hash changes; the old token dies", async () => {
    const b = newBinding();
    const id = await verified(b);
    const lost = await claim(id, b);
    const before = await sessionRow(id);
    const rec = await claim(id, b);
    const after = await sessionRow(id);
    expect([after.id, after.status, after.expires_at.getTime()]).toEqual([before.id, "ACTIVE", before.expires_at.getTime()]);
    expect(after.token_hash).toBe(sha256Hex(rec.token!));
    expect(after.token_hash).not.toBe(before.token_hash);
    expect(await verification(id)).toBe("CONSUMED");
    expect((await getSession(b, lost.token)).status).toBe(401);
    expect(new Date(rec.body.expiresAt).getTime()).toBe(Math.floor(before.expires_at.getTime()));
  });

  it("REC-04 concurrent recoveries: exactly one token is live at the end, one session row, still CONSUMED", async () => {
    const b = newBinding();
    const id = await verified(b);
    await claim(id, b);
    const rs = await Promise.all(Array.from({ length: 10 }, () => claim(id, b)));
    for (const r of rs) expect(r.status).toBe(200); // each rotation is serialized by the row lock
    const row = await sessionRow(id);
    expect(rs.filter((r) => sha256Hex(r.token!) === row.token_hash)).toHaveLength(1);
    expect(await q(`SELECT id FROM identity_sessions WHERE identity_verification_id = $1`, [id])).toHaveLength(1);
    expect(await verification(id)).toBe("CONSUMED");
  });

  it("REC-05 once the session has been used, no recovery", async () => {
    const b = newBinding();
    const id = await verified(b);
    const c = await claim(id, b);
    await getSession(b, c.token);
    expect((await claim(id, b)).status).toBe(422);
    expect((await getSession(b, c.token)).status).toBe(200); // the used token is untouched
  });

  it("REC-06 another verification id cannot recover someone's session: neither another browser's, nor this browser's older one", async () => {
    // this browser: first claim (id1) then a second verification claimed (id2) → id1's session REVOKED
    const b = newBinding();
    const id1 = await verified(b);
    await claim(id1, b);
    const id2 = await verified(b);
    const c2 = await claim(id2, b);
    // id1 is CONSUMED with a REVOKED session → no recovery, and id2's session is not touched by it
    expect((await claim(id1, b)).status).toBe(422);
    expect((await sessionRow(id2)).token_hash).toBe(sha256Hex(c2.token!));
    // another browser's CONSUMED verification → binding mismatch, nothing rotated
    const other = newBinding();
    const idOther = await verified(other);
    const co = await claim(idOther, other);
    expect((await claim(idOther, b)).status).toBe(401);
    expect((await sessionRow(idOther)).token_hash).toBe(sha256Hex(co.token!));
  });

  it("REC-07 the session-ownership condition is enforced in SQL: a session of another verification is never rotated", async () => {
    const b = newBinding();
    const id = await verified(b);
    const c = await claim(id, b);
    // forge: a CONSUMED verification of the same browser that owns no session of its own (would fail A-040 at commit
    // in real data; here only the recovery UPDATE's WHERE clause is exercised inside a rolled-back transaction)
    const cl = await db.pool.connect();
    try {
      await cl.query("BEGIN");
      const r = await cl.query(
        `UPDATE identity_sessions SET token_hash = 'x' WHERE identity_verification_id = $1::uuid AND browser_binding_hash = $2 AND status = 'ACTIVE' AND expires_at > now() AND last_used_at IS NULL AND now() < created_at + interval '5 minutes' RETURNING id`,
        ["00000000-0000-4000-8000-000000000999", sha256Hex(b)],
      );
      expect(r.rowCount).toBe(0);
    } finally {
      await cl.query("ROLLBACK");
      cl.release();
    }
    expect((await sessionRow(id)).token_hash).toBe(sha256Hex(c.token!));
  });
});

describe("LKP LOOKUP session lifetime (A-052)", () => {
  it("LKP-01 LOOKUP is fixed 10 minutes (DB time), not extended by use; expired → 401", async () => {
    expect(SESSION_TTL_MS.LOOKUP).toBe(10 * 60_000);
    const b = newBinding();
    const c = await claim(await verified(b, "success:A", "LOOKUP"), b);
    const row = (await q<{ ms: string; e: Date }>(`SELECT extract(epoch FROM expires_at - created_at) * 1000 ms, expires_at e FROM identity_sessions WHERE token_hash = $1`, [sha256Hex(c.token!)]))[0];
    expect(Number(row.ms)).toBe(10 * 60_000);
    await getSession(b, c.token);
    const after = (await q<{ e: Date }>(`SELECT expires_at e FROM identity_sessions WHERE token_hash = $1`, [sha256Hex(c.token!)]))[0];
    expect(after.e.getTime()).toBe(row.e.getTime());
    await db.query(`UPDATE identity_sessions SET created_at = now() - interval '10 minutes', expires_at = now() WHERE token_hash = $1`, [sha256Hex(c.token!)]);
    expect((await getSession(b, c.token)).status).toBe(401); // expires_at == now() is expired
  });
});

describe("M7 statement- and COMMIT-time constraint errors through Prisma", () => {
  it("M7-01 a COMMIT-time 23514 (deferred trigger) arrives as DriverAdapterError and is mapped; a statement-time 23505 too", async () => {
    const b = newBinding();
    const id = await verified(b);
    const subject = (await q<{ s: string }>(`SELECT identity_subject_id s FROM identity_verifications WHERE id = $1`, [id]))[0].s;
    let commitErr: unknown;
    try {
      await ptx((t) => t(`INSERT INTO identity_sessions (identity_verification_id, identity_subject_id, purpose, token_hash, browser_binding_hash, status, expires_at) VALUES ($1::uuid, $2::uuid, 'BOOKING', $3, $4, 'ACTIVE', now() + interval '1 minute')`, [id, subject, sha256Hex(k()), sha256Hex(b)]));
    } catch (e) {
      commitErr = e;
    }
        expect((commitErr as Error).name).toBe("DriverAdapterError");
    // measured: the adapter keeps the SQLSTATE but drops the constraint name of a constraint-trigger error at COMMIT
    expect(dbConstraintOf(commitErr)).toEqual({ sqlState: "23514", constraint: null });
    expect(mapClaimDbError(commitErr)?.code).toBe("IDENTITY_VERIFICATION_FAILED");
    // statement time: duplicate token hash
    const c = await claim(id, b);
    let stmtErr: unknown;
    try {
      await ptx((t) => t(`UPDATE identity_sessions SET token_hash = $1 WHERE identity_verification_id <> $2::uuid AND status = 'ACTIVE'`, [sha256Hex(c.token!), id]));
    } catch (e) {
      stmtErr = e;
    }
    expect(dbConstraintOf(stmtErr)).toEqual({ sqlState: "23505", constraint: "identity_sessions_token_hash_uq" });
    // a 23514 naming an unrelated constraint is NOT turned into a claim error
    expect(mapClaimDbError({ name: "DriverAdapterError", cause: { originalCode: "23514", constraint: "payments_primary_amount_ck" } })).toBeNull();
    expect(mapClaimDbError(new Error("x"))).toBeNull();
  });

  it("M7-02 a claim whose transaction fails at COMMIT returns 422 (not 500) and rolls EVERYTHING back", async () => {
    const b = newBinding();
    const old = await claim(await verified(b), b); // an existing ACTIVE session that the next claim would revoke
    const id = await verified(b);
    // the TxRunner sneaks in a statement after the claim's work that breaks the deferred A-040 rule at COMMIT
    const sabotage: TxRunner = (fn) =>
      ptx(async (t) => {
        const r = await fn(t);
        await t(`UPDATE identity_verifications SET status = 'VERIFIED' WHERE id = $1::uuid`, [id]);
        return r;
      });
    const r = await claim(id, b, {}, deps({ tx: sabotage }));
    expect([r.status, r.body.error.code, r.setCookie]).toEqual([422, "IDENTITY_VERIFICATION_FAILED", null]);
    expect(await verification(id)).toBe("VERIFIED"); // not CONSUMED
    expect(await sessionsOf(id)).toHaveLength(0); // no new session
    expect((await getSession(b, old.token)).status).toBe(200); // the old session was NOT revoked
    expect(logs.join("\n")).toContain("[identity-claim] constraint:");
  });

  it("M7-03 unrelated errors still become a generic 500 without internals", async () => {
    const b = newBinding();
    const id = await verified(b);
    const r = await claim(id, b, {}, deps({ tx: async () => { throw new Error("secret detail 010-0000-0001"); } }));
    expect([r.status, r.body.error.code]).toEqual([500, "INTERNAL_ERROR"]);
    expect(JSON.stringify(r.body)).not.toContain("secret detail");
  });
});

describe("SES identity session", () => {
  it("SES-01 valid session → purpose, expiresAt, masked name only; no-store; expires_at never moves, last_used_at set", async () => {
    const b = newBinding();
    const c = await claim(await verified(b, "success:C"), b);
    const before = (await q<{ e: Date }>(`SELECT expires_at e FROM identity_sessions WHERE token_hash = $1`, [sha256Hex(c.token!)]))[0].e;
    const s = await getSession(b, c.token);
    expect(s.status).toBe(200);
    expect(s.cc).toBe("no-store");
    expect(Object.keys(s.body).sort()).toEqual(["displayName", "expiresAt", "purpose"]);
    expect(s.body.displayName).toBe("테*****C");
    const after = (await q<{ e: Date; u: Date | null }>(`SELECT expires_at e, last_used_at u FROM identity_sessions WHERE token_hash = $1`, [sha256Hex(c.token!)]))[0];
    expect(after.e.getTime()).toBe(before.getTime());
    expect(after.u).toBeInstanceOf(Date);
  });

  it("SES-02 expired (DB time), revoked, garbage or missing cookie → 401 IDENTITY_SESSION_REQUIRED", async () => {
    const b = newBinding();
    const c = await claim(await verified(b), b);
    expect((await getSession(b, null)).body.error.code).toBe("IDENTITY_SESSION_REQUIRED");
    expect((await getSession(b, "x".repeat(10))).status).toBe(401);
    expect((await getSession(b, k())).status).toBe(401);
    expect((await getSession(null, c.token)).status).toBe(401);
    await db.query(`UPDATE identity_sessions SET created_at = now() - interval '31 minutes', expires_at = now() - interval '1 second' WHERE token_hash = $1`, [sha256Hex(c.token!)]);
    expect((await getSession(b, c.token)).status).toBe(401);
    const b2 = newBinding();
    const c2 = await claim(await verified(b2), b2);
    await db.query(`UPDATE identity_sessions SET status = 'REVOKED', revoked_at = now() WHERE token_hash = $1`, [sha256Hex(c2.token!)]);
    expect((await getSession(b2, c2.token)).status).toBe(401);
  });

  it("SES-03 a session cookie copied to another browser → 401 BROWSER_BINDING_MISMATCH (IDV-05)", async () => {
    const b = newBinding();
    const c = await claim(await verified(b), b);
    expect((await getSession(newBinding(), c.token)).body.error.code).toBe("BROWSER_BINDING_MISMATCH");
  });

  it("SES-04 logout: 204, cookie cleared with the same attributes, token rejected afterwards; repeated logout is harmless", async () => {
    const b = newBinding();
    const c = await claim(await verified(b), b);
    const res = await handleDeleteSession(sessionReq("DELETE", b, c.token), deps());
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBe(`${IDENTITY_SESSION_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`);
    expect((await getSession(b, c.token)).status).toBe(401);
    expect((await q(`SELECT status FROM identity_sessions WHERE token_hash = $1`, [sha256Hex(c.token!)]))[0].status).toBe("REVOKED");
    expect((await handleDeleteSession(sessionReq("DELETE", b, c.token), deps())).status).toBe(204);
    expect((await handleDeleteSession(sessionReq("DELETE", b, null), deps())).status).toBe(204);
  });

  it("SES-05 logout touches only the caller's own session: another user's, and a copied token from another browser, survive", async () => {
    const a = newBinding();
    const ca = await claim(await verified(a, "success:A"), a);
    const b = newBinding();
    const cb = await claim(await verified(b, "success:B"), b);
    // browser b sends a's token (copied) with its own binding: nothing is revoked
    await handleDeleteSession(sessionReq("DELETE", b, ca.token), deps());
    expect((await getSession(a, ca.token)).status).toBe(200);
    await handleDeleteSession(sessionReq("DELETE", b, cb.token), deps());
    expect((await getSession(b, cb.token)).status).toBe(401);
    expect((await getSession(a, ca.token)).status).toBe(200);
  });

  it("SES-06 logout without CSRF/Origin is refused and neither revokes nor clears the cookie", async () => {
    const b = newBinding();
    const c = await claim(await verified(b), b);
    const r = await handleDeleteSession(sessionReq("DELETE", b, c.token, { origin: "https://evil.example" }), deps());
    expect(r.status).toBe(403);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect((await getSession(b, c.token)).status).toBe(200);
  });

  it("SES-07 the DB allows only one ACTIVE session per binding+purpose", async () => {
    const b = newBinding();
    const c = await claim(await verified(b), b);
    const row = (await q<{ identity_verification_id: string }>(`SELECT identity_verification_id FROM identity_sessions WHERE token_hash = $1`, [sha256Hex(c.token!)]))[0];
    void row;
    const id2 = await verified(b);
    const sub = (await q<{ s: string }>(`SELECT identity_subject_id s FROM identity_verifications WHERE id = $1`, [id2]))[0].s;
    const cl = await db.pool.connect();
    try {
      await cl.query("BEGIN");
      await cl.query(`UPDATE identity_verifications SET status = 'CONSUMED' WHERE id = $1`, [id2]);
      await expect(cl.query(`INSERT INTO identity_sessions (identity_verification_id, identity_subject_id, purpose, token_hash, browser_binding_hash, status, expires_at) VALUES ($1, $2, 'BOOKING', $3, $4, 'ACTIVE', now() + interval '30 minutes')`, [id2, sub, sha256Hex(k()), sha256Hex(b)])).rejects.toMatchObject({ code: "23505", constraint: "identity_sessions_active_binding_uq" });
    } finally {
      await cl.query("ROLLBACK");
      cl.release();
    }
  });

  it("SES-08 no raw token, binding, name or phone in logs", async () => {
    logs = [];
    const b = newBinding();
    const c = await claim(await verified(b, "success:B"), b);
    await getSession(b, c.token);
    await handleDeleteSession(sessionReq("DELETE", b, c.token), deps());
    const all = logs.join("\n");
    for (const s of [c.token!, b, "테스트사용자B", "01000000002"]) expect(all).not.toContain(s);
  });
});
