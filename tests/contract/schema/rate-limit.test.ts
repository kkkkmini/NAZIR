/**
 * RL-01~RL-12 (A-045): the PostgreSQL rate limit store and service against a real PostgreSQL server.
 * Concurrency uses many real connections, each running its hit inside its own explicit transaction, released together
 * by an advisory-lock barrier so the upserts genuinely overlap.
 */
import { randomBytes } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { parseKeyring } from "../../../src/server/lib/secrets";
import { parsePolicyOverrides } from "../../../src/server/rate-limit/policies";
import { resolveClientIp } from "../../../src/server/rate-limit/client-ip";
import { RateLimiter, rateLimitKey } from "../../../src/server/rate-limit/service";
import { deleteExpiredCounters, hitCounter, type SqlExecutor } from "../../../src/server/rate-limit/store";
import { cloneTestDb, destroyTestDb, resolveTestServer, type TestDb } from "./helpers/pg";

const server = resolveTestServer();
let db: TestDb;
let pool: Pool;
beforeAll(async () => {
  db = await cloneTestDb(server, inject("templateDb"));
  pool = new Pool({ connectionString: db.url, max: 60 });
});
afterAll(async () => {
  await pool.end();
  await destroyTestDb(db);
});
afterEach(async () => {
  await db.query(`DELETE FROM rate_limit_counters`);
});

const keys = parseKeyring({ RL_KEYS: `v1:${randomBytes(32).toString("base64url")}`, RL_KEY_CURRENT: "v1" }, "RL", [])!;
const execOf = (c: Pool | PoolClient): SqlExecutor => async (sql, params) => (await c.query(sql, params)).rows;
const limiter = (policies: string, exec: SqlExecutor = execOf(pool)) =>
  new RateLimiter({ exec, keys, policies: parsePolicyOverrides({ NAZIR_RATE_LIMIT_POLICIES: policies }) });
const IP = "203.0.113.77";

describe("RL-01..04 basic window", () => {
  it("RL-01 first request is allowed with limit-1 remaining and creates one row", async () => {
    const d = await limiter("identity.start.ip=3/60").consume("identity.start.ip", [["ip", IP]]);
    expect(d).toMatchObject({ allowed: true, limit: 3, remaining: 2, retryAt: null });
    expect((await db.query(`SELECT count(*)::int n FROM rate_limit_counters`)).rows[0].n).toBe(1);
  });

  it("RL-02/03 the limit-th request is allowed with 0 remaining, the next is rejected with retryAt = window end", async () => {
    const l = limiter("identity.start.ip=3/60");
    const r = [];
    for (let i = 0; i < 5; i++) r.push(await l.consume("identity.start.ip", [["ip", IP]]));
    expect(r.map((x) => x.allowed)).toEqual([true, true, true, false, false]);
    expect(r[2].remaining).toBe(0);
    const { rows } = await db.query<{ exp: Date; c: number }>(`SELECT expires_at exp, count c FROM rate_limit_counters`);
    expect(r[3].retryAt!.getTime()).toBe(Math.floor(rows[0].exp.getTime()));
    expect(r[4].retryAt!.getTime()).toBe(r[3].retryAt!.getTime()); // rejected hits do not extend the window
    expect(rows[0].c).toBe(4); // capped at limit + 1
    expect(r[3].retryAfterSeconds).toBeGreaterThanOrEqual(59);
    expect(r[3].retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("RL-04 after the window has passed the counter restarts at 1", async () => {
    const l = limiter("identity.start.ip=1/60");
    await l.consume("identity.start.ip", [["ip", IP]]);
    expect((await l.consume("identity.start.ip", [["ip", IP]])).allowed).toBe(false);
    await db.query(`UPDATE rate_limit_counters SET window_started_at = now() - interval '61 seconds', expires_at = now() - interval '1 second'`);
    const d = await l.consume("identity.start.ip", [["ip", IP]]);
    expect(d).toMatchObject({ allowed: true, remaining: 0 });
    const { rows } = await db.query<{ ok: boolean; c: number }>(
      `SELECT count c, expires_at > now() + interval '59 seconds' ok FROM rate_limit_counters`,
    );
    expect(rows[0]).toEqual({ c: 1, ok: true });
  });
});

describe("RL-05..07 separation and privacy", () => {
  it("RL-05 policies have separate counters for the same identifier", async () => {
    const l = limiter("identity.start.ip=1/60,identity.start.binding=1/60");
    expect((await l.consume("identity.start.ip", [["ip", IP]])).allowed).toBe(true);
    expect((await l.consume("identity.start.binding", [["ip", IP]])).allowed).toBe(true);
    expect((await l.consume("identity.start.ip", [["ip", IP]])).allowed).toBe(false);
  });

  it("RL-06 different IPs and different browser bindings are counted separately", async () => {
    const l = limiter("identity.start.ip=1/60,identity.start.binding=1/60");
    expect((await l.consume("identity.start.ip", [["ip", IP]])).allowed).toBe(true);
    expect((await l.consume("identity.start.ip", [["ip", "198.51.100.1"]])).allowed).toBe(true);
    const b1 = randomBytes(32).toString("base64url");
    const b2 = randomBytes(32).toString("base64url");
    expect((await l.consume("identity.start.binding", [["binding", b1]])).allowed).toBe(true);
    expect((await l.consume("identity.start.binding", [["binding", b2]])).allowed).toBe(true);
    expect((await l.consume("identity.start.binding", [["binding", b1]])).allowed).toBe(false);
  });

  it("RL-07 no raw identifier is stored anywhere in the row", async () => {
    const b = randomBytes(32).toString("base64url");
    const l = limiter("identity.start.ip=5/60,identity.start.binding=5/60");
    await l.consume("identity.start.ip", [["ip", IP]]);
    await l.consume("identity.start.binding", [["binding", b]]);
    const { rows } = await db.query(`SELECT row_to_json(c)::text t, key_hash FROM rate_limit_counters c`);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.t).not.toContain(IP);
      expect(r.t).not.toContain("203.0.113");
      expect(r.t).not.toContain(b);
      expect(r.key_hash).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/);
    }
    // DB CHECKs refuse a raw value or a free-form policy
    await expect(db.query(`INSERT INTO rate_limit_counters(policy,key_hash,window_started_at,expires_at,count) VALUES ('identity.start.ip',$1,now(),now()+interval '1 s',1)`, [IP])).rejects.toMatchObject({ code: "23514" });
    await expect(db.query(`INSERT INTO rate_limit_counters(policy,key_hash,window_started_at,expires_at,count) VALUES ('Bad Policy!',$1,now(),now()+interval '1 s',1)`, [rateLimitKey(keys, "x", [["ip", IP]])])).rejects.toMatchObject({ code: "23514" });
  });
});

