/**
 * S2-01~S2-16, A41-01~A41-07, S2-M1~M5 (Step 5 unit 2, A-053 ③ ⑦) against a REAL PostgreSQL 16.
 *
 * S2: a live hold (ACTIVE / CONFIRMING) is only created on an AVAILABLE seat (guard A, BEFORE ROW, seat FOR SHARE), and a
 * seat set to SOLD has no live hold at COMMIT (guard B, deferred constraint trigger). Writes go through the booking
 * transaction runner on the application Prisma adapter (READ COMMITTED, the real error shapes). Races are driven with
 * gates and pg_stat_activity, so "B waits for A" is observed, not assumed.
 * A-041: order_status_logs / seat_status_logs append-only, seat_holds never deleted.
 * Mutations: each guard is weakened in a separate throwaway database and the same scenario must then break — proving the
 * scenarios detect the defect they are written for.
 */
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { PrismaClient } from "../../../src/generated/prisma/client";
import { loadDbPoolConfig } from "../../../src/server/config/db-pool-config";
import { buildPgPoolConfig } from "../../../src/server/db/pg-adapter";
import { ensureAndLockQuota, lockSeatsSorted } from "../../../src/server/booking/locks";
import { DEFAULT_RETRY_POLICY, runBookingTx, type BookingTxDeps, type ConstraintRules, type TxLimits, type TxObservation } from "../../../src/server/booking/tx";
import { AppError } from "../../../src/server/lib/errors";
import { insert, mkHold, mkIdentitySession, mkOrder, mkOrderItem, mkSubject, mkWorld } from "./helpers/fixtures";
import { cloneTestDb, destroyTestDb, resolveTestServer, type TestDb } from "./helpers/pg";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const server = resolveTestServer();
const LIMITS: TxLimits = { txMaxWaitMs: 2000, txTimeoutMs: 15000, statementTimeoutMs: 8000, lockTimeoutMs: 5000 };
const BOOKING_RULES = (): ConstraintRules => ({
  unique: { seat_holds_active_seat_uq: () => new AppError("SEAT_UNAVAILABLE", "seat") },
  check: () => new AppError("SEAT_UNAVAILABLE", "seat"), // guard A / guard B: 23514 without a name → context
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

/** One database + Prisma client + runner deps. The main suite and every mutation get their own. */
interface Env {
  db: TestDb;
  prisma: PrismaClient;
  deps: (o?: { limits?: Partial<TxLimits>; observe?: (x: TxObservation) => void; maxAttempts?: number }) => BookingTxDeps;
  q: <T = Row>(sql: string, p?: unknown[]) => Promise<T[]>;
}
async function makeEnv(): Promise<Env> {
  const db = await cloneTestDb(server, inject("templateDb"));
  const prisma = new PrismaClient({ adapter: new PrismaPg(buildPgPoolConfig(db.url, "DATABASE_URL", loadDbPoolConfig({}, "test"))) });
  return {
    db,
    prisma,
    deps: (o = {}) => ({
      startTx: (fn, options) => prisma.$transaction((tx) => fn(tx), options),
      limits: { ...LIMITS, ...o.limits },
      retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: o.maxAttempts ?? 1 },
      observe: o.observe,
    }),
    q: async (sql, p = []) => (await db.query(sql, p)).rows as never,
  };
}
async function dropEnv(e: Env) {
  await e.prisma.$disconnect();
  await destroyTestDb(e.db);
}

let env: Env;
beforeAll(async () => {
  env = await makeEnv();
});
afterAll(async () => {
  await dropEnv(env);
});
afterEach(() => vi.restoreAllMocks());
const quiet = () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
};

/**
 * A seat S with two candidate owners: order X (subject u1) owns item X on S with a CONVERTED (ended) hold — the item a
 * sale would record — and order Y (subject u2) has item Y on S without a hold yet.
 */
async function raceWorld(e: Env) {
  const w = await mkWorld(e.db);
  const x = await mkOrder(e.db, w.ref(w.u1, w.is1));
  const itemX = await mkOrderItem(e.db, { orderId: x.id, sessionId: w.s1.id, sessionSeatId: w.s1a.id });
  await mkHold(e.db, { orderId: x.id, orderItemId: itemX.id, sessionSeatId: w.s1a.id }, { status: "CONVERTED", ended_at: new Date() });
  const y = await mkOrder(e.db, w.ref(w.u2, w.is2));
  const itemY = await mkOrderItem(e.db, { orderId: y.id, sessionId: w.s1.id, sessionSeatId: w.s1a.id });
  return { w, seat: w.s1a.id as string, itemX: itemX.id as string, orderY: y.id as string, itemY: itemY.id as string };
}
type RaceWorld = Awaited<ReturnType<typeof raceWorld>>;

const holdSql = `INSERT INTO seat_holds (order_id, order_item_id, session_seat_id, status) VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`;
const sellSql = `UPDATE session_seats SET status = 'SOLD', sold_order_item_id = $2::uuid, updated_at = now() WHERE id = $1::uuid`;

