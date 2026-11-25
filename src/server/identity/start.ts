/**
 * POST /api/v1/identity-verifications — start an identity verification (API_SPEC §4.2, A-049).
 *
 * Order of checks (each stops the request):
 *   1. body: JSON object with exactly { purpose: "BOOKING" | "LOOKUP" }      → 400 VALIDATION_FAILED
 *      (any other field — e.g. a returnUrl — is refused: the callback URL is decided by the server, §3.4)
 *   2. browser binding cookie present and well-formed                       → 401 BROWSER_BINDING_REQUIRED
 *   3. Origin == NAZIR_APP_ORIGIN, Sec-Fetch-Site, X-CSRF-Token             → 403 CSRF_REJECTED
 *   4. rate limit identity.start.ip (IPv4 /32, IPv6 /64)                    → 429 RATE_LIMITED + Retry-After
 *   5. rate limit identity.start.binding (only when 4 passed)               → 429 RATE_LIMITED + Retry-After
 *      store/config/trusted-IP failure                                       → 503 RATE_LIMIT_UNAVAILABLE
 *   6. Tx1: lock (binding, purpose); a start still waiting for the provider   → 409 REQUEST_IN_PROGRESS
 *           older PENDING of the same binding+purpose → EXPIRED (SUPERSEDED); INSERT PENDING with
 *           state hash, binding hash, expires_at = DB now() + TTL
 *   7. provider.startVerification — OUTSIDE any transaction                  → 503 PROVIDER_UNAVAILABLE / 502 IDENTITY_START_FAILED
 *      (the PENDING row is marked FAILED with a code, its context cleared)
 *   8. Tx2: store provider transaction id + encrypted context (only if still PENDING and unset)
 * Response 200 { verificationId, purpose, expiresAt, launch: { type, url } }, always Cache-Control: no-store.
 * Nothing secret is logged: only error class names and codes.
 */
import { randomBytes } from "node:crypto";
import type { TxRunner } from "../db/sql";
import { BINDING_COOKIE, isValidBindingValue, readCookie } from "../lib/cookies";
import { sha256Hex } from "../lib/crypto/hmac";
import { sealProviderContext } from "../lib/crypto/provider-context";
import { assertCsrf } from "../lib/csrf";
import { AppError, toErrorResponse } from "../lib/errors";
import type { Keyring, SecurityConfig } from "../lib/secrets";
import { ClientIpUnavailableError, resolveClientIp, type ClientIpSource } from "../rate-limit/client-ip";
import type { RateLimiter } from "../rate-limit/service";
import {
  ProviderRejectedError,
  type IdentityProvider,
  type StartVerificationResult,
  type VerificationPurpose,
} from "./providers/types";

/** PROVIDERS §2.2 (원문): NICE transaction_id / auth URL are valid for 10 minutes. The server never allows longer. */
export const IDENTITY_START_TTL_MS = 10 * 60_000;
/** A PENDING start whose provider call has not come back within this time no longer blocks a new start. */
export const START_IN_FLIGHT_MS = 30_000;
const PURPOSES: readonly VerificationPurpose[] = ["BOOKING", "LOOKUP"];
const TXN_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

export interface StartDeps {
  security: () => SecurityConfig;
  rateLimit: () => { limiter: RateLimiter; ipSource: ClientIpSource };
  provider: () => IdentityProvider;
  contextKeys: () => Keyring;
  tx: TxRunner;
  random?: (n: number) => Buffer;
}

function respond(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...extra } });
}

function fail(e: unknown): Response {
  if (!(e instanceof AppError)) console.error("[identity-start] failed:", e instanceof Error ? e.name : typeof e);
  const { status, body } = toErrorResponse(e);
  const extra: Record<string, string> = {};
  if (e instanceof AppError && e.code === "RATE_LIMITED" && typeof e.details.retryAfterSeconds === "number")
    extra["Retry-After"] = String(e.details.retryAfterSeconds);
  return respond(body, status, extra);
}

