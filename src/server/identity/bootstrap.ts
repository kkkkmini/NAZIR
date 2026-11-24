/**
 * GET /api/v1/bootstrap (API_SPEC §4.1): issues the browser binding cookie when the request has no valid one and
 * returns the CSRF token bound to it. No database access: the binding value is stored nowhere; later identity rows
 * store only its SHA-256 (`browser_binding_hash`).
 * - Valid existing cookie: reused, NOT re-set (30-day lifetime is never extended).
 * - Missing, malformed or duplicated cookie: a fresh value is issued.
 * - Security config missing/invalid: 500 INTERNAL_ERROR, no cookie, no token (fail-closed).
 */
import { BINDING_COOKIE, BINDING_MAX_AGE_SECONDS, isValidBindingValue, newBindingValue, readCookie, serializeHostCookie } from "../lib/cookies";
import { issueCsrfToken } from "../lib/csrf";
import { toErrorResponse } from "../lib/errors";
import type { SecurityConfig } from "../lib/secrets";

export interface BootstrapDeps {
  security: () => SecurityConfig;
  random?: (n: number) => Buffer;
}

const NO_STORE = "no-store";

export function handleBootstrap(request: Request, deps: BootstrapDeps): Response {
  let security: SecurityConfig;
  try {
    security = deps.security();
  } catch (e) {
    console.error("[bootstrap] security configuration unavailable:", e instanceof Error ? e.name : typeof e);
    const { status, body } = toErrorResponse(e);
    return Response.json(body, { status, headers: { "Cache-Control": NO_STORE } });
  }
  const headers = new Headers({ "Cache-Control": NO_STORE });
  let binding = readCookie(request.headers.get("cookie"), BINDING_COOKIE);
  if (!isValidBindingValue(binding ?? undefined)) {
    binding = newBindingValue(deps.random);
    headers.append("Set-Cookie", serializeHostCookie(BINDING_COOKIE, binding, BINDING_MAX_AGE_SECONDS));
  }
  return Response.json({ csrfToken: issueCsrfToken(security.csrfKeys, binding!) }, { status: 200, headers });
}
