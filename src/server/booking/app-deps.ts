import "server-only";
import { getDbPoolConfig, getPrisma } from "../db/client";
import type { BookingTxDeps } from "./tx";

/**
 * Application wiring of the booking transaction runner: the shared Prisma client and the validated pool / time limits
 * (review M8). Resolved per call, so an invalid configuration fails that request closed instead of crashing at import.
 */
export function bookingTxDeps(): BookingTxDeps {
  const prisma = getPrisma();
  return {
    startTx: (fn, options) => prisma.$transaction((tx) => fn(tx), options),
    limits: getDbPoolConfig(),
  };
}
