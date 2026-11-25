/**
 * Extracts the PostgreSQL error class from the shapes that reach the application (review M7, DATABASE §19.11 S7):
 *  - statement-time error through Prisma: PrismaClientKnownRequestError with `meta.driverAdapterError.cause`
 *    { originalCode, constraint }  (Prisma maps some codes, e.g. a trigger's 23001 shows up as P2003 — we read
 *    originalCode, never the Prisma code)
 *  - COMMIT-time error of an interactive transaction (deferred constraint / deferred constraint trigger):
 *    a raw DriverAdapterError (NOT wrapped by Prisma) with `cause.originalCode`. MEASURED (adapter-pg 7.10.1,
 *    2026-11-27 A-051 and again 2026-11-25 for orders_confirmed_payment_guard): `cause.constraint` is ABSENT, so the
 *    constraint is null and the caller must decide from the transaction's context.
 *  - node-pg DatabaseError (tests, scripts): `code` and `constraint`
 * Constraint names are only present for unique (23505) and foreign-key (23503) violations at statement time. A CHECK
 * (23514) or trigger (23001) violation carries no name even at statement time (measured 2026-11-25).
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
  deadlockDetected: "40P01",
  serializationFailure: "40001",
  lockNotAvailable: "55P03",
  queryCanceled: "57014",
  inFailedTransaction: "25P02",
} as const;

/**
 * What kind of failure a database error is, for retry and HTTP mapping (Step 5, review M7/M8). Every rule is based on a
 * MEASURED shape (2026-11-25, Prisma 7.10.1 + @prisma/adapter-pg 7.10.1 + pg 8.23.1, PostgreSQL 16):
 *  - deadlock            40P01                     → retry the whole transaction (bounded)
 *  - lock_timeout        55P03 (SET LOCAL lock_timeout)            → retry (bounded), then 503
 *  - statement_timeout   57014 (SET LOCAL statement_timeout)       → 503, no retry
 *  - tx_unavailable      Prisma P2028 (no cause): maxWait exceeded (pool exhausted) OR the transaction expired
 *                        (`timeout`). The two cannot be told apart without the message → both 503, no retry.
 *  - db_unreachable      Prisma P1001 (DatabaseNotReachable)        → 503
 *  - aborted_tx          25P02: a statement ran after an earlier error in the same transaction — a programming error
 *                        (code caught a DB error and continued). Never retried → 500.
 *  - constraint          any other SQLSTATE (class 23 etc.) with the constraint name when the driver gives one
 *  - null                not a database error we recognise (includes pg's own connection-timeout `Error`, which has no
 *                        code: the pool configuration prevents it on the transaction path, see db-pool-config.ts)
 * Never reads the message.
 */
export type DbErrorClass =
  | { kind: "deadlock"; sqlState: string }
  | { kind: "serialization"; sqlState: string }
  | { kind: "lock_timeout"; sqlState: string }
  | { kind: "statement_timeout"; sqlState: string }
  | { kind: "aborted_tx"; sqlState: string }
  | { kind: "tx_unavailable"; prismaCode: "P2028" }
  | { kind: "db_unreachable"; prismaCode: "P1001" }
  | ({ kind: "constraint" } & DbConstraintError);

export function classifyDbError(e: unknown): DbErrorClass | null {
  if (isObj(e) && e.name === "PrismaClientKnownRequestError") {
    if (e.code === "P2028") return { kind: "tx_unavailable", prismaCode: "P2028" };
    if (e.code === "P1001") return { kind: "db_unreachable", prismaCode: "P1001" };
  }
  const c = dbConstraintOf(e);
  if (!c) return null;
  switch (c.sqlState) {
    case SQLSTATE_CODES.deadlockDetected:
      return { kind: "deadlock", sqlState: c.sqlState };
    case SQLSTATE_CODES.serializationFailure:
      return { kind: "serialization", sqlState: c.sqlState };
    case SQLSTATE_CODES.lockNotAvailable:
      return { kind: "lock_timeout", sqlState: c.sqlState };
    case SQLSTATE_CODES.queryCanceled:
      return { kind: "statement_timeout", sqlState: c.sqlState };
    case SQLSTATE_CODES.inFailedTransaction:
      return { kind: "aborted_tx", sqlState: c.sqlState };
    default:
      return { kind: "constraint", ...c };
  }
}