async function parseBody(request: Request): Promise<VerificationPurpose> {
  const invalid = () => new AppError("VALIDATION_FAILED", "요청 형식이 올바르지 않습니다.");
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw invalid();
  const text = await request.text();
  if (text.length > 1024) throw invalid();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  const keys = Object.keys(body);
  const purpose = (body as { purpose?: unknown }).purpose;
  if (keys.length !== 1 || keys[0] !== "purpose" || !PURPOSES.includes(purpose as VerificationPurpose))
    throw new AppError("VALIDATION_FAILED", "요청 형식이 올바르지 않습니다.", { field: keys.find((k) => k !== "purpose") ?? "purpose" });
  return purpose as VerificationPurpose;
}

/** Validates what an adapter returned before anything is stored or sent to the browser. */
function checkProviderResult(r: StartVerificationResult, provider: IdentityProvider, appOrigin: string): void {
  if (!r || typeof r.providerTransactionId !== "string" || !TXN_ID.test(r.providerTransactionId))
    throw new ProviderRejectedError("bad_transaction_id");
  let url: URL;
  try {
    url = new URL(r.launch?.url);
  } catch {
    throw new ProviderRejectedError("bad_launch_url");
  }
  const sameOrigin = url.origin === appOrigin;
  // MOCK may only send the browser to our own origin; a real provider only to an https URL off our origin.
  if (r.launch.type !== "redirect" || (provider.name === "MOCK" ? !sameOrigin : url.protocol !== "https:"))
    throw new ProviderRejectedError("bad_launch_url");
  if (r.validForMs !== null && (!Number.isSafeInteger(r.validForMs) || r.validForMs <= 0)) throw new ProviderRejectedError("bad_validity");
}

