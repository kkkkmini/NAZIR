/** ON-U01~U02 (Q-025): order number pattern and nextOrderNumber's use of the caller's transaction executor. */
import { describe, expect, it } from "vitest";
import { ORDER_NUMBER_PATTERN, isOrderNumber, nextOrderNumber } from "@/server/booking/order-number";
import type { SqlExecutor } from "@/server/db/sql";

describe("ON-U01 order number pattern (same rule as the DB CHECK)", () => {
  it.each(["NZ-202611-000001", "NZ-202612-999999", "NZ-202701-1000000", "NZ-209912-9223372036854775807"])("accepts %s", (n) => {
    expect(isOrderNumber(n)).toBe(true);
    expect(ORDER_NUMBER_PATTERN.test(n)).toBe(true);
  });
  it.each(["NZ-202611-00001", "NZ-T-abc", "nz-202611-000001", "NZ-202611-000001\n", " NZ-202611-000001", "NZ-202611-0000a1", `NZ-202611-${"1".repeat(31)}`, null, 202611, undefined])(
    "refuses %j",
    (n) => expect(isOrderNumber(n)).toBe(false),
  );
});

describe("ON-U02 nextOrderNumber", () => {
  it("runs ONE statement on the given executor (no transaction of its own) and returns the DB value", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const tx = (async (sql: string, params: unknown[]) => (calls.push({ sql, params }), [{ order_number: "NZ-202611-000042" }])) as SqlExecutor;
    expect(await nextOrderNumber(tx)).toBe("NZ-202611-000042");
    expect(calls).toEqual([{ sql: `SELECT next_order_number() AS "order_number"`, params: [] }]);
  });
  it.each([[[]], [[{ order_number: "NZ-T-1" }]], [[{ order_number: null }]]])("refuses an unexpected DB result %j without echoing it", async (rows) => {
    const tx = (async () => rows) as SqlExecutor;
    const e = await nextOrderNumber(tx).catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("next_order_number() returned an unexpected value");
  });
});