/** No SOLD / BLOCKED seat with a live hold anywhere in the database (INV-9). */
async function violations(e: Env): Promise<Row[]> {
  return e.q(`SELECT s.id, s.status, h.id AS hold_id, h.status AS hold_status FROM session_seats s
                JOIN seat_holds h ON h.session_seat_id = s.id AND h.status IN ('ACTIVE','CONFIRMING')
               WHERE s.status <> 'AVAILABLE'`);
}
async function seatState(e: Env, r: RaceWorld) {
  const [s] = await e.q(`SELECT status, sold_order_item_id FROM session_seats WHERE id = $1`, [r.seat]);
  const holds = await e.q(`SELECT status FROM seat_holds WHERE order_item_id = $1`, [r.itemY]);
  return { seat: s.status, owner: s.sold_order_item_id, holdY: holds.map((h) => h.status) };
}
/** Waits until some backend of this database is blocked on a lock (B really waits for A). */
async function waitForLockWait(e: Env, min = 1) {
  for (let i = 0; i < 100; i++) {
    const [r] = await e.q<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if (r.n >= min) return;
    await sleep(20);
  }
  throw new Error("expected a backend waiting on a lock");
}
const outcome = (p: PromiseSettledResult<unknown>) => (p.status === "fulfilled" ? "ok" : (p.reason as AppError).code ?? String(p.reason));

// ───────────── reusable scenarios (asserted "protected" here, "violated" under mutation) ─────────────

/** Hold first: A creates Y's live hold and keeps its transaction open; B sells S to X meanwhile. */
async function holdFirstRace(e: Env) {
  const r = await raceWorld(e);
  const aHeld = gate();
  const aGo = gate();
  const A = runBookingTx(e.deps(), {
    name: "s2.hold",
    constraints: BOOKING_RULES(),
    fn: async (tx) => {
      await tx(holdSql, [r.orderY, r.itemY, r.seat, "ACTIVE"]);
      aHeld.open();
      await aGo.p;
    },
  });
  await aHeld.p;
  let bWaited = false;
  const B = runBookingTx(e.deps(), { name: "s2.sell", constraints: BOOKING_RULES(), fn: (tx) => tx(sellSql, [r.seat, r.itemX]) });
  try {
    await waitForLockWait(e);
    bWaited = true;
  } catch {
    /* B did not wait (only under mutation) */
  }
  await sleep(50);
  aGo.open();
  const res = await Promise.allSettled([A, B]);
  return { r, a: outcome(res[0]), b: outcome(res[1]), bWaited, state: await seatState(e, r), violations: await violations(e) };
}

