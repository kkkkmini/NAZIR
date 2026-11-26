/**
 * ON-01~ON-12 (Step 5 unit 3, Q-025, A-053 ②) against a REAL PostgreSQL 16 through the Prisma adapter and the booking
 * transaction runner: format, KST month boundary, default instant = transaction start, 200 concurrent issues, rollback
 * gaps, growth past 6 digits, NO CYCLE, the format CHECK, privileges, the schema contract and MIG-06.
 * Tests that move the sequence (setval) use their own throwaway database.
 */
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { PrismaClient } from "../../../src/generated/prisma/client";
import { loadDbPoolConfig, type DbPoolConfig } from "../../../src/server/config/db-pool-config";
import { buildPgPoolConfig } from "../../../src/server/db/pg-adapter";
import { ORDER_NUMBER_PATTERN, isOrderNumber, nextOrderNumber } from "../../../src/server/booking/order-number";
import { DEFAULT_RETRY_POLICY, runBookingTx, type BookingTxDeps } from "../../../src/server/booking/tx";
import { AppError } from "../../../src/server/lib/errors";
import { checkSequences, checkSqlFunctions, findProtectedDrops } from "./contract";
import { mkIdentitySession, mkSubject, mkWorld } from "./helpers/fixtures";
import { cloneTestDb, destroyTestDb, resolveTestServer, type TestDb } from "./helpers/pg";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const server = resolveTestServer();

interface Env {
  db: TestDb;
  prisma: PrismaClient;
  deps: () => BookingTxDeps;
  q: <T = Row>(sql: string, p?: unknown[]) => Promise<T[]>;
}
async function makeEnv(pool: Partial<DbPoolConfig> = {}): Promise<Env> {
  const db = await cloneTestDb(server, inject("templateDb"));
  const prisma = new PrismaClient({ adapter: new PrismaPg(buildPgPoolConfig(db.url, "DATABASE_URL", { ...loadDbPoolConfig({}, "test"), ...pool })) });
  return {
    db,
    prisma,
    deps: () => ({
      startTx: (fn, options) => prisma.$transaction((tx) => fn(tx), options),
      limits: { txMaxWaitMs: 10000, txTimeoutMs: 15000, statementTimeoutMs: 8000, lockTimeoutMs: 5000 },
      retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 },
    }),
    q: async (sql, p = []) => (await db.query(sql, p)).rows as never,
  };
}
async function dropEnv(e: Env) {
  await e.prisma.$disconnect();
  await destroyTestDb(e.db);
}
const issue = (e: Env) => runBookingTx(e.deps(), { name: "on.issue", fn: (tx) => nextOrderNumber(tx) });
const seq = (n: string) => BigInt(n.split("-")[2]);
const month = (n: string) => n.split("-")[1];

/** Inserts an order that uses `number`, in the caller's transaction (plain SQL, like the order service will). */
async function insertOrder(tx: (s: string, p: unknown[]) => Promise<unknown[]>, ref: { sessionId: string; subjectId: string; identitySessionId: string }, number: string) {
  await tx(`INSERT INTO purchase_quotas (identity_subject_id, show_session_id, seat_limit) VALUES ($1::uuid, $2::uuid, 4) ON CONFLICT DO NOTHING`, [ref.subjectId, ref.sessionId]);
  await tx(
    `INSERT INTO orders (order_number, show_session_id, identity_subject_id, identity_session_id, status, customer_name, customer_phone, total_amount, hold_expires_at)
     VALUES ($1, $2::uuid, $3::uuid, $4::uuid, 'PENDING', 'n', 'p', 100000, now() + interval '7 min')`,
    [number, ref.sessionId, ref.subjectId, ref.identitySessionId],
  );
}

let env: Env;
beforeAll(async () => {
  env = await makeEnv({ poolMax: 20 });
});
afterAll(async () => {
  await dropEnv(env);
});
afterEach(() => vi.restoreAllMocks());

