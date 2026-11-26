/**
 * TX-01~TX-16 (Step 5 unit 1, A-053): the booking transaction runner and lock helpers against a REAL PostgreSQL through
 * the Prisma 7 driver adapter (`@prisma/adapter-pg`), so every error shape is the real one — statement time, COMMIT time,
 * deadlock, lock / statement timeout, pool exhaustion, expired transaction.
 * Fixtures are written with plain SQL (helpers/fixtures.ts) and COMMITTED, because the runner commits.
 */
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { PrismaClient } from "../../../src/generated/prisma/client";
import { loadDbPoolConfig, type DbPoolConfig } from "../../../src/server/config/db-pool-config";
import { buildPgPoolConfig } from "../../../src/server/db/pg-adapter";
import { ensureAndLockQuota, lockSeatsSorted } from "../../../src/server/booking/locks";
import { DEFAULT_RETRY_POLICY, runBookingTx, type BookingTxDeps, type ConstraintRules, type RetryPolicy, type TxLimits, type TxObservation } from "../../../src/server/booking/tx";
import { AppError } from "../../../src/server/lib/errors";
import { mkOrder, mkOrderItem, mkHold, mkWorld, testOrderNumber } from "./helpers/fixtures";
import { cloneTestDb, destroyTestDb, resolveTestServer, type TestDb } from "./helpers/pg";

const server = resolveTestServer();
let db: TestDb;
const clients: PrismaClient[] = [];
let prisma: PrismaClient;

const POOL = (o: Partial<DbPoolConfig> = {}): DbPoolConfig => ({ ...loadDbPoolConfig({}, "test"), ...o });
function newClient(o: Partial<DbPoolConfig> = {}): PrismaClient {
  const c = new PrismaClient({ adapter: new PrismaPg(buildPgPoolConfig(db.url, "DATABASE_URL", POOL(o))) });
  clients.push(c);
  return c;
}
const LIMITS: TxLimits = { txMaxWaitMs: 2000, txTimeoutMs: 15000, statementTimeoutMs: 8000, lockTimeoutMs: 5000 };
function deps(client: PrismaClient, o: { limits?: Partial<TxLimits>; retry?: Partial<RetryPolicy>; observe?: (x: TxObservation) => void } = {}): BookingTxDeps {
  return {
    startTx: (fn, options) => client.$transaction((tx) => fn(tx), options),
    limits: { ...LIMITS, ...o.limits },
    retry: { ...DEFAULT_RETRY_POLICY, ...o.retry },
    observe: o.observe,
  };
}
const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as T[];
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let logs: string[] = [];

beforeAll(async () => {
  db = await cloneTestDb(server, inject("templateDb"));
  prisma = newClient();
});
afterAll(async () => {
  for (const c of clients) await c.$disconnect();
  await destroyTestDb(db);
});
afterEach(() => {
  vi.restoreAllMocks();
  logs = [];
});
function captureLogs() {
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")));
}

const ORDER_RULES = (): ConstraintRules => ({
  unique: {
    seat_holds_active_seat_uq: () => new AppError("SEAT_UNAVAILABLE", "seat"),
    orders_active_subject_session_uq: () => new AppError("ACTIVE_ORDER_EXISTS", "active"),
  },
  check: () => new AppError("PURCHASE_LIMIT_EXCEEDED", "limit"),
});

