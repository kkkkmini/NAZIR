/**
 * Rate limit configuration (A-045): its own HMAC keyring (NAZIR_RATE_LIMIT_KEYS / _KEY_CURRENT, never shared with the
 * CSRF, subject or encryption keys), the trusted client IP source, and policy overrides.
 * Malformed values are refused at startup everywhere; missing values are refused at startup in staging/production.
 * In local/test the server starts without them and every rate-limited request fails closed (503).
 */
import { SecretConfigError, assertDistinctKeyrings, parseKeyring, type Keyring } from "../lib/secrets";
import { ClientIpConfigError, parseClientIpSource, type ClientIpSource } from "./client-ip";
import { RateLimitConfigError, parsePolicyOverrides, type PolicyName, type RateLimitPolicy } from "./policies";

type Env = Record<string, string | undefined>;

export interface RateLimitConfig {
  keys: Keyring;
  ipSource: ClientIpSource;
  policies: Map<PolicyName, RateLimitPolicy>;
}

export function loadRateLimitConfig(env: Env, runtimeEnv: string): RateLimitConfig {
  const v: string[] = [];
  const keys = parseKeyring(env, "NAZIR_RATE_LIMIT", v);
  const csrf = parseKeyring(env, "NAZIR_CSRF", []);
  if (keys && csrf) assertDistinctKeyrings([csrf, keys], v);
  if (!keys && v.length === 0) v.push("NAZIR_RATE_LIMIT_KEYS and NAZIR_RATE_LIMIT_KEY_CURRENT are required");
  let ipSource: ClientIpSource | null = null;
  let policies = new Map<PolicyName, RateLimitPolicy>();
  try {
    ipSource = parseClientIpSource(env, runtimeEnv);
    if (ipSource.kind !== "vercel" && runtimeEnv !== "local" && runtimeEnv !== "test") v.push("staging/production require NAZIR_CLIENT_IP_SOURCE=vercel");
  } catch (e) {
    if (e instanceof ClientIpConfigError) v.push(e.message);
    else throw e;
  }
  try {
    policies = parsePolicyOverrides(env);
  } catch (e) {
    if (e instanceof RateLimitConfigError) v.push(e.message);
    else throw e;
  }
  if (v.length > 0) throw new SecretConfigError(v);
  return { keys: keys!, ipSource: ipSource!, policies };
}

/** Startup: staging/production must be complete; local/test only refuse values that are present but malformed. */
export function assertStartupRateLimitConfig(env: Env, runtimeEnv: string): void {
  if (runtimeEnv === "staging" || runtimeEnv === "production") {
    loadRateLimitConfig(env, runtimeEnv);
    return;
  }
  const v: string[] = [];
  const keys = parseKeyring(env, "NAZIR_RATE_LIMIT", v);
  const csrf = parseKeyring(env, "NAZIR_CSRF", []);
  if (keys && csrf) assertDistinctKeyrings([csrf, keys], v);
  if (env.NAZIR_CLIENT_IP_SOURCE?.trim()) {
    try {
      parseClientIpSource(env, runtimeEnv);
    } catch (e) {
      if (e instanceof ClientIpConfigError) v.push(e.message);
      else throw e;
    }
  }
  try {
    parsePolicyOverrides(env);
  } catch (e) {
    if (e instanceof RateLimitConfigError) v.push(e.message);
    else throw e;
  }
  if (v.length > 0) throw new SecretConfigError(v);
}
