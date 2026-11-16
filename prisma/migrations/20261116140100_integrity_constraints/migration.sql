-- NAZIR Step 2 — integrity constraints that Prisma cannot express (raw SQL, hand written).
--
-- Contents (DATABASE.md §13.3, §14, §14.1):
--   A. Partial unique indexes            (5)  — final defence for seat hold / active order /
--                                               in-flight payment / valid ticket / open review case
--   B. CHECK constraints                      — state vocabularies, amounts, quota, ownership
--   C. order_items immutability trigger  (1)  — DATABASE.md §5.2, rule 14
--
-- DO NOT drop or rename any object created here from a later Prisma-generated migration.
-- Prisma does not track CHECK constraints, partial indexes or triggers, so `prisma migrate dev`
-- will not warn about them. tests/contract/schema (MIG-02..MIG-06) fails if they disappear.
-- Status vocabularies below must match src/server/db/constants.ts (enforced by test MIG-03b).

-- ═════════════════════════════ A. Partial unique indexes ═════════════════════════════

-- Rule 1: at most one live hold per seat (§5.3). ACTIVE and CONFIRMING both protect the seat.
CREATE UNIQUE INDEX "seat_holds_active_seat_uq"
  ON "seat_holds" ("session_seat_id")
  WHERE "status" IN ('ACTIVE', 'CONFIRMING');

-- Rule 2: at most one active order per (identity subject, session) — D-008, D-014 (§5.1).
CREATE UNIQUE INDEX "orders_active_subject_session_uq"
  ON "orders" ("identity_subject_id", "show_session_id")
  WHERE "status" IN ('PENDING', 'PAYMENT_CONFIRMING', 'PAYMENT_UNKNOWN', 'REVIEW_REQUIRED');

-- Rule 3: at most one in-flight payment per order — A-005 (§7.1).
CREATE UNIQUE INDEX "payments_in_progress_order_uq"
  ON "payments" ("order_id")
  WHERE "status" IN ('READY', 'CONFIRMING', 'UNKNOWN');

-- Rule 7: at most one valid ticket per seat — H1 (§8.1).
CREATE UNIQUE INDEX "tickets_valid_seat_uq"
  ON "tickets" ("session_seat_id")
  WHERE "status" IN ('ISSUED', 'USED');

-- No duplicate open review case for the same matter (§10.1).
CREATE UNIQUE INDEX "review_cases_open_dedupe_uq"
  ON "review_cases" ("case_type", "dedupe_key")
  WHERE "status" <> 'RESOLVED';

-- ═════════════════════════════ B. CHECK constraints ═════════════════════════════

-- ── shows / show_sessions / seats (§4) ──
ALTER TABLE "shows"
  ADD CONSTRAINT "shows_status_ck"
  CHECK ("status" IN ('DRAFT', 'PUBLISHED', 'CLOSED'));

ALTER TABLE "show_sessions"
  ADD CONSTRAINT "show_sessions_sales_status_ck"
  CHECK ("sales_status" IN ('ON_SALE', 'PAUSED', 'CLOSED', 'CANCELED'));

-- D-006: the per-identity limit is at most 4 and at least 1.
ALTER TABLE "show_sessions"
  ADD CONSTRAINT "show_sessions_max_seats_per_identity_ck"
  CHECK ("max_seats_per_identity" BETWEEN 1 AND 4);

-- ── session_seats (§4.5) ──
-- HELD is never stored; it is derived from live holds (§11.1).
ALTER TABLE "session_seats"
  ADD CONSTRAINT "session_seats_status_ck"
  CHECK ("status" IN ('AVAILABLE', 'SOLD', 'BLOCKED'));

ALTER TABLE "session_seats"
  ADD CONSTRAINT "session_seats_price_ck"
  CHECK ("price" >= 0);

-- Rule 6: SOLD <=> sold_order_item_id is set (A-013).
ALTER TABLE "session_seats"
  ADD CONSTRAINT "session_seats_sold_owner_ck"
  CHECK (("status" = 'SOLD') = ("sold_order_item_id" IS NOT NULL));

-- ── identity (§6) ──
ALTER TABLE "identity_subjects"
  ADD CONSTRAINT "identity_subjects_key_type_ck"
  CHECK ("subject_key_type" IN ('DI', 'CI', 'PHONE'));

ALTER TABLE "identity_verifications"
  ADD CONSTRAINT "identity_verifications_purpose_ck"
  CHECK ("purpose" IN ('BOOKING', 'LOOKUP'));

ALTER TABLE "identity_verifications"
  ADD CONSTRAINT "identity_verifications_status_ck"
  CHECK ("status" IN ('PENDING', 'VERIFIED', 'CONSUMED', 'FAILED', 'EXPIRED'));

