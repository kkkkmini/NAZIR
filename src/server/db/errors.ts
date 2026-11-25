/**
 * Extracts the PostgreSQL error class from the shapes that reach the application (review M7, DATABASE §19.11 S7):
 *  - statement-time error through Prisma: PrismaClientKnownRequestError with `meta.driverAdapterError.cause`
 *    { originalCode, constraint }  (Prisma maps some codes, e.g. a trigger's 23001 shows up as P2003 — we read
 *    originalCode, never the Prisma code)
 *  - COMMIT-time error of an interactive transaction (deferred constraint / deferred constraint trigger):
 *    a raw DriverAdapterError with `cause.originalCode` and `cause.constraint`
 *  - node-pg DatabaseError (tests, scripts): `code` and `constraint`
 * Returns null for anything else. Never inspects or returns the message (it can contain row values).
 */
export interface DbConstraintError {
  sqlState: string;
  constraint: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;
const SQLSTATE = /^[0-9A-Z]{5}$/;

function fromCause(cause: unknown): DbConstraintError | null {
  if (!isObj(cause)) return null;
  const code = cause.originalCode ?? cause.code;
  if (typeof code !== "string" || !SQLSTATE.test(code)) return null;
  const c = cause.constraint;
  const constraint = typeof c === "string" ? c : isObj(c) && typeof c.index === "string" ? c.index : null;
  return { sqlState: code, constraint };
}

export function dbConstraintOf(e: unknown): DbConstraintError | null {
  if (!isObj(e)) return null;
  // Prisma known request error (statement time)
  const meta = e.meta;
  if (isObj(meta) && isObj(meta.driverAdapterError)) {
    const r = fromCause(meta.driverAdapterError.cause);
    if (r) return r;
  }
  // DriverAdapterError (commit time)
  if (e.name === "DriverAdapterError") {
    const r = fromCause(e.cause);
    if (r) return r;
  }
  // node-pg DatabaseError
  if (typeof e.code === "string" && SQLSTATE.test(e.code) && "severity" in e) {
    return { sqlState: e.code, constraint: typeof e.constraint === "string" ? e.constraint : null };
  }
  return null;
}

export const SQLSTATE_CODES = {
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
  restrictViolation: "23001",
} as const;