describe("TX-01 isolation level and SET LOCAL limits", () => {
  it("runs READ COMMITTED even when the database default is SERIALIZABLE", async () => {
    await q(`ALTER DATABASE "${db.name}" SET default_transaction_isolation = 'serializable'`);
    try {
      const c = newClient();
      const outside = await c.$queryRawUnsafe<{ iso: string }[]>(`SELECT current_setting('transaction_isolation') AS iso`);
      expect(outside[0].iso).toBe("serializable"); // the default really changed
      const inside = await runBookingTx(deps(c), { name: "tx01", fn: async (tx) => (await tx<{ iso: string }>(`SELECT current_setting('transaction_isolation') AS iso`, []))[0].iso });
      expect(inside).toBe("read committed");
    } finally {
      await q(`ALTER DATABASE "${db.name}" RESET default_transaction_isolation`);
    }
  });

  it("lock_timeout / statement_timeout are set inside the transaction and gone after it (same pooled connection)", async () => {
    const one = newClient({ poolMax: 1 });
    const inside = await runBookingTx(deps(one, { limits: { lockTimeoutMs: 1234, statementTimeoutMs: 4321 } }), {
      name: "tx01b",
      fn: async (tx) => (await tx<{ lt: string; st: string; pid: number }>(`SELECT current_setting('lock_timeout') AS lt, current_setting('statement_timeout') AS st, pg_backend_pid() AS pid`, []))[0],
    });
    expect([inside.lt, inside.st]).toEqual(["1234ms", "4321ms"]);
    const after = await one.$queryRawUnsafe<{ lt: string; st: string; pid: number }[]>(`SELECT current_setting('lock_timeout') AS lt, current_setting('statement_timeout') AS st, pg_backend_pid() AS pid`);
    expect(after[0].pid).toBe(inside.pid); // really the same connection
    expect([after[0].lt, after[0].st]).toEqual(["0", "0"]);
  });
});

describe("TX-02 lock timeout (55P03)", () => {
  it("bounded retries, then 503 DATABASE_BUSY; every attempt rolled back", async () => {
    captureLogs();
    const w = await mkWorld(db);
    const holder = await db.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT 1 FROM session_seats WHERE id = $1 FOR UPDATE`, [w.s1a.id]);
      const seen: TxObservation[] = [];
      const t0 = Date.now();
      const e = await runBookingTx(deps(prisma, { limits: { lockTimeoutMs: 200 }, retry: { maxAttempts: 2 }, observe: (x) => seen.push(x) }), {
        name: "tx02",
        fn: async (tx) => {
          await tx(`INSERT INTO venues (name) VALUES ($1)`, [`tx02-${w.v1.id}`]);
          return lockSeatsSorted(tx, [w.s1a.id]);
        },
      }).catch((x) => x);
      expect([e.code, e.status, e.details]).toEqual(["DATABASE_BUSY", 503, { retryAfterSeconds: 2 }]);
      expect(seen.map((s) => [s.outcome, s.kind])).toEqual([["retry", "lock_timeout"], ["failed", "lock_timeout"]]);
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(await q(`SELECT 1 FROM venues WHERE name = $1`, [`tx02-${w.v1.id}`])).toHaveLength(0);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });

  it("succeeds on retry when the lock is released between attempts", async () => {
    captureLogs();
    const w = await mkWorld(db);
    const holder = await db.pool.connect();
    await holder.query("BEGIN");
    await holder.query(`SELECT 1 FROM session_seats WHERE id = $1 FOR UPDATE`, [w.s1a.id]);
    const seen: TxObservation[] = [];
    const r = await runBookingTx(
      deps(prisma, {
        limits: { lockTimeoutMs: 200 },
        observe: (x) => {
          seen.push(x);
          if (x.outcome === "retry") void holder.query("ROLLBACK").then(() => holder.release());
        },
      }),
      { name: "tx02b", fn: async (tx) => (await lockSeatsSorted(tx, [w.s1a.id])).map((s) => s.id) },
    );
    expect(r).toEqual([w.s1a.id]);
    expect(seen.map((s) => s.outcome)).toEqual(["retry", "committed"]);
  });
});

describe("TX-03 statement timeout (57014)", () => {
  it("503 without retry; the statement is cancelled by PostgreSQL at statement_timeout", async () => {
    captureLogs();
    const seen: TxObservation[] = [];
    const t0 = Date.now();
    const e = await runBookingTx(deps(prisma, { limits: { lockTimeoutMs: 100, statementTimeoutMs: 300 }, observe: (x) => seen.push(x) }), {
      name: "tx03",
      fn: async (tx) => tx(`SELECT pg_sleep(3)::text AS x`, []),
    }).catch((x) => x);
    expect([e.code, e.status]).toEqual(["DATABASE_BUSY", 503]);
    expect(seen).toEqual([{ name: "tx03", attempt: 1, outcome: "failed", kind: "statement_timeout" }]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("TX-04 pool exhausted and expired transaction (P2028)", () => {
  it("pool max=1 held by another transaction: P2028 after maxWait → 503 + retryAfterSeconds; no leaked connection afterwards", async () => {
    captureLogs();
    const one = newClient({ poolMax: 1, connectionTimeoutMs: 5000 });
    const held = gate();
    const started = gate();
    const holder = one.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT 1 AS x`);
      started.open();
      await held.p;
    }, { timeout: 20000 });
    await started.p;
    const seen: TxObservation[] = [];
    const t0 = Date.now();
    const e = await runBookingTx(deps(one, { limits: { txMaxWaitMs: 300 }, observe: (x) => seen.push(x) }), { name: "tx04", fn: async () => 1 }).catch((x) => x);
    expect([e.code, e.status, e.details.retryAfterSeconds]).toEqual(["DATABASE_BUSY", 503, 2]);
    expect(seen).toEqual([{ name: "tx04", attempt: 1, outcome: "failed", kind: "tx_unavailable" }]);
    expect(Date.now() - t0).toBeLessThan(2000);
    held.open();
    await holder;
    // the timed-out wait must not keep the only connection: a new transaction gets it
    expect(await runBookingTx(deps(one), { name: "tx04b", fn: async (tx) => (await tx<{ x: number }>(`SELECT 7 AS x`, []))[0].x })).toBe(7);
  });

  it("transaction expired (timeout) → 503, and its writes are rolled back", async () => {
    captureLogs();
    const tag = `tx04c-${randomUUID()}`;
    const e = await runBookingTx(deps(prisma, { limits: { txTimeoutMs: 600, statementTimeoutMs: 400, lockTimeoutMs: 200 } }), {
      name: "tx04c",
      fn: async (tx) => {
        await tx(`INSERT INTO venues (name) VALUES ($1)`, [tag]);
        await sleep(900);
        return tx(`SELECT 1 AS x`, []);
      },
    }).catch((x) => x);
    expect([e.code, e.status]).toEqual(["DATABASE_BUSY", 503]);
    expect(await q(`SELECT 1 FROM venues WHERE name = $1`, [tag])).toHaveLength(0);
  });
});