/** RR seller: B takes its REPEATABLE READ snapshot, then A commits Y's hold, then B sells S (without guard B's isolation check this commits). */
async function repeatableReadSeller(e: Env) {
  const r = await raceWorld(e);
  const snap = gate();
  const sell = gate();
  const B = e.prisma
    .$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM seat_holds WHERE session_seat_id = $1::uuid`, r.seat); // snapshot taken
        snap.open();
        await sell.p;
        await tx.$queryRawUnsafe(sellSql, r.seat, r.itemX);
      },
      { isolationLevel: "RepeatableRead", timeout: 15000 },
    )
    .then(() => "ok", (x) => (x?.name === "DriverAdapterError" ? `commit-${x.cause?.originalCode}` : String(x?.code)));
  await snap.p;
  await runBookingTx(e.deps(), { name: "s2.hold", fn: (tx) => tx(holdSql, [r.orderY, r.itemY, r.seat, "ACTIVE"]) });
  sell.open();
  return { b: await B, state: await seatState(e, r), violations: await violations(e) };
}

describe("S2 guard A — a live hold needs an AVAILABLE seat", () => {
  it("S2-01 AVAILABLE seat: ACTIVE and CONFIRMING holds are created", async () => {
    const r = await raceWorld(env);
    await runBookingTx(env.deps(), { name: "s2.01", fn: (tx) => tx(holdSql, [r.orderY, r.itemY, r.seat, "ACTIVE"]) });
    expect((await seatState(env, r)).holdY).toEqual(["ACTIVE"]);
    const w = await mkWorld(env.db);
    const o = await mkOrder(env.db, w.ref(w.u1, w.is1));
    const it2 = await mkOrderItem(env.db, { orderId: o.id, sessionId: w.s1.id, sessionSeatId: w.s1b.id });
    await runBookingTx(env.deps(), { name: "s2.01", fn: (tx) => tx(holdSql, [o.id, it2.id, w.s1b.id, "CONFIRMING"]) });
  });

  it.each([["SOLD"], ["BLOCKED"]])("S2-02/03 %s seat: ACTIVE and CONFIRMING holds are refused (23514 → context), ended holds are not checked", async (state) => {
    quiet();
    const r = await raceWorld(env);
    if (state === "SOLD") await env.q(sellSql, [r.seat, r.itemX]);
    else await env.q(`UPDATE session_seats SET status = 'BLOCKED', updated_at = now() WHERE id = $1`, [r.seat]);
    for (const status of ["ACTIVE", "CONFIRMING"]) {
      const e = await runBookingTx(env.deps(), { name: "s2.02", constraints: BOOKING_RULES(), fn: (tx) => tx(holdSql, [r.orderY, r.itemY, r.seat, status]) }).catch((x) => x);
      expect(e.code, status).toBe("SEAT_UNAVAILABLE");
    }
    const raw = await runBookingTx(env.deps(), { name: "s2.02", fn: (tx) => tx(holdSql, [r.orderY, r.itemY, r.seat, "ACTIVE"]) }).catch((x) => x);
    expect(raw.code).toBe("INTERNAL_ERROR"); // without a context rule: a generic 500
    expect((await seatState(env, r)).holdY).toEqual([]);
    // a hold created already ended is not live: allowed (no invariant at stake)
    await runBookingTx(env.deps(), { name: "s2.02", fn: (tx) => tx(`${holdSql.replace("$4)", "$4, now())").replace("status)", "status, ended_at)")}`, [r.orderY, r.itemY, r.seat, "RELEASED"]) });
    expect((await seatState(env, r)).holdY).toEqual(["RELEASED"]);
    expect(await violations(env)).toEqual([]);
  });

  it("S2-04 an ended hold turned live again (UPDATE) on a SOLD seat is refused; on an AVAILABLE seat the existing unique rule still decides", async () => {
    quiet();
    const r = await raceWorld(env);
    const h = await mkHold(env.db, { orderId: r.orderY, orderItemId: r.itemY, sessionSeatId: r.seat }, { status: "EXPIRED", ended_at: new Date() });
    await env.q(sellSql, [r.seat, r.itemX]);
    const e = await runBookingTx(env.deps(), { name: "s2.04", constraints: BOOKING_RULES(), fn: (tx) => tx(`UPDATE seat_holds SET status = 'ACTIVE', ended_at = NULL, updated_at = now() WHERE id = $1::uuid`, [h.id]) }).catch((x) => x);
    expect(e.code).toBe("SEAT_UNAVAILABLE");
    expect((await env.q(`SELECT status FROM seat_holds WHERE id = $1`, [h.id]))[0].status).toBe("EXPIRED");
  });

  it("S2-05 a hold cannot move to another seat: the composite FK to the immutable order item refuses it (seat change is not a DB path)", async () => {
    quiet();
    const w = await mkWorld(env.db);
    const o = await mkOrder(env.db, w.ref(w.u1, w.is1));
    const it2 = await mkOrderItem(env.db, { orderId: o.id, sessionId: w.s1.id, sessionSeatId: w.s1a.id });
    const h = await mkHold(env.db, { orderId: o.id, orderItemId: it2.id, sessionSeatId: w.s1a.id });
    const e = await runBookingTx(env.deps(), { name: "s2.05", fn: (tx) => tx(`UPDATE seat_holds SET session_seat_id = $2::uuid WHERE id = $1::uuid`, [h.id, w.s1b.id]) }).catch((x) => x);
    expect(e.code).toBe("INTERNAL_ERROR");
    expect((await env.q(`SELECT session_seat_id FROM seat_holds WHERE id = $1`, [h.id]))[0].session_seat_id).toBe(w.s1a.id);
  });

  it("S2-06 lock order: creating a live hold locks the seat; ACTIVE → CONFIRMING (live → live) does not touch the seat lock", async () => {
    quiet();
    const r = await raceWorld(env);
    const holder = await env.db.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT 1 FROM session_seats WHERE id = $1 FOR UPDATE`, [r.seat]);
      const e = await runBookingTx(env.deps({ limits: { lockTimeoutMs: 300 } }), { name: "s2.06", fn: (tx) => tx(holdSql, [r.orderY, r.itemY, r.seat, "ACTIVE"]) }).catch((x) => x);
      expect(e.code).toBe("DATABASE_BUSY"); // the trigger waited for the seat lock (55P03)
      await holder.query("ROLLBACK");
      await runBookingTx(env.deps(), { name: "s2.06", fn: (tx) => tx(holdSql, [r.orderY, r.itemY, r.seat, "ACTIVE"]) });
      await holder.query("BEGIN");
      await holder.query(`SELECT 1 FROM session_seats WHERE id = $1 FOR UPDATE`, [r.seat]);
      const t0 = Date.now();
      await runBookingTx(env.deps({ limits: { lockTimeoutMs: 300 } }), { name: "s2.06", fn: (tx) => tx(`UPDATE seat_holds SET status = 'CONFIRMING', updated_at = now() WHERE order_item_id = $1::uuid`, [r.itemY]) });
      expect(Date.now() - t0).toBeLessThan(300);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });
});