-- A verified/consumed verification must carry its subject (§6.2).
ALTER TABLE "identity_verifications"
  ADD CONSTRAINT "identity_verifications_verified_subject_ck"
  CHECK ("status" NOT IN ('VERIFIED', 'CONSUMED') OR "identity_subject_id" IS NOT NULL);

ALTER TABLE "identity_sessions"
  ADD CONSTRAINT "identity_sessions_purpose_ck"
  CHECK ("purpose" IN ('BOOKING', 'LOOKUP'));

ALTER TABLE "identity_sessions"
  ADD CONSTRAINT "identity_sessions_status_ck"
  CHECK ("status" IN ('ACTIVE', 'REVOKED', 'EXPIRED'));

-- ── purchase_quotas (§5.7) — rule 11 ──
ALTER TABLE "purchase_quotas"
  ADD CONSTRAINT "purchase_quotas_seat_limit_ck"
  CHECK ("seat_limit" BETWEEN 1 AND 4);

ALTER TABLE "purchase_quotas"
  ADD CONSTRAINT "purchase_quotas_counted_seats_ck"
  CHECK ("counted_seats" >= 0 AND "counted_seats" <= "seat_limit");

-- ── orders (§5.1) ──
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_status_ck"
  CHECK ("status" IN (
    'PENDING', 'PAYMENT_CONFIRMING', 'PAYMENT_UNKNOWN', 'REVIEW_REQUIRED',
    'UNFULFILLED', 'PAID', 'CANCELED', 'EXPIRED', 'REFUNDED'
  ));

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_total_amount_ck"
  CHECK ("total_amount" >= 0);

-- Rule 9: a PAID order must have a confirmed payment.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_paid_requires_confirmed_payment_ck"
  CHECK ("status" <> 'PAID' OR "confirmed_payment_id" IS NOT NULL);

-- D-003: the 3-minute protection window must be recorded while confirming / unknown.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_confirm_protected_until_ck"
  CHECK ("status" NOT IN ('PAYMENT_CONFIRMING', 'PAYMENT_UNKNOWN') OR "confirm_protected_until" IS NOT NULL);

-- ── order_items / seat_holds (§5.2, §5.3) ──
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_price_ck"
  CHECK ("price" >= 0);

ALTER TABLE "seat_holds"
  ADD CONSTRAINT "seat_holds_status_ck"
  CHECK ("status" IN ('ACTIVE', 'CONFIRMING', 'CONVERTED', 'RELEASED', 'EXPIRED'));

ALTER TABLE "seat_holds"
  ADD CONSTRAINT "seat_holds_released_reason_ck"
  CHECK ("released_reason" IS NULL
         OR "released_reason" IN ('USER_CANCELED', 'PAYMENT_FAILED', 'ADMIN_RESOLVED', 'REFUND_RESOLVED'));

-- ── logs / access / idempotency (§5.4–§5.8) ──
ALTER TABLE "order_status_logs"
  ADD CONSTRAINT "order_status_logs_source_ck"
  CHECK ("source" IN ('API', 'RETURN', 'WEBHOOK', 'PG_REQUERY', 'EXPIRY_JOB', 'ADMIN', 'SYSTEM'));

ALTER TABLE "seat_status_logs"
  ADD CONSTRAINT "seat_status_logs_actor_type_ck"
  CHECK ("actor_type" IN ('ADMIN', 'SYSTEM'));

ALTER TABLE "order_access_sessions"
  ADD CONSTRAINT "order_access_sessions_scope_ck"
  CHECK ("scope" IN ('CONFIRMATION_VIEW'));

ALTER TABLE "order_access_sessions"
  ADD CONSTRAINT "order_access_sessions_status_ck"
  CHECK ("status" IN ('ACTIVE', 'REVOKED', 'EXPIRED'));

ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_status_ck"
  CHECK ("status" IN ('PROCESSING', 'COMPLETED', 'FAILED'));

ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_resource_type_ck"
  CHECK ("resource_type" IS NULL OR "resource_type" IN ('ORDER', 'PAYMENT'));

-- ── payments (§7.1) ──
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_status_ck"
  CHECK ("status" IN ('READY', 'CONFIRMING', 'UNKNOWN', 'SUCCEEDED', 'FAILED', 'CANCELED'));

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_role_ck"
  CHECK ("role" IS NULL OR "role" IN ('PRIMARY', 'EXCESS'));

