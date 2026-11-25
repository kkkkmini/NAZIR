-- Step 4: identity verification start (DECISIONS A-049, DATABASE.md §6.2).
BEGIN;

-- The callback state is single-use and globally unique (only its SHA-256 is stored).
CREATE UNIQUE INDEX "identity_verifications_state_nonce_uq" ON "identity_verifications"("state_nonce_hash");

-- At most one PENDING start per browser binding and purpose: a new start supersedes the previous one (EXPIRED,
-- failure_code SUPERSEDED) inside the same transaction, so a callback can only ever complete the latest attempt.
CREATE UNIQUE INDEX "identity_verifications_pending_binding_uq" ON "identity_verifications"("browser_binding_hash", "purpose")
  WHERE "status" IN ('PENDING');

COMMIT;