describe("S2 guard B — a SOLD seat has no live hold at COMMIT", () => {
  it("S2-07 seat without holds (or only ended holds): SOLD commits", async () => {
    const w = await mkWorld(env.db);
    const o = await mkOrder(env.db, w.ref(w.u1, w.is1));
    const it2 = await mkOrderItem(env.db, { orderId: o.id, sessionId: w.s1.id, sessionSeatId: w.s1b.id });
    await runBookingTx(env.deps(), { name: "s2.07", fn: (tx) => tx(sellSql, [w.s1b.id, it2.id]) });
    const r = await raceWorld(env); // seat with a CONVERTED hold only
    await runBookingTx(env.deps(), { name: "s2.07", fn: (tx) => tx(sellSql, [r.seat, r.itemX]) });
    expect((await seatState(env, r)).seat).toBe("SOLD");
  });

  it.each([["ACTIVE"], ["CONFIRMING"]])("S2-08 live %s hold: the UPDATE is accepted, COMMIT refuses, everything rolled back", async (hold) => {
    quiet();
    const r = await raceWorld(env);
    await mkHold(env.db, { orderId: r.orderY, orderItemId: r.itemY, sessionSeatId: r.seat }, { status: hold });
    let statementAccepted = false;
    const seen: TxObservation[] = [];
    const e = await runBookingTx(env.deps({ observe: (x) => seen.push(x) }), {
      name: "s2.08",
      constraints: BOOKING_RULES(),
      fn: async (tx) => {
        await tx(sellSql, [r.seat, r.itemX]);
        statementAccepted = true;
        await tx(`INSERT INTO seat_status_logs (session_seat_id, from_status, to_status, order_item_id, actor_type) VALUES ($1::uuid, 'AVAILABLE', 'SOLD', $2::uuid, 'SYSTEM')`, [r.seat, r.itemX]);
      },
    }).catch((x) => x);
    expect(statementAccepted).toBe(true);
    expect(e.code).toBe("SEAT_UNAVAILABLE");
    expect(seen.at(-1)).toMatchObject({ outcome: "failed", kind: "constraint" });
    expect(await seatState(env, r)).toEqual({ seat: "AVAILABLE", owner: null, holdY: [hold] });
    expect(await env.q(`SELECT 1 FROM seat_status_logs WHERE session_seat_id = $1`, [r.seat])).toHaveLength(0);
  });

  it("S2-09 an ACTIVE hold whose order already expired is still live until expireOrder ends it; then SOLD commits (same transaction is enough)", async () => {
    quiet();
    const r = await raceWorld(env);
    await env.q(`UPDATE orders SET hold_expires_at = now() - interval '1 minute', updated_at = now() WHERE id = $1`, [r.orderY]);
    const h = await mkHold(env.db, { orderId: r.orderY, orderItemId: r.itemY, sessionSeatId: r.seat });
    const e = await runBookingTx(env.deps(), { name: "s2.09", constraints: BOOKING_RULES(), fn: (tx) => tx(sellSql, [r.seat, r.itemX]) }).catch((x) => x);
    expect(e.code).toBe("SEAT_UNAVAILABLE");
    // the sale may write the seat first and end the hold afterwards: only the final state is checked
    await runBookingTx(env.deps(), {
      name: "s2.09",
      fn: async (tx) => {
        await tx(sellSql, [r.seat, r.itemX]);
        await tx(`UPDATE seat_holds SET status = 'EXPIRED', ended_at = now(), updated_at = now() WHERE id = $1::uuid`, [h.id]);
      },
    });
    expect(await seatState(env, r)).toMatchObject({ seat: "SOLD", holdY: ["EXPIRED"] });
  });

  it("S2-10 the sale path: CONFIRMING → CONVERTED and SOLD in one transaction, in either statement order", async () => {
    for (const holdFirst of [true, false]) {
      const w = await mkWorld(env.db);
      const o = await mkOrder(env.db, w.ref(w.u1, w.is1));
      const item = await mkOrderItem(env.db, { orderId: o.id, sessionId: w.s1.id, sessionSeatId: w.s1a.id });
      const h = await mkHold(env.db, { orderId: o.id, orderItemId: item.id, sessionSeatId: w.s1a.id }, { status: "CONFIRMING" });
      const convert = `UPDATE seat_holds SET status = 'CONVERTED', ended_at = now(), updated_at = now() WHERE id = $1::uuid`;
      await runBookingTx(env.deps(), {
        name: "s2.10",
        fn: async (tx) => {
          if (holdFirst) await tx(convert, [h.id]);
          await tx(sellSql, [w.s1a.id, item.id]);
          if (!holdFirst) await tx(convert, [h.id]);
        },
      });
      expect((await env.q(`SELECT status FROM session_seats WHERE id = $1`, [w.s1a.id]))[0].status).toBe("SOLD");
    }
  });

  it("S2-11 SOLD outside READ COMMITTED is refused at COMMIT even with no hold (guard B could not see committed holds)", async () => {
    const w = await mkWorld(env.db);
    const o = await mkOrder(env.db, w.ref(w.u1, w.is1));
    const it2 = await mkOrderItem(env.db, { orderId: o.id, sessionId: w.s1.id, sessionSeatId: w.s1c.id });
    for (const isolationLevel of ["RepeatableRead", "Serializable"] as const) {
      const e = await env.prisma.$transaction((tx) => tx.$queryRawUnsafe(sellSql, w.s1c.id, it2.id), { isolationLevel }).catch((x: { name: string; cause?: { originalCode?: string } }) => x) as { name: string; cause?: { originalCode?: string } };
      expect([e.name, e.cause?.originalCode], isolationLevel).toEqual(["DriverAdapterError", "23514"]);
    }
    expect((await env.q(`SELECT status FROM session_seats WHERE id = $1`, [w.s1c.id]))[0].status).toBe("AVAILABLE");
  });

  it("S2-12 the REPEATABLE READ race: hold committed after the seller's snapshot — the seller is refused", async () => {
    const res = await repeatableReadSeller(env);
    expect(res.b).toBe("commit-23514");
    expect(res.state).toEqual({ seat: "AVAILABLE", owner: null, holdY: ["ACTIVE"] });
    expect(res.violations).toEqual([]);
  });
});

