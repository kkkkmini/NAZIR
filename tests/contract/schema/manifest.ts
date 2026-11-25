/**
 * The schema contract: every database object that DATABASE.md §13.3 / §14 requires and that
 * Prisma cannot guarantee on its own. Tests compare this list against the LIVE catalog
 * (pg_index / pg_constraint / information_schema) — never against schema.prisma.
 *
 * Adding a table or rule later means adding it here; removing an entry is a design change that
 * needs the same approval as a DATABASE.md change.
 */
import {
  ACTIVE_ORDER_STATUS,
  ADMIN_ROLE,
  HOLD_RELEASED_REASON,
  HOLD_STATUS,
  IDEMPOTENCY_RESOURCE_TYPE,
  IDEMPOTENCY_STATUS,
  IDENTITY_PURPOSE,
  IDENTITY_SUBJECT_KEY_TYPE,
  IDENTITY_VERIFICATION_STATUS,
  IN_PROGRESS_PAYMENT_STATUS,
  LIVE_HOLD_STATUS,
  ORDER_ACCESS_SCOPE,
  ORDER_LOG_SOURCE,
  ORDER_STATUS,
  OUTBOX_STATUS,
  PAYMENT_LOG_SOURCE,
  PAYMENT_METHOD_TYPE,
  PAYMENT_REQUEST_METHOD_TYPE,
  PAYMENT_ROLE,
  PAYMENT_STATUS,
  REFUND_STATUS,
  REFUND_TYPE,
  REVIEW_CASE_SEVERITY,
  REVIEW_CASE_STATUS,
  REVIEW_CASE_TYPE,
  SEAT_LOG_ACTOR_TYPE,
  SESSION_SALES_STATUS,
  SESSION_SEAT_STATUS,
  SESSION_STATUS,
  SHOW_STATUS,
  TICKET_STATUS,
  VALID_TICKET_STATUS,
  WEBHOOK_EVENT_STATUS,
  PII_ERASURE_ACTOR,
  PII_ERASURE_FIELD,
  PII_ERASURE_TARGET,
} from "../../../src/server/db/constants";

/** DATABASE.md §3: 27 core tables + rate_limit_counters (A-045) + pii_erasure_logs (A-048). */
export const TABLES = [
  "venues", "shows", "show_sessions", "seats", "session_seats",
  "identity_subjects", "identity_verifications", "identity_sessions",
  "orders", "order_items", "seat_holds", "order_status_logs", "seat_status_logs",
  "order_access_sessions", "purchase_quotas", "idempotency_records",
  "payments", "payment_webhook_events", "payment_status_logs", "refunds", "refund_items",
  "tickets",
  "admins", "admin_sessions", "admin_audit_logs",
  "review_cases", "outbox_events",
  "rate_limit_counters",
  "pii_erasure_logs",
] as const;

// ───────────────────────── MIG-02: partial unique indexes ─────────────────────────

export interface PartialUnique {
  name: string;
  table: string;
  columns: string[];
  /** `in`: predicate is `col IN (values)`; `neq`: predicate is `col <> value`. */
  predicate: { column: string; op: "in" | "neq"; values: readonly string[] };
  rule: string;
}

export const PARTIAL_UNIQUES: PartialUnique[] = [
  {
    name: "seat_holds_active_seat_uq",
    table: "seat_holds",
    columns: ["session_seat_id"],
    predicate: { column: "status", op: "in", values: LIVE_HOLD_STATUS },
    rule: "1: one live hold per seat",
  },
  {
    name: "orders_active_subject_session_uq",
    table: "orders",
    columns: ["identity_subject_id", "show_session_id"],
    predicate: { column: "status", op: "in", values: ACTIVE_ORDER_STATUS },
    rule: "2: one active order per subject and session (D-008, D-014)",
  },
  {
    name: "payments_in_progress_order_uq",
    table: "payments",
    columns: ["order_id"],
    predicate: { column: "status", op: "in", values: IN_PROGRESS_PAYMENT_STATUS },
    rule: "3: one in-flight payment per order (A-005)",
  },
  {
    name: "payments_primary_order_uq",
    table: "payments",
    columns: ["order_id"],
    predicate: { column: "role", op: "in", values: ["PRIMARY"] },
    rule: "S3: one PRIMARY (order-confirming) payment per order",
  },
  {
    name: "tickets_valid_seat_uq",
    table: "tickets",
    columns: ["session_seat_id"],
    predicate: { column: "status", op: "in", values: VALID_TICKET_STATUS },
    rule: "7: one valid ticket per seat (H1)",
  },
  {
    name: "review_cases_open_dedupe_uq",
    table: "review_cases",
    columns: ["case_type", "dedupe_key"],
    predicate: { column: "status", op: "neq", values: ["RESOLVED"] },
    rule: "no duplicate open review case (§10.1)",
  },
];

