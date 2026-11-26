/**
 * The audience session check shared by booking writes (order creation, cancellation): locks this browser's session row
 * (UPDATE last_used_at — the session counts as used, so the claim response-loss recovery of A-052 no longer applies)
 * inside the caller's booking transaction. 401 IDENTITY_SESSION_REQUIRED when absent / expired / revoked,
 * 401 BROWSER_BINDING_MISMATCH when the token is valid but belongs to another browser. Purpose is checked by the caller.
 */
import type { SqlExecutor } from "../db/sql";
import { AppError } from "../lib/errors";

export interface SessionRow {
  id: string;
  purpose: string;
  identity_subject_id: string;
  identity_verification_id: string;
  remaining_ms: unknown;
}

/** Locks the BOOKING/LOOKUP session row of this browser (UPDATE last_used_at); 401 when absent / copied to another browser. */
export async function lockBookingSession(tx: SqlExecutor, tokenHash: string, bindingHash: string): Promise<SessionRow> {
  const rows = await tx<SessionRow>(
    `UPDATE "identity_sessions" SET "last_used_at" = now(), "updated_at" = now()
      WHERE "token_hash" = $1 AND "browser_binding_hash" = $2 AND "status" = 'ACTIVE' AND "expires_at" > now()
      RETURNING "id", "purpose", "identity_subject_id", "identity_verification_id",
                floor(extract(epoch FROM ("expires_at" - now())) * 1000)::bigint AS "remaining_ms"`,
    [tokenHash, bindingHash],
  );
  if (rows.length === 1) return rows[0];
  const copied = await tx<{ n: number }>(
    `SELECT count(*)::int AS "n" FROM "identity_sessions" WHERE "token_hash" = $1 AND "status" = 'ACTIVE' AND "expires_at" > now()`,
    [tokenHash],
  );
  if (Number(copied[0]?.n) > 0) throw new AppError("BROWSER_BINDING_MISMATCH", "인증을 시작한 브라우저에서만 진행할 수 있습니다.");
  throw new AppError("IDENTITY_SESSION_REQUIRED", "본인인증이 필요합니다.");
}
