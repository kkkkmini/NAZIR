/**
 * TX-U01~U08 (Step 5 unit 1, A-053): pool / time-limit configuration, database error classification on the MEASURED
 * shapes, retry backoff bounds, and the booking transaction runner's decisions with a fake transaction starter.
 * The same behaviour against a real PostgreSQL + Prisma adapter is in tests/contract/schema/booking-tx.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DB_POOL_FIELDS, assertStartupDbPoolConfig, loadDbPoolConfig } from "@/server/config/db-pool-config";
import { DatabaseConfigError } from "@/server/config/database-config";
import { classifyDbError } from "@/server/db/errors";
import { buildPgPoolConfig } from "@/server/db/pg-adapter";
import { sortSeatIds } from "@/server/booking/locks";
import { DEFAULT_RETRY_POLICY, retryDelayMs, runBookingTx, validateRetryPolicy, type BookingTxDeps, type StartTx, type TxObservation } from "@/server/booking/tx";
import { AppError, retryAfterHeader } from "@/server/lib/errors";

const FULL: Record<string, string> = {
  NAZIR_DB_POOL_MAX: "3",
  NAZIR_DB_CONNECTION_TIMEOUT_MS: "4000",
  NAZIR_DB_IDLE_TIMEOUT_MS: "10000",
  NAZIR_DB_TX_MAX_WAIT_MS: "1500",
  NAZIR_DB_TX_TIMEOUT_MS: "8000",
  NAZIR_DB_STATEMENT_TIMEOUT_MS: "4000",
  NAZIR_DB_LOCK_TIMEOUT_MS: "1000",
};

describe("TX-U01 database pool configuration (M8)", () => {
  it("local/test: explicit development defaults when unset", () => {
    for (const env of ["local", "test"]) {
      const c = loadDbPoolConfig({}, env);
      for (const f of DB_POOL_FIELDS) expect(c[f.key]).toBe(f.dev);
    }
  });
  it.each(["staging", "production", "unknown-env"])("%s: every variable is required (fail-closed, no production default)", (env) => {
    expect(() => loadDbPoolConfig({}, env)).toThrow(DatabaseConfigError);
    try {
      loadDbPoolConfig({}, env);
    } catch (e) {
      for (const f of DB_POOL_FIELDS) expect((e as Error).message).toContain(f.env);
    }
    for (const f of DB_POOL_FIELDS) {
      const partial = { ...FULL };
      delete partial[f.env];
      expect(() => loadDbPoolConfig(partial, env), f.env).toThrow(new RegExp(`${f.env} is required`));
    }
    expect(loadDbPoolConfig(FULL, env)).toEqual({ poolMax: 3, connectionTimeoutMs: 4000, idleTimeoutMs: 10000, txMaxWaitMs: 1500, txTimeoutMs: 8000, statementTimeoutMs: 4000, lockTimeoutMs: 1000 });
  });
  it("rejects non-integers and out-of-range values in every environment", () => {
    for (const bad of ["0", "-1", "1.5", "3e3", "abc", "99999999"]) {
      expect(() => loadDbPoolConfig({ ...FULL, NAZIR_DB_POOL_MAX: bad }, "test"), bad).toThrow(DatabaseConfigError);
    }
    expect(() => loadDbPoolConfig({ NAZIR_DB_POOL_MAX: "51" }, "local")).toThrow(/between 1 and 50/);
  });
  it("ordering: lock < statement < transaction timeout, connection timeout > maxWait", () => {
    expect(() => loadDbPoolConfig({ ...FULL, NAZIR_DB_LOCK_TIMEOUT_MS: "4000" }, "production")).toThrow(/LOCK_TIMEOUT_MS must be less than/);
    expect(() => loadDbPoolConfig({ ...FULL, NAZIR_DB_STATEMENT_TIMEOUT_MS: "8000" }, "production")).toThrow(/STATEMENT_TIMEOUT_MS must be less than/);
    expect(() => loadDbPoolConfig({ ...FULL, NAZIR_DB_CONNECTION_TIMEOUT_MS: "1500" }, "production")).toThrow(/CONNECTION_TIMEOUT_MS must be greater than/);
    expect(() => loadDbPoolConfig({ NAZIR_DB_LOCK_TIMEOUT_MS: "9000" }, "test")).toThrow(/LOCK_TIMEOUT_MS must be less than/);
  });
  it("startup rule: checked when DATABASE_URL is set, always in staging/production", () => {
    expect(assertStartupDbPoolConfig({}, "local")).toBeNull();
    expect(assertStartupDbPoolConfig({ DATABASE_URL: "postgresql://h/nazir_dev" }, "local")?.poolMax).toBe(5);
    expect(() => assertStartupDbPoolConfig({}, "staging")).toThrow(DatabaseConfigError);
    expect(() => assertStartupDbPoolConfig({}, "production")).toThrow(DatabaseConfigError);
  });
  it("buildPgPoolConfig passes the pool limits to pg (and keeps the UTC session options)", () => {
    const pool = loadDbPoolConfig(FULL, "production");
    expect(buildPgPoolConfig("postgresql://u@h/nazir_dev", "DATABASE_URL", pool)).toEqual({
      connectionString: "postgresql://u@h/nazir_dev",
      options: "-c TimeZone=UTC",
      max: 3,
      connectionTimeoutMillis: 4000,
      idleTimeoutMillis: 10000,
    });
  });
});

// Shapes copied from measurements (2026-11-25, Prisma 7.10.1 / adapter-pg 7.10.1 / PostgreSQL 16).
const stmt = (originalCode: string, constraint?: unknown) => ({
  name: "PrismaClientKnownRequestError",
  code: "P2010",
  meta: { driverAdapterError: { name: "DriverAdapterError", cause: { originalCode, kind: "postgres", ...(constraint ? { constraint } : {}) } } },
});
const commit = (originalCode: string) => ({ name: "DriverAdapterError", cause: { originalCode, kind: "postgres" } });
const prisma = (code: string, meta: object = {}) => ({ name: "PrismaClientKnownRequestError", code, meta });

describe("TX-U02 classifyDbError on measured shapes", () => {
  it.each([
    ["deadlock", stmt("40P01"), { kind: "deadlock", sqlState: "40P01" }],
    ["lock timeout", stmt("55P03"), { kind: "lock_timeout", sqlState: "55P03" }],
    ["statement timeout", stmt("57014"), { kind: "statement_timeout", sqlState: "57014" }],
    ["statement after error", stmt("25P02"), { kind: "aborted_tx", sqlState: "25P02" }],
    ["serialization", stmt("40001"), { kind: "serialization", sqlState: "40001" }],
    ["P2028 maxWait", prisma("P2028"), { kind: "tx_unavailable", prismaCode: "P2028" }],
    ["P2028 expired", prisma("P2028", { operation: "query", timeout: 200, timeTaken: 501 }), { kind: "tx_unavailable", prismaCode: "P2028" }],
    ["P1001 unreachable", prisma("P1001", { driverAdapterError: { cause: { kind: "DatabaseNotReachable" } } }), { kind: "db_unreachable", prismaCode: "P1001" }],
    ["unique with name", stmt("23505", { index: "seat_holds_active_seat_uq" }), { kind: "constraint", sqlState: "23505", constraint: "seat_holds_active_seat_uq" }],
    ["fk with name", stmt("23503", { index: "orders_quota_fk" }), { kind: "constraint", sqlState: "23503", constraint: "orders_quota_fk" }],
    ["check (statement, no name)", stmt("23514"), { kind: "constraint", sqlState: "23514", constraint: null }],
    ["deferred trigger at COMMIT (no name)", commit("23514"), { kind: "constraint", sqlState: "23514", constraint: null }],
    ["immutability trigger", stmt("23001"), { kind: "constraint", sqlState: "23001", constraint: null }],
  ])("%s", (_l, e, expected) => {
    expect(classifyDbError(e)).toEqual(expected);
  });
  it("unrecognised: pg's own connection timeout (plain Error, no code) and non-errors → null; messages are never read", () => {
    expect(classifyDbError(new Error("timeout exceeded when trying to connect"))).toBeNull();
    expect(classifyDbError(new Error("40P01 deadlock detected"))).toBeNull();
    expect(classifyDbError(prisma("P2002"))).toBeNull();
    expect(classifyDbError(null)).toBeNull();
  });
});

describe("TX-U03 retry policy and backoff", () => {
  it("delay is full jitter, doubling, capped", () => {
    const p = { ...DEFAULT_RETRY_POLICY, baseDelayMs: 25, maxDelayMs: 200 };
    expect([1, 2, 3, 4, 5].map((r) => retryDelayMs(p, r, () => 0.999999))).toEqual([24, 49, 99, 199, 199]);
    expect(retryDelayMs(p, 3, () => 0)).toBe(0);
    expect(retryDelayMs(p, 1, () => 5)).toBe(25); // random clamped
  });
  it("rejects unbounded policies", () => {
    for (const bad of [{ maxAttempts: 0 }, { maxAttempts: 6 }, { maxDelayMs: 5000 }, { baseDelayMs: 300, maxDelayMs: 200 }, { retryAfterSeconds: 0 }, { maxAttempts: 1.5 }])
      expect(() => validateRetryPolicy({ ...DEFAULT_RETRY_POLICY, ...bad })).toThrow();
  });
});

/** A fake StartTx: runs fn with a recording client; `failures` are thrown by the n-th attempt instead of committing. */
function fakeDeps(script: (attempt: number) => unknown | undefined, o: Partial<BookingTxDeps> = {}) {
  const calls: { sql: string; params: unknown[] }[][] = [];
  const startOpts: unknown[] = [];
  const observed: TxObservation[] = [];
  const sleeps: number[] = [];
  const startTx: StartTx = async (fn, options) => {
    startOpts.push(options);
    const log: { sql: string; params: unknown[] }[] = [];
    calls.push(log);
    const result = await fn({ $queryRawUnsafe: async (sql: string, ...params: unknown[]) => (log.push({ sql, params }), [] as never) });
    const failure = script(calls.length);
    if (failure !== undefined) throw failure; // e.g. a COMMIT-time error
    return result;
  };
  const deps: BookingTxDeps = {
    startTx,
    limits: { txMaxWaitMs: 1500, txTimeoutMs: 8000, statementTimeoutMs: 4000, lockTimeoutMs: 1000 },
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
    observe: (x) => void observed.push(x),
    ...o,
  };
  return { deps, calls, startOpts, observed, sleeps };
}

