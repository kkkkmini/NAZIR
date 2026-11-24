/**
 * Rate limit service (A-045). Generic: a caller names a policy and the identifiers that make up its key, e.g.
 *   await limiter.consume("identity.start.ip", [["ip", clientIp]])
 *   await limiter.consume("identity.start.binding", [["binding", bindingValue]])
 * Check the IP policy first and the browser-binding policy only when it passed: binding values are client-chosen, so
 * the IP limit is what bounds how many binding counters one client can create.
 *
 * Identifiers are never stored: the key is `HMAC(NAZIR_RATE_LIMIT keyring, policy ‖ dimension ‖ value)`, versioned.
 * Rotating the keyring's current version starts fresh counters (old rows expire and are cleaned up) — accepted.
 *
 * Outcomes:
 * - allowed → { allowed: true, remaining, retryAt: null }
 * - over limit → { allowed: false, remaining: 0, retryAt } ; `enforce` turns it into 429 RATE_LIMITED (+ Retry-After)
 * - store / configuration failure → RateLimitUnavailableError (never "allowed"); `enforce` turns it into
 *   503 RATE_LIMIT_UNAVAILABLE — a different code from the user's own limit.
 */
import { signVersioned } from "../lib/crypto/hmac";
import { AppError } from "../lib/errors";
import type { Keyring } from "../lib/secrets";
import { resolvePolicy, type PolicyName, type RateLimitPolicy } from "./policies";
import { hitCounter, type SqlExecutor } from "./store";

export interface RateLimitDecision {
  policy: PolicyName;
  allowed: boolean;
  limit: number;
  remaining: number;
  /** When the window ends (DB time). Set only when rejected. */
  retryAt: Date | null;
  /** Whole seconds from DB now() to retryAt (>= 1). Set only when rejected. */
  retryAfterSeconds: number | null;
}

export class RateLimitUnavailableError extends Error {
  constructor(readonly causeName: string) {
    super("rate limit store unavailable");
    this.name = "RateLimitUnavailableError";
  }
}

export interface RateLimiterDeps {
  exec: SqlExecutor;
  keys: Keyring;
  policies: Map<PolicyName, RateLimitPolicy>;
}

const DIMENSION = /^[a-z][a-z0-9_]{0,31}$/;

export function rateLimitKey(keys: Keyring, policy: string, parts: [dimension: string, value: string][]): string {
  if (parts.length === 0) throw new Error("rate limit key needs at least one identifier");
  const msg = parts
    .map(([d, v]) => {
      if (!DIMENSION.test(d)) throw new Error("invalid rate limit dimension");
      return `${d}=${encodeURIComponent(v)}`;
    })
    .join("&");
  return signVersioned(keys, "rate-limit", `${policy}\u0000${msg}`);
}

export class RateLimiter {
  constructor(private readonly deps: RateLimiterDeps) {}

  async consume(policyName: PolicyName, parts: [string, string][]): Promise<RateLimitDecision> {
    let policy: RateLimitPolicy;
    let key: string;
    try {
      policy = resolvePolicy(policyName, this.deps.policies);
      key = rateLimitKey(this.deps.keys, policy.name, parts);
    } catch (e) {
      throw new RateLimitUnavailableError(e instanceof Error ? e.name : typeof e);
    }
    let hit;
    try {
      hit = await hitCounter(this.deps.exec, policy.name, key, policy.windowMs, policy.limit);
    } catch (e) {
      throw new RateLimitUnavailableError(e instanceof Error ? e.name : typeof e);
    }
    const allowed = hit.count <= policy.limit;
    return {
      policy: policyName,
      allowed,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - hit.count),
      retryAt: allowed ? null : new Date(hit.expiresAtMs),
      retryAfterSeconds: allowed ? null : Math.max(1, Math.ceil((hit.expiresAtMs - hit.nowMs) / 1000)),
    };
  }

  /** consume + throw AppError: 429 RATE_LIMITED on the limit, 503 RATE_LIMIT_UNAVAILABLE on a store failure. */
  async enforce(policyName: PolicyName, parts: [string, string][]): Promise<RateLimitDecision> {
    let d: RateLimitDecision;
    try {
      d = await this.consume(policyName, parts);
    } catch (e) {
      if (e instanceof RateLimitUnavailableError) {
        console.error("[rate-limit] store unavailable:", e.causeName);
        throw new AppError("RATE_LIMIT_UNAVAILABLE", "일시적으로 요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.");
      }
      throw e;
    }
    if (!d.allowed) {
      throw new AppError("RATE_LIMITED", "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.", {
        retryAt: d.retryAt!.toISOString(),
        retryAfterSeconds: d.retryAfterSeconds,
      });
    }
    return d;
  }
}
