/**
 * Identity claim and identity sessions (API_SPEC §3.2, §4.2; DATABASE §6.3; A-040, A-051).
 *
 * POST /api/v1/identity-verifications/{id}/claim
 *   1. id is a uuid; body empty or `{}` (no client-supplied subject/purpose/user data)   → 400 VALIDATION_FAILED
 *   2. binding cookie                                                                    → 401 BROWSER_BINDING_REQUIRED
 *   3. Origin + CSRF                                                                     → 403 CSRF_REJECTED
 *   4. ONE transaction (READ COMMITTED):
 *        lock the verification row (FOR UPDATE), then a per-(binding, purpose) advisory lock
 *        not found                                   → 404 NOT_FOUND
 *        stored binding hash ≠ this browser's        → 401 BROWSER_BINDING_MISMATCH
 *        VERIFIED and DB now() < claim_expires_at    → claim: revoke this browser's ACTIVE session of the same purpose,
 *                                                       verification → CONSUMED, INSERT new session (token hash only)
 *        CONSUMED, recovery conditions (below)       → rotate the token of its never-used session
 *        anything else / window passed               → 422 IDENTITY_VERIFICATION_FAILED
 *      A DB constraint at statement or COMMIT time is mapped (dbConstraintOf) — never a raw 500 — and rolls everything back.
 *   5. 200 { purpose, expiresAt, displayName } + Set-Cookie __Host-nz_idv (Max-Age = seconds to expires_at). The raw
 *      token exists only in that header.
 *
 * Response-loss recovery (A-051, A-052): if the claim committed but the browser never received the cookie, the same
 * browser may repeat the claim of the SAME verification while ALL hold (each checked in SQL against DB now()):
 *   - the verification is CONSUMED and its stored binding hash equals this browser's
 *   - the session row belongs to THIS verification (identity_verification_id = id) and to this binding
 *   - the session is ACTIVE, unexpired, never used (last_used_at IS NULL)
 *   - now() < session.created_at + RECOVERY_WINDOW_MS (5 minutes from the first successful claim's transaction;
 *     NOT the verification's claim_expires_at)
 * The row is kept (same id, same expires_at — no extension), the verification stays CONSUMED, and only token_hash is
 * replaced, so any copy of the lost token stops working at once. No token is ever stored or returned for recovery.
 *
 * GET /api/v1/identity-session  — both cookies must match an ACTIVE, unexpired (DB now()) session. Returns
 *   { purpose, expiresAt, displayName }. Updates last_used_at only (never expires_at: no sliding, D-015).
 * DELETE /api/v1/identity-session — Origin + CSRF; revokes the session that matches BOTH cookies (only that row),
 *   always clears the cookie, idempotent (204 also when nothing matched).
 */
import { randomBytes } from "node:crypto";
import { dbConstraintOf, SQLSTATE_CODES } from "../db/errors";
import { DB_CONSTRAINT } from "../db/constants";
import type { SqlExecutor, TxRunner } from "../db/sql";
import {
  BINDING_COOKIE,
  IDENTITY_SESSION_COOKIE,
  isValidBindingValue,
  isValidToken,
  readCookie,
  serializeHostCookie,
  serializeHostCookieDeletion,
} from "../lib/cookies";
import { sha256Hex } from "../lib/crypto/hmac";
import { decryptPii } from "../lib/crypto/pii";
import { assertCsrf } from "../lib/csrf";
import { AppError, toErrorResponse } from "../lib/errors";
import type { Keyring, SecurityConfig } from "../lib/secrets";
import { MINUTE_MS, POLICY } from "../lib/clock";

/** D-015 (확정): BOOKING fixed 30 minutes. A-052 (확정): LOOKUP fixed 10 minutes. No sliding for either. */
export const SESSION_TTL_MS = { BOOKING: POLICY.bookingSessionMs, LOOKUP: 10 * MINUTE_MS } as const;
/** A-052: a lost claim response can be recovered for 5 minutes after the first claim (session created_at, DB time). */
export const RECOVERY_WINDOW_MS = 5 * MINUTE_MS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionDeps {
  security: () => SecurityConfig;
  piiKeys: () => Keyring;
  tx: TxRunner;
  random?: (n: number) => Buffer;
}