describe("RL-13/14 A-047 confirmed identity-start policies", () => {
  const ipOf = (raw: string) => resolveClientIp(new Headers({ "x-vercel-forwarded-for": raw }), { kind: "vercel" });
  const confirmed = () => new RateLimiter({ exec: execOf(pool), keys, policies: new Map() }); // no overrides: A-047 values

  it("RL-13 one IPv6 /64 is one bucket (privacy addresses), another /64 is independent; mapped IPv4 = IPv4", async () => {
    const l = confirmed();
    for (let i = 0; i < 60; i++) {
      const d = await l.consume("identity.start.ip", [["ip", ipOf(`2001:db8:aa:1:${(i + 1).toString(16)}:0:0:1`)]]);
      expect(d.allowed).toBe(true);
    }
    expect((await l.consume("identity.start.ip", [["ip", ipOf("2001:db8:aa:1:dead:beef:0:9")]])).allowed).toBe(false);
    expect((await l.consume("identity.start.ip", [["ip", ipOf("2001:db8:aa:2::9")]])).allowed).toBe(true);
    expect((await l.consume("identity.start.ip", [["ip", ipOf("::ffff:198.51.100.40")]])).remaining).toBe(59);
    expect((await l.consume("identity.start.ip", [["ip", ipOf("198.51.100.40")]])).remaining).toBe(58);
    expect((await db.query(`SELECT count(*)::int n FROM rate_limit_counters`)).rows[0].n).toBe(3);
  });

  it("RL-14 a shared public IP: many browsers each get 5, the network as a whole gets 60", async () => {
    const l = confirmed();
    const shared = ipOf("203.0.113.200");
    const results: string[] = [];
    // IP first, binding only when the IP passed (API_SPEC §7)
    for (let b = 0; b < 15; b++) {
      const binding = randomBytes(32).toString("base64url");
      for (let i = 0; i < 6; i++) {
        const ip = await l.consume("identity.start.ip", [["ip", shared]]);
        if (!ip.allowed) {
          results.push("ip");
          continue;
        }
        results.push((await l.consume("identity.start.binding", [["binding", binding]])).allowed ? "ok" : "binding");
      }
    }
    expect(results.filter((r) => r === "ok")).toHaveLength(50); // 10 browsers × 5, within the first 60 network hits
    expect(results.filter((r) => r === "binding")).toHaveLength(10); // each browser's 6th try
    expect(results.filter((r) => r === "ip")).toHaveLength(30); // the network limit of 60 then stops the rest
  });
});

