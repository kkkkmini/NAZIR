/**
 * POST /api/v1/orders/{orderId}/cancel (API_SPEC §4.5, DATABASE §11.5). Before any database work:
 * binding cookie (401) → Origin + CSRF (403) → identity session cookie (401) → orderId format (400) → empty body or {}
 * (400). Then cancelOrder's single transaction (BOOKING session of this browser, owner check, quota → order → payments
 * → holds). Idempotent: cancelling a CANCELED / EXPIRED order answers 200 with that state.
 * 200 `{orderId, orderNumber, status}` (status CANCELED, or EXPIRED when the hold had already run out). Changing seats
 * = cancel, then a NEW POST /orders with a NEW Idempotency-Key (D-001): a failed rebooking never restores the old order.
 */
import { BINDING_COOKIE, IDENTITY_SESSION_COOKIE, isValidBindingValue, isValidToken, readCookie } from "../lib/cookies";
import { sha256Hex } from "../lib/crypto/hmac";
import { assertCsrf } from "../lib/csrf";
import { AppError, retryAfterHeader, toErrorResponse } from "../lib/errors";
import type { SecurityConfig } from "../lib/secrets";
import { cancelOrder } from "./order-lifecycle";
import type { BookingTxDeps } from "./tx";

export interface CancelRouteDeps {
  security: () => SecurityConfig;
  tx: () => BookingTxDeps;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function respond(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

async function readEmptyBody(request: Request): Promise<void> {
  const text = await request.text();
  if (text.trim() === "" || text.trim() === "{}") return;
  throw new AppError("VALIDATION_FAILED", "요청 형식이 올바르지 않습니다.");
}

export async function handleCancelOrder(request: Request, params: { orderId: string }, deps: CancelRouteDeps): Promise<Response> {
  try {
    const cookies = request.headers.get("cookie");
    const binding = readCookie(cookies, BINDING_COOKIE);
    if (!isValidBindingValue(binding ?? undefined))
      throw new AppError("BROWSER_BINDING_REQUIRED", "브라우저 확인이 필요합니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.");
    const security = deps.security();
    assertCsrf(request.headers, security.appOrigin, security.csrfKeys, binding);
    const token = readCookie(cookies, IDENTITY_SESSION_COOKIE);
    if (!isValidToken(token)) throw new AppError("IDENTITY_SESSION_REQUIRED", "본인인증이 필요합니다.");
    if (!UUID.test(params.orderId)) throw new AppError("VALIDATION_FAILED", "요청 형식이 올바르지 않습니다.", { field: "orderId" });
    await readEmptyBody(request);
    const result = await cancelOrder(deps.tx(), params.orderId.toLowerCase(), { tokenHash: sha256Hex(token), bindingHash: sha256Hex(binding!) });
    return respond(result, 200);
  } catch (e) {
    if (!(e instanceof AppError)) console.error("[order-cancel] failed:", e instanceof Error ? e.name : typeof e);
    const { status, body } = toErrorResponse(e);
    return respond(body, status, retryAfterHeader(e));
  }
}
