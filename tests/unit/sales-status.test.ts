/**
 * CAT-01..CAT-06, CAT-08: display sales status (src/server/catalog/sales-status.ts), DATABASE.md §11.11.
 * Pure function: every case passes "now" explicitly; no clock or database is involved.
 */
import { describe, expect, it } from "vitest";
import {
  computeSalesStatus,
  isSellableStatus,
  SALES_DISPLAY_STATUS,
  SalesStatusInputError,
  type SalesDisplayStatus,
  type SalesStatusInput,
} from "@/server/catalog/sales-status";
import { countSeatDisplay, type SeatDisplayInput } from "@/server/catalog/seat-display";
import { SESSION_SALES_STATUS, SHOW_STATUS } from "@/server/db/constants";

const MS = 1;
const OPENS = new Date("2026-12-01T01:00:00.000Z"); // 10:00 KST
const CLOSES = new Date("2026-12-20T15:00:00.000Z");
const STARTS = new Date("2026-12-24T10:00:00.000Z"); // 19:00 KST
const at = (d: Date, deltaMs = 0) => new Date(d.getTime() + deltaMs);
const MID = new Date("2026-12-10T00:00:00.000Z"); // inside the sales window, before the start

function input(over: {
  showStatus?: string;
  opensAt?: Date | null;
  closesAt?: Date | null;
  sessionStatus?: string;
  startsAt?: Date;
  available?: number;
  held?: number;
  now: Date;
}): SalesStatusInput {
  return {
    show: {
      status: over.showStatus ?? "PUBLISHED",
      salesOpensAt: over.opensAt === undefined ? OPENS : over.opensAt,
      salesClosesAt: over.closesAt === undefined ? CLOSES : over.closesAt,
    },
    session: { salesStatus: over.sessionStatus ?? "ON_SALE", startsAt: over.startsAt ?? STARTS },
    seats: { available: over.available ?? 10, held: over.held ?? 0 },
    now: over.now,
  };
}

type Row = [label: string, over: Parameters<typeof input>[0], expected: SalesDisplayStatus];

describe("CAT-01 time boundaries (half-open sales window, start instant closes sales)", () => {
  const rows: Row[] = [
    ["1 ms before sales open", { now: at(OPENS, -MS) }, "UPCOMING"],
    ["exactly at sales open", { now: OPENS }, "ON_SALE"],
    ["1 ms after sales open", { now: at(OPENS, MS) }, "ON_SALE"],
    ["1 ms before sales close", { now: at(CLOSES, -MS) }, "ON_SALE"],
    ["exactly at sales close", { now: CLOSES }, "CLOSED"],
    ["1 ms after sales close", { now: at(CLOSES, MS) }, "CLOSED"],
    // no close time: the session start instant is the cut-off (§11.11 needs starts_at > now)
    ["no close time, 1 ms before start", { closesAt: null, now: at(STARTS, -MS) }, "ON_SALE"],
    ["no close time, exactly at start", { closesAt: null, now: STARTS }, "CLOSED"],
    ["no close time, after start", { closesAt: null, now: at(STARTS, MS) }, "CLOSED"],
    // the session starts BEFORE the show-level close time: the start wins
    ["start before close: 1 ms before start", { startsAt: at(CLOSES, -60_000), now: at(CLOSES, -60_001) }, "ON_SALE"],
    ["start before close: exactly at start", { startsAt: at(CLOSES, -60_000), now: at(CLOSES, -60_000) }, "CLOSED"],
    // start and close at the same instant
    ["close == start, 1 ms before", { startsAt: CLOSES, now: at(CLOSES, -MS) }, "ON_SALE"],
    ["close == start, at that instant", { startsAt: CLOSES, now: CLOSES }, "CLOSED"],
  ];
  it.each(rows)("%s", (_label, over, expected) => {
    expect(computeSalesStatus(input(over))).toBe(expected);
  });
});