describe("ON-01~03 format, KST month, default instant", () => {
  it("ON-01 a fresh database issues NZ-<KST month>-000001, then 000002 — through the runner's own transaction", async () => {
    const e = await makeEnv();
    try {
      const [kst] = await e.q<{ m: string }>(`SELECT to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYYMM') AS m`);
      const a = await issue(e);
      const b = await issue(e);
      expect([a, b]).toEqual([`NZ-${kst.m}-000001`, `NZ-${kst.m}-000002`]);
      expect(isOrderNumber(a) && ORDER_NUMBER_PATTERN.test(b)).toBe(true);
    } finally {
      await dropEnv(e);
    }
  });

  it.each([
    ["2026-11-30T14:59:59.999999Z", "202611"],
    ["2026-11-30T15:00:00Z", "202612"], // = 2026-12-01 00:00 KST
    ["2026-12-31T14:59:59Z", "202612"],
    ["2026-12-31T15:00:00Z", "202701"], // year boundary
    ["2026-02-28T15:00:00Z", "202603"],
  ])("ON-02 KST month boundary: %s → %s, whatever the session TimeZone", async (at, expected) => {
    for (const tz of ["UTC", "America/Los_Angeles", "Asia/Seoul", "Pacific/Kiritimati"]) {
      const n = await env.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${tz}'`); // test-only: the application never changes it
        const r = await tx.$queryRawUnsafe<{ n: string }[]>(`SELECT next_order_number($1::timestamptz) AS n`, at);
        return r[0].n;
      });
      expect(month(n), `${at} in session TimeZone ${tz}`).toBe(expected);
    }
  });

  it("ON-03 default instant = transaction start (stable within the transaction) = the KST month of the order's created_at", async () => {
    const w = await mkWorld(env.db);
    const r = await runBookingTx(env.deps(), {
      name: "on.default",
      fn: async (tx) => {
        const a = await nextOrderNumber(tx);
        await tx(`SELECT pg_sleep(0.05)::text AS x`, []);
        const b = await nextOrderNumber(tx);
        const [now] = await tx<{ m: string }>(`SELECT to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYYMM') AS m`, []);
        const [explicit] = await tx<{ n: string }>(`SELECT next_order_number(now()) AS n`, []);
        await insertOrder(tx, w.ref(w.u1, w.is1), b);
        return { a, b, nowMonth: now.m, explicit: explicit.n };
      },
    });
    expect(month(r.a)).toBe(r.nowMonth);
    expect(month(r.b)).toBe(r.nowMonth);
    expect(month(r.explicit)).toBe(r.nowMonth);
    expect(seq(r.b)).toBe(seq(r.a) + BigInt(1));
    const [o] = await env.q<{ m: string }>(`SELECT to_char(created_at AT TIME ZONE 'Asia/Seoul', 'YYYYMM') AS m FROM orders WHERE order_number = $1`, [r.b]);
    expect(o.m).toBe(month(r.b));
  });

  it("ON-04 NULL instant is refused (22004)", async () => {
    const e = (await env.prisma.$queryRawUnsafe(`SELECT next_order_number(NULL) AS n`).catch((x: unknown) => x)) as Row;
    expect(e.meta?.driverAdapterError?.cause?.originalCode).toBe("22004");
  });
});

describe("ON-05~06 concurrency and gaps", () => {
  it("ON-05 200 concurrent issues (each in its own booking transaction): all distinct, valid, one contiguous range", async () => {
    const numbers = await Promise.all(Array.from({ length: 200 }, () => issue(env)));
    expect(new Set(numbers).size).toBe(200);
    for (const n of numbers) expect(isOrderNumber(n), n).toBe(true);
    const values = numbers.map(seq).sort((a, b) => (a < b ? -1 : 1));
    expect(values.at(-1)! - values[0]).toBe(BigInt(199)); // nothing lost, nothing reused (no other issuer meanwhile)
  });

  it("ON-05b 30 concurrent order inserts using the number of their own transaction: stored numbers = issued numbers, all unique", async () => {
    const w = await mkWorld(env.db);
    const people: { s: Row; is: Row }[] = [];
    for (let i = 0; i < 30; i++) {
      const s = await mkSubject(env.db);
      people.push({ s, is: await mkIdentitySession(env.db, s.id) });
    }
    const issued = await Promise.all(
      people.map((p) =>
        runBookingTx(env.deps(), {
          name: "on.order",
          fn: async (tx) => {
            const n = await nextOrderNumber(tx);
            await insertOrder(tx, { sessionId: w.s1.id, subjectId: p.s.id, identitySessionId: p.is.id }, n);
            return n;
          },
        }),
      ),
    );
    const stored = await env.q<{ order_number: string }>(`SELECT order_number FROM orders WHERE show_session_id = $1`, [w.s1.id]);
    expect(stored.map((r) => r.order_number).sort()).toEqual([...issued].sort());
    expect(new Set(issued).size).toBe(30);
  });

  it("ON-06 a rolled-back transaction leaves a gap: its number is never stored nor reissued", async () => {
    const w = await mkWorld(env.db);
    const a = await issue(env);
    let lost = "";
    const e = await runBookingTx(env.deps(), {
      name: "on.rollback",
      fn: async (tx) => {
        lost = await nextOrderNumber(tx);
        await insertOrder(tx, w.ref(w.u1, w.is1), lost);
        throw new AppError("SEAT_UNAVAILABLE", "rollback after the number was used");
      },
    }).catch((x) => x);
    expect(e.code).toBe("SEAT_UNAVAILABLE");
    const c = await issue(env);
    expect([seq(lost), seq(c)]).toEqual([seq(a) + BigInt(1), seq(a) + BigInt(2)]);
    expect(await env.q(`SELECT 1 FROM orders WHERE order_number = $1`, [lost])).toHaveLength(0);
  });
});