describe("TX-U04 runner: transaction options and SET LOCAL", () => {
  afterEach(() => vi.restoreAllMocks());
  it("starts READ COMMITTED with explicit maxWait/timeout; first statement sets lock/statement timeouts LOCALLY", async () => {
    const f = fakeDeps(() => undefined);
    const r = await runBookingTx(f.deps, { name: "test.ok", fn: async (tx) => (await tx("SELECT 1 AS x", []), 7) });
    expect(r).toBe(7);
    expect(f.startOpts).toEqual([{ isolationLevel: "ReadCommitted", maxWait: 1500, timeout: 8000 }]);
    expect(f.calls[0][0].sql).toMatch(/set_config\('lock_timeout', \$1, true\)[\s\S]*set_config\('statement_timeout', \$2, true\)/);
    expect(f.calls[0][0].params).toEqual(["1000ms", "4000ms"]);
    expect(f.calls[0][1]).toEqual({ sql: "SELECT 1 AS x", params: [] });
    expect(f.observed).toEqual([{ name: "test.ok", attempt: 1, outcome: "committed" }]);
  });
  it("rejects an unsafe transaction name (log injection)", async () => {
    await expect(runBookingTx(fakeDeps(() => undefined).deps, { name: "bad\nname", fn: async () => 1 })).rejects.toThrow();
  });
});