describe("CAT-02 NULL sales window = no limit (§11.11)", () => {
  const FAR_PAST = new Date("2000-01-01T00:00:00.000Z");
  const rows: Row[] = [
    ["both NULL, long before start", { opensAt: null, closesAt: null, now: FAR_PAST }, "ON_SALE"],
    ["both NULL, 1 ms before start", { opensAt: null, closesAt: null, now: at(STARTS, -MS) }, "ON_SALE"],
    ["both NULL, at start", { opensAt: null, closesAt: null, now: STARTS }, "CLOSED"],
    ["open NULL, before close", { opensAt: null, now: FAR_PAST }, "ON_SALE"],
    ["open NULL, at close", { opensAt: null, now: CLOSES }, "CLOSED"],
    ["close NULL, before open", { closesAt: null, now: at(OPENS, -MS) }, "UPCOMING"],
    ["close NULL, at open", { closesAt: null, now: OPENS }, "ON_SALE"],
  ];
  it.each(rows)("%s", (_label, over, expected) => {
    expect(computeSalesStatus(input(over))).toBe(expected);
  });
});

describe("CAT-03 show and session status", () => {
  const rows: Row[] = [
    ["DRAFT show is never public", { showStatus: "DRAFT", now: MID }, "NOT_PUBLIC"],
    ["DRAFT show wins over a CANCELED session", { showStatus: "DRAFT", sessionStatus: "CANCELED", now: MID }, "NOT_PUBLIC"],
    ["DRAFT show wins after the start", { showStatus: "DRAFT", now: at(STARTS, MS) }, "NOT_PUBLIC"],
    ["CLOSED show inside the sales window", { showStatus: "CLOSED", now: MID }, "CLOSED"],
    ["CLOSED show before sales open", { showStatus: "CLOSED", now: at(OPENS, -MS) }, "CLOSED"],
    ["CLOSED session", { sessionStatus: "CLOSED", now: MID }, "CLOSED"],
    ["PAUSED session inside the window", { sessionStatus: "PAUSED", now: MID }, "PAUSED"],
    ["PAUSED session before sales open", { sessionStatus: "PAUSED", now: at(OPENS, -MS) }, "PAUSED"],
    ["PAUSED session with no seats left", { sessionStatus: "PAUSED", available: 0, now: MID }, "PAUSED"],
    ["PAUSED session after close is CLOSED", { sessionStatus: "PAUSED", now: CLOSES }, "CLOSED"],
    ["PAUSED session after start is CLOSED", { sessionStatus: "PAUSED", now: STARTS }, "CLOSED"],
    ["CANCELED session inside the window", { sessionStatus: "CANCELED", now: MID }, "CANCELED"],
    ["CANCELED session after start stays CANCELED", { sessionStatus: "CANCELED", now: at(STARTS, MS) }, "CANCELED"],
    ["CANCELED session of a CLOSED show", { showStatus: "CLOSED", sessionStatus: "CANCELED", now: MID }, "CANCELED"],
    ["CANCELED session before sales open", { sessionStatus: "CANCELED", now: at(OPENS, -MS) }, "CANCELED"],
  ];
  it.each(rows)("%s", (_label, over, expected) => {
    expect(computeSalesStatus(input(over))).toBe(expected);
  });
});

describe("CAT-04 on sale vs temporarily unavailable vs sold out (user decision 2026-11-21)", () => {
  const rows: Row[] = [
    ["normal on-sale session", { now: MID }, "ON_SALE"],
    ["one available seat", { available: 1, now: MID }, "ON_SALE"],
    ["one available seat while others are held", { available: 1, held: 5, now: MID }, "ON_SALE"],
    ["no available seat, one valid hold", { available: 0, held: 1, now: MID }, "TEMPORARILY_UNAVAILABLE"],
    ["no available seat, many valid holds", { available: 0, held: 40, now: MID }, "TEMPORARILY_UNAVAILABLE"],
    ["no available seat and no hold: real sell-out", { available: 0, held: 0, now: MID }, "SOLD_OUT"],
    ["held seats before sales open is still UPCOMING", { available: 0, held: 3, now: at(OPENS, -MS) }, "UPCOMING"],
    ["held seats in a PAUSED session is PAUSED", { sessionStatus: "PAUSED", available: 0, held: 3, now: MID }, "PAUSED"],
    ["held seats after close is CLOSED", { available: 0, held: 3, now: CLOSES }, "CLOSED"],
    ["held seats after start is CLOSED", { available: 0, held: 3, now: STARTS }, "CLOSED"],
    ["no seats before sales open is still UPCOMING", { available: 0, now: at(OPENS, -MS) }, "UPCOMING"],
    ["no seats after close is CLOSED", { available: 0, now: CLOSES }, "CLOSED"],
    ["no seats after start is CLOSED", { available: 0, now: STARTS }, "CLOSED"],
  ];
  it.each(rows)("%s", (_label, over, expected) => {
    expect(computeSalesStatus(input(over))).toBe(expected);
  });

  it("only ON_SALE is sellable (TEMPORARILY_UNAVAILABLE is not)", () => {
    expect(SALES_DISPLAY_STATUS.filter(isSellableStatus)).toEqual(["ON_SALE"]);
    expect(isSellableStatus("TEMPORARILY_UNAVAILABLE")).toBe(false);
  });
});

