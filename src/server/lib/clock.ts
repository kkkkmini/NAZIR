/**
 * Clock abstraction (DATABASE.md §1.2, A-023).
 *
 * Expiry and payment-protection decisions use DB time in production. The DB-backed
 * clock is added with the database layer (Step 2); until then services depend only
 * on this interface so tests can inject a fixed time.
 */
export interface Clock {
  now(): Promise<Date>;
}

export class FixedClock implements Clock {
  private current: Date;
  constructor(at: Date | string) {
    this.current = new Date(at);
  }
  async now(): Promise<Date> {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(at: Date | string): void {
    this.current = new Date(at);
  }
}

export const MINUTE_MS = 60_000;

/** Policy durations (D-002, D-003, D-015). Not configurable: these are confirmed policies. */
export const POLICY = {
  holdDurationMs: 7 * MINUTE_MS,
  confirmProtectionMs: 3 * MINUTE_MS,
  bookingSessionMs: 30 * MINUTE_MS,
  minSessionRemainingForOrderMs: 10 * MINUTE_MS,
  maxSeatsPerIdentityPerSession: 4,
} as const;