const NO_STORE = { "Cache-Control": "no-store" };
function json(body: unknown, status: number, cookie?: string): Response {
  const h = new Headers(NO_STORE);
  if (cookie) h.append("Set-Cookie", cookie);
  return Response.json(body, { status, headers: h });
}
function fail(e: unknown, scope: string, cookie?: string): Response {
  if (!(e instanceof AppError)) console.error(`[${scope}] failed:`, e instanceof Error ? e.name : typeof e);
  const { status, body } = toErrorResponse(e);
  return json(body, status, cookie);
}

/** "홍*동" style mask: first and last character kept (one character → "*"). */
export function maskName(name: string): string {
  const chars = [...name];
  if (chars.length <= 1) return "*";
  if (chars.length === 2) return chars[0] + "*";
  return chars[0] + "*".repeat(chars.length - 2) + chars[chars.length - 1];
}

function displayName(keys: Keyring, stored: string | null): string | null {
  if (!stored) return null; // erased (A-048)
  try {
    return maskName(decryptPii(keys, "identity_verifications.verified_name", stored));
  } catch {
    return null;
  }
}

const verificationFailed = () => new AppError("IDENTITY_VERIFICATION_FAILED", "본인인증을 확인할 수 없습니다. 다시 인증해 주세요.");
const bindingMismatch = () => new AppError("BROWSER_BINDING_MISMATCH", "인증을 시작한 브라우저에서만 진행할 수 있습니다.");

/**
 * Maps a DB constraint error of the claim transaction (statement or COMMIT time) to a domain error.
 * Measured (2026-11-27, @prisma/adapter-pg 7.10.1): a COMMIT-time error raised by the A-040 constraint triggers carries
 * `originalCode` 23514 but NO constraint name. Inside the claim transaction every 23514 can only come from the claim
 * rules (A-040 triggers), so a 23514 with a missing name is mapped too; a 23514 naming some OTHER constraint is not.
 */
export function mapClaimDbError(e: unknown): AppError | null {
  const c = dbConstraintOf(e);
  if (!c) return null;
  const claimChecks: (string | null)[] = [DB_CONSTRAINT.sessionNeedsConsumedVerification, DB_CONSTRAINT.consumedVerificationNeedsSession, null];
  const claimUniques: (string | null)[] = [DB_CONSTRAINT.sessionPerVerificationUnique, DB_CONSTRAINT.activeSessionPerBindingUnique, null];
  if (c.sqlState === SQLSTATE_CODES.foreignKeyViolation && c.constraint === DB_CONSTRAINT.identitySessionVerificationFk) return bindingMismatch();
  if (c.sqlState === SQLSTATE_CODES.checkViolation && claimChecks.includes(c.constraint)) return verificationFailed();
  if (c.sqlState === SQLSTATE_CODES.uniqueViolation && claimUniques.includes(c.constraint)) return verificationFailed();
  return null;
}

