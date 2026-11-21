/**
 * CLK-01: DbClock contract with a fake executor (no database). The real PostgreSQL behaviour, including the
 * session-time-zone case that motivated reading epoch milliseconds, is DB-03 (tests/contract/schema/db-clock.test.ts).
 */
import { describe, expect, it } from "vitest";
import { DbClock, DbClockError, type RawQueryExecutor } from "@/server/db/db-clock";
import { FixedClock, type Clock } from "@/server/lib/clock";

function fake(result: unknown | (() => Promise<unknown>)): RawQueryExecutor & { sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    $queryRaw<T>(query: TemplateStringsArray, ...values: unknown[]) {
      sql.push(query.join("?"));
      expect(values).toEqual([]); // no interpolated values: nothing user-controlled reaches the query
      return (typeof result === "function" ? (result as () => Promise<unknown>)() : Promise.resolve(result)) as Promise<T>;
    },
  };
}

const T = Date.UTC(2026, 10, 20, 5, 6, 7, 123); // 2026-11-20T05:06:07.123Z

describe("CLK-01 DbClock", () => {
  it("returns the database now() read as epoch milliseconds (bigint from the driver)", async () => {
    const db = fake([{ epochMs: BigInt(T) }]);
    const now = await new DbClock(db).now();
    expect(now.toISOString()).toBe("2026-11-20T05:06:07.123Z");
    expect(db.sql).toEqual(['SELECT floor(extract(epoch FROM now()) * 1000)::bigint AS "epochMs"']);
  });

  it("also accepts a plain number", async () => {
    expect((await new DbClock(fake([{ epochMs: T }])).now()).getTime()).toBe(T);
  });

  it("returns a new Date on every call (callers may mutate theirs)", async () => {
    const clock = new DbClock(fake([{ epochMs: BigInt(T) }]));
    const a = await clock.now();
    a.setFullYear(1999);
    expect((await clock.now()).getTime()).toBe(T);
  });

  it("propagates database errors unchanged and never falls back to the system clock", async () => {
    const boom = new Error("connection refused");
    await expect(new DbClock(fake(() => Promise.reject(boom))).now()).rejects.toBe(boom);
  });

  it.each([
    ["no rows", []],
    ["two rows", [{ epochMs: BigInt(T) }, { epochMs: BigInt(T) }]],
    ["not an array", { epochMs: BigInt(T) }],
    ["a string", [{ epochMs: String(T) }]],
    ["a Date object", [{ epochMs: new Date(T) }]],
    ["a fractional number", [{ epochMs: T + 0.5 }]],
    ["NaN", [{ epochMs: Number.NaN }]],
    ["a value beyond Number.MAX_SAFE_INTEGER", [{ epochMs: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(2) }]],
    ["a safe integer outside the Date range", [{ epochMs: 8.64e15 + 1 }]],
    ["a missing column", [{ now: new Date(T) }]],
    ["a null row", [null]],
  ])("rejects %s with DbClockError", async (_label, rows) => {
    await expect(new DbClock(fake(rows)).now()).rejects.toThrow(DbClockError);
  });

  it("is a Clock, interchangeable with FixedClock for tests", async () => {
    const clocks: Clock[] = [new DbClock(fake([{ epochMs: BigInt(0) }])), new FixedClock(new Date(0))];
    for (const c of clocks) expect((await c.now()).getTime()).toBe(0);
  });
});
