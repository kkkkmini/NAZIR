import "server-only";
import { getSecurityConfig } from "../identity/app-deps";
import { loadKeyring } from "../lib/secrets";
import { getRateLimit } from "../rate-limit/app-deps";
import { bookingTxDeps } from "./app-deps";
import type { CreateOrderDeps } from "./create-order";
import { RateLimitConfigUnavailable, type OrderRouteDeps } from "./order-route";

/**
 * Application wiring of POST /api/v1/orders. Everything is resolved per request: a missing or invalid key fails that
 * request closed (rate-limit configuration → 503 RATE_LIMIT_UNAVAILABLE; other configuration → generic 500), never
 * skips a check. The rate limiter's keys and policies are used on the order transaction itself (createOrder).
 */
export const orderAppDeps: OrderRouteDeps = {
  security: getSecurityConfig,
  order: (): CreateOrderDeps => {
    let rateLimit: CreateOrderDeps["rateLimit"];
    try {
      const { config } = getRateLimit();
      rateLimit = { keys: config.keys, policies: config.policies };
    } catch {
      throw new RateLimitConfigUnavailable();
    }
    return { tx: bookingTxDeps(), piiKeys: loadKeyring(process.env, "NAZIR_PII_ENC"), rateLimit };
  },
};
