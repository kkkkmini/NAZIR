import "server-only";
import type { Clock } from "../lib/clock";
import { getPrisma } from "./client";
import { DbClock } from "./db-clock";

/**
 * The application clock for request-scoped work: DB time through the shared, environment-checked Prisma client
 * (`getPrisma()` validates DATABASE_URL against NAZIR_RUNTIME_ENV before connecting).
 *
 * Services should accept a `Clock` parameter and receive this from the route handler, so tests can pass a `FixedClock`.
 * Inside an interactive transaction use `new DbClock(tx)` instead, to read that transaction's own `now()`.
 */
export function getAppClock(): Clock {
  return new DbClock(getPrisma());
}