export async function handleStartVerification(request: Request, deps: StartDeps): Promise<Response> {
  try {
    // 1
    const purpose = await parseBody(request);
    // 2
    const security = deps.security();
    const binding = readCookie(request.headers.get("cookie"), BINDING_COOKIE);
    if (!isValidBindingValue(binding ?? undefined))
      throw new AppError("BROWSER_BINDING_REQUIRED", "브라우저 확인이 필요합니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.");
    // 3
    assertCsrf(request.headers, security.appOrigin, security.csrfKeys, binding);
    // 4, 5
    let rl: { limiter: RateLimiter; ipSource: ClientIpSource };
    let ip: string;
    try {
      rl = deps.rateLimit();
      ip = resolveClientIp(request.headers, rl.ipSource);
    } catch (e) {
      console.error("[identity-start] rate limit unavailable:", e instanceof ClientIpUnavailableError ? "no_trusted_ip" : e instanceof Error ? e.name : typeof e);
      throw new AppError("RATE_LIMIT_UNAVAILABLE", "일시적으로 요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.");
    }
    await rl.limiter.enforce("identity.start.ip", [["ip", ip]]);
    await rl.limiter.enforce("identity.start.binding", [["binding", binding!]]);

    let provider: IdentityProvider;
    try {
      provider = deps.provider(); // refuses MOCK outside local/test (A-049) even if the startup guard was bypassed
    } catch (e) {
      console.error("[identity-start] provider not available:", e instanceof Error ? e.name : typeof e);
      throw new AppError("PROVIDER_UNAVAILABLE", "본인인증 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.");
    }
    const contextKeys = deps.contextKeys();
    const bindingHash = sha256Hex(binding!);
    const state = (deps.random ?? randomBytes)(32).toString("base64url");
    const stateHash = sha256Hex(state);
    const returnUrl = new URL(`/api/v1/identity-verifications/callback/${provider.name.toLowerCase()}`, security.appOrigin);
    returnUrl.searchParams.set("state", state);

    // 6
    const pending = await deps.tx(async (tx) => {
      await tx(`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtextextended($1, 0))` /* not the void value itself: Prisma cannot decode a void column */, [`identity_start:${bindingHash}:${purpose}`]);
      const open = await tx<{ id: string; in_flight: boolean }>(
        `SELECT "id", ("provider_transaction_id" IS NULL AND "created_at" > now() - $3::int * interval '1 millisecond') AS in_flight
           FROM "identity_verifications"
          WHERE "browser_binding_hash" = $1 AND "purpose" = $2 AND "status" = 'PENDING' FOR UPDATE`,
        [bindingHash, purpose, START_IN_FLIGHT_MS],
      );
      if (open.some((r) => r.in_flight))
        throw new AppError("REQUEST_IN_PROGRESS", "본인인증 요청을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.");
      if (open.length > 0)
        await tx(
          `UPDATE "identity_verifications" SET "status" = 'EXPIRED', "failure_code" = 'SUPERSEDED',
                  "provider_context_encrypted" = NULL, "updated_at" = now()
            WHERE "id" = ANY($1::uuid[])`,
          [open.map((r) => r.id)],
        );
      const rows = await tx<{ id: string; expiresAtMs: unknown }>(
        `INSERT INTO "identity_verifications" ("purpose", "provider", "browser_binding_hash", "state_nonce_hash", "status", "expires_at")
         VALUES ($1, $2, $3, $4, 'PENDING', now() + $5::int * interval '1 millisecond')
         RETURNING "id", floor(extract(epoch FROM "expires_at") * 1000)::bigint AS "expiresAtMs"`,
        [purpose, provider.name, bindingHash, stateHash, IDENTITY_START_TTL_MS],
      );
      return { id: rows[0].id, expiresAtMs: Number(rows[0].expiresAtMs) };
    });

    // 7
    let result: StartVerificationResult;
    try {
      result = await provider.startVerification({ verificationId: pending.id, purpose, returnUrl: returnUrl.toString() });
      checkProviderResult(result, provider, security.appOrigin);
    } catch (e) {
      const unavailable = !(e instanceof ProviderRejectedError); // anything unexpected counts as unavailable
      const code = unavailable ? "PROVIDER_UNAVAILABLE" : "PROVIDER_REJECTED";
      console.error("[identity-start] provider failed:", code, e instanceof Error ? e.name : typeof e);
      await deps
        .tx((tx) =>
          tx(
            `UPDATE "identity_verifications" SET "status" = 'FAILED', "failure_code" = $2, "provider_context_encrypted" = NULL, "updated_at" = now()
              WHERE "id" = $1::uuid AND "status" = 'PENDING'`,
            [pending.id, code],
          ),
        )
        .catch((err) => console.error("[identity-start] could not mark start failed:", err instanceof Error ? err.name : typeof err));
      if (unavailable)
        throw new AppError("PROVIDER_UNAVAILABLE", "본인인증 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.");
      throw new AppError("IDENTITY_START_FAILED", "본인인증을 시작할 수 없습니다. 잠시 후 다시 시도해 주세요.");
    }

    // 8
    const sealed = sealProviderContext(contextKeys, pending.id, result.context);
    const validFor = Math.min(IDENTITY_START_TTL_MS, result.validForMs ?? IDENTITY_START_TTL_MS);
    const stored = await deps.tx((tx) =>
      tx<{ expiresAtMs: unknown }>(
        `UPDATE "identity_verifications"
            SET "provider_transaction_id" = $2, "provider_context_encrypted" = $3,
                "expires_at" = least("expires_at", "created_at" + $4::int * interval '1 millisecond'), "updated_at" = now()
          WHERE "id" = $1::uuid AND "status" = 'PENDING' AND "provider_transaction_id" IS NULL AND "expires_at" > now()
          RETURNING floor(extract(epoch FROM "expires_at") * 1000)::bigint AS "expiresAtMs"`,
        [pending.id, result.providerTransactionId, sealed, validFor],
      ),
    );
    if (stored.length !== 1)
      throw new AppError("REQUEST_IN_PROGRESS", "본인인증 요청이 다른 요청으로 대체되었습니다. 다시 시도해 주세요.");

    return respond(
      {
        verificationId: pending.id,
        purpose,
        expiresAt: new Date(Number(stored[0].expiresAtMs)).toISOString(),
        launch: { type: result.launch.type, url: result.launch.url },
      },
      200,
    );
  } catch (e) {
    return fail(e);
  }
}
