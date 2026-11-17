-- NAZIR Step 2 — integrity constraints that Prisma cannot express (raw SQL, hand written).
--
-- Contents (DATABASE.md §13.3, §14, §14.1):
--   A. Partial unique indexes            (6)  — final defence for seat hold / active order /
--                                               in-flight payment / PRIMARY payment / valid ticket /
--                                               open review case
--   B. CHECK constraints                      — state vocabularies, amounts, quota, ownership
--   C. ledger / append-only protection       — order_items (rule 14, Q-023), payments (A-038), payments.requested_method_type
--                                               (A-039), admin_audit_logs / payment_status_logs / refund_items /
--                                               refunds (A-041)
--   D. Order <-> payment consistency     (2)  — DEFERRED constraint triggers (S3)
--   E. Identity claim consistency        (2)  — DEFERRED constraint triggers (A-040)
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

-- A-039 (Q-027): what the user asked for and what the PG reported are different facts and are stored separately.
--   requested_method_type  the method chosen when the attempt was created; immutable (trigger below)
--   method_type            normalised effective method: the requested one until approval, then the PG-reported one
--   provider_method_raw    the PG-reported method label, verbatim; mandatory when method_type = OTHER
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_requested_method_type_ck"
  CHECK ("requested_method_type" IN ('CARD', 'EASY_PAY'));

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_other_requires_raw_ck"
  CHECK ("method_type" <> 'OTHER' OR "provider_method_raw" IS NOT NULL);

-- The raw label is a short method name ("카드", "가상계좌", ...), never personal or payment data. The DB rejects values
-- that look like it: blank, 9+ consecutive digits (card / phone / account numbers), an e-mail marker, control chars.
-- Nothing is transformed: the value is stored exactly as the adapter passes it.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_provider_method_raw_ck"
  CHECK ("provider_method_raw" IS NULL
         OR (btrim("provider_method_raw") <> ''
             AND "provider_method_raw" !~ '[0-9]{9,}'
             AND "provider_method_raw" !~ '@'
             AND "provider_method_raw" !~ '[[:cntrl:]]'));

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

-- A-038: SUCCEEDED also carries the approval time. A SUCCEEDED row without it is an incomplete payment record;
-- the transition to SUCCEEDED sets status, role, approved_amount and approved_at in the same UPDATE (DATABASE.md §11.7).
-- NULL-safe by construction: "approved_at IS NOT NULL" can never be NULL.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_succeeded_approved_at_ck"
  CHECK ("status" <> 'SUCCEEDED' OR "approved_at" IS NOT NULL);

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

-- A-039: the user's original choice can never be rewritten (it is evidence). A WHEN clause keeps the trigger silent for
-- every UPDATE that leaves the column alone.
CREATE FUNCTION "payments_reject_requested_method_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payments.requested_method_type is immutable (id=%, % -> %)', OLD."id", OLD."requested_method_type", NEW."requested_method_type"
    USING ERRCODE = 'restrict_violation',
          HINT = 'Record the PG-reported method in method_type / provider_method_raw instead.';
END;
$$;

CREATE TRIGGER "payments_requested_method_no_change"
  BEFORE UPDATE OF "requested_method_type" ON "payments"
  FOR EACH ROW
  WHEN (OLD."requested_method_type" IS DISTINCT FROM NEW."requested_method_type")
  EXECUTE FUNCTION "payments_reject_requested_method_change"();

-- A-041 (Q-029): append-only audit / history tables and the refund ledger.
--   admin_audit_logs      UPDATE + DELETE rejected   (A-022: audit log is P0)
--   payment_status_logs   UPDATE + DELETE rejected
--   refund_items          UPDATE + DELETE rejected   (created with the refund request, never edited)
--   refunds               DELETE rejected; status UPDATEs are the normal lifecycle (REQUESTED -> VERIFYING -> ...)
-- Deliberately NOT covered here (decided per Step once their real write patterns are known): tickets, orders,
-- seat_holds, order_status_logs, seat_status_logs, payment_webhook_events.
CREATE FUNCTION "ledger_reject_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only: UPDATE rejected (id=%)', TG_TABLE_NAME, OLD."id"
    USING ERRCODE = 'restrict_violation',
          HINT = 'Append a new row instead of editing history.';
END;
$$;

