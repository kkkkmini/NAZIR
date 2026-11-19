-- NAZIR Step 2 — baseline schema (27 tables).
--
-- Generated with:
--   prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
-- and then edited by hand in exactly THREE places (everything else is verbatim Prisma output):
--   1. Removed "CREATE SCHEMA IF NOT EXISTS public" (public always exists; the statement can fail
--      for roles without CREATE on the database).
--   2. seats_venue_section_row_number_nnd_uq is created as UNIQUE ... NULLS NOT DISTINCT
--      (DATABASE.md §4.4, PostgreSQL 15+). Prisma cannot express it; the index is declared in
--      schema.prisma only so that Prisma does not DROP it as drift. Verified by MIG-05.
--   3. The whole script is wrapped in BEGIN; ... COMMIT; (S1). Prisma Migrate does NOT run a
--      migration in a transaction: without the wrapper a failure leaves the statements that ran before
--      it in the database (verified, tests MIG-09/MIG-10). Every migration in this repository must
--      carry the wrapper; see docs/DATABASE.md §19.9 for recovery after a failed migration.
--
-- CHECK constraints, partial unique indexes, the order_items trigger and the payment/order
-- consistency triggers live in the next migration (20261116140100_integrity_constraints).

BEGIN;

-- CreateTable
CREATE TABLE "venues" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(200) NOT NULL,
    "address" TEXT,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Seoul',
    "seat_map_version" VARCHAR(50),
    "seat_map_asset_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(220) NOT NULL,
    "description" TEXT,
    "poster_url" TEXT,
    "status" VARCHAR(20) NOT NULL,
    "sales_opens_at" TIMESTAMPTZ(6),
    "sales_closes_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "show_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "show_id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6),
    "sales_status" VARCHAR(20) NOT NULL,
    "max_seats_per_identity" SMALLINT NOT NULL DEFAULT 4,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "show_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seats" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "svg_seat_id" VARCHAR(100) NOT NULL,
    "section_name" VARCHAR(100),
    "row_label" VARCHAR(30),
    "seat_number" VARCHAR(30) NOT NULL,
    "seat_label" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_seats" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "show_session_id" UUID NOT NULL,
    "seat_id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "price" BIGINT NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "sold_order_item_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_seats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_subjects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subject_key_hash" VARCHAR(255) NOT NULL,
    "subject_key_type" VARCHAR(20) NOT NULL,
    "key_version" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_verifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "purpose" VARCHAR(20) NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "provider_transaction_id" VARCHAR(200),
    "browser_binding_hash" VARCHAR(255) NOT NULL,
    "state_nonce_hash" VARCHAR(255) NOT NULL,
    "provider_context_encrypted" TEXT,
    "status" VARCHAR(20) NOT NULL,
    "identity_subject_id" UUID,
    "verified_name" TEXT,
    "verified_phone" TEXT,
    "verified_at" TIMESTAMPTZ(6),
    "claim_expires_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "failure_code" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "identity_verification_id" UUID NOT NULL,
    "identity_subject_id" UUID NOT NULL,
    "purpose" VARCHAR(20) NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "browser_binding_hash" VARCHAR(255) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_quotas" (
    "identity_subject_id" UUID NOT NULL,
    "show_session_id" UUID NOT NULL,
    "seat_limit" SMALLINT NOT NULL,
    "counted_seats" SMALLINT NOT NULL DEFAULT 0,
    "version" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_quotas_pkey" PRIMARY KEY ("identity_subject_id","show_session_id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_number" VARCHAR(40) NOT NULL,
    "show_session_id" UUID NOT NULL,
    "identity_subject_id" UUID NOT NULL,
    "identity_session_id" UUID NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "customer_name" TEXT NOT NULL,
    "customer_phone" TEXT NOT NULL,
    "customer_email" VARCHAR(254),
    "total_amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'KRW',
    "hold_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "confirm_protected_until" TIMESTAMPTZ(6),
    "confirmed_payment_id" UUID,
    "admin_memo" TEXT,
    "paid_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "show_session_id" UUID NOT NULL,
    "session_seat_id" UUID NOT NULL,
    "price" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seat_holds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "session_seat_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "released_reason" VARCHAR(30),
    "ended_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seat_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_status_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "from_status" VARCHAR(30),
    "to_status" VARCHAR(30) NOT NULL,
    "source" VARCHAR(30) NOT NULL,
    "admin_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seat_status_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_seat_id" UUID NOT NULL,
    "from_status" VARCHAR(20),
    "to_status" VARCHAR(20) NOT NULL,
    "order_item_id" UUID,
    "reason" TEXT,
    "actor_type" VARCHAR(20) NOT NULL,
    "admin_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seat_status_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_access_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "browser_binding_hash" VARCHAR(255) NOT NULL,
    "scope" VARCHAR(30) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_access_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scope" VARCHAR(200) NOT NULL,
    "owner_key_hash" VARCHAR(255) NOT NULL,
    "idempotency_key_hash" VARCHAR(255) NOT NULL,
    "request_hash" VARCHAR(255) NOT NULL,
    "resource_type" VARCHAR(50),
    "resource_id" UUID,
    "response_status" INTEGER,
    "response_body" JSONB,
    "status" VARCHAR(20) NOT NULL,
    "locked_until" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "merchant_payment_ref" VARCHAR(64) NOT NULL,
    "provider_payment_id" VARCHAR(200),
    "pg_transaction_id" VARCHAR(200),
    "status" VARCHAR(30) NOT NULL,
    "role" VARCHAR(20),
    "method_type" VARCHAR(20) NOT NULL,
    "requested_method_type" VARCHAR(20) NOT NULL,
    "provider_method_raw" VARCHAR(100),
    "easy_pay_provider" VARCHAR(50),
    "card_company" VARCHAR(50),
    "requested_amount" BIGINT NOT NULL,
    "approved_amount" BIGINT,
    "refunded_amount" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'KRW',
    "return_nonce_hash" VARCHAR(255) NOT NULL,
    "checkout_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "confirm_started_at" TIMESTAMPTZ(6),
    "unknown_since" TIMESTAMPTZ(6),
    "next_requery_at" TIMESTAMPTZ(6),
    "requery_count" INTEGER NOT NULL DEFAULT 0,
    "last_verified_at" TIMESTAMPTZ(6),
    "approved_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "canceled_at" TIMESTAMPTZ(6),
    "failure_code" VARCHAR(100),
    "failure_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_webhook_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" VARCHAR(50) NOT NULL,
    "provider_event_id" VARCHAR(200),
    "deduplication_key" VARCHAR(255) NOT NULL,
    "payment_id" UUID,
    "event_type" VARCHAR(100) NOT NULL,
    "signature_verified" BOOLEAN NOT NULL,
    "payload_hash" VARCHAR(255) NOT NULL,
    "payload_redacted" JSONB,
    "status" VARCHAR(20) NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "failure_reason" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_status_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payment_id" UUID NOT NULL,
    "from_status" VARCHAR(30),
    "to_status" VARCHAR(30) NOT NULL,
    "source" VARCHAR(30) NOT NULL,
    "source_event_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_status_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "refund_type" VARCHAR(20) NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "provider_refund_id" VARCHAR(200),
    "total_amount" BIGINT NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "reason" TEXT,
    "requested_by_admin_id" UUID,
    "pg_executed_by_admin_id" UUID,
    "verified_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "refund_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticket_number" VARCHAR(40) NOT NULL,
    "order_item_id" UUID NOT NULL,
    "session_seat_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "qr_token_hash" VARCHAR(255),
    "issued_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "voided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admins" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(254) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "role" VARCHAR(30) NOT NULL,
    "mfa_secret_encrypted" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "admin_id" UUID NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "idle_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "mfa_verified_at" TIMESTAMPTZ(6),
    "ip_address" INET,
    "user_agent" TEXT,
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "admin_id" UUID,
    "action" VARCHAR(100) NOT NULL,
    "target_type" VARCHAR(50) NOT NULL,
    "target_id" UUID,
    "before_data" JSONB,
    "after_data" JSONB,
    "evidence_note" TEXT,
    "ip_address" INET,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_cases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "case_type" VARCHAR(40) NOT NULL,
    "severity" VARCHAR(10) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "order_id" UUID,
    "payment_id" UUID,
    "refund_id" UUID,
    "dedupe_key" VARCHAR(255) NOT NULL,
    "detail" JSONB,
    "assigned_admin_id" UUID,
    "resolved_by_admin_id" UUID,
    "resolution_action" VARCHAR(50),
    "resolution_note" TEXT,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_type" VARCHAR(100) NOT NULL,
    "aggregate_type" VARCHAR(50) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "aggregate_version" BIGINT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_retry_at" TIMESTAMPTZ(6),
    "locked_until" TIMESTAMPTZ(6),
    "locked_by" VARCHAR(100),
    "last_error" TEXT,
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shows_slug_uq" ON "shows"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "shows_id_venue_id_uq" ON "shows"("id", "venue_id");