describe("RL-08 DB time, not the web server's clock", () => {
  it("the window is computed from DB now() even when the process clock is far off", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2001-01-01T00:00:00Z"));
    try {
      const d = await limiter("identity.start.ip=1/60").consume("identity.start.ip", [["ip", IP]]);
      expect(d.allowed).toBe(true);
      const { rows } = await db.query<{ ok: boolean }>(
        `SELECT abs(extract(epoch FROM window_started_at - now())) < 5 AND expires_at = window_started_at + interval '60 seconds' ok FROM rate_limit_counters`,
      );
      expect(rows[0].ok).toBe(true);
      const r = await limiter("identity.start.ip=1/60").consume("identity.start.ip", [["ip", IP]]);
      expect(r.retryAt!.getFullYear()).toBeGreaterThanOrEqual(2026);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RL-09 concurrent requests are atomic (real overlapping transactions)", () => {
  async function burst(n: number, policy: string, limit: number, identifier: (i: number) => string) {
    const barrier = await pool.connect();
    const LOCK = 424242;
    await barrier.query(`SELECT pg_advisory_lock($1)`, [LOCK]);
    const clients = await Promise.all(Array.from({ length: n }, () => pool.connect()));
    const l = (c: PoolClient) => limiter(`${policy}=${limit}/60`, execOf(c));
    const runs = clients.map(async (c, i) => {
      try {
        await c.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await c.query(`SELECT pg_advisory_lock_shared($1)`, [LOCK]); // everyone waits here
        await c.query(`SELECT pg_advisory_unlock_shared($1)`, [LOCK]);
        const d = await l(c).consume(policy as never, [["ip", identifier(i)]]);
        await c.query("COMMIT");
        return d;
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    });
    // wait until all n sessions are blocked on the barrier, then release them at once
    let waiting = 0;
    for (let t = 0; t < 200; t++) {
      const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND NOT granted`);
      waiting = rows[0].n;
      if (waiting === n) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(waiting, "all transactions must be parked on the barrier before release").toBe(n);
    await barrier.query(`SELECT pg_advisory_unlock($1)`, [LOCK]);
    barrier.release();
    return Promise.all(runs);
  }

  it("50 simultaneous hits on one key: exactly `limit` allowed, no lost increment, every count distinct", async () => {
    const results = await burst(50, "identity.start.ip", 10, () => IP);
    expect(results.filter((d) => d.allowed)).toHaveLength(10);
    expect(results.filter((d) => !d.allowed)).toHaveLength(40);
    // remaining values of the allowed ones are 9..0, each exactly once => increments were serialized
    expect(results.filter((d) => d.allowed).map((d) => d.remaining).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const { rows } = await db.query<{ c: number; n: number }>(`SELECT count c, (SELECT count(*)::int FROM rate_limit_counters) n FROM rate_limit_counters`);
    expect(rows[0]).toEqual({ c: 11, n: 1 }); // one row, capped at limit + 1
  });

  it("50 simultaneous first hits on one key with limit 50: count reaches exactly 50 (INSERT races resolved by ON CONFLICT)", async () => {
    const results = await burst(50, "identity.start.ip", 50, () => IP);
    expect(results.every((d) => d.allowed)).toBe(true);
    expect(new Set(results.map((d) => d.remaining)).size).toBe(50);
    expect((await db.query(`SELECT count c FROM rate_limit_counters`)).rows[0].c).toBe(50);
  });

  it("simultaneous hits on 25 different keys do not interfere", async () => {
    const results = await burst(50, "identity.start.ip", 2, (i) => `198.51.100.${i % 25}`);
    expect(results.every((d) => d.allowed)).toBe(true);
    const { rows } = await db.query<{ c: number }>(`SELECT count c FROM rate_limit_counters`);
    expect(rows).toHaveLength(25);
    expect(rows.every((r) => r.c === 2)).toBe(true);
  });

  it("through the application Prisma client (pooled adapter) concurrent hits are exact too", async () => {
    vi.stubEnv("NAZIR_RUNTIME_ENV", "test");
    vi.stubEnv("DATABASE_URL", db.url);
    vi.stubEnv("PAYMENT_PROVIDER", "mock");
    vi.stubEnv("IDENTITY_PROVIDER", "mock");
    vi.resetModules();
    const { getPrisma } = await import("../../../src/server/db/client");
    const prisma = getPrisma();
    try {
      const exec: SqlExecutor = (sql, params) => prisma.$queryRawUnsafe(sql, ...params);
      const l = limiter("identity.start.ip=7/60", exec);
      const results = await Promise.all(Array.from({ length: 30 }, () => l.consume("identity.start.ip", [["ip", IP]])));
      expect(results.filter((d) => d.allowed)).toHaveLength(7);
      expect((await db.query(`SELECT count c FROM rate_limit_counters`)).rows[0].c).toBe(8);
    } finally {
      await prisma.$disconnect();
      delete (globalThis as { __nazirPrisma?: unknown }).__nazirPrisma;
      vi.unstubAllEnvs();
    }
  });
});

describe("RL-10 store failure fails closed", () => {
  it("a broken connection gives 503 RATE_LIMIT_UNAVAILABLE, never allowed", async () => {
    const dead = new Pool({ connectionString: db.url.replace(/:(\d+)\//, ":1/"), connectionTimeoutMillis: 500 });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(limiter("identity.start.ip=5/60", execOf(dead)).enforce("identity.start.ip", [["ip", IP]])).rejects.toMatchObject({
        code: "RATE_LIMIT_UNAVAILABLE",
        status: 503,
      });
      expect(JSON.stringify(err.mock.calls)).not.toContain(IP);
    } finally {
      err.mockRestore();
      await dead.end();
    }
  });

  it("a missing table (e.g. migration not applied) fails closed as well", async () => {
    const c = await pool.connect();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await c.query("BEGIN");
      await c.query("ALTER TABLE rate_limit_counters RENAME TO rate_limit_counters_gone");
      await expect(limiter("identity.start.ip=5/60", execOf(c)).enforce("identity.start.ip", [["ip", IP]])).rejects.toMatchObject({ code: "RATE_LIMIT_UNAVAILABLE" });
    } finally {
      await c.query("ROLLBACK");
      c.release();
      err.mockRestore();
    }
  });
});

describe("RL-11 cleanup of expired counters", () => {
  it("deletes only expired rows, in batches, and a later hit simply starts a new window", async () => {
    const l = limiter("identity.start.ip=5/60");
    for (let i = 0; i < 7; i++) await l.consume("identity.start.ip", [["ip", `192.0.2.${i}`]]);
    await db.query(`UPDATE rate_limit_counters SET window_started_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute' WHERE ctid IN (SELECT ctid FROM rate_limit_counters LIMIT 5)`);
    const exec = execOf(pool);
    expect(await deleteExpiredCounters(exec, 3)).toBe(3);
    expect(await deleteExpiredCounters(exec, 3)).toBe(2);
    expect(await deleteExpiredCounters(exec, 3)).toBe(0);
    expect((await db.query(`SELECT count(*)::int n FROM rate_limit_counters`)).rows[0].n).toBe(2);
  });
});

describe("RL-12 boundary instants (one transaction = one fixed now())", () => {
  async function inTx<T>(fn: (c: PoolClient) => Promise<T>) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } finally {
      c.release();
    }
  }
  const key = () => rateLimitKey(keys, "identity.start.ip", [["ip", IP]]);

  it("expires_at == now() counts as expired: the window restarts at 1", async () => {
    await hitCounter(execOf(pool), "identity.start.ip", key(), 60_000, 1);
    await hitCounter(execOf(pool), "identity.start.ip", key(), 60_000, 1);
    const r = await inTx(async (c) => {
      await c.query(`UPDATE rate_limit_counters SET window_started_at = now() - interval '60 seconds', expires_at = now()`);
      return hitCounter(execOf(c), "identity.start.ip", key(), 60_000, 1);
    });
    expect(r.count).toBe(1);
    expect(r.expiresAtMs - r.nowMs).toBe(60_000);
  });

  it("expires_at one microsecond after now() is still the old window", async () => {
    await hitCounter(execOf(pool), "identity.start.ip", key(), 60_000, 1);
    const r = await inTx(async (c) => {
      await c.query(`UPDATE rate_limit_counters SET window_started_at = now() - interval '60 seconds', expires_at = now() + interval '1 microsecond'`);
      return hitCounter(execOf(c), "identity.start.ip", key(), 60_000, 1);
    });
    expect(r.count).toBe(2);
  });

  it("cleanup at the boundary: expires_at == now() is deleted, + 1µs is kept", async () => {
    const a = key();
    const b = rateLimitKey(keys, "identity.start.ip", [["ip", "198.51.100.9"]]);
    await hitCounter(execOf(pool), "identity.start.ip", a, 60_000, 1);
    await hitCounter(execOf(pool), "identity.start.ip", b, 60_000, 1);
    const n = await inTx(async (c) => {
      await c.query(`UPDATE rate_limit_counters SET window_started_at = now() - interval '1 minute', expires_at = CASE WHEN key_hash = $1 THEN now() ELSE now() + interval '1 microsecond' END`, [a]);
      return deleteExpiredCounters(execOf(c));
    });
    expect(n).toBe(1);
    expect((await db.query(`SELECT key_hash FROM rate_limit_counters`)).rows.map((r) => r.key_hash)).toEqual([b]);
  });
});