describe("TX-05 COMMIT-time 23514 (deferred constraint trigger)", () => {
  async function paidWithoutSucceededPayment(rules?: ConstraintRules) {
    const w = await mkWorld(db);
    const order = await mkOrder(db, w.ref(w.u1, w.is1));
    let statementsDone = false;
    const e = await runBookingTx(deps(prisma), {
      name: "tx05",
      constraints: rules,
      fn: async (tx) => {
        const [p] = await tx<{ id: string }>(
          `INSERT INTO payments (order_id, provider, merchant_payment_ref, status, method_type, requested_method_type, requested_amount, return_nonce_hash, checkout_expires_at)
           VALUES ($1::uuid, 'MOCK', $2, 'READY', 'CARD', 'CARD', 100000, $3, now() + interval '7 min') RETURNING id`,
          [order.id, `pay-${randomUUID()}`, `rn-${randomUUID()}`],
        );
        await tx(`UPDATE orders SET status = 'PAID', confirmed_payment_id = $2::uuid, paid_at = now(), updated_at = now() WHERE id = $1::uuid`, [order.id, p.id]);
        statementsDone = true; // every statement accepted: the rejection can only come from COMMIT
      },
    }).catch((x) => x);
    return { e, order, statementsDone };
  }

  it("statements are accepted, COMMIT rejects; mapped by the transaction's context; everything rolled back", async () => {
    captureLogs();
    const { e, order, statementsDone } = await paidWithoutSucceededPayment({ check: () => new AppError("INVALID_STATE_TRANSITION", "ctx") });
    expect(statementsDone).toBe(true);
    expect(e.code).toBe("INVALID_STATE_TRANSITION");
    expect(await q(`SELECT status, confirmed_payment_id FROM orders WHERE id = $1`, [order.id])).toEqual([{ status: "PENDING", confirmed_payment_id: null }]);
    expect(await q(`SELECT 1 FROM payments WHERE order_id = $1`, [order.id])).toHaveLength(0);
    expect(logs.join("\n")).toContain("kind=constraint sqlstate=23514 constraint=none"); // measured: no name at COMMIT
  });

  it("without a context rule it is a generic 500", async () => {
    captureLogs();
    const { e } = await paidWithoutSucceededPayment();
    expect([e.code, e.status]).toEqual(["INTERNAL_ERROR", 500]);
  });
});

