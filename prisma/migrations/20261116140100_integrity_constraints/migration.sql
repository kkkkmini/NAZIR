-- NAZIR Step 2 — integrity constraints that Prisma cannot express (raw SQL, hand written).
--
-- Contents (DATABASE.md §13.3, §14, §14.1):
--   A. Partial unique indexes            (6)  — final defence for seat hold / active order /
--                                               in-flight payment / PRIMARY payment / valid ticket /
--                                               open review case
--   B. CHECK constraints                      — state vocabularies, amounts, quota, ownership
--   C. ledger protection triggers        (3)  — order_items: UPDATE and DELETE are rejected (rule 14, Q-023);
--                                               payments: DELETE is rejected (A-038)
--   D. Order <-> payment consistency     (2)  — DEFERRED constraint triggers (S3)
--
-- The whole script runs inside one explicit transaction (S1): Prisma Migrate does not wrap a
-- migration in a transaction itself, so a failure would otherwise leave the earlier statements applied.
-- Do not add statements that cannot run in a transaction block (CREATE INDEX CONCURRENTLY, ...) here;
-- put them in their own migration with the marker documented in docs/DATABASE.md §19.9.
--
-- DO NOT drop or rename any object created here from a later Prisma-generated migration.
-- Prisma does not track CHECK constraints, partial indexes or triggers, so `prisma migrate dev`
-- will not warn about them. tests/contract/schema (MIG-02..MIG-06) fails if they disappear.
-- Status vocabularies below must match src/server/db/constants.ts (enforced by test MIG-03b).

BEGIN;

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

-- S3: at most one PRIMARY (order-confirming) payment per order. EXCESS payments may be many (history is kept).
-- Status-based uniqueness is deliberately not used (DATABASE.md §7.1); role is the discriminator.
CREATE UNIQUE INDEX "payments_primary_order_uq"
  ON "payments" ("order_id")
  WHERE "role" = 'PRIMARY';

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

-- D-005 + Q-022: a payment is requested as CARD or EASY_PAY. If the PG later reports that an APPROVED payment
-- used something else (virtual account, a method outside the allow-list, ...), the ledger must still record the
-- approval, so method_type becomes OTHER. The real details stay in card_company / easy_pay_provider (free text,
-- no allow-list CHECK: D4) and in review_cases(DISALLOWED_METHOD).detail.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_method_type_ck"
  CHECK ("method_type" IN ('CARD', 'EASY_PAY', 'OTHER'));

-- OTHER can only describe an approved payment that was NOT used to fulfil the order. It can never be
-- READY/CONFIRMING/UNKNOWN (those are requests the server created) and never PRIMARY. Single-statement
-- transition: UPDATE ... SET status = 'SUCCEEDED', role = 'EXCESS', method_type = 'OTHER'.
-- (IS NOT DISTINCT FROM keeps the check NULL-safe: role may be NULL.)
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_method_type_other_ck"
  CHECK ("method_type" <> 'OTHER' OR ("status" = 'SUCCEEDED' AND "role" IS NOT DISTINCT FROM 'EXCESS'));

-- S3: a PRIMARY payment was approved for exactly the amount requested. Together with the composite FK
-- payments_order_total_fk (requested_amount = orders.total_amount) this means approved = order total.
-- NULL-safe: a PRIMARY payment without an approved amount is rejected.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_primary_amount_ck"
  CHECK ("role" IS DISTINCT FROM 'PRIMARY' OR ("approved_amount" IS NOT NULL AND "approved_amount" = "requested_amount"));

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

-- A-038: SUCCEEDED means "the PG approved this payment", so the approved amount must be recorded and positive.
-- Without it the refund cap (payments_refunded_amount_ck uses COALESCE(approved_amount, 0)) would make an approved
-- payment impossible to refund in the ledger. The transition to SUCCEEDED must set approved_amount in the same UPDATE.
-- (COALESCE keeps the check NULL-safe: "NULL > 0" would otherwise let NULL through.)
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_succeeded_amount_ck"
  CHECK ("status" <> 'SUCCEEDED' OR COALESCE("approved_amount", 0) > 0);

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

-- Rule 14 (D-001 / A-006, Q-023): order_items is an immutable ledger. Rows are only ever INSERTed, in the order
-- creation transaction. UPDATE and DELETE are rejected with SQLSTATE 23001 (restrict_violation). If the creating
-- transaction rolls back, the INSERT simply never happened (no DELETE is involved).
-- Not covered here: TRUNCATE and a superuser/owner disabling the triggers; restrict those through database roles
-- (Step 10, S9). Retention / privacy purges must be a separate, explicitly approved procedure (Q-016).
CREATE FUNCTION "order_items_reject_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'order_items rows are immutable: % rejected (id=%)', TG_OP, OLD."id"
    USING ERRCODE = 'restrict_violation',
          HINT = 'Cancel the order and create a new one instead of changing its items (D-001).';
END;
$$;

CREATE TRIGGER "order_items_no_update"
  BEFORE UPDATE ON "order_items"
  FOR EACH ROW
  EXECUTE FUNCTION "order_items_reject_change"();

CREATE TRIGGER "order_items_no_delete"
  BEFORE DELETE ON "order_items"
  FOR EACH ROW
  EXECUTE FUNCTION "order_items_reject_change"();