describe("S2 concurrency — hold creation vs SOLD on the same seat (real concurrent Prisma transactions)", () => {
  it("S2-13a hold locks first: the seller WAITS on the seat, then is refused at COMMIT; the hold stays", async () => {
    quiet();
    const res = await holdFirstRace(env);
    expect(res.bWaited).toBe(true);
    expect([res.a, res.b]).toEqual(["ok", "SEAT_UNAVAILABLE"]);
    expect(res.state).toEqual({ seat: "AVAILABLE", owner: null, holdY: ["ACTIVE"] });
    expect(res.violations).toEqual([]);
  });

  it("S2-13b seller locks first: the hold WAITS in guard A, then is refused; the whole order transaction rolls back", async () => {
    quiet();
    const r = await raceWorld(env);
    const bSold = gate();
    const bGo = gate();
    const B = runBookingTx(env.deps(), {
      name: "s2.sell",
      fn: async (tx) => {
        await tx(sellSql, [r.seat, r.itemX]);
        bSold.open();
        await bGo.p;
      },
    });
    await bSold.p;
    const tag = `s2-13b-${randomUUID()}`;
    const A = runBookingTx(env.deps(), {
      name: "s2.hold",
      constraints: BOOKING_RULES(),
      fn: async (tx) => {
        await tx(`INSERT INTO venues (name) VALUES ($1)`, [tag]); // stands for the rest of the order transaction
        await tx(holdSql, [r.orderY, r.itemY, r.seat, "ACTIVE"]);
      },
    });
    await waitForLockWait(env);
    bGo.open();
    const res = await Promise.allSettled([A, B]);
    expect([outcome(res[0]), outcome(res[1])]).toEqual(["SEAT_UNAVAILABLE", "ok"]);
    expect(await seatState(env, r)).toEqual({ seat: "SOLD", owner: r.itemX, holdY: [] });
    expect(await env.q(`SELECT 1 FROM venues WHERE name = $1`, [tag])).toHaveLength(0);
    expect(await violations(env)).toEqual([]);
  });

  it.each([
    ["the hold transaction", "hold"],
    ["the seller", "sell"],
  ])("S2-13c when %s that locked first rolls back, the waiting one succeeds", async (_l, first) => {
    quiet();
    const r = await raceWorld(env);
    const locked = gate();
    const go = gate();
    const firstTx = runBookingTx(env.deps(), {
      name: "s2.first",
      fn: async (tx) => {
        if (first === "hold") await tx(holdSql, [r.orderY, r.itemY, r.seat, "ACTIVE"]);
        else await tx(sellSql, [r.seat, r.itemX]);
        locked.open();
        await go.p;
        throw new AppError("INVALID_STATE_TRANSITION", "rollback");
      },
    }).catch((x) => x);
    await locked.p;
    const second = runBookingTx(env.deps(), {
      name: "s2.second",
      constraints: BOOKING_RULES(),
      fn: (tx) => (first === "hold" ? tx(sellSql, [r.seat, r.itemX]) : tx(holdSql, [r.orderY, r.itemY, r.seat, "ACTIVE"])),
    });
    await waitForLockWait(env);
    go.open();
    expect((await firstTx).code).toBe("INVALID_STATE_TRANSITION");
    await second;
    expect(await seatState(env, r)).toEqual(first === "hold" ? { seat: "SOLD", owner: r.itemX, holdY: [] } : { seat: "AVAILABLE", owner: null, holdY: ["ACTIVE"] });
  });

  it("S2-14 started together, 30 rounds: never both, always exactly one, invariant holds", async () => {
    quiet();
    const wins = { hold: 0, sell: 0 };
    for (let i = 0; i < 30; i++) {
      const r = await raceWorld(env);
      // alternate a small head start so that both orderings really occur (asserted below), plus random jitter
      const headStart = (side: "hold" | "sell") => sleep(((i % 2 === 0) === (side === "sell") ? 15 : 0) + Math.floor(Math.random() * 3));
      const res = await Promise.allSettled([
        runBookingTx(env.deps(), { name: "s2.hold", constraints: BOOKING_RULES(), fn: async (tx) => (await headStart("hold"), tx(holdSql, [r.orderY, r.itemY, r.seat, "ACTIVE"])) }),
        runBookingTx(env.deps(), { name: "s2.sell", constraints: BOOKING_RULES(), fn: async (tx) => (await headStart("sell"), tx(sellSql, [r.seat, r.itemX])) }),
      ]);
      const [a, b] = [outcome(res[0]), outcome(res[1])];
      expect([a, b].filter((x) => x === "ok"), `round ${i}: ${a} / ${b}`).toHaveLength(1);
      expect([a, b].filter((x) => x !== "ok")).toEqual(["SEAT_UNAVAILABLE"]);
      const s = await seatState(env, r);
      if (a === "ok") {
        wins.hold++;
        expect(s).toEqual({ seat: "AVAILABLE", owner: null, holdY: ["ACTIVE"] });
      } else {
        wins.sell++;
        expect(s).toEqual({ seat: "SOLD", owner: r.itemX, holdY: [] });
      }
    }
    expect(await violations(env)).toEqual([]);
    expect(wins.hold, JSON.stringify(wins)).toBeGreaterThan(0); // the race was really exercised in both directions
    expect(wins.sell, JSON.stringify(wins)).toBeGreaterThan(0);
  });

  it("S2-15 overlapping multi-seat bookings with lockSeatsSorted: no deadlock, all-or-nothing, at most one live hold per seat", async () => {
    quiet();
    const w = await mkWorld(env.db);
    const seats = [w.s1a.id, w.s1b.id, w.s1c.id];
    const picks = [[0, 1], [2, 1], [1, 0], [2, 0], [0, 2], [1, 2], [2, 1], [0, 1]];
    const people: { s: Row; is: Row }[] = [];
    for (let i = 0; i < picks.length; i++) {
      const s = await mkSubject(env.db);
      people.push({ s, is: await mkIdentitySession(env.db, s.id) });
    }
    const seen: TxObservation[] = [];
    const res = await Promise.allSettled(
      picks.map((pick, i) =>
        runBookingTx(env.deps({ observe: (x) => seen.push(x) }), {
          name: "s2.book",
          constraints: BOOKING_RULES(),
          fn: async (tx) => {
            const wanted = pick.map((k) => seats[k]);
            await ensureAndLockQuota(tx, people[i].s.id, w.s1.id);
            const [o] = await tx<{ id: string }>(
              `INSERT INTO orders (order_number, show_session_id, identity_subject_id, identity_session_id, status, customer_name, customer_phone, total_amount, hold_expires_at)
               VALUES ($1, $2::uuid, $3::uuid, $4::uuid, 'PENDING', 'n', 'p', 200000, now() + interval '7 min') RETURNING id`,
              [`NZ-T-${randomUUID().slice(0, 18)}`, w.s1.id, people[i].s.id, people[i].is.id],
            );
            const locked = await lockSeatsSorted(tx, wanted);
            if (locked.some((s) => s.status !== "AVAILABLE")) throw new AppError("SEAT_UNAVAILABLE", "seat");
            for (const s of locked) {
              const [item] = await tx<{ id: string }>(`INSERT INTO order_items (order_id, show_session_id, session_seat_id, price) VALUES ($1::uuid, $2::uuid, $3::uuid, 100000) RETURNING id`, [o.id, w.s1.id, s.id]);
              await tx(holdSql, [o.id, item.id, s.id, "ACTIVE"]);
              await sleep(5);
            }
            return o.id;
          },
        }),
      ),
    );
    expect(seen.filter((s) => s.kind === "deadlock" || s.kind === "lock_timeout")).toEqual([]);
    const committed = res.filter((x): x is PromiseFulfilledResult<string> => x.status === "fulfilled").map((x) => x.value);
    expect(res.filter((x) => x.status === "rejected").map((x) => outcome(x))).toEqual(Array(picks.length - committed.length).fill("SEAT_UNAVAILABLE"));
    expect(committed.length).toBeGreaterThanOrEqual(1);
    for (const id of committed) expect((await env.q(`SELECT count(*)::int AS n FROM seat_holds WHERE order_id = $1 AND status = 'ACTIVE'`, [id]))[0].n).toBe(2); // all-or-nothing
    const perSeat = await env.q<{ n: number }>(`SELECT count(*)::int AS n FROM seat_holds WHERE session_seat_id = ANY($1::uuid[]) AND status IN ('ACTIVE','CONFIRMING') GROUP BY session_seat_id`, [seats]);
    for (const p of perSeat) expect(p.n).toBe(1);
    expect(await env.q(`SELECT 1 FROM orders o WHERE o.show_session_id = $1 AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id)`, [w.s1.id])).toHaveLength(0);
  });
});

