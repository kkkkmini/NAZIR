/**
 * POST /api/v1/orders (API_SPEC §4.4). HTTP layer over createOrder (./create-order.ts).
 *
 * Checks before any database work, in this order (each failure writes nothing and consumes no rate limit):
 *   1. browser binding cookie                     → 401 BROWSER_BINDING_REQUIRED
 *   2. Origin + CSRF token (bound to the binding) → 403 CSRF_REJECTED
 *   3. identity session cookie present            → 401 IDENTITY_SESSION_REQUIRED
 *   4. Idempotency-Key                            → 400 IDEMPOTENCY_KEY_INVALID
 *   5. JSON body {sessionId, sessionSeatIds}      → 400 VALIDATION_FAILED (canonicalised: seat order irrelevant)
 * then createOrder's single transaction (session, idempotency, rate limits, sales, quota, seats, writes).
 *
 * 201 + the order body + `Set-Cookie: __Host-nz_oa_<id>` (the order access session; also renewed on an exact replay
 * from the same browser). 429/503 carry `Retry-After` when the error states one (ORDER_CREATION_LIMITED,
 * DATABASE_BUSY). Responses are `no-store`. Nothing internal (SQL, constraint names, tokens, personal data) is returned
 * or logged; an unexpected error is a generic 500 and only its class name is logged.
 */
import { BINDING_COOKIE, IDENTITY_SESSION_COOKIE, isValidBindingValue, isValidToken, readCookie, serializeHostCookie } from "../lib/cookies";
import { sha256Hex } from "../lib/crypto/hmac";
import { assertCsrf } from "../lib/csrf";
import { AppError, retryAfterHeader, toErrorResponse } from "../lib/errors";
import type { SecurityConfig } from "../lib/secrets";
import { createOrder, parseCreateOrderBody, type CreateOrderDeps } from "./create-order";
import { idempotencyKeyHash, parseIdempotencyKey } from "./idempotency";

export const MAX_ORDER_BODY_BYTES = 4096;

export interface OrderRouteDeps {
  security: () => SecurityConfig;
  /** Throws on a configuration problem; a rate-limit configuration failure must surface as RateLimitConfigUnavailable. */
  order: () => CreateOrderDeps;
}

/** Thrown by `order()` when the rate-limit configuration is unusable: fail closed with 503 RATE_LIMIT_UNAVAILABLE. */
export class RateLimitConfigUnavailable extends Error {
  constructor() {
    super("rate limit configuration unavailable");
    this.name = "RateLimitConfigUnavailable";
  }
}

function respond(body: unknown, status: number, headers: Record<string, string> = {}, cookie?: string): Response {
  const h = new Headers({ "Cache-Control": "no-store", ...headers });
  if (cookie) h.append("Set-Cookie", cookie);
  return Response.json(body, { status, headers: h });
}

function fail(e: unknown): Response {
  if (e instanceof RateLimitConfigUnavailable) {
    console.error("[order-create] rate limit configuration unavailable");
    e = new AppError("RATE_LIMIT_UNAVAILABLE", "일시적으로 요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.");
  } else if (!(e instanceof AppError)) {
    console.error("[order-create] failed:", e instanceof Error ? e.name : typeof e);
  }
  const { status, body } = toErrorResponse(e);
  return respond(body, status, retryAfterHeader(e));
}

async function readJson(request: Request): Promise<unknown> {
  const invalid = () => new AppError("VALIDATION_FAILED", "요청 형식이 올바르지 않습니다.");
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw invalid();
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_ORDER_BODY_BYTES) throw invalid();
  try {
    return JSON.parse(text);
  } catch {
    throw invalid();
  }
}

export async function handleCreateOrder(request: Request, deps: OrderRouteDeps): Promise<Response> {
  try {
    const cookies = request.headers.get("cookie");
    const binding = readCookie(cookies, BINDING_COOKIE);
    if (!isValidBindingValue(binding ?? undefined))
      throw new AppError("BROWSER_BINDING_REQUIRED", "브라우저 확인이 필요합니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.");
    const security = deps.security();
    assertCsrf(request.headers, security.appOrigin, security.csrfKeys, binding);
    const token = readCookie(cookies, IDENTITY_SESSION_COOKIE);
    if (!isValidToken(token)) throw new AppError("IDENTITY_SESSION_REQUIRED", "본인인증이 필요합니다.");
    const key = parseIdempotencyKey(request.headers.get("idempotency-key"));
    const body = parseCreateOrderBody(await readJson(request));

    const result = await createOrder(deps.order(), {
      sessionTokenHash: sha256Hex(token),
      bindingHash: sha256Hex(binding!),
      idempotencyKeyHash: idempotencyKeyHash(key),
      request: body,
    });
    const cookie = result.access ? serializeHostCookie(result.access.cookieName, result.access.token, result.access.maxAgeSeconds) : undefined;
    return respond(result.body, result.status, {}, cookie);
  } catch (e) {
    return fail(e);
  }
}