describe("TX-06 statement-time 23505 by constraint name", () => {
  it("second active order for the same subject/session → ACTIVE_ORDER_EXISTS; the quota row it inserted is rolled back", async () => {
    captureLogs();
    const w = await mkWorld(db);
    await mkOrder(db, w.ref(w.u1, w.is1)); // active PENDING order; creates the (u1, s1) quota row
    const e = await runBookingTx(deps(prisma), {
      name: "tx06",
      constraints: ORDER_RULES(),
      fn: async (tx) => {
        await ensureAndLockQuota(tx, w.u1.id, w.s2.id); // other session: a NEW quota row in this transaction
        await tx(
          `INSERT INTO orders (order_number, show_session_id, identity_subject_id, identity_session_id, status, customer_name, customer_phone, total_amount, hold_expires_at)
           VALUES ($1, $2::uuid, $3::uuid, $4::uuid, 'PENDING', 'n', 'p', 100000, now() + interval '7 min')`,
          [testOrderNumber(), w.s1.id, w.u1.id, w.is1.id],
        );
      },
    }).catch((x) => x);
    expect(e.code).toBe("ACTIVE_ORDER_EXISTS");
    expect(await q(`SELECT 1 FROM purchase_quotas WHERE identity_subject_id = $1 AND show_session_id = $2`, [w.u1.id, w.s2.id])).toHaveLength(0);
  });

  it("live hold on an already held seat → SEAT_UNAVAILABLE; the whole order is rolled back", async () => {
    captureLogs();
    const w = await mkWorld(db);
    const a = await mkOrder(db, w.ref(w.u1, w.is1));
    const ai = await mkOrderItem(db, { orderId: a.id, sessionId: w.s1.id, sessionSeatId: w.s1a.id });
    await mkHold(db, { orderId: a.id, orderItemId: ai.id, sessionSeatId: w.s1a.id });
    const number = testOrderNumber();
    const e = await runBookingTx(deps(prisma), {
      name: "tx06b",
      constraints: ORDER_RULES(),
      fn: async (tx) => {
        await ensureAndLockQuota(tx, w.u2.id, w.s1.id);
        const [o] = await tx<{ id: string }>(
          `INSERT INTO orders (order_number, show_session_id, identity_subject_id, identity_session_id, status, customer_name, customer_phone, total_amount, hold_expires_at)
           VALUES ($1, $2::uuid, $3::uuid, $4::uuid, 'PENDING', 'n', 'p', 100000, now() + interval '7 min') RETURNING id`,
          [number, w.s1.id, w.u2.id, w.is2.id],
        );
        const [it] = await tx<{ id: string }>(`INSERT INTO order_items (order_id, show_session_id, session_seat_id, price) VALUES ($1::uuid, $2::uuid, $3::uuid, 100000) RETURNING id`, [o.id, w.s1.id, w.s1a.id]);
        await tx(`INSERT INTO seat_holds (order_id, order_item_id, session_seat_id, status) VALUES ($1::uuid, $2::uuid, $3::uuid, 'ACTIVE')`, [o.id, it.id, w.s1a.id]);
      },
    }).catch((x) => x);
    expect(e.code).toBe("SEAT_UNAVAILABLE");
    expect(await q(`SELECT 1 FROM orders WHERE order_number = $1`, [number])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM purchase_quotas WHERE identity_subject_id = $1 AND show_session_id = $2`, [w.u2.id, w.s1.id])).toHaveLength(0);
  });
});

describe("TX-07 deadlock (40P01)", () => {
  /** Two transactions lock two seats in REVERSE order (deliberately not using lockSeatsSorted). */
  async function reverseOrder(maxAttempts: number) {
    const w = await mkWorld(db);
    const both = gate();
    let arrived = 0;
    const seen: TxObservation[] = [];
    const run = (first: string, second: string, name: string) =>
      runBookingTx(deps(prisma, { retry: { maxAttempts }, observe: (x) => seen.push(x) }), {
        name,
        fn: async (tx) => {
          await tx(`SELECT 1 AS x FROM session_seats WHERE id = $1::uuid FOR UPDATE`, [first]);
          if (++arrived === 2) both.open();
          await both.p; // only the first attempts meet here; afterwards the gate is open
          await tx(`SELECT 1 AS x FROM session_seats WHERE id = $1::uuid FOR UPDATE`, [second]);
          return name;
        },
      });
    const r = await Promise.allSettled([run(w.s1a.id, w.s1b.id, "tx07a"), run(w.s1b.id, w.s1a.id, "tx07b")]);
    return { r, seen };
  }

  it("is reproduced and the loser is retried to success", async () => {
    captureLogs();
    const { r, seen } = await reverseOrder(3);
    expect(r.map((x) => x.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(seen.filter((s) => s.outcome === "retry").map((s) => s.kind)).toEqual(["deadlock"]);
    expect(logs.join("\n")).toMatch(/kind=deadlock sqlstate=40P01/);
  });

  it("with no retry left the loser gets 503 DATABASE_BUSY", async () => {
    captureLogs();
    const { r } = await reverseOrder(1);
    const rejected = r.filter((x): x is PromiseRejectedResult => x.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect([rejected[0].reason.code, rejected[0].reason.status]).toEqual(["DATABASE_BUSY", 503]);
  });
});

describe("TX-08 lockSeatsSorted: overlapping seats in any order never deadlock", () => {
  it("12 concurrent transactions, shuffled seat lists, all commit with zero retries", async () => {
    const w = await mkWorld(db);
    const ids = [w.s1a.id, w.s1b.id, w.s1c.id];
    const perms = [[0, 1, 2], [2, 1, 0], [1, 2, 0], [2, 0, 1], [0, 2, 1], [1, 0, 2]];
    const seen: TxObservation[] = [];
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        runBookingTx(deps(prisma, { observe: (x) => seen.push(x) }), {
          name: "tx08",
          fn: async (tx) => {
            const locked = await lockSeatsSorted(tx, perms[i % perms.length].map((k) => ids[k]));
            await tx(`SELECT pg_sleep(0.02)::text AS x`, []);
            return locked.map((s) => s.id);
          },
        }),
      ),
    );
    const sorted = [...ids].sort();
    for (const r of results) expect(r).toEqual(sorted);
    expect(seen.filter((s) => s.outcome !== "committed")).toEqual([]);
  });

  it("returns rows in lock order with their session and status; unknown ids are absent", async () => {
    const w = await mkWorld(db);
    const ghost = randomUUID();
    const rows = await runBookingTx(deps(prisma), { name: "tx08b", fn: (tx) => lockSeatsSorted(tx, [w.s1c.id, ghost, w.s2a.id]) });
    expect(rows.map((r) => r.id)).toEqual([w.s1c.id, w.s2a.id].sort());
    expect(rows.find((r) => r.id === w.s2a.id)).toMatchObject({ showSessionId: w.s2.id, status: "AVAILABLE", price: BigInt(100000), soldOrderItemId: null });
  });
});

describe("TX-09 ensureAndLockQuota", () => {
  it("creates the row with the session's current limit snapshot; an existing row is not changed", async () => {
    const w = await mkWorld(db);
    await q(`UPDATE show_sessions SET max_seats_per_identity = 2 WHERE id = $1`, [w.s1.id]);
    const first = await runBookingTx(deps(prisma), { name: "tx09", fn: (tx) => ensureAndLockQuota(tx, w.u1.id, w.s1.id) });
    expect(first).toMatchObject({ seatLimit: 2, countedSeats: 0, version: 0 });
    await q(`UPDATE show_sessions SET max_seats_per_identity = 4 WHERE id = $1`, [w.s1.id]);
    const again = await runBookingTx(deps(prisma), { name: "tx09", fn: (tx) => ensureAndLockQuota(tx, w.u1.id, w.s1.id) });
    expect(again?.seatLimit).toBe(2);
  });

  it("unknown show session → null, nothing inserted", async () => {
    const w = await mkWorld(db);
    const ghost = randomUUID();
    expect(await runBookingTx(deps(prisma), { name: "tx09b", fn: (tx) => ensureAndLockQuota(tx, w.u1.id, ghost) })).toBeNull();
    expect(await q(`SELECT 1 FROM purchase_quotas WHERE show_session_id = $1`, [ghost])).toHaveLength(0);
  });

  it("row missing, two concurrent transactions: the second waits and reads the first's COMMITTED counter", async () => {
    const w = await mkWorld(db);
    const t1Locked = gate();
    const t1Go = gate();
    const t1 = runBookingTx(deps(prisma), {
      name: "tx09c",
      fn: async (tx) => {
        await ensureAndLockQuota(tx, w.u1.id, w.s1.id);
        t1Locked.open();
        await t1Go.p;
        await tx(`UPDATE purchase_quotas SET counted_seats = 3, version = version + 1, updated_at = now() WHERE identity_subject_id = $1::uuid AND show_session_id = $2::uuid`, [w.u1.id, w.s1.id]);
      },
    });
    await t1Locked.p;
    let t2Done = false;
    const t2 = runBookingTx(deps(prisma), { name: "tx09c", fn: (tx) => ensureAndLockQuota(tx, w.u1.id, w.s1.id) }).finally(() => (t2Done = true));
    await sleep(300);
    expect(t2Done).toBe(false); // blocked on the primary key until T1 ends
    t1Go.open();
    await t1;
    expect(await t2).toMatchObject({ countedSeats: 3, version: 1 });
  });

  it("row missing, the first transaction rolls back: the second inserts it and proceeds", async () => {
    const w = await mkWorld(db);
    const t1Locked = gate();
    const t1Go = gate();
    const t1 = runBookingTx(deps(prisma), {
      name: "tx09d",
      fn: async (tx) => {
        await ensureAndLockQuota(tx, w.u1.id, w.s1.id);
        t1Locked.open();
        await t1Go.p;
        throw new AppError("PURCHASE_LIMIT_EXCEEDED", "rollback");
      },
    }).catch((x) => x);
    await t1Locked.p;
    const t2 = runBookingTx(deps(prisma), { name: "tx09d", fn: (tx) => ensureAndLockQuota(tx, w.u1.id, w.s1.id) });
    await sleep(200);
    t1Go.open();
    expect((await t1).code).toBe("PURCHASE_LIMIT_EXCEEDED");
    expect(await t2).toMatchObject({ seatLimit: 4, countedSeats: 0 });
  });
});

describe("TX-10 failure → rollback", () => {
  it("an AppError from fn is rethrown unchanged and the transaction's writes are rolled back", async () => {
    const tag = `tx10-${randomUUID()}`;
    const app = new AppError("SALES_NOT_OPEN", "closed");
    const e = await runBookingTx(deps(prisma), {
      name: "tx10",
      fn: async (tx) => {
        await tx(`INSERT INTO venues (name) VALUES ($1)`, [tag]);
        throw app;
      },
    }).catch((x) => x);
    expect(e).toBe(app);
    expect(await q(`SELECT 1 FROM venues WHERE name = $1`, [tag])).toHaveLength(0);
  });

  it("catching a DB error inside fn and continuing → 25P02 → 500, nothing committed", async () => {
    captureLogs();
    const w = await mkWorld(db);
    const o = await mkOrder(db, w.ref(w.u1, w.is1));
    const it2 = await mkOrderItem(db, { orderId: o.id, sessionId: w.s1.id, sessionSeatId: w.s1b.id });
    const tag = `tx10b-${randomUUID()}`;
    const e = await runBookingTx(deps(prisma), {
      name: "tx10b",
      constraints: { restrict: () => new AppError("INVALID_STATE_TRANSITION", "x") },
      fn: async (tx) => {
        await tx(`INSERT INTO venues (name) VALUES ($1)`, [tag]);
        try {
          await tx(`UPDATE order_items SET price = 1 WHERE id = $1::uuid`, [it2.id]); // 23001 (immutable)
        } catch {
          /* WRONG on purpose: swallowing a DB error */
        }
        return tx(`SELECT 1 AS x`, []);
      },
    }).catch((x) => x);
    expect([e.code, e.status]).toEqual(["INTERNAL_ERROR", 500]);
    expect(logs.join("\n")).toContain("kind=aborted_tx sqlstate=25P02");
    expect(await q(`SELECT 1 FROM venues WHERE name = $1`, [tag])).toHaveLength(0);
  });
});

describe("TX-11 no sensitive data in logs or responses", () => {
  it("a CHECK violation whose PostgreSQL message contains the row's customer name and phone", async () => {
    const w = await mkWorld(db);
    const NAME = `SENSITIVE-NAME-${randomUUID()}`;
    const PHONE = "01098765432";
    const insertBad = (tx: (s: string, p: unknown[]) => Promise<unknown>) =>
      tx(
        `INSERT INTO orders (order_number, show_session_id, identity_subject_id, identity_session_id, status, customer_name, customer_phone, total_amount, hold_expires_at)
         VALUES ($1, $2::uuid, $3::uuid, $4::uuid, 'PENDING', $5, $6, -1, now() + interval '7 min')`,
        [testOrderNumber(), w.s1.id, w.u1.id, w.is1.id, NAME, PHONE],
      );
    await q(`INSERT INTO purchase_quotas (identity_subject_id, show_session_id, seat_limit) VALUES ($1, $2, 4) ON CONFLICT DO NOTHING`, [w.u1.id, w.s1.id]);
    // precondition: the raw error really carries the values (otherwise this test proves nothing)
    const raw = await prisma.$transaction((tx) => insertBad((s, p) => tx.$queryRawUnsafe(s, ...p))).catch((x: { message: string; meta: unknown }) => x) as { message: string; meta: unknown };
    expect(JSON.stringify({ m: raw.message, meta: raw.meta })).toContain(NAME);

    captureLogs();
    const e = await runBookingTx(deps(prisma), { name: "tx11", constraints: ORDER_RULES(), fn: (tx) => insertBad(tx) }).catch((x: AppError) => x) as AppError;
    expect(e.code).toBe("PURCHASE_LIMIT_EXCEEDED"); // 23514 by context (CHECK carries no name)
    const out = JSON.stringify({ logs, e: { code: e.code, message: e.message, details: e.details } });
    expect(out).not.toContain(NAME);
    expect(out).not.toContain(PHONE);
    expect(logs).toEqual(["[booking-tx] tx11 attempt=1/3 kind=constraint sqlstate=23514 constraint=none mapped=PURCHASE_LIMIT_EXCEEDED"]);
  });
});

describe("TX-12 application wiring (getPrisma + bookingTxDeps)", () => {
  it("uses the validated pool limits and READ COMMITTED; an invalid pool configuration fails the request closed", async () => {
    vi.stubEnv("NAZIR_RUNTIME_ENV", "test");
    vi.stubEnv("DATABASE_URL", db.url);
    vi.stubEnv("PAYMENT_PROVIDER", "mock");
    vi.stubEnv("IDENTITY_PROVIDER", "mock");
    vi.stubEnv("NAZIR_DB_LOCK_TIMEOUT_MS", "777");
    const g = globalThis as { __nazirPrisma?: PrismaClient; __nazirDbPool?: unknown };
    const reset = async () => {
      const c = g.__nazirPrisma;
      delete g.__nazirPrisma;
      delete g.__nazirDbPool;
      await c?.$disconnect();
    };
    await reset();
    vi.resetModules();
    try {
      const { bookingTxDeps } = await import("../../../src/server/booking/app-deps");
      const d = bookingTxDeps();
      expect(d.limits).toMatchObject({ lockTimeoutMs: 777, statementTimeoutMs: 5000, txTimeoutMs: 10000, txMaxWaitMs: 2000 });
      const r = await runBookingTx(d, { name: "tx12", fn: async (tx) => (await tx<{ iso: string; lt: string }>(`SELECT current_setting('transaction_isolation') AS iso, current_setting('lock_timeout') AS lt`, []))[0] });
      expect(r).toEqual({ iso: "read committed", lt: "777ms" });
      await reset();
      vi.stubEnv("NAZIR_DB_LOCK_TIMEOUT_MS", "99999");
      vi.resetModules();
      const again = await import("../../../src/server/booking/app-deps");
      expect(() => again.bookingTxDeps()).toThrow(/Invalid database pool configuration/);
    } finally {
      await reset();
      vi.unstubAllEnvs();
    }
  });
});
