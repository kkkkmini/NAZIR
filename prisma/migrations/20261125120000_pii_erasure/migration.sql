-- Step 4: selective personal-data erasure (DECISIONS A-048, DATABASE.md §3.29).
-- Rows that orders/sessions reference (RESTRICT) are kept; only their personal-data columns are cleared.
BEGIN;

-- identity_subjects: the DI HMAC can be erased; the row stays for orders/quotas/sessions FKs.
ALTER TABLE "identity_subjects" ALTER COLUMN "subject_key_hash" DROP NOT NULL;
ALTER TABLE "identity_subjects" ADD COLUMN "erased_at" TIMESTAMPTZ(6);
ALTER TABLE "identity_subjects" ADD CONSTRAINT "identity_subjects_erasure_ck"
  CHECK (("erased_at" IS NULL) = ("subject_key_hash" IS NOT NULL));

-- identity_verifications: name/phone/provider context can be cleared; once erased they stay empty.
ALTER TABLE "identity_verifications" ADD COLUMN "pii_erased_at" TIMESTAMPTZ(6);
ALTER TABLE "identity_verifications" ADD CONSTRAINT "identity_verifications_pii_erasure_ck"
  CHECK ("pii_erased_at" IS NULL OR ("verified_name" IS NULL AND "verified_phone" IS NULL AND "provider_context_encrypted" IS NULL));

-- orders: customer contact data can be cleared separately from the order/payment record itself.
ALTER TABLE "orders" ALTER COLUMN "customer_name" DROP NOT NULL;
ALTER TABLE "orders" ALTER COLUMN "customer_phone" DROP NOT NULL;
ALTER TABLE "orders" ADD COLUMN "customer_pii_erased_at" TIMESTAMPTZ(6);
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_pii_ck"
  CHECK ("customer_pii_erased_at" IS NOT NULL OR ("customer_name" IS NOT NULL AND "customer_phone" IS NOT NULL));

CREATE TABLE "pii_erasure_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "target_type" VARCHAR(40) NOT NULL,
    "target_id" UUID NOT NULL,
    "fields" VARCHAR(40)[],
    "reason" VARCHAR(50) NOT NULL,
    "actor_type" VARCHAR(20) NOT NULL,
    "admin_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pii_erasure_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "pii_erasure_logs_target_idx" ON "pii_erasure_logs"("target_type", "target_id");
ALTER TABLE "pii_erasure_logs" ADD CONSTRAINT "pii_erasure_logs_admin_fk"
  FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "pii_erasure_logs"
  ADD CONSTRAINT "pii_erasure_logs_target_type_ck" CHECK ("target_type" IN ('IDENTITY_VERIFICATION', 'IDENTITY_SUBJECT', 'ORDER')),
  ADD CONSTRAINT "pii_erasure_logs_actor_type_ck" CHECK ("actor_type" IN ('SYSTEM', 'ADMIN')),
  ADD CONSTRAINT "pii_erasure_logs_actor_admin_ck" CHECK (("actor_type" = 'ADMIN') = ("admin_id" IS NOT NULL)),
  ADD CONSTRAINT "pii_erasure_logs_reason_ck" CHECK ("reason" ~ '^[A-Z][A-Z0-9_]{2,49}$'),
  ADD CONSTRAINT "pii_erasure_logs_fields_ck" CHECK (
    "fields" IS NOT NULL AND cardinality("fields") >= 1
    AND "fields" <@ ARRAY['verified_name', 'verified_phone', 'provider_context_encrypted', 'subject_key_hash',
                          'customer_name', 'customer_phone', 'customer_email']::VARCHAR(40)[]);

CREATE TRIGGER "pii_erasure_logs_no_update" BEFORE UPDATE ON "pii_erasure_logs" FOR EACH ROW EXECUTE FUNCTION "ledger_reject_update"();
CREATE TRIGGER "pii_erasure_logs_no_delete" BEFORE DELETE ON "pii_erasure_logs" FOR EACH ROW EXECUTE FUNCTION "ledger_reject_delete"();

COMMIT;