describe("ON-07~08 growth past 6 digits and NO CYCLE (own database: the sequence is moved)", () => {
  it("ON-07 999999 → 1000000 (7 digits, never truncated) up to the bigint maximum; the CHECK accepts them", async () => {
    const e = await makeEnv();
    try {
      const w = await mkWorld(e.db);
      await e.q(`SELECT setval('order_number_seq', 999998)`);
      const six = await issue(e);
      const seven = await issue(e);
      expect(six.endsWith("-999999")).toBe(true);
      expect(seven.endsWith("-1000000")).toBe(true);
      await e.q(`SELECT setval('order_number_seq', 9223372036854775806)`);
      const max = await issue(e);
      expect(max.endsWith("-9223372036854775807")).toBe(true);
      expect(max.length).toBeLessThanOrEqual(40);
      await runBookingTx(e.deps(), { name: "on.big", fn: (tx) => insertOrder(tx, w.ref(w.u1, w.is1), max) });
      await runBookingTx(e.deps(), { name: "on.big", fn: (tx) => insertOrder(tx, w.ref(w.u2, w.is2), seven) });
      expect(await e.q(`SELECT order_number FROM orders WHERE order_number IN ($1, $2) ORDER BY 1`, [seven, max])).toHaveLength(2);
    } finally {
      await dropEnv(e);
    }
  });

  it("ON-08 NO CYCLE: past the maximum the sequence refuses (2200H) instead of wrapping to 1; the runner answers a generic 500", async () => {
    const e = await makeEnv();
    try {
      const [p] = await e.q(`SELECT data_type::text, cycle, increment_by::text, min_value::text, max_value::text FROM pg_sequences WHERE sequencename = 'order_number_seq'`);
      expect(p).toEqual({ data_type: "bigint", cycle: false, increment_by: "1", min_value: "1", max_value: "9223372036854775807" });
      await e.q(`SELECT setval('order_number_seq', 9223372036854775807)`);
      const raw = (await e.prisma.$queryRawUnsafe(`SELECT next_order_number() AS n`).catch((x: unknown) => x)) as Row;
      expect(raw.meta?.driverAdapterError?.cause?.originalCode).toBe("2200H");
      vi.spyOn(console, "error").mockImplementation(() => {});
      const viaRunner = await issue(e).catch((x) => x);
      expect([viaRunner.code, viaRunner.status]).toEqual(["INTERNAL_ERROR", 500]);
    } finally {
      await dropEnv(e);
    }
  });
});

describe("ON-09 the format CHECK orders_order_number_format_ck", () => {
  it.each([
    ["NZ-T-abc123"],
    ["NZ-202611-12345"], // 5 digits
    ["nz-202611-000001"],
    ["NZ-2026111-000001"],
    ["NZ-20261-000001"],
    ["NZ-202611-00000a"],
    [" NZ-202611-000001"],
    ["NZ-202611-000001 "],
    ["NZ-202611-000001\n"],
    ["NZ-202611-000001-1"],
    ["XNZ-202611-000001"],
  ])("refuses %j (23514), application pattern agrees", async (bad) => {
    const w = await mkWorld(env.db);
    const e = await runBookingTx(env.deps(), {
      name: "on.check",
      constraints: { check: () => new AppError("VALIDATION_FAILED", "format") },
      fn: (tx) => insertOrder(tx, w.ref(w.u1, w.is1), bad),
    }).catch((x) => x);
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(isOrderNumber(bad)).toBe(false);
    expect(await env.q(`SELECT 1 FROM orders WHERE order_number = $1`, [bad])).toHaveLength(0);
  });

  it("accepts the documented shapes", async () => {
    const w = await mkWorld(env.db);
    const ok = [`NZ-202611-${String(Date.now()).slice(-6)}`, `NZ-209912-${String(Date.now())}`];
    await runBookingTx(env.deps(), { name: "on.check", fn: (tx) => insertOrder(tx, w.ref(w.u1, w.is1), ok[0]) });
    await runBookingTx(env.deps(), { name: "on.check", fn: (tx) => insertOrder(tx, w.ref(w.u2, w.is2), ok[1]) });
    for (const n of ok) expect(isOrderNumber(n)).toBe(true);
  });
});

