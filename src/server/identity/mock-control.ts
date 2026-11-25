/**
 * Mock provider control (local/test ONLY, A-050, PRV-05). Plays the provider's side of a verification:
 *  - `loadMockTransaction` backs the /identity/mock page: a PENDING, unexpired MOCK verification with this txn id.
 *  - `handleMockComplete` (POST /api/v1/mock/identity/complete, form) records the chosen outcome once, with the hash of a
 *    fresh 256-bit result token, then 303s the browser to the callback URL that the SERVER stored at start
 *    (never a URL from the request), adding `mock_result=<token>`.
 * Both refuse to run outside local/test (the caller passes the runtime flag) — the routes answer 404 there.
 */
import { createHash, randomBytes } from "node:crypto";
import type { TxRunner } from "../db/sql";
import { openProviderContext, sealProviderContext } from "../lib/crypto/provider-context";
import { assertAllowedOrigin } from "../lib/csrf";
import { AppError } from "../lib/errors";
import type { Keyring } from "../lib/secrets";
import { MOCK_TXN } from "./providers/mock";
import { isMockOutcome } from "./providers/mock-personas";

export interface MockControlDeps {
  enabled: () => boolean;
  appOrigin: () => string;
  contextKeys: () => Keyring;
  tx: TxRunner;
  random?: (n: number) => Buffer;
}

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const notFound = () => new Response("Not Found", { status: 404, headers: HEADERS });

export async function loadMockTransaction(deps: MockControlDeps, txn: unknown): Promise<{ id: string; purpose: string } | null> {
  if (!deps.enabled() || typeof txn !== "string" || !MOCK_TXN.test(txn)) return null;
  return deps.tx(async (tx) => {
    const rows = await tx<{ id: string; purpose: string; provider_context_encrypted: string | null }>(
      `SELECT "id", "purpose", "provider_context_encrypted" FROM "identity_verifications"
        WHERE "provider" = 'MOCK' AND "provider_transaction_id" = $1 AND "status" = 'PENDING' AND "expires_at" > now()`,
      [txn],
    );
    if (rows.length !== 1 || !rows[0].provider_context_encrypted) return null;
    const ctx = openProviderContext(deps.contextKeys(), rows[0].id, rows[0].provider_context_encrypted);
    return ctx.outcome ? null : { id: rows[0].id, purpose: rows[0].purpose };
  });
}

export async function handleMockComplete(request: Request, deps: MockControlDeps): Promise<Response> {
  if (!deps.enabled()) return notFound();
  const appOrigin = deps.appOrigin();
  try {
    assertAllowedOrigin(request.headers, appOrigin);
  } catch {
    return new Response("Forbidden", { status: 403, headers: HEADERS });
  }
  const form = await request.formData().catch(() => null);
  const txn = form?.get("txn");
  const outcome = form?.get("outcome");
  if (typeof txn !== "string" || !MOCK_TXN.test(txn) || !isMockOutcome(outcome))
    return new Response("Bad Request", { status: 400, headers: HEADERS });

  const token = (deps.random ?? randomBytes)(32).toString("base64url");
  const location = await deps.tx(async (tx) => {
    const rows = await tx<{ id: string; provider_context_encrypted: string | null }>(
      `SELECT "id", "provider_context_encrypted" FROM "identity_verifications"
        WHERE "provider" = 'MOCK' AND "provider_transaction_id" = $1 AND "status" = 'PENDING' AND "expires_at" > now()
        FOR UPDATE`,
      [txn],
    );
    if (rows.length !== 1 || !rows[0].provider_context_encrypted) return null;
    const keys = deps.contextKeys();
    const ctx = openProviderContext(keys, rows[0].id, rows[0].provider_context_encrypted);
    if (ctx.mock !== "1" || ctx.outcome) return null; // one completion per transaction
    const cb = new URL(ctx.returnUrl);
    // only the callback path on our own origin (the value was written by the server at start; checked anyway)
    if (cb.origin !== appOrigin || cb.pathname !== "/api/v1/identity-verifications/callback/mock") throw new AppError("INTERNAL_ERROR", "bad mock context");
    const next = { ...ctx, outcome, resultTokenHash: createHash("sha256").update(token).digest("hex") };
    await tx(`UPDATE "identity_verifications" SET "provider_context_encrypted" = $2, "updated_at" = now() WHERE "id" = $1::uuid`, [
      rows[0].id,
      sealProviderContext(keys, rows[0].id, next),
    ]);
    cb.searchParams.set("mock_result", token);
    return cb.toString();
  });
  if (!location) return new Response("Gone", { status: 410, headers: HEADERS });
  return new Response(null, { status: 303, headers: { ...HEADERS, Location: location } });
}
