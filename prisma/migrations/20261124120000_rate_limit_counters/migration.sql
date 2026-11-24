-- Step 4: shared rate limit counters (DECISIONS A-045, DATABASE.md §3.28).
-- No personal data: key_hash is "v<N>." + base64url HMAC-SHA256 (NAZIR_RATE_LIMIT keyring) of the identifier.
BEGIN;

CREATE TABLE "rate_limit_counters" (
    "policy" VARCHAR(64) NOT NULL,
    "key_hash" VARCHAR(64) NOT NULL,
    "window_started_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_limit_counters_pkey" PRIMARY KEY ("policy","key_hash")
);

CREATE INDEX "rate_limit_counters_expires_idx" ON "rate_limit_counters"("expires_at");

-- Policy names come from a fixed code registry; keys are fixed-shape HMAC outputs (no free-form input is stored).
ALTER TABLE "rate_limit_counters"
  ADD CONSTRAINT "rate_limit_counters_policy_ck" CHECK ("policy" ~ '^[a-z][a-z0-9_.]{0,63}$'),
  ADD CONSTRAINT "rate_limit_counters_key_hash_ck" CHECK ("key_hash" ~ '^v[1-9][0-9]{0,3}\.[A-Za-z0-9_-]{43}$'),
  ADD CONSTRAINT "rate_limit_counters_count_ck" CHECK ("count" >= 1),
  ADD CONSTRAINT "rate_limit_counters_window_ck" CHECK ("expires_at" > "window_started_at");

COMMIT;