// ───────────────────────── plain / NULLS NOT DISTINCT uniques ─────────────────────────

export interface UniqueSpec {
  name: string;
  table: string;
  columns: string[];
  nullsNotDistinct?: boolean;
}

/** Non-partial unique indexes that carry an integrity rule (DATABASE.md §13.3, §14). */
export const UNIQUES: UniqueSpec[] = [
  { name: "seats_venue_section_row_number_nnd_uq", table: "seats", columns: ["venue_id", "section_name", "row_label", "seat_number"], nullsNotDistinct: true },
  { name: "seats_venue_svg_seat_uq", table: "seats", columns: ["venue_id", "svg_seat_id"] },
  { name: "shows_slug_uq", table: "shows", columns: ["slug"] },
  { name: "session_seats_session_seat_uq", table: "session_seats", columns: ["show_session_id", "seat_id"] },
  { name: "session_seats_sold_order_item_id_uq", table: "session_seats", columns: ["sold_order_item_id"] },
  { name: "identity_subjects_key_uq", table: "identity_subjects", columns: ["subject_key_type", "key_version", "subject_key_hash"] },
  { name: "identity_verifications_id_subject_purpose_binding_uq", table: "identity_verifications", columns: ["id", "identity_subject_id", "purpose", "browser_binding_hash"] },
  { name: "orders_id_total_uq", table: "orders", columns: ["id", "total_amount"] },
  { name: "identity_verifications_provider_txn_uq", table: "identity_verifications", columns: ["provider", "provider_transaction_id"] },
  { name: "identity_sessions_verification_uq", table: "identity_sessions", columns: ["identity_verification_id"] },
  { name: "identity_sessions_token_hash_uq", table: "identity_sessions", columns: ["token_hash"] },
  { name: "orders_order_number_uq", table: "orders", columns: ["order_number"] },
  { name: "orders_confirmed_payment_id_uq", table: "orders", columns: ["confirmed_payment_id"] },
  { name: "order_items_order_seat_uq", table: "order_items", columns: ["order_id", "session_seat_id"] },
  { name: "seat_holds_order_item_id_uq", table: "seat_holds", columns: ["order_item_id"] },
  { name: "order_access_sessions_token_hash_uq", table: "order_access_sessions", columns: ["token_hash"] },
  { name: "idempotency_records_scope_owner_key_uq", table: "idempotency_records", columns: ["scope", "owner_key_hash", "idempotency_key_hash"] },
  { name: "payments_merchant_payment_ref_uq", table: "payments", columns: ["merchant_payment_ref"] },
  { name: "payments_provider_pg_txn_uq", table: "payments", columns: ["provider", "pg_transaction_id"] },
  { name: "payments_provider_payment_id_uq", table: "payments", columns: ["provider", "provider_payment_id"] },
  { name: "payment_webhook_events_dedup_uq", table: "payment_webhook_events", columns: ["provider", "deduplication_key"] },
  { name: "refunds_provider_refund_id_uq", table: "refunds", columns: ["provider", "provider_refund_id"] },
  { name: "refund_items_refund_item_uq", table: "refund_items", columns: ["refund_id", "order_item_id"] },
  { name: "tickets_ticket_number_uq", table: "tickets", columns: ["ticket_number"] },
  { name: "tickets_order_item_id_uq", table: "tickets", columns: ["order_item_id"] },
  { name: "admins_email_uq", table: "admins", columns: ["email"] },
  { name: "admin_sessions_token_hash_uq", table: "admin_sessions", columns: ["token_hash"] },
  // composite-FK targets (must exist for the FKs below to be creatable at all)
  { name: "shows_id_venue_id_uq", table: "shows", columns: ["id", "venue_id"] },
  { name: "show_sessions_id_venue_id_uq", table: "show_sessions", columns: ["id", "venue_id"] },
  { name: "seats_id_venue_id_uq", table: "seats", columns: ["id", "venue_id"] },
  { name: "session_seats_id_session_uq", table: "session_seats", columns: ["id", "show_session_id"] },
  { name: "identity_sessions_id_subject_uq", table: "identity_sessions", columns: ["id", "identity_subject_id"] },
  { name: "orders_id_session_uq", table: "orders", columns: ["id", "show_session_id"] },
  { name: "order_items_id_order_uq", table: "order_items", columns: ["id", "order_id"] },
  { name: "order_items_id_seat_uq", table: "order_items", columns: ["id", "session_seat_id"] },
  { name: "order_items_id_order_seat_uq", table: "order_items", columns: ["id", "order_id", "session_seat_id"] },
  { name: "payments_id_order_uq", table: "payments", columns: ["id", "order_id"] },
  { name: "refunds_id_order_uq", table: "refunds", columns: ["id", "order_id"] },
];

