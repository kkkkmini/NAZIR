/**
 * Display status of one session seat — DATABASE.md §11.1 (좌석 표시 상태 우선순위). PURE: no I/O, no clock reads.
 *
 *   1. session_seats.status = SOLD     → SOLD      (판매 완료)
 *   2. session_seats.status = BLOCKED  → BLOCKED   (판매 불가)
 *   3. a CONFIRMING hold exists        → HELD      (임시 점유, 결제 확인 중)
 *   4. an ACTIVE hold exists and its order's hold_expires_at > now → HELD (임시 점유)
 *   5. otherwise                       → AVAILABLE (만료됐지만 아직 정리되지 않은 ACTIVE hold 포함)
 *
 * `HELD` is never stored (§4.5); it is derived here. An ACTIVE hold whose `hold_expires_at` is at or before `now` is
 * NOT a valid hold (rule 4 needs `>`): the seat counts as AVAILABLE, and the order-creation path cleans it up (§11.4).
 * RELEASED / EXPIRED / CONVERTED holds never make a seat HELD.
 *
 * The future seat query (not implemented yet) passes, per seat, every hold row it joins together with the hold's
 * order `hold_expires_at` — the single source of truth for hold expiry (A-007). Who holds a seat is never an input
 * and never part of the output (API_SPEC §4.3).
 */
import { HOLD_STATUS, SESSION_SEAT_STATUS } from "../db/constants";

export const SEAT_DISPLAY_STATUS = ["AVAILABLE", "HELD", "SOLD", "BLOCKED"] as const;
export type SeatDisplayStatus = (typeof SEAT_DISPLAY_STATUS)[number];

export interface SeatDisplayInput {
  /** session_seats.status */
  status: string;
  /** seat_holds rows of this seat (any status), each with its order's hold_expires_at. */
  holds: readonly { status: string; holdExpiresAt: Date }[];
}

export interface SeatDisplayCounts {
  available: number;
  held: number;
  sold: number;
  blocked: number;
}

export class SeatDisplayInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeatDisplayInputError";
  }
}

function assertValidDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new SeatDisplayInputError(`${field} must be a valid Date`);
  }
}

export function computeSeatDisplayStatus(seat: SeatDisplayInput, now: Date): SeatDisplayStatus {
  assertValidDate(now, "now");
  if (!(SESSION_SEAT_STATUS as readonly string[]).includes(seat.status)) {
    throw new SeatDisplayInputError(`seat status has an unknown value (${JSON.stringify(seat.status)})`);
  }
  // Validate every hold before deciding, so bad data fails loudly even on a SOLD/BLOCKED seat.
  for (const h of seat.holds) {
    if (!(HOLD_STATUS as readonly string[]).includes(h.status)) {
      throw new SeatDisplayInputError(`hold status has an unknown value (${JSON.stringify(h.status)})`);
    }
    assertValidDate(h.holdExpiresAt, "hold.holdExpiresAt");
  }

  if (seat.status === "SOLD") return "SOLD";
  if (seat.status === "BLOCKED") return "BLOCKED";
  const t = now.getTime();
  const live = seat.holds.some(
    (h) => h.status === "CONFIRMING" || (h.status === "ACTIVE" && h.holdExpiresAt.getTime() > t),
  );
  return live ? "HELD" : "AVAILABLE";
}

/** Counts per display status — the `seats` input of `computeSalesStatus`. */
export function countSeatDisplay(seats: readonly SeatDisplayInput[], now: Date): SeatDisplayCounts {
  const counts: SeatDisplayCounts = { available: 0, held: 0, sold: 0, blocked: 0 };
  for (const seat of seats) {
    const s = computeSeatDisplayStatus(seat, now);
    if (s === "AVAILABLE") counts.available++;
    else if (s === "HELD") counts.held++;
    else if (s === "SOLD") counts.sold++;
    else counts.blocked++;
  }
  return counts;
}