describe("TX-U05 runner: retries", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([["deadlock", stmt("40P01")], ["lock timeout", stmt("55P03")], ["serialization", stmt("40001")]])("%s is retried, bounded, then succeeds", async (_l, err) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fakeDeps((n) => (n < 3 ? err : undefined));
    expect(await runBookingTx(f.deps, { name: "t", fn: async () => "ok" })).toBe("ok");
    expect(f.calls).toHaveLength(3);
    expect(f.sleeps).toEqual([12, 25]); // 0.5 · 25, 0.5 · 50
    expect(f.observed.map((o) => o.outcome)).toEqual(["retry", "retry", "committed"]);
  });
  it("retry limit exceeded → 503 DATABASE_BUSY with retryAfterSeconds, exactly maxAttempts attempts", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fakeDeps(() => stmt("40P01"), { retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 2, retryAfterSeconds: 3 } });
    const e = await runBookingTx(f.deps, { name: "t", fn: async () => 1 }).catch((x) => x);
    expect(e).toBeInstanceOf(AppError);
    expect([e.code, e.status, e.details]).toEqual(["DATABASE_BUSY", 503, { retryAfterSeconds: 3 }]);
    expect(retryAfterHeader(e)).toEqual({ "Retry-After": "3" });
    expect(f.calls).toHaveLength(2);
  });
  it.each([["statement timeout", stmt("57014")], ["P2028", prisma("P2028")], ["P1001", prisma("P1001")]])("%s → 503, never retried", async (_l, err) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fakeDeps(() => err);
    const e = await runBookingTx(f.deps, { name: "t", fn: async () => 1 }).catch((x) => x);
    expect([e.code, e.status, e.details.retryAfterSeconds]).toEqual(["DATABASE_BUSY", 503, 2]);
    expect(f.calls).toHaveLength(1);
  });
});