// ───────────────────────── MIG-03: CHECK constraints ─────────────────────────

export interface CheckSpec {
  name: string;
  table: string;
  /** Columns the check reads (used by MIG-06 to protect them from DROP COLUMN). */
  columns: string[];
  /** If set, the CHECK is a vocabulary check: literals in the live definition must equal this list. */
  vocab?: readonly string[];
  rule?: string;
}

const vocab = (table: string, column: string, values: readonly string[], suffix = "ck"): CheckSpec => ({
  name: `${table}_${column}_${suffix}`,
  table,
  columns: [column],
  vocab: values,
});

export const CHECKS: CheckSpec[] = [
  // vocabularies ("상태값")
  vocab("shows", "status", SHOW_STATUS),
  vocab("show_sessions", "sales_status", SESSION_SALES_STATUS),
  vocab("session_seats", "status", SESSION_SEAT_STATUS),
  { name: "identity_subjects_key_type_ck", table: "identity_subjects", columns: ["subject_key_type"], vocab: IDENTITY_SUBJECT_KEY_TYPE },
  vocab("identity_verifications", "purpose", IDENTITY_PURPOSE),
  vocab("identity_verifications", "status", IDENTITY_VERIFICATION_STATUS),
  vocab("identity_sessions", "purpose", IDENTITY_PURPOSE),
  vocab("identity_sessions", "status", SESSION_STATUS),
  vocab("orders", "status", ORDER_STATUS),
  vocab("seat_holds", "status", HOLD_STATUS),
  vocab("seat_holds", "released_reason", HOLD_RELEASED_REASON),
  vocab("order_status_logs", "source", ORDER_LOG_SOURCE),
  vocab("seat_status_logs", "actor_type", SEAT_LOG_ACTOR_TYPE),
  vocab("order_access_sessions", "scope", ORDER_ACCESS_SCOPE),
  vocab("order_access_sessions", "status", SESSION_STATUS),
  vocab("idempotency_records", "status", IDEMPOTENCY_STATUS),
  vocab("idempotency_records", "resource_type", IDEMPOTENCY_RESOURCE_TYPE),
  vocab("payments", "status", PAYMENT_STATUS),
  vocab("payments", "role", PAYMENT_ROLE),
  { name: "payments_method_type_ck", table: "payments", columns: ["method_type"], vocab: PAYMENT_METHOD_TYPE, rule: "D-005, Q-022: CARD / EASY_PAY / OTHER" },
  { name: "payments_method_type_other_ck", table: "payments", columns: ["method_type", "status", "role"], rule: "Q-022: OTHER only for SUCCEEDED + EXCESS" },
  { name: "payments_succeeded_approved_at_ck", table: "payments", columns: ["status", "approved_at"], rule: "A-038: SUCCEEDED carries its approval time" },
  { name: "payments_requested_method_type_ck", table: "payments", columns: ["requested_method_type"], vocab: PAYMENT_REQUEST_METHOD_TYPE, rule: "A-039: what the user chose" },
  { name: "payments_other_requires_raw_ck", table: "payments", columns: ["method_type", "provider_method_raw"], rule: "A-039: OTHER keeps the PG label" },
  { name: "payments_provider_method_raw_ck", table: "payments", columns: ["provider_method_raw"], rule: "A-039: no personal / payment data in the raw label" },
  { name: "payments_unapproved_method_matches_request_ck", table: "payments", columns: ["status", "method_type", "requested_method_type"], rule: "A-039: method_type may differ from the request only once SUCCEEDED" },
  { name: "payments_succeeded_amount_ck", table: "payments", columns: ["status", "approved_amount"], rule: "A-038: SUCCEEDED carries a positive approved amount" },
  { name: "payments_primary_amount_ck", table: "payments", columns: ["role", "approved_amount", "requested_amount"], rule: "S3: PRIMARY approved = requested" },
  vocab("payment_webhook_events", "status", WEBHOOK_EVENT_STATUS),
  vocab("payment_status_logs", "source", PAYMENT_LOG_SOURCE),
  vocab("refunds", "refund_type", REFUND_TYPE),
  vocab("refunds", "status", REFUND_STATUS),
  vocab("tickets", "status", TICKET_STATUS),
  vocab("admins", "role", ADMIN_ROLE),
  vocab("admin_sessions", "status", SESSION_STATUS),
  { name: "review_cases_case_type_ck", table: "review_cases", columns: ["case_type"], vocab: REVIEW_CASE_TYPE },
  vocab("review_cases", "severity", REVIEW_CASE_SEVERITY),
  vocab("review_cases", "status", REVIEW_CASE_STATUS),
  vocab("outbox_events", "status", OUTBOX_STATUS),

  // amounts, limits, ownership (behaviour is exercised in integrity.test.ts)
  { name: "show_sessions_max_seats_per_identity_ck", table: "show_sessions", columns: ["max_seats_per_identity"], rule: "D-006: 1..4" },
  { name: "session_seats_price_ck", table: "session_seats", columns: ["price"] },
  { name: "session_seats_sold_owner_ck", table: "session_seats", columns: ["status", "sold_order_item_id"], rule: "6: SOLD <=> owner item" },
  { name: "identity_verifications_verified_subject_ck", table: "identity_verifications", columns: ["status", "identity_subject_id"] },
  { name: "purchase_quotas_seat_limit_ck", table: "purchase_quotas", columns: ["seat_limit"], rule: "11" },
  { name: "purchase_quotas_counted_seats_ck", table: "purchase_quotas", columns: ["counted_seats", "seat_limit"], rule: "11: 0 <= counted <= limit" },
  { name: "orders_total_amount_ck", table: "orders", columns: ["total_amount"] },
  { name: "orders_paid_requires_confirmed_payment_ck", table: "orders", columns: ["status", "confirmed_payment_id"], rule: "9" },
  { name: "orders_confirm_protected_until_ck", table: "orders", columns: ["status", "confirm_protected_until"], rule: "D-003" },
  { name: "order_items_price_ck", table: "order_items", columns: ["price"] },
  { name: "payments_requested_amount_ck", table: "payments", columns: ["requested_amount"] },
  { name: "payments_approved_amount_ck", table: "payments", columns: ["approved_amount"] },
  { name: "payments_refunded_amount_ck", table: "payments", columns: ["refunded_amount", "approved_amount"], rule: "10: refunded <= approved" },
  { name: "payments_succeeded_role_ck", table: "payments", columns: ["status", "role"] },
  { name: "refunds_total_amount_ck", table: "refunds", columns: ["total_amount"] },
  { name: "refund_items_amount_ck", table: "refund_items", columns: ["amount"] },
  // rate_limit_counters (A-045)
  { name: "rate_limit_counters_policy_ck", table: "rate_limit_counters", columns: ["policy"] },
  { name: "rate_limit_counters_key_hash_ck", table: "rate_limit_counters", columns: ["key_hash"] },
  { name: "rate_limit_counters_count_ck", table: "rate_limit_counters", columns: ["count"] },
  { name: "rate_limit_counters_window_ck", table: "rate_limit_counters", columns: ["expires_at", "window_started_at"] },
  // personal-data erasure (A-048)
  { name: "identity_subjects_erasure_ck", table: "identity_subjects", columns: ["erased_at", "subject_key_hash"] },
  { name: "identity_verifications_pii_erasure_ck", table: "identity_verifications", columns: ["pii_erased_at", "verified_name", "verified_phone", "provider_context_encrypted"] },
  { name: "orders_customer_pii_ck", table: "orders", columns: ["customer_pii_erased_at", "customer_name", "customer_phone"] },
  vocab("pii_erasure_logs", "target_type", PII_ERASURE_TARGET),
  vocab("pii_erasure_logs", "actor_type", PII_ERASURE_ACTOR),
  { name: "pii_erasure_logs_actor_admin_ck", table: "pii_erasure_logs", columns: ["actor_type", "admin_id"] },
  { name: "pii_erasure_logs_reason_ck", table: "pii_erasure_logs", columns: ["reason"] },
  { name: "pii_erasure_logs_fields_ck", table: "pii_erasure_logs", columns: ["fields"], vocab: PII_ERASURE_FIELD },
];