CREATE TRIGGER "admin_audit_logs_no_update" BEFORE UPDATE ON "admin_audit_logs" FOR EACH ROW EXECUTE FUNCTION "ledger_reject_update"();
CREATE TRIGGER "admin_audit_logs_no_delete" BEFORE DELETE ON "admin_audit_logs" FOR EACH ROW EXECUTE FUNCTION "ledger_reject_delete"();
CREATE TRIGGER "payment_status_logs_no_update" BEFORE UPDATE ON "payment_status_logs" FOR EACH ROW EXECUTE FUNCTION "ledger_reject_update"();
CREATE TRIGGER "payment_status_logs_no_delete" BEFORE DELETE ON "payment_status_logs" FOR EACH ROW EXECUTE FUNCTION "ledger_reject_delete"();
CREATE TRIGGER "refund_items_no_update" BEFORE UPDATE ON "refund_items" FOR EACH ROW EXECUTE FUNCTION "ledger_reject_update"();
CREATE TRIGGER "refund_items_no_delete" BEFORE DELETE ON "refund_items" FOR EACH ROW EXECUTE FUNCTION "ledger_reject_delete"();
CREATE TRIGGER "refunds_no_delete" BEFORE DELETE ON "refunds" FOR EACH ROW EXECUTE FUNCTION "ledger_reject_delete"();

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

-- ═════════════════════════════ E. identity claim consistency (A-040, Q-028) ═════════════════════════════
--
-- The claim (DATABASE.md §6.2, API_SPEC "Claim") exchanges a VERIFIED verification for exactly one session and marks the
-- verification CONSUMED in the same transaction. The composite FK identity_sessions_verification_claim_fk already forces
-- the session's subject, purpose and BROWSER BINDING to equal the verification's. These two DEFERRED constraint
-- triggers check the FINAL state at COMMIT, so the claim may write its two rows in either order:
--   * a session exists            =>  its verification is CONSUMED   (never PENDING / VERIFIED / FAILED / EXPIRED)
--   * a verification is CONSUMED  =>  its session exists            (single use, no orphan)
-- Not checked here on purpose: claim_expires_at (a time policy; the service validates it, DATABASE.md §6.2), and no
-- CHECK restricts the subject of PENDING / FAILED rows. Sessions keep their own lifecycle (ACTIVE / REVOKED / EXPIRED).
--
-- Retention note: orders.identity_session_id is ON DELETE RESTRICT, so a session that created an order (and therefore its
-- verification) can never be deleted; personal data in it is removed by UPDATE (verified_name / verified_phone), which
-- these triggers do not interfere with. An unreferenced verification is purged together with its session in ONE
-- transaction (delete the session, then the verification); deleting only the session is rejected at COMMIT.
CREATE FUNCTION "identity_assert_claim_consistent"(vid uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  st text;
  has_session boolean;
BEGIN
  SELECT v."status" INTO st FROM "identity_verifications" v WHERE v."id" = vid;
  IF NOT FOUND THEN
    RETURN; -- the verification itself was purged in this transaction
  END IF;
  SELECT EXISTS (SELECT 1 FROM "identity_sessions" s WHERE s."identity_verification_id" = vid) INTO has_session;

  IF has_session AND st <> 'CONSUMED' THEN
    RAISE EXCEPTION 'identity verification % has a session but is % (a session needs a CONSUMED verification)', vid, st
      USING ERRCODE = 'check_violation', TABLE = 'identity_sessions', CONSTRAINT = 'identity_sessions_verification_consumed_ck';
  ELSIF st = 'CONSUMED' AND NOT has_session THEN
    RAISE EXCEPTION 'identity verification % is CONSUMED but no session was issued for it', vid
      USING ERRCODE = 'check_violation', TABLE = 'identity_verifications', CONSTRAINT = 'identity_verifications_consumed_session_ck';
  END IF;
END;
$$;

CREATE FUNCTION "identity_sessions_check_claimed"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "identity_assert_claim_consistent"(OLD."identity_verification_id");
  ELSE
    PERFORM "identity_assert_claim_consistent"(NEW."identity_verification_id");
    IF TG_OP = 'UPDATE' THEN
      IF OLD."identity_verification_id" IS DISTINCT FROM NEW."identity_verification_id" THEN
        PERFORM "identity_assert_claim_consistent"(OLD."identity_verification_id"); -- it lost its session
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "identity_sessions_claim_guard"
  AFTER INSERT OR UPDATE OF "identity_verification_id" OR DELETE ON "identity_sessions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "identity_sessions_check_claimed"();

CREATE FUNCTION "identity_verifications_check_consumed"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "identity_assert_claim_consistent"(NEW."id");
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "identity_verifications_claim_guard"
  AFTER INSERT OR UPDATE OF "status" ON "identity_verifications"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "identity_verifications_check_consumed"();

COMMIT;
