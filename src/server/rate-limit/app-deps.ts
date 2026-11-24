import "server-only";
import { getRuntimeConfig } from "../config/server-config";
import { getPrisma } from "../db/client";
import { loadRateLimitConfig, type RateLimitConfig } from "./config";
import { RateLimiter } from "./service";
import type { SqlExecutor } from "./store";

let cached: { config: RateLimitConfig; limiter: RateLimiter } | null = null;

/** Prisma ($queryRawUnsafe, parameterised) as the store executor — the app's pooled connection (A-045). */
export const prismaExecutor: SqlExecutor = (sql, params) => getPrisma().$queryRawUnsafe(sql, ...params);

/**
 * Lazily built. A configuration error throws here; callers (route handlers) must treat that as fail-closed
 * (RATE_LIMIT_UNAVAILABLE), never skip the limit.
 */
export function getRateLimit(): { config: RateLimitConfig; limiter: RateLimiter } {
  if (!cached) {
    const config = loadRateLimitConfig(process.env, getRuntimeConfig().runtimeEnv);
    cached = { config, limiter: new RateLimiter({ exec: prismaExecutor, keys: config.keys, policies: config.policies }) };
  }
  return cached;
}