// ───────────────────────── MIG-04: composite foreign keys ─────────────────────────

export interface CompositeFk {
  name: string;
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  rule: string;
}

export const COMPOSITE_FKS: CompositeFk[] = [
  { name: "show_sessions_show_venue_fk", table: "show_sessions", columns: ["show_id", "venue_id"], refTable: "shows", refColumns: ["id", "venue_id"], rule: "session venue = show venue" },
  { name: "identity_sessions_verification_claim_fk", table: "identity_sessions", columns: ["identity_verification_id", "identity_subject_id", "purpose", "browser_binding_hash"], refTable: "identity_verifications", refColumns: ["id", "identity_subject_id", "purpose", "browser_binding_hash"], rule: "Q-024, A-040: session subject + purpose + browser binding = verification's" },
  { name: "orders_quota_fk", table: "orders", columns: ["identity_subject_id", "show_session_id"], refTable: "purchase_quotas", refColumns: ["identity_subject_id", "show_session_id"], rule: "S4: an order needs its quota row" },
  { name: "payments_order_total_fk", table: "payments", columns: ["order_id", "requested_amount"], refTable: "orders", refColumns: ["id", "total_amount"], rule: "S3: requested_amount = order total" },
  { name: "session_seats_session_venue_fk", table: "session_seats", columns: ["show_session_id", "venue_id"], refTable: "show_sessions", refColumns: ["id", "venue_id"], rule: "5" },
  { name: "session_seats_seat_venue_fk", table: "session_seats", columns: ["seat_id", "venue_id"], refTable: "seats", refColumns: ["id", "venue_id"], rule: "5: only the session venue's seats are sellable" },
  { name: "session_seats_sold_item_seat_fk", table: "session_seats", columns: ["sold_order_item_id", "id"], refTable: "order_items", refColumns: ["id", "session_seat_id"], rule: "6: owner item belongs to this seat" },
  { name: "orders_identity_session_subject_fk", table: "orders", columns: ["identity_session_id", "identity_subject_id"], refTable: "identity_sessions", refColumns: ["id", "identity_subject_id"], rule: "12" },
  { name: "orders_confirmed_payment_fk", table: "orders", columns: ["confirmed_payment_id", "id"], refTable: "payments", refColumns: ["id", "order_id"], rule: "8" },
  { name: "order_items_order_session_fk", table: "order_items", columns: ["order_id", "show_session_id"], refTable: "orders", refColumns: ["id", "show_session_id"], rule: "4" },
  { name: "order_items_seat_session_fk", table: "order_items", columns: ["session_seat_id", "show_session_id"], refTable: "session_seats", refColumns: ["id", "show_session_id"], rule: "4, 5" },
  { name: "seat_holds_item_order_seat_fk", table: "seat_holds", columns: ["order_item_id", "order_id", "session_seat_id"], refTable: "order_items", refColumns: ["id", "order_id", "session_seat_id"], rule: "13" },
  { name: "refunds_payment_order_fk", table: "refunds", columns: ["payment_id", "order_id"], refTable: "payments", refColumns: ["id", "order_id"], rule: "13" },
  { name: "refund_items_refund_order_fk", table: "refund_items", columns: ["refund_id", "order_id"], refTable: "refunds", refColumns: ["id", "order_id"], rule: "13" },
  { name: "refund_items_item_order_fk", table: "refund_items", columns: ["order_item_id", "order_id"], refTable: "order_items", refColumns: ["id", "order_id"], rule: "13" },
  { name: "tickets_item_seat_fk", table: "tickets", columns: ["order_item_id", "session_seat_id"], refTable: "order_items", refColumns: ["id", "session_seat_id"], rule: "13" },
];

