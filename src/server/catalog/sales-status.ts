/**
 * Display sales status of a show session — a PURE function (no I/O, no clock reads).
 *
 * Source rules:
 *   - DATABASE.md §11.11 (판매 가능 조건): show `PUBLISHED`, `sales_opens_at <= now < sales_closes_at` (NULL = no limit),
 *     session `ON_SALE`, session `starts_at > now` (판매 마감 시점 정책은 미정 — 기본 시작 시각).
 *   - DATABASE.md §4.2 / §4.3: show `DRAFT | PUBLISHED | CLOSED`, session `ON_SALE | PAUSED | CLOSED | CANCELED`,
 *     `CANCELED` = 공연 취소 표시.
 *   - API_SPEC.md §4.0 / §4.3: the catalog API is public and lists public shows only.
 *
 * The precedence between the "not sellable" reasons is a display proposal from the Step 3 investigation and is
 * NOT approved yet (TEST_PLAN §2.4); the three seat-availability labels ON_SALE / SOLD_OUT / TEMPORARILY_UNAVAILABLE
 * were decided by the user on 2026-11-21. None of this changes WHETHER a session is sellable: `ON_SALE` here is
 * exactly §11.11 plus "at least one seat displayed as available" (tests/unit/sales-status.test.ts checks this
 * equivalence exhaustively). The order of the reasons, highest first:
 *
 *   1. NOT_PUBLIC  show DRAFT                     → the public API answers 404 (never shown)
 *   2. CANCELED    session CANCELED               → 공연 취소
 *   3. CLOSED      show CLOSED | session CLOSED | now >= starts_at | now >= sales_closes_at → 판매 종료
 *   4. PAUSED      session PAUSED                 → 판매 중지
 *   5. UPCOMING    now < sales_opens_at           → 판매 예정
 *   6. ON_SALE     all of §11.11 and >= 1 AVAILABLE seat           → 예매 가능
 *   7. TEMPORARILY_UNAVAILABLE  no AVAILABLE seat, >= 1 HELD seat   → 일시 품절
 *   8. SOLD_OUT    no AVAILABLE seat and no HELD seat             → 매진
 *
 * Seat counts follow DATABASE.md §11.1 (src/server/catalog/seat-display.ts → `countSeatDisplay`): HELD means a VALID
 * hold only (CONFIRMING, or ACTIVE with hold_expires_at > now); a seat with an expired, not yet cleaned-up ACTIVE hold
 * is AVAILABLE. SOLD_OUT therefore currently also covers "every remaining seat is BLOCKED" (and a session with no
 * seats at all) — whether BLOCKED-only should read 매진 is an OPEN policy question (TEST_PLAN §2.4).
 *
 * Time boundaries (half-open window, as §11.11): opens_at itself is ON SALE, closes_at itself is CLOSED, and the
 * session's start instant itself is CLOSED (§11.11 needs starts_at > now).
 *
 * This status is for display only. The order-creation transaction (Step 5) re-checks §11.11 under locks with DB time,
 * and payment start re-checks the session (§11.11). Never use this result as the sole guard for a write.
 *
 * Inputs are taken as plain strings (as Prisma returns varchar columns) and validated against the shared vocabularies;
 * a value outside them breaks a DB CHECK invariant, so it throws instead of guessing a status.
 */
import { SESSION_SALES_STATUS, SHOW_STATUS } from "../db/constants";

export const SALES_DISPLAY_STATUS = [
  "NOT_PUBLIC",
  "CANCELED",
  "CLOSED",
  "PAUSED",
  "UPCOMING",
  "ON_SALE",
  "TEMPORARILY_UNAVAILABLE",
  "SOLD_OUT",
] as const;
export type SalesDisplayStatus = (typeof SALES_DISPLAY_STATUS)[number];

export interface SalesStatusInput {
  show: {
    status: string;
    salesOpensAt: Date | null;
    salesClosesAt: Date | null;
  };
  session: {
    salesStatus: string;
    startsAt: Date;
  };
  /**
   * Seats of this session by DATABASE.md §11.1 display status, from `countSeatDisplay()`:
   * `available` = not SOLD, not BLOCKED, no valid hold; `held` = not SOLD/BLOCKED with a VALID hold.
   * (`countSeatDisplay` also returns `sold` / `blocked`; they are accepted and not needed here.)
   */
  seats: { available: number; held: number };
  /** "Now" from the caller's Clock (DbClock in production, FixedClock in tests). */
  now: Date;
}

export class SalesStatusInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SalesStatusInputError";
  }
}

function assertValidDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new SalesStatusInputError(`${field} must be a valid Date`);
  }
}

function assertOneOf(value: string, allowed: readonly string[], field: string): void {
  if (!allowed.includes(value)) {
    throw new SalesStatusInputError(`${field} has an unknown value (${JSON.stringify(value)})`);
  }
}

export function computeSalesStatus(input: SalesStatusInput): SalesDisplayStatus {
  const { show, session, seats, now } = input;

  assertOneOf(show.status, SHOW_STATUS, "show.status");
  assertOneOf(session.salesStatus, SESSION_SALES_STATUS, "session.salesStatus");
  assertValidDate(now, "now");
  assertValidDate(session.startsAt, "session.startsAt");
  if (show.salesOpensAt !== null) assertValidDate(show.salesOpensAt, "show.salesOpensAt");
  if (show.salesClosesAt !== null) assertValidDate(show.salesClosesAt, "show.salesClosesAt");
  for (const key of ["available", "held"] as const) {
    const n = seats?.[key];
    if (!Number.isInteger(n) || n < 0) {
      throw new SalesStatusInputError(`seats.${key} must be a non-negative integer`);
    }
  }

  const t = now.getTime();

  if (show.status === "DRAFT") return "NOT_PUBLIC";
  if (session.salesStatus === "CANCELED") return "CANCELED";
  if (
    show.status === "CLOSED" ||
    session.salesStatus === "CLOSED" ||
    t >= session.startsAt.getTime() ||
    (show.salesClosesAt !== null && t >= show.salesClosesAt.getTime())
  ) {
    return "CLOSED";
  }
  if (session.salesStatus === "PAUSED") return "PAUSED";
  if (show.salesOpensAt !== null && t < show.salesOpensAt.getTime()) return "UPCOMING";
  if (seats.available > 0) return "ON_SALE";
  if (seats.held > 0) return "TEMPORARILY_UNAVAILABLE";
  return "SOLD_OUT";
}

/** Only ON_SALE may offer a "book" action in the UI. Still display-only — see the note above. */
export function isSellableStatus(status: SalesDisplayStatus): boolean {
  return status === "ON_SALE";
}
