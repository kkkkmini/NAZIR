import "server-only";
import { getSecurityConfig } from "../identity/app-deps";
import { bookingTxDeps } from "./app-deps";
import type { CancelRouteDeps } from "./cancel-route";

/** Application wiring of POST /api/v1/orders/{orderId}/cancel, resolved per request (fail closed on configuration). */
export const cancelAppDeps: CancelRouteDeps = { security: getSecurityConfig, tx: bookingTxDeps };
