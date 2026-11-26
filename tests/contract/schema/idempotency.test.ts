/**
 * IDM-01~IDM-10 (Step 5, A-010, A-053 ⑥) against a REAL PostgreSQL through the Prisma adapter and the booking runner.
 * A stand-in resource (a venue row) and a REAL rate limiter running on the SAME transaction executor model the order
 * flow: acquire → (owner only) rate-limit hit → resource → complete. This proves the ordering claims with concurrency:
 * an exact replay, and concurrent identical requests, never consume the rate limit twice.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { PrismaClient } from "../../../src/generated/prisma/client";
import { loadDbPoolConfig } from "../../../src/server/config/db-pool-config";
import { buildPgPoolConfig } from "../../../src/server/db/pg-adapter";
import type { SqlExecutor } from "../../../src/server/db/sql";
import {
  IDEMPOTENCY_TTL_MS,
  acquireIdempotency,
  completeIdempotency,
  idempotencyKeyHash,
  idempotencyOwnerHash,
  requestHash,
  type IdempotencyRef,
} from "../../../src/server/booking/idempotency";
import { DEFAULT_RETRY_POLICY, runBookingTx, type BookingTxDeps } from "../../../src/server/booking/tx";
import { AppError } from "../../../src/server/lib/errors";
import { parseKeyring } from "../../../src/server/lib/secrets";
import { parsePolicyOverrides } from "../../../src/server/rate-limit/policies";
import { RateLimiter } from "../../../src/server/rate-limit/service";
import { cloneTestDb, destroyTestDb, resolveTestServer, type TestDb } from "./helpers/pg";

const server = resolveTestServer();
let db: TestDb;
let prisma: PrismaClient;
const deps = (): BookingTxDeps => ({
  startTx: (fn, options) => prisma.$transaction((tx) => fn(tx), options),
  limits: { txMaxWaitMs: 10000, txTimeoutMs: 20000, statementTimeoutMs: 15000, lockTimeoutMs: 10000 },
  retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 },
});
const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as T[];
const keys = parseKeyring({ RL_KEYS: `v1:${randomBytes(32).toString("base64url")}`, RL_KEY_CURRENT: "v1" }, "RL", [])!;
const policies = parsePolicyOverrides({ NAZIR_RATE_LIMIT_POLICIES: "order.create.session=1000/1800" });
const SCOPE = "POST /orders";

beforeAll(async () => {
  db = await cloneTestDb(server, inject("templateDb"));
  prisma = new PrismaClient({ adapter: new PrismaPg(buildPgPoolConfig(db.url, "DATABASE_URL", { ...loadDbPoolConfig({}, "test"), poolMax: 20 })) });
});
afterAll(async () => {
  await prisma.$disconnect();
  await destroyTestDb(db);
});

const ref = (o: { owner?: string; key?: string; body?: unknown } = {}): IdempotencyRef => ({
  scope: SCOPE,
  ownerKeyHash: idempotencyOwnerHash(o.owner ?? "00000000-0000-4000-8000-000000000001", "bindhash"),
  keyHash: idempotencyKeyHash(o.key ?? randomUUID()),
  requestHash: requestHash(o.body ?? { a: 1 }),
});

/** The modelled flow. `rlTag` names the rate-limit counter; `fail` makes the owner path reject after its work. */
async function call(r: IdempotencyRef, rlTag: string, o: { fail?: boolean; holdMs?: number } = {}) {
  return runBookingTx(deps(), {
    name: "idm.call",
    fn: async (tx: SqlExecutor) => {
      const a = await acquireIdempotency(tx, r);
      if (a.kind === "replay") return { kind: "replay" as const, body: a.responseBody, status: a.responseStatus };
      const d = await new RateLimiter({ exec: tx, keys, policies }).consume("order.create.session", [["session", rlTag]]);
      const [v] = await tx<{ id: string }>(`INSERT INTO venues (name) VALUES ($1) RETURNING id`, [`idm-${rlTag}-${randomUUID()}`]);
      if (o.holdMs) await new Promise((res) => setTimeout(res, o.holdMs));
      if (o.fail) throw new AppError("SEAT_UNAVAILABLE", "business rejection after work");
      await completeIdempotency(tx, a.recordId, { resourceType: "ORDER", resourceId: v.id, responseStatus: 201, responseBody: { venueId: v.id } });
      return { kind: "owner" as const, body: { venueId: v.id }, status: 201, remaining: d.remaining, takenOver: a.takenOver };
    },
  });
}
const venues = async (tag: string) => (await q<{ n: number }>(`SELECT count(*)::int AS n FROM venues WHERE name LIKE $1`, [`idm-${tag}-%`]))[0].n;
const hits = async () => (await q<{ n: number }>(`SELECT coalesce(sum(count), 0)::int AS n FROM rate_limit_counters WHERE policy = 'order.create.session'`))[0].n;

