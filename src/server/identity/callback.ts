/**
 * GET /api/v1/identity-verifications/callback/{provider} (API_SPEC §3.4, §4.2, A-050).
 *
 * No cookie is read or required (a cross-site return may arrive without SameSite=Lax cookies). The callback never
 * issues a session: it only moves the verification PENDING → VERIFIED | FAILED | EXPIRED; the browser binding hash
 * stored at start is left untouched so the later claim can require the same browser.
 *
 * Steps (all fail closed):
 *   1. path provider ∈ {mock, nice} and equals the configured provider; `state` is 43 base64url chars
 *   2. Tx A (short, row lock): find by SHA-256(state); must be PENDING, not expired (DB now()), same provider.
 *      Expired → EXPIRED (context cleared). Read & decrypt the stored context.
 *   3. provider.completeVerification(context, callback) — OUTSIDE any transaction (DATABASE §13.2)
 *        ProviderRejectedError (integrity) → FAILED 'INTEGRITY_FAILED'
 *        ProviderUnavailableError / unexpected → row stays PENDING (retry possible until expiry)
 *   4. Tx B: lock the row again; still PENDING, not expired, same context version → apply exactly once:
 *        VERIFIED: resolveSubjectInTx(DI) → subject, AES-256-GCM name/phone, verified_at = now(),
 *                  claim_expires_at = now() + CLAIM_WINDOW_MS, context cleared
 *        CANCELED → FAILED 'USER_CANCELED' · FAILED → FAILED 'PROVIDER_FAILED' (context cleared)
 *      Any error inside Tx B rolls the whole transition back (no half-verified row, no orphan subject).
 *   5. 303 to `${appOrigin}/identity/complete?vid=<id>` (or without vid when the state matched nothing).
 *      Never echoes the state; Cache-Control: no-store; Referrer-Policy: no-referrer.
 * A repeated or concurrent callback for an already-processed state changes nothing and gets the same 303.
 */
import type { SqlExecutor, TxRunner } from "../db/sql";
import { sha256Hex } from "../lib/crypto/hmac";
import { encryptPii } from "../lib/crypto/pii";
import { openProviderContext } from "../lib/crypto/provider-context";
import { DiUnavailableError } from "../lib/crypto/subject-key";
import type { Keyring } from "../lib/secrets";
import { MINUTE_MS } from "../lib/clock";
import { resolveSubjectInTx } from "./subjects";
import { ProviderRejectedError, type IdentityProvider, type VerificationOutcome } from "./providers/types";

/** DATABASE §6.2 / DECISIONS §Q (권장 5분): how long a VERIFIED result may be claimed. Recommended value, not confirmed policy. */
export const CLAIM_WINDOW_MS = 5 * MINUTE_MS;
const STATE = /^[A-Za-z0-9_-]{43}$/;
const NAME_MAX = 100;
const PHONE = /^01[0-9]{8,9}$/;

export type CallbackResult =
  | "VERIFIED"
  | "CANCELED"
  | "FAILED"
  | "INTEGRITY_FAILED"
  | "EXPIRED"
  | "ALREADY_PROCESSED"
  | "UNKNOWN_STATE"
  | "PROVIDER_MISMATCH"
  | "PROVIDER_UNAVAILABLE"
  | "INVALID_REQUEST";

export interface CallbackDeps {
  appOrigin: () => string;
  provider: () => IdentityProvider;
  contextKeys: () => Keyring;
  subjectKeys: () => Keyring;
  piiKeys: () => Keyring;
  tx: TxRunner;
}

interface Row {
  id: string;
  provider: string;
  status: string;
  expired: boolean;
  provider_context_encrypted: string | null;
}