describe("TX-U06 runner: constraint mapping", () => {
  afterEach(() => vi.restoreAllMocks());
  const rules = {
    unique: { seat_holds_active_seat_uq: () => new AppError("SEAT_UNAVAILABLE", "x"), orders_active_subject_session_uq: () => new AppError("ACTIVE_ORDER_EXISTS", "x") },
    foreignKey: { orders_quota_fk: () => new AppError("NOT_FOUND", "x") },
    check: () => new AppError("PURCHASE_LIMIT_EXCEEDED", "x"),
    restrict: () => new AppError("INVALID_STATE_TRANSITION", "x"),
  };
  it.each([
    [stmt("23505", { index: "seat_holds_active_seat_uq" }), "SEAT_UNAVAILABLE"],
    [stmt("23505", { index: "orders_active_subject_session_uq" }), "ACTIVE_ORDER_EXISTS"],
    [stmt("23503", { index: "orders_quota_fk" }), "NOT_FOUND"],
    [stmt("23514"), "PURCHASE_LIMIT_EXCEEDED"],
    [commit("23514"), "PURCHASE_LIMIT_EXCEEDED"],
    [stmt("23001"), "INVALID_STATE_TRANSITION"],
    [stmt("23505", { index: "some_other_uq" }), "INTERNAL_ERROR"],
    [stmt("23505", { index: "toString" }), "INTERNAL_ERROR"], // prototype keys are not rules
    [stmt("23505"), "INTERNAL_ERROR"],
    [stmt("22P02"), "INTERNAL_ERROR"],
  ])("%j → %s, never retried", async (err, code) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fakeDeps(() => err);
    const e = await runBookingTx(f.deps, { name: "t", fn: async () => 1, constraints: rules }).catch((x) => x);
    expect(e.code).toBe(code);
    expect(f.calls).toHaveLength(1);
  });
  it("without rules every constraint is a generic 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const e = await runBookingTx(fakeDeps(() => commit("23514")).deps, { name: "t", fn: async () => 1 }).catch((x) => x);
    expect([e.code, e.status, e.message]).toEqual(["INTERNAL_ERROR", 500, "일시적인 오류가 발생했습니다."]);
  });
  it("25P02 (statement after a caught error) → 500, not retried", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fakeDeps(() => stmt("25P02"));
    const e = await runBookingTx(f.deps, { name: "t", fn: async () => 1, constraints: rules }).catch((x) => x);
    expect(e.code).toBe("INTERNAL_ERROR");
    expect(f.calls).toHaveLength(1);
  });
});

describe("TX-U07 runner: business errors and unknown errors", () => {
  afterEach(() => vi.restoreAllMocks());
  it("an AppError thrown by fn is rethrown unchanged and not retried", async () => {
    const f = fakeDeps(() => undefined);
    const app = new AppError("ACTIVE_ORDER_EXISTS", "x", { activeOrderId: "o" });
    const e = await runBookingTx(f.deps, { name: "t", fn: async () => { throw app; } }).catch((x) => x);
    expect(e).toBe(app);
    expect(f.calls).toHaveLength(1);
  });
  it("an unknown error is rethrown as is (the route answers a generic 500)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new TypeError("bug");
    const e = await runBookingTx(fakeDeps(() => boom).deps, { name: "t", fn: async () => 1 }).catch((x) => x);
    expect(e).toBe(boom);
  });
  it("logs carry class, SQLSTATE, constraint and attempt — never the message", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    const leaky = { ...stmt("23514"), message: "Failing row contains (홍길동, 01012345678)" };
    await runBookingTx(fakeDeps(() => leaky).deps, { name: "order.create", fn: async () => 1 }).catch(() => {});
    expect(lines).toEqual(["[booking-tx] order.create attempt=1/3 kind=constraint sqlstate=23514 constraint=none unmapped"]);
  });
});

describe("TX-U08 seat id sorting and Retry-After", () => {
  it("sorts in uuid byte order, rejects duplicates, empties and non-uuids", () => {
    const a = "0f000000-0000-4000-8000-000000000000";
    const b = "a0000000-0000-4000-8000-000000000000";
    const c = "f0000000-0000-4000-8000-000000000001";
    expect(sortSeatIds([c, a, b])).toEqual([a, b, c]);
    expect(() => sortSeatIds([a, a])).toThrow(/duplicate/);
    expect(() => sortSeatIds([])).toThrow();
    expect(() => sortSeatIds([a.toUpperCase()])).toThrow();
  });
  it("retryAfterHeader only for 429/503 AppErrors with a positive whole number", () => {
    expect(retryAfterHeader(new AppError("DATABASE_BUSY", "x", { retryAfterSeconds: 2 }))).toEqual({ "Retry-After": "2" });
    expect(retryAfterHeader(new AppError("DATABASE_BUSY", "x", { retryAfterSeconds: 0 }))).toEqual({});
    expect(retryAfterHeader(new AppError("SEAT_UNAVAILABLE", "x", { retryAfterSeconds: 2 }))).toEqual({});
    expect(retryAfterHeader(new Error("x"))).toEqual({});
  });
});