async function readEmptyBody(request: Request): Promise<void> {
  const text = await request.text();
  if (text.trim() === "") return;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AppError("VALIDATION_FAILED", "요청 형식이 올바르지 않습니다.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0)
    throw new AppError("VALIDATION_FAILED", "요청 형식이 올바르지 않습니다.");
}

function requireBinding(request: Request): string {
  const b = readCookie(request.headers.get("cookie"), BINDING_COOKIE);
  if (!isValidBindingValue(b ?? undefined))
    throw new AppError("BROWSER_BINDING_REQUIRED", "브라우저 확인이 필요합니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.");
  return b!;
}

interface ClaimRow {
  id: string;
  status: string;
  purpose: "BOOKING" | "LOOKUP";
  browser_binding_hash: string;
  identity_subject_id: string | null;
  verified_name: string | null;
  claim_open: boolean;
}

export async function handleClaim(request: Request, params: { id: string }, deps: SessionDeps): Promise<Response> {
  try {
    if (!UUID.test(params.id)) throw new AppError("VALIDATION_FAILED", "요청 형식이 올바르지 않습니다.", { field: "id" });
    await readEmptyBody(request);
    const security = deps.security();
    const binding = requireBinding(request);
    assertCsrf(request.headers, security.appOrigin, security.csrfKeys, binding);
    const piiKeys = deps.piiKeys();
    const bindingHash = sha256Hex(binding);
    const token = (deps.random ?? randomBytes)(32).toString("base64url");
    const tokenHash = sha256Hex(token);

    let result: { purpose: string; expiresAtMs: number; nowMs: number; name: string | null };
    try {
      result = await deps.tx(async (tx: SqlExecutor) => {
        const rows = await tx<ClaimRow>(
          `SELECT "id", "status", "purpose", "browser_binding_hash", "identity_subject_id", "verified_name",
                  ("claim_expires_at" IS NOT NULL AND now() < "claim_expires_at") AS "claim_open"
             FROM "identity_verifications" WHERE "id" = $1::uuid FOR UPDATE`,
          [params.id],
        );
        const v = rows[0];
        if (!v) throw new AppError("NOT_FOUND", "인증 정보를 찾을 수 없습니다.");
        if (v.browser_binding_hash !== bindingHash) throw bindingMismatch();
        await tx(`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtextextended($1, 0))`, [`identity_claim:${bindingHash}:${v.purpose}`]);

        if (v.status === "VERIFIED" && v.claim_open) {
          await tx(
            `UPDATE "identity_sessions" SET "status" = 'REVOKED', "revoked_at" = now(), "updated_at" = now()
              WHERE "browser_binding_hash" = $1 AND "purpose" = $2 AND "status" = 'ACTIVE'`,
            [bindingHash, v.purpose],
          );
          await tx(`UPDATE "identity_verifications" SET "status" = 'CONSUMED', "updated_at" = now() WHERE "id" = $1::uuid AND "status" = 'VERIFIED'`, [v.id]);
          const s = await tx<{ expiresAtMs: unknown; nowMs: unknown }>(
            `INSERT INTO "identity_sessions" ("identity_verification_id", "identity_subject_id", "purpose", "token_hash", "browser_binding_hash", "status", "expires_at")
             VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'ACTIVE', now() + $6::int * interval '1 millisecond')
             RETURNING floor(extract(epoch FROM "expires_at") * 1000)::bigint AS "expiresAtMs", floor(extract(epoch FROM now()) * 1000)::bigint AS "nowMs"`,
            [v.id, v.identity_subject_id, v.purpose, tokenHash, bindingHash, SESSION_TTL_MS[v.purpose]],
          );
          return { purpose: v.purpose, expiresAtMs: Number(s[0].expiresAtMs), nowMs: Number(s[0].nowMs), name: v.verified_name };
        }

        if (v.status === "CONSUMED") {
          // response-loss recovery: rotate the token of the never-used session of THIS claim (A-052)
          const s = await tx<{ expiresAtMs: unknown; nowMs: unknown }>(
            `UPDATE "identity_sessions" SET "token_hash" = $3, "updated_at" = now()
              WHERE "identity_verification_id" = $1::uuid AND "browser_binding_hash" = $2 AND "status" = 'ACTIVE'
                AND "expires_at" > now() AND "last_used_at" IS NULL
                AND now() < "created_at" + $4::int * interval '1 millisecond'
              RETURNING floor(extract(epoch FROM "expires_at") * 1000)::bigint AS "expiresAtMs", floor(extract(epoch FROM now()) * 1000)::bigint AS "nowMs"`,
            [v.id, bindingHash, tokenHash, RECOVERY_WINDOW_MS],
          );
          if (s.length === 1) return { purpose: v.purpose, expiresAtMs: Number(s[0].expiresAtMs), nowMs: Number(s[0].nowMs), name: v.verified_name };
        }
        throw verificationFailed();
      });
    } catch (e) {
      const mapped = mapClaimDbError(e);
      if (mapped) {
        console.error("[identity-claim] constraint:", dbConstraintOf(e)?.constraint ?? "unknown");
        throw mapped;
      }
      throw e;
    }
    const maxAge = Math.max(1, Math.floor((result.expiresAtMs - result.nowMs) / 1000));
    return json(
      { purpose: result.purpose, expiresAt: new Date(result.expiresAtMs).toISOString(), displayName: displayName(piiKeys, result.name) },
      200,
      serializeHostCookie(IDENTITY_SESSION_COOKIE, token, maxAge),
    );
  } catch (e) {
    return fail(e, "identity-claim");
  }
}

interface SessionRow {
  id: string;
  purpose: string;
  expiresAtMs: unknown;
  verified_name: string | null;
}

function sessionCookies(request: Request): { tokenHash: string; bindingHash: string } | null {
  const cookie = request.headers.get("cookie");
  const token = readCookie(cookie, IDENTITY_SESSION_COOKIE);
  const binding = readCookie(cookie, BINDING_COOKIE);
  if (!isValidToken(token) || !isValidBindingValue(binding ?? undefined)) return null;
  return { tokenHash: sha256Hex(token), bindingHash: sha256Hex(binding!) };
}

const sessionRequired = () => new AppError("IDENTITY_SESSION_REQUIRED", "본인인증이 필요합니다.");

export async function handleGetSession(request: Request, deps: SessionDeps): Promise<Response> {
  try {
    const c = sessionCookies(request);
    if (!c) throw sessionRequired();
    const piiKeys = deps.piiKeys();
    const rows = await deps.tx((tx) =>
      tx<SessionRow & { binding_ok: boolean }>(
        `UPDATE "identity_sessions" s SET "last_used_at" = now()
           FROM "identity_verifications" v
          WHERE s."token_hash" = $1 AND s."status" = 'ACTIVE' AND s."expires_at" > now()
            AND s."browser_binding_hash" = $2 AND v."id" = s."identity_verification_id"
          RETURNING s."id", s."purpose", floor(extract(epoch FROM s."expires_at") * 1000)::bigint AS "expiresAtMs", v."verified_name"`,
        [c.tokenHash, c.bindingHash],
      ),
    );
    if (rows.length !== 1) {
      // distinguish a copied cookie (token valid, other browser) for the error code only; nothing else is revealed
      const other = await deps.tx((tx) =>
        tx<{ n: number }>(`SELECT count(*)::int AS "n" FROM "identity_sessions" WHERE "token_hash" = $1 AND "status" = 'ACTIVE' AND "expires_at" > now()`, [c.tokenHash]),
      );
      if (Number(other[0]?.n) > 0) throw bindingMismatch();
      throw sessionRequired();
    }
    const r = rows[0];
    return json({ purpose: r.purpose, expiresAt: new Date(Number(r.expiresAtMs)).toISOString(), displayName: displayName(piiKeys, r.verified_name) }, 200);
  } catch (e) {
    return fail(e, "identity-session");
  }
}

export async function handleDeleteSession(request: Request, deps: SessionDeps): Promise<Response> {
  const clear = serializeHostCookieDeletion(IDENTITY_SESSION_COOKIE);
  try {
    const security = deps.security();
    const binding = requireBinding(request);
    assertCsrf(request.headers, security.appOrigin, security.csrfKeys, binding);
    const token = readCookie(request.headers.get("cookie"), IDENTITY_SESSION_COOKIE);
    if (isValidToken(token)) {
      await deps.tx((tx) =>
        tx(
          `UPDATE "identity_sessions" SET "status" = 'REVOKED', "revoked_at" = now(), "updated_at" = now()
            WHERE "token_hash" = $1 AND "browser_binding_hash" = $2 AND "status" = 'ACTIVE'`,
          [sha256Hex(token), sha256Hex(binding)],
        ),
      );
    }
    const h = new Headers(NO_STORE);
    h.append("Set-Cookie", clear);
    return new Response(null, { status: 204, headers: h });
  } catch (e) {
    // CSRF/binding failures do not revoke anything, and do not clear the cookie either (a cross-site request must not log out)
    return fail(e, "identity-session");
  }
}