describe("CAT-05 ON_SALE is exactly DATABASE.md §11.11 plus 'a seat is available'; the two no-seat states split on valid holds", () => {
  // Direct transcription of §11.11, kept independent of the implementation's precedence.
  const sellableBy11_11 = (i: SalesStatusInput) => {
    const t = i.now.getTime();
    return (
      i.show.status === "PUBLISHED" &&
      (i.show.salesOpensAt === null || i.show.salesOpensAt.getTime() <= t) &&
      (i.show.salesClosesAt === null || t < i.show.salesClosesAt.getTime()) &&
      i.session.salesStatus === "ON_SALE" &&
      i.session.startsAt.getTime() > t
    );
  };
  const times = [at(OPENS, -MS), OPENS, MID, at(CLOSES, -MS), CLOSES, at(STARTS, -MS), STARTS, at(STARTS, MS)];
  const windows: [Date | null, Date | null][] = [
    [OPENS, CLOSES],
    [null, CLOSES],
    [OPENS, null],
    [null, null],
    [CLOSES, OPENS], // inverted window (no DB CHECK forbids it): must never be on sale
  ];

  it("holds for every combination of show status, session status, window, time and availability", () => {
    let checked = 0;
    for (const showStatus of SHOW_STATUS)
      for (const sessionStatus of SESSION_SALES_STATUS)
        for (const [opensAt, closesAt] of windows)
          for (const now of times)
            for (const available of [0, 1])
              for (const held of [0, 1]) {
                const i = input({ showStatus, sessionStatus, opensAt, closesAt, now, available, held });
                const status = computeSalesStatus(i);
                const ctx = JSON.stringify({ showStatus, sessionStatus, opensAt, closesAt, now, available, held });
                expect(SALES_DISPLAY_STATUS).toContain(status);
                const open = sellableBy11_11(i);
                expect(status === "ON_SALE", ctx).toBe(open && available > 0);
                expect(status === "TEMPORARILY_UNAVAILABLE", ctx).toBe(open && available === 0 && held > 0);
                expect(status === "SOLD_OUT", ctx).toBe(open && available === 0 && held === 0);
                checked++;
              }
    expect(checked).toBe(SHOW_STATUS.length * SESSION_SALES_STATUS.length * windows.length * times.length * 4);
  });
});

