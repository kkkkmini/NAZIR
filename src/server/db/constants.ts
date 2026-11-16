/**
 * Status vocabularies shared by application code and the database.
 *
 * DATABASE.md §1.2: "상태값은 애플리케이션 상수와 DB CHECK 제약을 함께 관리한다".
 * Every list here mirrors a CHECK constraint (or a partial-unique-index predicate) in
 * prisma/migrations/20261116140100_integrity_constraints. Test MIG-03b compares them against the
 * live database catalog, so a change on one side without the other fails CI.
 *
 * Pure data, no I/O: safe to import anywhere on the server.
 */

export const SHOW_STATUS = ["DRAFT", "PUBLISHED", "CLOSED"] as const;
export const SESSION_SALES_STATUS = ["ON_SALE", "PAUSED", "CLOSED", "CANCELED"] as const;
/** `HELD` is never stored; it is derived from live holds (DATABASE.md §11.1). */
export const SESSION_SEAT_STATUS = ["AVAILABLE", "SOLD", "BLOCKED"] as const;

export const IDENTITY_SUBJECT_KEY_TYPE = ["DI", "CI", "PHONE"] as const;
export const IDENTITY_PURPOSE = ["BOOKING", "LOOKUP"] as const;
export const IDENTITY_VERIFICATION_STATUS = ["PENDING", "VERIFIED", "CONSUMED", "FAILED", "EXPIRED"] as const;
export const SESSION_STATUS = ["ACTIVE", "REVOKED", "EXPIRED"] as const;

export const ORDER_STATUS = [
  "PENDING",
  "PAYMENT_CONFIRMING",
  "PAYMENT_UNKNOWN",
  "REVIEW_REQUIRED",
  "UNFULFILLED",
  "PAID",
  "CANCELED",
  "EXPIRED",
  "REFUNDED",
] as const;
/** Active order = blocks a second order for the same subject + session (D-008, D-014). */
export const ACTIVE_ORDER_STATUS = ["PENDING", "PAYMENT_CONFIRMING", "PAYMENT_UNKNOWN", "REVIEW_REQUIRED"] as const;

export const HOLD_STATUS = ["ACTIVE", "CONFIRMING", "CONVERTED", "RELEASED", "EXPIRED"] as const;
/** Live hold = protects the seat (partial unique on seat_holds). */
export const LIVE_HOLD_STATUS = ["ACTIVE", "CONFIRMING"] as const;
export const HOLD_RELEASED_REASON = ["USER_CANCELED", "PAYMENT_FAILED", "ADMIN_RESOLVED", "REFUND_RESOLVED"] as const;

export const ORDER_LOG_SOURCE = ["API", "RETURN", "WEBHOOK", "PG_REQUERY", "EXPIRY_JOB", "ADMIN", "SYSTEM"] as const;
export const PAYMENT_LOG_SOURCE = ["API", "RETURN", "WEBHOOK", "PG_REQUERY", "ADMIN", "SYSTEM"] as const;
export const SEAT_LOG_ACTOR_TYPE = ["ADMIN", "SYSTEM"] as const;

export const ORDER_ACCESS_SCOPE = ["CONFIRMATION_VIEW"] as const;
export const IDEMPOTENCY_STATUS = ["PROCESSING", "COMPLETED", "FAILED"] as const;
export const IDEMPOTENCY_RESOURCE_TYPE = ["ORDER", "PAYMENT"] as const;

export const PAYMENT_STATUS = ["READY", "CONFIRMING", "UNKNOWN", "SUCCEEDED", "FAILED", "CANCELED"] as const;
/** In-flight payment = at most one per order (partial unique on payments). */
export const IN_PROGRESS_PAYMENT_STATUS = ["READY", "CONFIRMING", "UNKNOWN"] as const;
export const PAYMENT_ROLE = ["PRIMARY", "EXCESS"] as const;
export const PAYMENT_METHOD_TYPE = ["CARD", "EASY_PAY"] as const;
export const WEBHOOK_EVENT_STATUS = ["RECEIVED", "PROCESSING", "PROCESSED", "FAILED", "IGNORED", "UNMATCHED"] as const;

export const REFUND_TYPE = ["SEAT", "PAYMENT_EXCESS"] as const;
export const REFUND_STATUS = ["REQUESTED", "VERIFYING", "COMPLETED", "FAILED", "WITHDRAWN"] as const;

export const TICKET_STATUS = ["ISSUED", "USED", "VOID"] as const;
/** Valid ticket = counts against the one-valid-ticket-per-seat partial unique. */
export const VALID_TICKET_STATUS = ["ISSUED", "USED"] as const;

export const ADMIN_ROLE = ["SUPER_ADMIN", "STAFF"] as const;

export const REVIEW_CASE_TYPE = [
  "PAYMENT_UNKNOWN_PROLONGED",
  "EXCESS_PAYMENT",
  "AMOUNT_MISMATCH",
  "DISALLOWED_METHOD",
  "UNFULFILLABLE_APPROVAL",
  "REFUND_VERIFICATION_PENDING",
  "REFUND_UNRECORDED",
  "REFUND_MISMATCH",
  "WEBHOOK_UNMATCHED",
  "WEBHOOK_FAILED",
  "QUOTA_MISMATCH",
  "SEAT_OWNERSHIP_MISMATCH",
  "OUTBOX_DEAD",
] as const;
export const REVIEW_CASE_SEVERITY = ["INFO", "WARN", "CRITICAL"] as const;
export const REVIEW_CASE_STATUS = ["OPEN", "IN_PROGRESS", "RESOLVED"] as const;

export const OUTBOX_STATUS = ["PENDING", "PROCESSING", "SENT", "RETRY", "DEAD", "SUPERSEDED"] as const;

/** D-006: hard ceiling for seats per identity per session (also a DB CHECK). */
export const MAX_SEATS_PER_IDENTITY = 4;

/**
 * Names of the constraints that application code must translate into domain errors
 * (DATABASE.md §14.1: unique 23505 / check 23514 / FK 23503 are mapped by constraint name).
 */
export const DB_CONSTRAINT = {
  seatLiveHoldUnique: "seat_holds_active_seat_uq",
  activeOrderUnique: "orders_active_subject_session_uq",
  inProgressPaymentUnique: "payments_in_progress_order_uq",
  validTicketUnique: "tickets_valid_seat_uq",
  openReviewCaseUnique: "review_cases_open_dedupe_uq",
  quotaCountedSeatsCheck: "purchase_quotas_counted_seats_ck",
  refundedAmountCheck: "payments_refunded_amount_ck",
} as const;