// ───────────────────────── MIG-07: types ─────────────────────────

/** Money columns: bigint KRW (DATABASE.md §1.2). */
export const BIGINT_COLUMNS: [table: string, column: string][] = [
  ["session_seats", "price"],
  ["orders", "total_amount"],
  ["order_items", "price"],
  ["payments", "requested_amount"],
  ["payments", "approved_amount"],
  ["payments", "refunded_amount"],
  ["refunds", "total_amount"],
  ["refund_items", "amount"],
  ["purchase_quotas", "version"],
  ["outbox_events", "aggregate_version"],
];

export const SMALLINT_COLUMNS: [string, string][] = [
  ["show_sessions", "max_seats_per_identity"],
  ["purchase_quotas", "seat_limit"],
  ["purchase_quotas", "counted_seats"],
  ["identity_subjects", "key_version"],
];

/** `_id` columns that are NOT uuid (provider-side identifiers, SVG ids). Everything else must be uuid. */
export const NON_UUID_ID_COLUMNS = new Set([
  "identity_verifications.provider_transaction_id",
  "payments.provider_payment_id",
  "payments.pg_transaction_id",
  "payments.merchant_payment_ref",
  "payment_webhook_events.provider_event_id",
  "refunds.provider_refund_id",
  "seats.svg_seat_id",
]);