-- CreateIndex
CREATE INDEX "show_sessions_show_id_starts_at_idx" ON "show_sessions"("show_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "show_sessions_id_venue_id_uq" ON "show_sessions"("id", "venue_id");

-- CreateIndex
CREATE UNIQUE INDEX "seats_venue_svg_seat_uq" ON "seats"("venue_id", "svg_seat_id");

-- CreateIndex
CREATE UNIQUE INDEX "seats_venue_section_row_number_nnd_uq" ON "seats"("venue_id", "section_name", "row_label", "seat_number") NULLS NOT DISTINCT;

-- CreateIndex
CREATE UNIQUE INDEX "seats_id_venue_id_uq" ON "seats"("id", "venue_id");

-- CreateIndex
CREATE INDEX "session_seats_session_status_idx" ON "session_seats"("show_session_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "session_seats_session_seat_uq" ON "session_seats"("show_session_id", "seat_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_seats_id_session_uq" ON "session_seats"("id", "show_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_seats_sold_order_item_id_uq" ON "session_seats"("sold_order_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "identity_subjects_key_uq" ON "identity_subjects"("subject_key_type", "key_version", "subject_key_hash");

-- CreateIndex
CREATE INDEX "identity_verifications_binding_created_idx" ON "identity_verifications"("browser_binding_hash", "created_at");

-- CreateIndex
CREATE INDEX "identity_verifications_status_expires_idx" ON "identity_verifications"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "identity_verifications_provider_txn_uq" ON "identity_verifications"("provider", "provider_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "identity_verifications_id_subject_purpose_binding_uq" ON "identity_verifications"("id", "identity_subject_id", "purpose", "browser_binding_hash");

-- CreateIndex
CREATE INDEX "identity_sessions_subject_status_idx" ON "identity_sessions"("identity_subject_id", "status");

-- CreateIndex
CREATE INDEX "identity_sessions_binding_status_idx" ON "identity_sessions"("browser_binding_hash", "status");

-- CreateIndex
CREATE UNIQUE INDEX "identity_sessions_verification_uq" ON "identity_sessions"("identity_verification_id");

-- CreateIndex
CREATE UNIQUE INDEX "identity_sessions_token_hash_uq" ON "identity_sessions"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "identity_sessions_id_subject_uq" ON "identity_sessions"("id", "identity_subject_id");

-- CreateIndex
CREATE INDEX "orders_status_hold_expires_idx" ON "orders"("status", "hold_expires_at");

-- CreateIndex
CREATE INDEX "orders_status_confirm_protected_idx" ON "orders"("status", "confirm_protected_until");

-- CreateIndex
CREATE INDEX "orders_subject_created_idx" ON "orders"("identity_subject_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_number_uq" ON "orders"("order_number");

-- CreateIndex
CREATE UNIQUE INDEX "orders_confirmed_payment_id_uq" ON "orders"("confirmed_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_id_session_uq" ON "orders"("id", "show_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_id_total_uq" ON "orders"("id", "total_amount");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_order_seat_uq" ON "order_items"("order_id", "session_seat_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_id_order_uq" ON "order_items"("id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_id_seat_uq" ON "order_items"("id", "session_seat_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_id_order_seat_uq" ON "order_items"("id", "order_id", "session_seat_id");

-- CreateIndex
CREATE INDEX "seat_holds_order_status_idx" ON "seat_holds"("order_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "seat_holds_order_item_id_uq" ON "seat_holds"("order_item_id");

-- CreateIndex
CREATE INDEX "order_status_logs_order_created_idx" ON "order_status_logs"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "seat_status_logs_seat_created_idx" ON "seat_status_logs"("session_seat_id", "created_at");

-- CreateIndex
CREATE INDEX "order_access_sessions_order_status_idx" ON "order_access_sessions"("order_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "order_access_sessions_token_hash_uq" ON "order_access_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "idempotency_records_expires_idx" ON "idempotency_records"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_scope_owner_key_uq" ON "idempotency_records"("scope", "owner_key_hash", "idempotency_key_hash");

-- CreateIndex
CREATE INDEX "payments_order_created_idx" ON "payments"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "payments_status_next_requery_idx" ON "payments"("status", "next_requery_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_merchant_payment_ref_uq" ON "payments"("merchant_payment_ref");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_pg_txn_uq" ON "payments"("provider", "pg_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_payment_id_uq" ON "payments"("provider", "provider_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_id_order_uq" ON "payments"("id", "order_id");

-- CreateIndex
CREATE INDEX "payment_webhook_events_status_received_idx" ON "payment_webhook_events"("status", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_webhook_events_dedup_uq" ON "payment_webhook_events"("provider", "deduplication_key");

-- CreateIndex
CREATE INDEX "payment_status_logs_payment_created_idx" ON "payment_status_logs"("payment_id", "created_at");

-- CreateIndex
CREATE INDEX "refunds_order_created_idx" ON "refunds"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "refunds_status_updated_idx" ON "refunds"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_provider_refund_id_uq" ON "refunds"("provider", "provider_refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_id_order_uq" ON "refunds"("id", "order_id");

-- CreateIndex
CREATE INDEX "refund_items_order_item_idx" ON "refund_items"("order_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "refund_items_refund_item_uq" ON "refund_items"("refund_id", "order_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_ticket_number_uq" ON "tickets"("ticket_number");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_order_item_id_uq" ON "tickets"("order_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "admins_email_uq" ON "admins"("email");

-- CreateIndex
CREATE INDEX "admin_sessions_admin_status_idx" ON "admin_sessions"("admin_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "admin_sessions_token_hash_uq" ON "admin_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "admin_audit_logs_admin_created_idx" ON "admin_audit_logs"("admin_id", "created_at");

-- CreateIndex
CREATE INDEX "admin_audit_logs_target_idx" ON "admin_audit_logs"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "outbox_events_status_next_retry_idx" ON "outbox_events"("status", "next_retry_at");

-- CreateIndex
CREATE INDEX "outbox_events_aggregate_idx" ON "outbox_events"("aggregate_type", "aggregate_id", "aggregate_version");

-- AddForeignKey
ALTER TABLE "shows" ADD CONSTRAINT "shows_venue_id_fk" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "show_sessions" ADD CONSTRAINT "show_sessions_show_venue_fk" FOREIGN KEY ("show_id", "venue_id") REFERENCES "shows"("id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "seats" ADD CONSTRAINT "seats_venue_id_fk" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "session_seats" ADD CONSTRAINT "session_seats_session_venue_fk" FOREIGN KEY ("show_session_id", "venue_id") REFERENCES "show_sessions"("id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "session_seats" ADD CONSTRAINT "session_seats_seat_venue_fk" FOREIGN KEY ("seat_id", "venue_id") REFERENCES "seats"("id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "session_seats" ADD CONSTRAINT "session_seats_sold_item_seat_fk" FOREIGN KEY ("sold_order_item_id", "id") REFERENCES "order_items"("id", "session_seat_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity_verifications" ADD CONSTRAINT "identity_verifications_subject_fk" FOREIGN KEY ("identity_subject_id") REFERENCES "identity_subjects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity_sessions" ADD CONSTRAINT "identity_sessions_verification_claim_fk" FOREIGN KEY ("identity_verification_id", "identity_subject_id", "purpose", "browser_binding_hash") REFERENCES "identity_verifications"("id", "identity_subject_id", "purpose", "browser_binding_hash") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity_sessions" ADD CONSTRAINT "identity_sessions_subject_fk" FOREIGN KEY ("identity_subject_id") REFERENCES "identity_subjects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "purchase_quotas" ADD CONSTRAINT "purchase_quotas_subject_fk" FOREIGN KEY ("identity_subject_id") REFERENCES "identity_subjects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "purchase_quotas" ADD CONSTRAINT "purchase_quotas_session_fk" FOREIGN KEY ("show_session_id") REFERENCES "show_sessions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_show_session_fk" FOREIGN KEY ("show_session_id") REFERENCES "show_sessions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_subject_fk" FOREIGN KEY ("identity_subject_id") REFERENCES "identity_subjects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_quota_fk" FOREIGN KEY ("identity_subject_id", "show_session_id") REFERENCES "purchase_quotas"("identity_subject_id", "show_session_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_identity_session_subject_fk" FOREIGN KEY ("identity_session_id", "identity_subject_id") REFERENCES "identity_sessions"("id", "identity_subject_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_confirmed_payment_fk" FOREIGN KEY ("confirmed_payment_id", "id") REFERENCES "payments"("id", "order_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_session_fk" FOREIGN KEY ("order_id", "show_session_id") REFERENCES "orders"("id", "show_session_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_seat_session_fk" FOREIGN KEY ("session_seat_id", "show_session_id") REFERENCES "session_seats"("id", "show_session_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "seat_holds" ADD CONSTRAINT "seat_holds_item_order_seat_fk" FOREIGN KEY ("order_item_id", "order_id", "session_seat_id") REFERENCES "order_items"("id", "order_id", "session_seat_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order_status_logs" ADD CONSTRAINT "order_status_logs_order_fk" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order_status_logs" ADD CONSTRAINT "order_status_logs_admin_fk" FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "seat_status_logs" ADD CONSTRAINT "seat_status_logs_seat_fk" FOREIGN KEY ("session_seat_id") REFERENCES "session_seats"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "seat_status_logs" ADD CONSTRAINT "seat_status_logs_admin_fk" FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order_access_sessions" ADD CONSTRAINT "order_access_sessions_order_fk" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_total_fk" FOREIGN KEY ("order_id", "requested_amount") REFERENCES "orders"("id", "total_amount") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_payment_fk" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_status_logs" ADD CONSTRAINT "payment_status_logs_payment_fk" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_order_fk" FOREIGN KEY ("payment_id", "order_id") REFERENCES "payments"("id", "order_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_fk" FOREIGN KEY ("requested_by_admin_id") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_pg_executed_by_fk" FOREIGN KEY ("pg_executed_by_admin_id") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "refund_items" ADD CONSTRAINT "refund_items_refund_order_fk" FOREIGN KEY ("refund_id", "order_id") REFERENCES "refunds"("id", "order_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "refund_items" ADD CONSTRAINT "refund_items_item_order_fk" FOREIGN KEY ("order_item_id", "order_id") REFERENCES "order_items"("id", "order_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_item_seat_fk" FOREIGN KEY ("order_item_id", "session_seat_id") REFERENCES "order_items"("id", "session_seat_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_fk" FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_admin_fk" FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "review_cases" ADD CONSTRAINT "review_cases_order_fk" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "review_cases" ADD CONSTRAINT "review_cases_payment_fk" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "review_cases" ADD CONSTRAINT "review_cases_refund_fk" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "review_cases" ADD CONSTRAINT "review_cases_assigned_admin_fk" FOREIGN KEY ("assigned_admin_id") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "review_cases" ADD CONSTRAINT "review_cases_resolved_by_fk" FOREIGN KEY ("resolved_by_admin_id") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

COMMIT;