describe("IDM idempotency records", () => {
  it("IDM-01 same owner + key + body: the second call replays the stored response, no new resource, no rate-limit hit", async () => {
    const tag = randomUUID();
    const r = ref();
    const before = await hits();
    const a = await call(r, tag);
    const b = await call(r, tag);
    expect(a.kind).toBe("owner");
    expect(b).toEqual({ kind: "replay", body: a.body, status: 201 });
    expect(await venues(tag)).toBe(1);
    expect((await hits()) - before).toBe(1);
  });

  it("IDM-02 same key, different body → 409 IDEMPOTENCY_KEY_REUSED, nothing created, no hit", async () => {
    const tag = randomUUID();
    const key = randomUUID();
    await call(ref({ key, body: { a: 1 } }), tag);
    const before = await hits();
    const e = await call(ref({ key, body: { a: 2 } }), tag).catch((x) => x);
    expect(e.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await venues(tag)).toBe(1);
    expect(await hits()).toBe(before);
  });

  it("IDM-03 the same key from another owner (other subject or other browser) is a separate request", async () => {
    const tag = randomUUID();
    const key = randomUUID();
    const a = await call(ref({ key, owner: "00000000-0000-4000-8000-0000000000a1" }), tag);
    const b = await call(ref({ key, owner: "00000000-0000-4000-8000-0000000000b2" }), tag);
    expect([a.kind, b.kind]).toEqual(["owner", "owner"]);
    expect(b.body).not.toEqual(a.body);
    expect(await venues(tag)).toBe(2);
  });

  it("IDM-04 a business rejection is not stored: the record, the resource and the rate-limit hit roll back; a retry is re-evaluated", async () => {
    const tag = randomUUID();
    const r = ref();
    const before = await hits();
    const e = await call(r, tag, { fail: true }).catch((x) => x);
    expect(e.code).toBe("SEAT_UNAVAILABLE");
    expect(await q(`SELECT 1 FROM idempotency_records WHERE idempotency_key_hash = $1`, [r.keyHash])).toHaveLength(0);
    expect(await venues(tag)).toBe(0);
    expect(await hits()).toBe(before);
    const ok = await call(r, tag);
    expect(ok.kind).toBe("owner");
  });

  it("IDM-05 10 concurrent identical requests: exactly one resource, nine replays of it, exactly ONE rate-limit hit", async () => {
    const tag = randomUUID();
    const r = ref();
    const before = await hits();
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => call(r, tag, { holdMs: i === 0 ? 100 : 0 })));
    const owners = res.filter((x) => x.kind === "owner");
    expect(owners).toHaveLength(1);
    for (const x of res) expect(x.body).toEqual(owners[0].body);
    expect(await venues(tag)).toBe(1);
    expect((await hits()) - before).toBe(1);
  });

  it("IDM-06 concurrent identical requests where the first rolls back: the next one becomes the owner; only its hit remains", async () => {
    const tag = randomUUID();
    const r = ref();
    const before = await hits();
    let started!: () => void;
    const firstStarted = new Promise<void>((res) => (started = res));
    const first = runBookingTx(deps(), {
      name: "idm.first",
      fn: async (tx) => {
        const a = await acquireIdempotency(tx, r);
        expect(a.kind).toBe("owner");
        await new RateLimiter({ exec: tx, keys, policies }).consume("order.create.session", [["session", tag]]);
        started();
        await new Promise((res) => setTimeout(res, 200));
        throw new AppError("PURCHASE_LIMIT_EXCEEDED", "rejected");
      },
    }).catch((x) => x);
    await firstStarted;
    const second = call(r, tag);
    expect((await first).code).toBe("PURCHASE_LIMIT_EXCEEDED");
    expect((await second).kind).toBe("owner");
    expect(await venues(tag)).toBe(1);
    expect((await hits()) - before).toBe(1);
  });

  it("IDM-07 retention boundary: replay while expires_at > now; at expires_at = now the key is free again (taken over in place)", async () => {
    const tag = randomUUID();
    const r = ref();
    const first = await call(r, tag);
    await q(`UPDATE idempotency_records SET expires_at = now() + interval '5 seconds' WHERE idempotency_key_hash = $1`, [r.keyHash]);
    expect((await call(r, tag)).kind).toBe("replay");
    // exact boundary inside ONE transaction: expires_at = now() of that transaction → expired (<=)
    const boundary = await runBookingTx(deps(), {
      name: "idm.boundary",
      fn: async (tx) => {
        await tx(`UPDATE idempotency_records SET expires_at = now() WHERE idempotency_key_hash = $1`, [r.keyHash]);
        return acquireIdempotency(tx, r);
      },
    });
    expect(boundary).toMatchObject({ kind: "owner", takenOver: true });
    // that transaction committed a PROCESSING takeover without completing; a later expiry makes the row free again
    await q(`UPDATE idempotency_records SET expires_at = now() - interval '1 second' WHERE idempotency_key_hash = $1`, [r.keyHash]);
    const again = await call(r, tag);
    expect(again).toMatchObject({ kind: "owner", takenOver: true });
    expect(again.body).not.toEqual(first.body);
    const [row] = await q<{ n: number; ok: boolean }>(
      `SELECT count(*) OVER ()::int AS n, (expires_at > now() + interval '23 hours 59 minutes') AS ok FROM idempotency_records WHERE idempotency_key_hash = $1`,
      [r.keyHash],
    );
    expect(row).toEqual({ n: 1, ok: true }); // one row per key, a fresh 24 h window
    expect(IDEMPOTENCY_TTL_MS).toBe(24 * 3600 * 1000);
  });

  it("IDM-08 5 concurrent requests on an EXPIRED record: exactly one takes it over", async () => {
    const tag = randomUUID();
    const r = ref();
    await call(r, tag);
    await q(`UPDATE idempotency_records SET expires_at = now() - interval '1 second' WHERE idempotency_key_hash = $1`, [r.keyHash]);
    const res = await Promise.all(Array.from({ length: 5 }, () => call(r, tag)));
    expect(res.filter((x) => x.kind === "owner")).toHaveLength(1);
    expect(await venues(tag)).toBe(2);
  });

  it("IDM-09 a committed PROCESSING row (never written by the flow, defensive) answers 409 REQUEST_IN_PROGRESS", async () => {
    const r = ref();
    await q(
      `INSERT INTO idempotency_records (scope, owner_key_hash, idempotency_key_hash, request_hash, status, expires_at) VALUES ($1, $2, $3, $4, 'PROCESSING', now() + interval '1 hour')`,
      [r.scope, r.ownerKeyHash, r.keyHash, r.requestHash],
    );
    const e = await call(r, randomUUID()).catch((x) => x);
    expect(e.code).toBe("REQUEST_IN_PROGRESS");
  });

  it("IDM-10 nothing secret is stored: raw key absent, hashes only, owner hash differs from the subject id", async () => {
    const key = randomUUID();
    const owner = "00000000-0000-4000-8000-0000000000c3";
    await call(ref({ key, owner }), randomUUID());
    const rows = await q<Record<string, unknown>>(`SELECT * FROM idempotency_records WHERE idempotency_key_hash = $1`, [idempotencyKeyHash(key)]);
    expect(rows).toHaveLength(1);
    const text = JSON.stringify(rows[0]);
    expect(text).not.toContain(key);
    expect(text).not.toContain(owner);
    expect(rows[0].idempotency_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].owner_key_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