// ───────────────────────── trigger ─────────────────────────

/** pg_trigger.tgtype bits: ROW(1) | BEFORE(2) | DELETE(8) | UPDATE(16); an AFTER trigger has no BEFORE bit */
export const IMMUTABLE_TRIGGERS = [
  { name: "order_items_no_update", table: "order_items", tgtype: 1 | 2 | 16, function: "order_items_reject_change" },
  { name: "order_items_no_delete", table: "order_items", tgtype: 1 | 2 | 8, function: "order_items_reject_change" },
  { name: "payments_no_delete", table: "payments", tgtype: 1 | 2 | 8, function: "ledger_reject_delete" },
  { name: "payments_requested_method_no_change", table: "payments", tgtype: 1 | 2 | 16, function: "payments_reject_requested_method_change" }, // A-039
  // A-041 (Q-029): append-only history and the refund ledger
  { name: "admin_audit_logs_no_update", table: "admin_audit_logs", tgtype: 1 | 2 | 16, function: "ledger_reject_update" },
  { name: "admin_audit_logs_no_delete", table: "admin_audit_logs", tgtype: 1 | 2 | 8, function: "ledger_reject_delete" },
  { name: "payment_status_logs_no_update", table: "payment_status_logs", tgtype: 1 | 2 | 16, function: "ledger_reject_update" },
  { name: "payment_status_logs_no_delete", table: "payment_status_logs", tgtype: 1 | 2 | 8, function: "ledger_reject_delete" },
  { name: "refund_items_no_update", table: "refund_items", tgtype: 1 | 2 | 16, function: "ledger_reject_update" },
  { name: "refund_items_no_delete", table: "refund_items", tgtype: 1 | 2 | 8, function: "ledger_reject_delete" },
  { name: "refunds_no_delete", table: "refunds", tgtype: 1 | 2 | 8, function: "ledger_reject_delete" },
  // PR #2 review: approval record of a SUCCEEDED payment, monetary core of a refund
  { name: "payments_approved_evidence_no_change", table: "payments", tgtype: 1 | 16, function: "payments_reject_approved_evidence_change" },
  { name: "refunds_core_no_change", table: "refunds", tgtype: 1 | 16, function: "refunds_reject_core_change" },
  // A-048: the erasure log is append-only
  { name: "pii_erasure_logs_no_update", table: "pii_erasure_logs", tgtype: 1 | 2 | 16, function: "ledger_reject_update" },
  { name: "pii_erasure_logs_no_delete", table: "pii_erasure_logs", tgtype: 1 | 2 | 8, function: "ledger_reject_delete" },
];

/**
 * S3: deferred constraint triggers (order <-> payment consistency). They run at COMMIT against the final state.
 * tgtype bits: ROW(1) | INSERT(4) | UPDATE(16); AFTER = no BEFORE/INSTEAD bit.
 */
export const CONSTRAINT_TRIGGERS = [
  { name: "orders_confirmed_payment_guard", table: "orders", tgtype: 1 | 16, function: "orders_check_confirmed_payment" },
  { name: "payments_primary_guard", table: "payments", tgtype: 1 | 4 | 16, function: "payments_check_primary_confirmed" },
  // A-040: identity claim consistency. tgtype: ROW(1) | INSERT(4) | DELETE(8) | UPDATE(16)
  { name: "identity_sessions_claim_guard", table: "identity_sessions", tgtype: 1 | 4 | 8 | 16, function: "identity_sessions_check_claimed" },
  { name: "identity_verifications_claim_guard", table: "identity_verifications", tgtype: 1 | 4 | 16, function: "identity_verifications_check_consumed" },
  // PR #2 review: SEAT refund total = sum of its items (checked at COMMIT). tgtype: ROW(1) | INSERT(4)
  { name: "refunds_items_guard", table: "refunds", tgtype: 1 | 4, function: "refunds_check_items" },
  { name: "refund_items_refund_guard", table: "refund_items", tgtype: 1 | 4, function: "refund_items_check_refund" },
];