function redirect(appOrigin: string, vid: string | null): Response {
  const url = new URL("/identity/complete", appOrigin);
  if (vid) url.searchParams.set("vid", vid);
  return new Response(null, {
    status: 303,
    headers: { Location: url.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

const log = (result: CallbackResult, extra?: string) =>
  // only the result code and an error class name — never the state, ids from the provider, or personal data
  console.info("[identity-callback]", result, ...(extra ? [extra] : []));

async function lockByState(tx: SqlExecutor, stateHash: string): Promise<Row | null> {
  const rows = await tx<Row>(
    `SELECT "id", "provider", "status", ("expires_at" <= now()) AS "expired", "provider_context_encrypted"
       FROM "identity_verifications" WHERE "state_nonce_hash" = $1 FOR UPDATE`,
    [stateHash],
  );
  return rows[0] ?? null;
}

async function finish(tx: SqlExecutor, id: string, status: "FAILED" | "EXPIRED", code: string) {
  await tx(
    `UPDATE "identity_verifications" SET "status" = $2, "failure_code" = $3, "provider_context_encrypted" = NULL, "updated_at" = now()
      WHERE "id" = $1::uuid AND "status" = 'PENDING'`,
    [id, status, code],
  );
}

function normalise(o: VerificationOutcome): VerificationOutcome {
  if (o.kind !== "VERIFIED") return o;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  const phone = typeof o.phone === "string" ? o.phone.replace(/-/g, "") : "";
  if (!name || name.length > NAME_MAX || !PHONE.test(phone)) throw new ProviderRejectedError("bad_identity_fields");
  return { kind: "VERIFIED", di: o.di, name, phone };
}

export async function handleIdentityCallback(
  request: Request,
  params: { provider: string },
  deps: CallbackDeps,
): Promise<{ response: Response; result: CallbackResult }> {
  let appOrigin: string;
  try {
    appOrigin = deps.appOrigin();
  } catch {
    log("INVALID_REQUEST", "no_app_origin");
    return { response: new Response(null, { status: 500, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } }), result: "INVALID_REQUEST" };
  }
  const done = (result: CallbackResult, vid: string | null, extra?: string) => {
    log(result, extra);
    return { response: redirect(appOrigin, vid), result };
  };

  // 1
  const query = new URL(request.url).searchParams;
  const state = query.get("state");
  if (!state || !STATE.test(state) || query.getAll("state").length !== 1) return done("INVALID_REQUEST", null);
  let provider: IdentityProvider;
  try {
    provider = deps.provider();
  } catch (e) {
    return done("PROVIDER_UNAVAILABLE", null, e instanceof Error ? e.name : typeof e);
  }
  if (params.provider !== provider.name.toLowerCase()) return done("PROVIDER_MISMATCH", null);
  const stateHash = sha256Hex(state);

  // 2
  const first = await deps.tx(async (tx) => {
    const row = await lockByState(tx, stateHash);
    if (!row) return { result: "UNKNOWN_STATE" as const, row: null };
    if (row.provider !== provider.name) return { result: "PROVIDER_MISMATCH" as const, row };
    if (row.status !== "PENDING") return { result: "ALREADY_PROCESSED" as const, row };
    if (row.expired) {
      await finish(tx, row.id, "EXPIRED", "EXPIRED_BEFORE_CALLBACK");
      return { result: "EXPIRED" as const, row };
    }
    return { result: null, row };
  });
  if (first.result) return done(first.result, first.result === "UNKNOWN_STATE" || first.result === "PROVIDER_MISMATCH" ? null : first.row!.id);
  const row = first.row!;

  // 3
  let outcome: VerificationOutcome;
  try {
    if (!row.provider_context_encrypted) throw new ProviderRejectedError("no_context");
    const context = openProviderContext(deps.contextKeys(), row.id, row.provider_context_encrypted);
    outcome = normalise(await provider.completeVerification({ context, callback: { query } }));
  } catch (e) {
    if (e instanceof ProviderRejectedError || (e instanceof Error && e.name === "ProviderContextError")) {
      await deps.tx((tx) => finish(tx, row.id, "FAILED", "INTEGRITY_FAILED"));
      return done("INTEGRITY_FAILED", row.id, e.name);
    }
    return done("PROVIDER_UNAVAILABLE", row.id, e instanceof Error ? e.name : typeof e);
  }

  // 4
  try {
    const applied = await deps.tx(async (tx) => {
      const again = await lockByState(tx, stateHash);
      if (!again || again.id !== row.id || again.status !== "PENDING") return "ALREADY_PROCESSED" as const;
      if (again.provider_context_encrypted !== row.provider_context_encrypted) return "ALREADY_PROCESSED" as const;
      if (again.expired) {
        await finish(tx, row.id, "EXPIRED", "EXPIRED_BEFORE_CALLBACK");
        return "EXPIRED" as const;
      }
      if (outcome.kind === "CANCELED") {
        await finish(tx, row.id, "FAILED", "USER_CANCELED");
        return "CANCELED" as const;
      }
      if (outcome.kind === "FAILED") {
        await finish(tx, row.id, "FAILED", "PROVIDER_FAILED");
        return "FAILED" as const;
      }
      const subject = await resolveSubjectInTx(tx, deps.subjectKeys(), outcome.di); // DI only, no fallback
      const pii = deps.piiKeys();
      const updated = await tx(
        `UPDATE "identity_verifications"
            SET "status" = 'VERIFIED', "identity_subject_id" = $2::uuid,
                "verified_name" = $3, "verified_phone" = $4, "verified_at" = now(),
                "claim_expires_at" = now() + $5::int * interval '1 millisecond',
                "provider_context_encrypted" = NULL, "failure_code" = NULL, "updated_at" = now()
          WHERE "id" = $1::uuid AND "status" = 'PENDING'
          RETURNING "id"`,
        [
          row.id,
          subject.id,
          encryptPii(pii, "identity_verifications.verified_name", outcome.name),
          encryptPii(pii, "identity_verifications.verified_phone", outcome.phone),
          CLAIM_WINDOW_MS,
        ],
      );
      if (updated.length !== 1) throw new Error("verification transition lost");
      return "VERIFIED" as const;
    });
    return done(applied, row.id);
  } catch (e) {
    if (e instanceof DiUnavailableError) {
      // A-043: no DI → stop; never fall back to CI or phone
      await deps.tx((tx) => finish(tx, row.id, "FAILED", "DI_UNAVAILABLE"));
      return done("FAILED", row.id, e.name);
    }
    // Tx B rolled back: the row is still PENDING and no subject was created
    return done("PROVIDER_UNAVAILABLE", row.id, e instanceof Error ? e.name : typeof e);
  }
}
