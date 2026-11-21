/**
 * CAT-07: seat display status (src/server/catalog/seat-display.ts) — DATABASE.md §11.1. Pure function, no DB.
 */
import { describe, expect, it } from "vitest";
import {
  computeSeatDisplayStatus,
  countSeatDisplay,
  SeatDisplayInputError,
  type SeatDisplayInput,
  type SeatDisplayStatus,
} from "@/server/catalog/seat-display";
import { HOLD_STATUS, SESSION_SEAT_STATUS } from "@/server/db/constants";

const NOW = new Date("2026-12-10T00:00:00.000Z");
const at = (deltaMs: number) => new Date(NOW.getTime() + deltaMs);
const hold = (status: string, expiresInMs: number) => ({ status, holdExpiresAt: at(expiresInMs) });

describe("CAT-07 §11.1 seat display status", () => {
  it.each([
    ["AVAILABLE, no holds", { status: "AVAILABLE", holds: [] }, "AVAILABLE"],
    ["SOLD", { status: "SOLD", holds: [] }, "SOLD"],
    ["BLOCKED", { status: "BLOCKED", holds: [] }, "BLOCKED"],
    // rule 3: CONFIRMING protects the seat regardless of the 7-minute expiry (payment confirmation fencing, §11.6)
    ["CONFIRMING hold before expiry", { status: "AVAILABLE", holds: [hold("CONFIRMING", 60_000)] }, "HELD"],
    ["CONFIRMING hold long after expiry", { status: "AVAILABLE", holds: [hold("CONFIRMING", -3_600_000)] }, "HELD"],
    // rule 4: ACTIVE needs hold_expires_at > now
    ["ACTIVE hold 1 ms before expiry", { status: "AVAILABLE", holds: [hold("ACTIVE", 1)] }, "HELD"],
    ["ACTIVE hold expiring exactly now", { status: "AVAILABLE", holds: [hold("ACTIVE", 0)] }, "AVAILABLE"],
    ["ACTIVE hold expired 1 ms ago (not yet cleaned up)", { status: "AVAILABLE", holds: [hold("ACTIVE", -1)] }, "AVAILABLE"],
    // ended holds never hold a seat
    ["RELEASED hold", { status: "AVAILABLE", holds: [hold("RELEASED", 60_000)] }, "AVAILABLE"],
    ["EXPIRED hold", { status: "AVAILABLE", holds: [hold("EXPIRED", 60_000)] }, "AVAILABLE"],
    ["CONVERTED hold", { status: "AVAILABLE", holds: [hold("CONVERTED", 60_000)] }, "AVAILABLE"],
    ["several ended holds + one valid", { status: "AVAILABLE", holds: [hold("RELEASED", 1), hold("EXPIRED", -1), hold("ACTIVE", 5)] }, "HELD"],
    ["several ended holds + one expired ACTIVE", { status: "AVAILABLE", holds: [hold("RELEASED", 1), hold("ACTIVE", -5)] }, "AVAILABLE"],
    // rules 1-2 win over holds (a stray live hold on a SOLD seat is S2, a Step 5 / Step 9 concern)
    ["SOLD with a valid hold", { status: "SOLD", holds: [hold("ACTIVE", 60_000)] }, "SOLD"],
    ["BLOCKED with a CONFIRMING hold", { status: "BLOCKED", holds: [hold("CONFIRMING", 60_000)] }, "BLOCKED"],
  ] as [string, SeatDisplayInput, SeatDisplayStatus][])("%s → %s", (_label, seat, expected) => {
    expect(computeSeatDisplayStatus(seat, NOW)).toBe(expected);
  });

  it("covers every stored seat status and hold status combination without throwing", () => {
    for (const status of SESSION_SEAT_STATUS)
      for (const h of HOLD_STATUS)
        for (const delta of [-1, 0, 1]) expect(() => computeSeatDisplayStatus({ status, holds: [hold(h, delta)] }, NOW)).not.toThrow();
  });

  it("counts a session's seats by display status", () => {
    const seats: SeatDisplayInput[] = [
      { status: "AVAILABLE", holds: [] },
      { status: "AVAILABLE", holds: [hold("ACTIVE", -1)] }, // expired → available
      { status: "AVAILABLE", holds: [hold("ACTIVE", 1)] },
      { status: "AVAILABLE", holds: [hold("CONFIRMING", -1)] },
      { status: "SOLD", holds: [] },
      { status: "BLOCKED", holds: [] },
      { status: "BLOCKED", holds: [] },
    ];
    expect(countSeatDisplay(seats, NOW)).toEqual({ available: 2, held: 2, sold: 1, blocked: 2 });
    expect(countSeatDisplay([], NOW)).toEqual({ available: 0, held: 0, sold: 0, blocked: 0 });
  });

  it.each([
    ["unknown seat status", { status: "HELD", holds: [] }], // HELD is never stored (§4.5)
    ["lower-case seat status", { status: "available", holds: [] }],
    ["unknown hold status", { status: "AVAILABLE", holds: [hold("PENDING", 1)] }],
    ["unknown hold status on a SOLD seat", { status: "SOLD", holds: [hold("LIVE", 1)] }],
    ["invalid hold expiry", { status: "AVAILABLE", holds: [{ status: "ACTIVE", holdExpiresAt: new Date("x") }] }],
  ] as [string, SeatDisplayInput][])("rejects %s", (_label, seat) => {
    expect(() => computeSeatDisplayStatus(seat, NOW)).toThrow(SeatDisplayInputError);
  });

  it("rejects an invalid now", () => {
    expect(() => computeSeatDisplayStatus({ status: "AVAILABLE", holds: [] }, new Date(Number.NaN))).toThrow(SeatDisplayInputError);
  });
});
