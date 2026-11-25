/**
 * Domain error catalog (API_SPEC.md §2.1). Route handlers convert AppError to the
 * common error body `{ error: { code, message, details } }`.
 */
export const ERROR_STATUS = {
  VALIDATION_FAILED: 400,
  IDEMPOTENCY_KEY_INVALID: 400,
  IDENTITY_SESSION_REQUIRED: 401,
  BROWSER_BINDING_MISMATCH: 401,
  /** No valid browser binding cookie: call GET /bootstrap first (A-049). */
  BROWSER_BINDING_REQUIRED: 401,
  CSRF_REJECTED: 403,
  SESSION_PURPOSE_MISMATCH: 403,
  ORDER_ACCESS_DENIED: 403,
  NOT_FOUND: 404,
  SEAT_UNAVAILABLE: 409,
  ACTIVE_ORDER_EXISTS: 409,
  PAYMENT_IN_PROGRESS: 409,
  INVALID_STATE_TRANSITION: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  REQUEST_IN_PROGRESS: 409,
  PURCHASE_LIMIT_EXCEEDED: 422,
  SALES_NOT_OPEN: 422,
  HOLD_EXPIRED: 422,
  HOLD_TIME_INSUFFICIENT: 422,
  PAYMENT_METHOD_NOT_ALLOWED: 422,
  PAYMENT_METHOD_UNAVAILABLE: 422,
  IDENTITY_VERIFICATION_FAILED: 422,
  IDENTITY_SESSION_TIME_INSUFFICIENT: 422,
  ORDER_CREATION_LIMITED: 429,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  /** The identity provider answered but refused / returned an unusable start response (A-049). */
  IDENTITY_START_FAILED: 502,
  PROVIDER_UNAVAILABLE: 503,
  /** Rate limit store unavailable: fail-closed, distinct from the user's own RATE_LIMITED (A-045). */
  RATE_LIMIT_UNAVAILABLE: 503,
  /**
   * The database could not serve the request in time: pool exhausted / transaction expired (P2028), lock or statement
   * timeout, deadlock retries exhausted, database unreachable (Step 5, review M8). `details.retryAfterSeconds`.
   */
  DATABASE_BUSY: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details: Record<string, unknown> };
}

/** `Retry-After` for a 429/503 AppError that carries `details.retryAfterSeconds` (a positive whole number). */
export function retryAfterHeader(err: unknown): Record<string, string> {
  if (!(err instanceof AppError) || (err.status !== 429 && err.status !== 503)) return {};
  const s = err.details.retryAfterSeconds;
  return typeof s === "number" && Number.isInteger(s) && s > 0 ? { "Retry-After": String(s) } : {};
}

/** Never leaks internal error text for non-AppError failures. */
export function toErrorResponse(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message, details: err.details } },
    };
  }
  return {
    status: 500,
    body: {
      error: { code: "INTERNAL_ERROR", message: "일시적인 오류가 발생했습니다.", details: {} },
    },
  };
}