-- payments is a money ledger (DATABASE.md §1.1 principle 3, §7.1): every attempt and every approval, including FAILED,
-- CANCELED and EXCESS payments, is kept. A payment that must be discarded is moved to CANCELED / FAILED (§12.2); it is
-- never deleted. Before this trigger an unreferenced payment row could be deleted (it was protected only by the
-- incidental FK of its payment_status_logs rows, and those rows were deletable too). A generic function so that other
-- ledger tables can reuse it once their scope is decided (see docs/DECISIONS.md Q-029).
CREATE FUNCTION "ledger_reject_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are a ledger and are never deleted: DELETE rejected (id=%)', TG_TABLE_NAME, OLD."id"
    USING ERRCODE = 'restrict_violation',
          HINT = 'Record the outcome with a status change (e.g. CANCELED / FAILED) instead of deleting the row.';
END;
$$;

CREATE TRIGGER "payments_no_delete"
  BEFORE DELETE ON "payments"
  FOR EACH ROW
  EXECUTE FUNCTION "ledger_reject_delete"();

-- ═════════════════════════════ D. order <-> payment consistency (S3) ═════════════════════════════
--
-- Invariants (DATABASE.md §5.1, §7.1; "PRIMARY = the approved payment used to confirm the order,
-- equal to orders.confirmed_payment_id"):
--   I1  orders.confirmed_payment_id references a payment of the SAME order           (composite FK, immediate)
--   I2  that payment is role = PRIMARY and status = SUCCEEDED                        (trigger below)
--   I3  every PRIMARY payment is the confirmed payment of its order                  (trigger below)
--   I4  at most one PRIMARY payment per order                                        (payments_primary_order_uq)
--   I5  PRIMARY.approved_amount = requested_amount = orders.total_amount              (CHECK + composite FK)
--   I6  any number of EXCESS payments per order                                      (no constraint, by design)
--
-- orders and payments reference each other, and the confirmation sets both sides in ONE transaction
-- (DATABASE.md §11.7), in either statement order. I2/I3 therefore cannot be checked per statement: they are
-- DEFERRABLE INITIALLY DEFERRED constraint triggers that run at COMMIT against the FINAL state. Consequences:
--   * violations surface when the transaction commits (or at SET CONSTRAINTS ... IMMEDIATE), not mid-transaction;
--   * deferred row events carry the row image of the moment of the statement, so the functions re-read the
--     current rows instead of trusting NEW/OLD;
--   * the functions only read, take no row locks, and so do not interfere with the global lock order (§13.2).
-- Errors use SQLSTATE 23514 and carry the constraint name for domain error mapping (§14.1).

CREATE FUNCTION "orders_check_confirmed_payment"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cur_confirmed uuid;
BEGIN
  SELECT o."confirmed_payment_id" INTO cur_confirmed FROM "orders" o WHERE o."id" = NEW."id";

  -- I2: the confirmed payment must be this order's SUCCEEDED PRIMARY payment
  IF cur_confirmed IS NOT NULL THEN
    PERFORM 1 FROM "payments" p
      WHERE p."id" = cur_confirmed AND p."order_id" = NEW."id" AND p."role" = 'PRIMARY' AND p."status" = 'SUCCEEDED';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'order % confirms payment % which is not its SUCCEEDED PRIMARY payment', NEW."id", cur_confirmed
        USING ERRCODE = 'check_violation', TABLE = 'orders', CONSTRAINT = 'orders_confirmed_payment_primary_ck';
    END IF;
  END IF;

  -- I3 (order side): a payment that this order stopped confirming must not stay PRIMARY
  IF OLD."confirmed_payment_id" IS NOT NULL AND OLD."confirmed_payment_id" IS DISTINCT FROM cur_confirmed THEN
    PERFORM 1 FROM "payments" p WHERE p."id" = OLD."confirmed_payment_id" AND p."role" = 'PRIMARY';
    IF FOUND THEN
      RAISE EXCEPTION 'order % no longer confirms payment %, but that payment is still PRIMARY', NEW."id", OLD."confirmed_payment_id"
        USING ERRCODE = 'check_violation', TABLE = 'orders', CONSTRAINT = 'orders_confirmed_payment_detach_ck';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- INSERT is not covered on purpose: a new order cannot already reference a payment (the payment would need the order
-- first), which the composite FK enforces.
CREATE CONSTRAINT TRIGGER "orders_confirmed_payment_guard"
  AFTER UPDATE OF "confirmed_payment_id" ON "orders"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "orders_check_confirmed_payment"();

CREATE FUNCTION "payments_check_primary_confirmed"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cur_role text;
  cur_order uuid;
BEGIN
  SELECT p."role", p."order_id" INTO cur_role, cur_order FROM "payments" p WHERE p."id" = NEW."id";
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF cur_role = 'PRIMARY' THEN
    -- I3 (payment side): a PRIMARY payment is the confirmed payment of its order
    PERFORM 1 FROM "orders" o WHERE o."id" = cur_order AND o."confirmed_payment_id" = NEW."id";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'payment % is PRIMARY but order % does not confirm it', NEW."id", cur_order
        USING ERRCODE = 'check_violation', TABLE = 'payments', CONSTRAINT = 'payments_primary_confirmed_ck';
    END IF;
  ELSE
    -- I2 (payment side): a payment that an order confirms cannot be demoted / un-succeeded
    PERFORM 1 FROM "orders" o WHERE o."confirmed_payment_id" = NEW."id";
    IF FOUND THEN
      RAISE EXCEPTION 'payment % is confirmed by an order but is no longer a SUCCEEDED PRIMARY payment', NEW."id"
        USING ERRCODE = 'check_violation', TABLE = 'payments', CONSTRAINT = 'payments_confirmed_must_be_primary_ck';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "payments_primary_guard"
  AFTER INSERT OR UPDATE OF "role", "status", "order_id" ON "payments"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "payments_check_primary_confirmed"();

COMMIT;