describe("A-041 — history is append-only, holds are never deleted", () => {
  async function logs() {
    const w = await mkWorld(env.db);
    const o = await mkOrder(env.db, w.ref(w.u1, w.is1));
    const item = await mkOrderItem(env.db, { orderId: o.id, sessionId: w.s1.id, sessionSeatId: w.s1a.id });
    const hold = await mkHold(env.db, { orderId: o.id, orderItemId: item.id, sessionSeatId: w.s1a.id });
    const ol = await insert(env.db, "order_status_logs", { order_id: o.id, from_status: null, to_status: "PENDING", source: "API" });
    const sl = await insert(env.db, "seat_status_logs", { session_seat_id: w.s1a.id, from_status: "AVAILABLE", to_status: "AVAILABLE", order_item_id: item.id, actor_type: "SYSTEM" });
    return { w, o, item, hold, ol, sl };
  }
  const expect23001 = async (sql: string, p: unknown[]) => {
    const e = await runBookingTx(env.deps(), { name: "a41", constraints: { restrict: () => new AppError("INVALID_STATE_TRANSITION", "ledger") }, fn: (tx) => tx(sql, p) }).catch((x) => x);
    expect(e.code, sql).toBe("INVALID_STATE_TRANSITION");
    const raw = await env.db.query(sql, p).catch((x) => x);
    expect(raw.code, sql).toBe("23001");
  };

  it("A41-01~04 order_status_logs / seat_status_logs: UPDATE and DELETE refused (23001), rows unchanged", async () => {
    quiet();
    const f = await logs();
    await expect23001(`UPDATE order_status_logs SET note = 'x' WHERE id = $1::uuid`, [f.ol.id]);
    await expect23001(`DELETE FROM order_status_logs WHERE id = $1::uuid`, [f.ol.id]);
    await expect23001(`UPDATE seat_status_logs SET reason = 'x' WHERE id = $1::uuid`, [f.sl.id]);
    await expect23001(`DELETE FROM seat_status_logs WHERE id = $1::uuid`, [f.sl.id]);
    expect(await env.q(`SELECT note FROM order_status_logs WHERE id = $1`, [f.ol.id])).toEqual([{ note: null }]);
    expect(await env.q(`SELECT reason FROM seat_status_logs WHERE id = $1`, [f.sl.id])).toEqual([{ reason: null }]);
  });

  it("A41-05 seat_holds: DELETE refused (23001), hold kept", async () => {
    quiet();
    const f = await logs();
    await expect23001(`DELETE FROM seat_holds WHERE id = $1::uuid`, [f.hold.id]);
    expect(await env.q(`SELECT status FROM seat_holds WHERE id = $1`, [f.hold.id])).toEqual([{ status: "ACTIVE" }]);
  });

  it("A41-06 allowed: new history rows are appended, a hold ends by a status UPDATE", async () => {
    const f = await logs();
    await runBookingTx(env.deps(), {
      name: "a41.ok",
      fn: async (tx) => {
        await tx(`UPDATE seat_holds SET status = 'RELEASED', released_reason = 'USER_CANCELED', ended_at = now(), updated_at = now() WHERE id = $1::uuid`, [f.hold.id]);
        await tx(`UPDATE orders SET status = 'CANCELED', closed_at = now(), updated_at = now() WHERE id = $1::uuid`, [f.o.id]);
        await tx(`INSERT INTO order_status_logs (order_id, from_status, to_status, source) VALUES ($1::uuid, 'PENDING', 'CANCELED', 'API')`, [f.o.id]);
      },
    });
    expect(await env.q(`SELECT to_status FROM order_status_logs WHERE order_id = $1 ORDER BY created_at`, [f.o.id])).toEqual([{ to_status: "PENDING" }, { to_status: "CANCELED" }]);
    expect(await env.q(`SELECT status FROM seat_holds WHERE id = $1`, [f.hold.id])).toEqual([{ status: "RELEASED" }]);
  });

  it("A41-07 an order with history cannot be deleted either (FK RESTRICT, unchanged)", async () => {
    const f = await logs();
    const raw = await env.db.query(`DELETE FROM orders WHERE id = $1`, [f.o.id]).catch((x) => x);
    expect(raw.code).toBe("23503");
  });
});

