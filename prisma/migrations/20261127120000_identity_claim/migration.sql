-- Step 4: identity claim and sessions (DECISIONS A-051, DATABASE.md §6.3).
BEGIN;

-- "같은 브라우저 바인딩에서 같은 purpose의 새 세션을 발급하면 기존 ACTIVE 세션은 REVOKED" (A-009) as a DB rule:
-- at most one ACTIVE session per browser binding and purpose. Claims revoke the previous one in the same transaction.
CREATE UNIQUE INDEX "identity_sessions_active_binding_uq" ON "identity_sessions"("browser_binding_hash", "purpose")
  WHERE "status" IN ('ACTIVE');

COMMIT;
