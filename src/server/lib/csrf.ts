/**
 * CSRF for cookie-authenticated state-changing requests (API_SPEC §3.3, A-044).
 * (1) Origin must equal NAZIR_APP_ORIGIN exactly; a missing or "null" Origin is refused.
 *     Sec-Fetch-Site, when the browser sends it, must be "same-origin" (extra defence, never a substitute).
 * (2) X-CSRF-Token must be the stateless HMAC of the browser binding value under the CSRF keyring.
 * Not for the identity/payment provider return endpoints: those use single-use transaction state (§3.4).
 */
import { AppError } from "./errors";
import { signVersioned, verifyVersioned } from "./crypto/hmac";
import type { Keyring } from "./secrets";

export const CSRF_HEADER = "x-csrf-token";
const PURPOSE = "csrf";

export function issueCsrfToken(ring: Keyring, bindingValue: string): string {
  return signVersioned(ring, PURPOSE, bindingValue);
}

export function verifyCsrfToken(ring: Keyring, bindingValue: string, token: unknown): boolean {
  return verifyVersioned(ring, PURPOSE, bindingValue, token);
}

const rejected = () => new AppError("CSRF_REJECTED", "요청을 확인할 수 없습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.");

export function assertAllowedOrigin(headers: Headers, appOrigin: string): void {
  const origin = headers.get("origin");
  if (!origin || origin === "null" || origin !== appOrigin) throw rejected();
  const site = headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") throw rejected();
}

/** Full check for a state-changing request. `bindingValue` is the request's valid binding cookie, or null. */
export function assertCsrf(headers: Headers, appOrigin: string, ring: Keyring, bindingValue: string | null): void {
  assertAllowedOrigin(headers, appOrigin);
  if (!bindingValue || !verifyCsrfToken(ring, bindingValue, headers.get(CSRF_HEADER))) throw rejected();
}