-- D-005: card and PG-supported easy pay only (virtual accounts are out of Phase 1).
-- NOTE: conflicts with the A-030 "disallowed method" path; see docs/DATABASE.md §19.7 (open item Q-022).
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_method_type_ck"
  CHECK ("method_type" IN ('CARD', 'EASY_PAY'));

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_requested_amount_ck"
  CHECK ("requested_amount" > 0);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_approved_amount_ck"
  CHECK ("approved_amount" IS NULL OR "approved_amount" >= 0);

-- Rule 10: cumulative completed refunds never exceed the approved amount (H2).
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_refunded_amount_ck"
  CHECK ("refunded_amount" >= 0 AND "refunded_amount" <= COALESCE("approved_amount", 0));

-- role is set exactly when the payment is SUCCEEDED (PRIMARY / EXCESS).
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_succeeded_role_ck"
  CHECK (("status" = 'SUCCEEDED') = ("role" IS NOT NULL));

ALTER TABLE "payment_webhook_events"
  ADD CONSTRAINT "payment_webhook_events_status_ck"
  CHECK ("status" IN ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED', 'UNMATCHED'));

ALTER TABLE "payment_status_logs"
  ADD CONSTRAINT "payment_status_logs_source_ck"
  CHECK ("source" IN ('API', 'RETURN', 'WEBHOOK', 'PG_REQUERY', 'ADMIN', 'SYSTEM'));

-- ── refunds (§7.4, §7.5) ──
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_refund_type_ck"
  CHECK ("refund_type" IN ('SEAT', 'PAYMENT_EXCESS'));

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_status_ck"
  CHECK ("status" IN ('REQUESTED', 'VERIFYING', 'COMPLETED', 'FAILED', 'WITHDRAWN'));

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_total_amount_ck"
  CHECK ("total_amount" > 0);

ALTER TABLE "refund_items"
  ADD CONSTRAINT "refund_items_amount_ck"
  CHECK ("amount" > 0);

-- ── tickets (§8.1) ──
ALTER TABLE "tickets"
  ADD CONSTRAINT "tickets_status_ck"
  CHECK ("status" IN ('ISSUED', 'USED', 'VOID'));

-- ── admin (§9) ──
ALTER TABLE "admins"
  ADD CONSTRAINT "admins_role_ck"
  CHECK ("role" IN ('SUPER_ADMIN', 'STAFF'));

ALTER TABLE "admin_sessions"
  ADD CONSTRAINT "admin_sessions_status_ck"
  CHECK ("status" IN ('ACTIVE', 'REVOKED', 'EXPIRED'));

-- ── operations (§10) ──
ALTER TABLE "review_cases"
  ADD CONSTRAINT "review_cases_case_type_ck"
  CHECK ("case_type" IN (
    'PAYMENT_UNKNOWN_PROLONGED', 'EXCESS_PAYMENT', 'AMOUNT_MISMATCH', 'DISALLOWED_METHOD',
    'UNFULFILLABLE_APPROVAL', 'REFUND_VERIFICATION_PENDING', 'REFUND_UNRECORDED', 'REFUND_MISMATCH',
    'WEBHOOK_UNMATCHED', 'WEBHOOK_FAILED', 'QUOTA_MISMATCH', 'SEAT_OWNERSHIP_MISMATCH', 'OUTBOX_DEAD'
  ));

ALTER TABLE "review_cases"
  ADD CONSTRAINT "review_cases_severity_ck"
  CHECK ("severity" IN ('INFO', 'WARN', 'CRITICAL'));

ALTER TABLE "review_cases"
  ADD CONSTRAINT "review_cases_status_ck"
  CHECK ("status" IN ('OPEN', 'IN_PROGRESS', 'RESOLVED'));

ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_status_ck"
  CHECK ("status" IN ('PENDING', 'PROCESSING', 'SENT', 'RETRY', 'DEAD', 'SUPERSEDED'));

-- ═════════════════════════════ C. order_items immutability ═════════════════════════════

-- Rule 14 (D-001 / A-006): order_items rows are never updated after insert. Changing seats means
-- cancelling the order and booking again. DELETE is deliberately not blocked here: DATABASE.md §5.2
-- only asks for an UPDATE block, and referenced items are already protected by ON DELETE RESTRICT.
-- (Open question Q-023 in docs/DECISIONS.md.)
CREATE FUNCTION "order_items_reject_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'order_items rows are immutable (id=%)', OLD."id"
    USING ERRCODE = 'restrict_violation',
          HINT = 'Cancel the order and create a new one instead of changing its items (D-001).';
END;
$$;

CREATE TRIGGER "order_items_no_update"
  BEFORE UPDATE ON "order_items"
  FOR EACH ROW
  EXECUTE FUNCTION "order_items_reject_update"();