describe("ON-10 privileges (SECURITY INVOKER)", () => {
  it("EXECUTE is public; issuing needs USAGE on order_number_seq — a role without it is refused (42501), granting it is enough", async () => {
    const role = `nazir_on_probe_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await env.q(`CREATE ROLE ${role} NOLOGIN`);
    try {
      await env.q(`GRANT USAGE ON SCHEMA public TO ${role}`);
      const [priv] = await env.q<{ ex: boolean; seq: boolean }>(
        `SELECT has_function_privilege($1, 'next_order_number(timestamptz)', 'EXECUTE') AS ex, has_sequence_privilege($1, 'order_number_seq', 'USAGE') AS seq`,
        [role],
      );
      expect(priv).toEqual({ ex: true, seq: false });
      const asRole = () =>
        env.prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
          return (await tx.$queryRawUnsafe<{ n: string }[]>(`SELECT next_order_number() AS n`))[0].n;
        });
      const denied = (await asRole().catch((x: unknown) => x)) as Row;
      expect(denied.meta?.driverAdapterError?.cause?.originalCode).toBe("42501");
      await env.q(`GRANT USAGE ON SEQUENCE order_number_seq TO ${role}`);
      expect(isOrderNumber(await asRole())).toBe(true);
    } finally {
      await env.q(`DROP OWNED BY ${role}`);
      await env.q(`DROP ROLE ${role}`);
    }
  });
});

describe("ON-11~12 schema contract and MIG-06", () => {
  it("ON-11 the contract holds: sequence properties and function signature", async () => {
    expect(await checkSequences(env.db)).toEqual([]);
    expect(await checkSqlFunctions(env.db)).toEqual([]);
  });

  it("ON-11b the contract checkers are not vacuous (sabotaged database)", async () => {
    const e = await makeEnv();
    try {
      await e.q(`ALTER SEQUENCE order_number_seq CYCLE INCREMENT BY 2`);
      await e.q(`CREATE OR REPLACE FUNCTION next_order_number("at" timestamptz DEFAULT now()) RETURNS varchar(40) LANGUAGE sql STABLE AS $$ SELECT 'NZ-000000-000000'::varchar $$`);
      const s = (await checkSequences(e.db)).join("\n");
      expect(s).toContain("cycle=true, expected false");
      expect(s).toContain("increment=2, expected 1");
      expect((await checkSqlFunctions(e.db)).join("\n")).toContain("volatility s, expected v");
      await e.q(`DROP FUNCTION next_order_number(timestamptz)`);
      await e.q(`DROP SEQUENCE order_number_seq`);
      expect(await checkSequences(e.db)).toEqual(["missing sequence order_number_seq"]);
      expect(await checkSqlFunctions(e.db)).toEqual(["missing function next_order_number"]);
    } finally {
      await dropEnv(e);
    }
  });

  it("ON-11c mutation: an lpad() that truncates is caught by the 7-digit scenario", async () => {
    const e = await makeEnv();
    try {
      await e.q(`CREATE OR REPLACE FUNCTION next_order_number("at" timestamptz DEFAULT now()) RETURNS varchar(40) LANGUAGE plpgsql VOLATILE AS $$
                 BEGIN RETURN 'NZ-' || to_char("at" AT TIME ZONE 'Asia/Seoul', 'YYYYMM') || '-' || lpad(nextval('order_number_seq')::text, 6, '0'); END $$`);
      await e.q(`SELECT setval('order_number_seq', 999999)`);
      const n = await issue(e);
      expect(n.endsWith("-1000000")).toBe(false); // the naive version cuts 1000000 to 100000
      expect(n.endsWith("-100000")).toBe(true);
    } finally {
      await dropEnv(e);
    }
  });

  it("ON-11d mutation: without the CHECK an invalid number is stored", async () => {
    const e = await makeEnv();
    try {
      const w = await mkWorld(e.db);
      await e.q(`ALTER TABLE orders DROP CONSTRAINT orders_order_number_format_ck`);
      await runBookingTx(e.deps(), { name: "on.m", fn: (tx) => insertOrder(tx, w.ref(w.u1, w.is1), "NZ-T-abc") });
      expect(await e.q(`SELECT 1 FROM orders WHERE order_number = 'NZ-T-abc'`)).toHaveLength(1);
    } finally {
      await dropEnv(e);
    }
  });

  it("ON-12 MIG-06 flags a later migration that drops the sequence, the function or the CHECK", () => {
    const f = findProtectedDrops(
      "29991231000000_bad/migration.sql",
      `BEGIN;
       DROP FUNCTION IF EXISTS "next_order_number"(timestamptz);
       DROP SEQUENCE order_number_seq;
       ALTER TABLE "orders" DROP CONSTRAINT "orders_order_number_format_ck";
       COMMIT;`,
    );
    expect(f.map((x) => x.object).sort()).toEqual(["next_order_number", "order_number_seq", "orders_order_number_format_ck"]);
  });
});