describe("CAT-06 invalid input fails loudly instead of guessing", () => {
  const ok = input({ now: MID });
  it.each([
    ["unknown show status", { ...ok, show: { ...ok.show, status: "ARCHIVED" } }],
    ["unknown session status", { ...ok, session: { ...ok.session, salesStatus: "HELD" } }],
    ["lower-case status", { ...ok, show: { ...ok.show, status: "published" } }],
    ["invalid now", { ...ok, now: new Date("nope") }],
    ["invalid start", { ...ok, session: { ...ok.session, startsAt: new Date(Number.NaN) } }],
    ["invalid open", { ...ok, show: { ...ok.show, salesOpensAt: new Date("x") } }],
    ["invalid close", { ...ok, show: { ...ok.show, salesClosesAt: new Date("x") } }],
    ["negative available count", { ...ok, seats: { available: -1, held: 0 } }],
    ["fractional available count", { ...ok, seats: { available: 1.5, held: 0 } }],
    ["NaN available count", { ...ok, seats: { available: Number.NaN, held: 0 } }],
    ["negative held count", { ...ok, seats: { available: 0, held: -1 } }],
    ["fractional held count", { ...ok, seats: { available: 0, held: 0.5 } }],
    ["missing held count", { ...ok, seats: { available: 0 } as unknown as SalesStatusInput["seats"] }],
    ["missing seats", { ...ok, seats: undefined as unknown as SalesStatusInput["seats"] }],
  ] as [string, SalesStatusInput][])("%s", (_label, bad) => {
    expect(() => computeSalesStatus(bad)).toThrow(SalesStatusInputError);
  });

  it("does not mutate its input", () => {
    const i = input({ now: MID });
    const snapshot = JSON.stringify(i);
    computeSalesStatus(i);
    expect(JSON.stringify(i)).toBe(snapshot);
  });
});

describe("CAT-08 seat rows → counts → status: expired holds do not make a session 'temporarily unavailable'", () => {
  const live = { status: "ACTIVE", holdExpiresAt: at(MID, 60_000) };
  const expired = { status: "ACTIVE", holdExpiresAt: at(MID, -1) };
  const expiresNow = { status: "ACTIVE", holdExpiresAt: MID };
  const confirming = { status: "CONFIRMING", holdExpiresAt: at(MID, -3_600_000) }; // past expiry: still protected
  const status = (seatRows: SeatDisplayInput[]) =>
    computeSalesStatus({ ...input({ now: MID }), seats: countSeatDisplay(seatRows, MID) });

  it.each([
    ["only SOLD seats", [{ status: "SOLD", holds: [] }], "SOLD_OUT"],
    ["SOLD + a seat with a valid ACTIVE hold", [{ status: "SOLD", holds: [] }, { status: "AVAILABLE", holds: [live] }], "TEMPORARILY_UNAVAILABLE"],
    ["SOLD + a seat with a CONFIRMING hold past its expiry", [{ status: "SOLD", holds: [] }, { status: "AVAILABLE", holds: [confirming] }], "TEMPORARILY_UNAVAILABLE"],
    ["SOLD + a seat whose ACTIVE hold expired 1 ms ago: selectable again", [{ status: "SOLD", holds: [] }, { status: "AVAILABLE", holds: [expired] }], "ON_SALE"],
    ["SOLD + a seat whose ACTIVE hold expires exactly now: selectable again", [{ status: "SOLD", holds: [] }, { status: "AVAILABLE", holds: [expiresNow] }], "ON_SALE"],
    ["SOLD + seats with only ended holds", [{ status: "SOLD", holds: [] }, { status: "AVAILABLE", holds: [{ status: "RELEASED", holdExpiresAt: at(MID, 60_000) }, { status: "EXPIRED", holdExpiresAt: at(MID, -1) }] }], "ON_SALE"],
    ["a SOLD seat with a stray live hold counts as SOLD, not held", [{ status: "SOLD", holds: [live] }], "SOLD_OUT"],
  ] as [string, SeatDisplayInput[], SalesDisplayStatus][])("%s", (_label, seatRows, expected) => {
    expect(status(seatRows)).toBe(expected);
  });

  // OPEN POLICY (TEST_PLAN §2.4): these pin the CURRENT behaviour only. BLOCKED is a reversible admin state (and the
  // recommended state for refunded seats, Q-012), so whether "only BLOCKED seats left" should read 매진 is undecided.
  it.each([
    ["every seat BLOCKED", [{ status: "BLOCKED", holds: [] }, { status: "BLOCKED", holds: [] }]],
    ["SOLD + the rest BLOCKED", [{ status: "SOLD", holds: [] }, { status: "BLOCKED", holds: [] }]],
    ["a session with no seats at all", []],
  ] as [string, SeatDisplayInput[]][])("current behaviour, policy pending: %s → SOLD_OUT", (_label, seatRows) => {
    expect(status(seatRows)).toBe("SOLD_OUT");
  });
});