/**
 * Mutation tests: each guard is weakened in a SEPARATE throwaway database, and the scenario that passes above must then
 * break. If a mutation still "passes", the scenario does not test what it claims.
 */
describe("S2-M / A41-M mutations — the scenarios detect a weakened guard", () => {
  const withMutation = async (sql: string, check: (e: Env) => Promise<void>) => {
    const e = await makeEnv();
    try {
      await e.q(sql);
      await check(e);
    } finally {
      await dropEnv(e);
    }
  };

  it("S2-M1 guard A disabled: a live hold is created on a SOLD seat", () =>
    withMutation(`CREATE OR REPLACE FUNCTION seat_holds_check_seat_available() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`, async (e) => {
      const r = await raceWorld(e);
      await e.q(sellSql, [r.seat, r.itemX]);
      await runBookingTx(e.deps(), { name: "m1", fn: (tx) => tx(holdSql, [r.orderY, r.itemY, r.seat, "ACTIVE"]) });
      expect(await violations(e)).toHaveLength(1);
    }));

  it("S2-M2 guard A without FOR SHARE: the race lets both commit (the seller no longer waits)", () =>
    withMutation(
      `CREATE OR REPLACE FUNCTION seat_holds_check_seat_available() RETURNS trigger LANGUAGE plpgsql AS $$
         DECLARE st text; BEGIN
           IF NEW.status NOT IN ('ACTIVE','CONFIRMING') THEN RETURN NEW; END IF;
           SELECT s.status INTO st FROM session_seats s WHERE s.id = NEW.session_seat_id; -- no FOR SHARE
           IF st <> 'AVAILABLE' THEN RAISE EXCEPTION 'x' USING ERRCODE = 'check_violation'; END IF;
           RETURN NEW; END $$`,
      async (e) => {
        quiet();
        const res = await holdFirstRace(e);
        expect(res.bWaited).toBe(false);
        expect([res.a, res.b]).toEqual(["ok", "ok"]);
        expect(res.violations).toHaveLength(1);
      },
    ));

  it("S2-M3 guard B dropped: a seat with a live hold is sold", () =>
    withMutation(`DROP TRIGGER session_seats_sold_hold_guard ON session_seats`, async (e) => {
      quiet();
      const r = await raceWorld(e);
      await mkHold(e.db, { orderId: r.orderY, orderItemId: r.itemY, sessionSeatId: r.seat });
      await runBookingTx(e.deps(), { name: "m3", fn: (tx) => tx(sellSql, [r.seat, r.itemX]) });
      expect(await violations(e)).toHaveLength(1);
    }));

  it("S2-M4 guard B without the READ COMMITTED check: the REPEATABLE READ seller commits over a live hold", () =>
    withMutation(
      `CREATE OR REPLACE FUNCTION session_seats_check_sold_no_live_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
         IF EXISTS (SELECT 1 FROM seat_holds h WHERE h.session_seat_id = NEW.id AND h.status IN ('ACTIVE','CONFIRMING')) THEN
           RAISE EXCEPTION 'x' USING ERRCODE = 'check_violation'; END IF;
         RETURN NULL; END $$`,
      async (e) => {
        const res = await repeatableReadSeller(e);
        expect(res.b).toBe("ok");
        expect(res.violations).toHaveLength(1);
      },
    ));

  it("A41-M1 history triggers dropped: UPDATE / DELETE of history and DELETE of a hold succeed", () =>
    withMutation(
      `DROP TRIGGER order_status_logs_no_update ON order_status_logs; DROP TRIGGER order_status_logs_no_delete ON order_status_logs;
       DROP TRIGGER seat_status_logs_no_update ON seat_status_logs; DROP TRIGGER seat_status_logs_no_delete ON seat_status_logs;
       DROP TRIGGER seat_holds_no_delete ON seat_holds`,
      async (e) => {
        const w = await mkWorld(e.db);
        const o = await mkOrder(e.db, w.ref(w.u1, w.is1));
        const item = await mkOrderItem(e.db, { orderId: o.id, sessionId: w.s1.id, sessionSeatId: w.s1a.id });
        const hold = await mkHold(e.db, { orderId: o.id, orderItemId: item.id, sessionSeatId: w.s1a.id });
        const ol = await insert(e.db, "order_status_logs", { order_id: o.id, to_status: "PENDING", source: "API" });
        const sl = await insert(e.db, "seat_status_logs", { session_seat_id: w.s1a.id, to_status: "AVAILABLE", actor_type: "SYSTEM" });
        for (const [sql, id] of [
          [`UPDATE order_status_logs SET note = 'x' WHERE id = $1`, ol.id],
          [`UPDATE seat_status_logs SET reason = 'x' WHERE id = $1`, sl.id],
          [`DELETE FROM order_status_logs WHERE id = $1`, ol.id],
          [`DELETE FROM seat_status_logs WHERE id = $1`, sl.id],
          [`DELETE FROM seat_holds WHERE id = $1`, hold.id],
        ])
          expect((await e.db.query(sql, [id])).rowCount, sql).toBe(1);
      },
    ));
});
