/**
 * Booking transaction runner (Step 5 unit 1, DATABASE.md §13.2, reviews M7/M8, decision A-053).
 *
 * Every booking write (order creation, cancel, expireOrder, …) runs through `runBookingTx`:
 *  1. one Prisma interactive transaction with an EXPLICIT READ COMMITTED isolation level (never the DB default) and
 *     explicit `maxWait` / `timeout`;
 *  2. first statement: SET LOCAL lock_timeout / statement_timeout (`set_config(…, true)`: reset at COMMIT/ROLLBACK, so a
 *     pooled connection never keeps them);
 *  3. the caller's work `fn`. It receives only a parameterised SQL executor. It must not call a PG / identity provider
 *     and must not have side effects outside the database: on a retry it runs again from the start in a new transaction;
 *  4. failure handling — the transaction is ALWAYS rolled back first (Prisma rolls back when `fn` throws or COMMIT fails):
 *     - AppError thrown by `fn` (a business decision)            → rethrown unchanged, never retried
 *     - deadlock 40P01 / serialization 40001 / lock_timeout 55P03 → whole transaction retried (bounded attempts, bounded
 *                                                                   jittered delay), then 503 DATABASE_BUSY
 *     - statement_timeout 57014, P2028 (pool exhausted / transaction expired), P1001 → 503 DATABASE_BUSY, no retry
 *     - constraint (statement or COMMIT time)                    → the caller's ConstraintRules: unique / FK by NAME;
 *                                                                   CHECK 23514 / trigger 23001 by transaction CONTEXT
 *                                                                   (they carry no name — measured); unmapped → 500
 *     - 25P02 (statement after a caught error)                   → 500: a programming error, never retried
 *     - anything else                                            → rethrown (the route answers a generic 500)
 *
 * Do not catch a database error inside `fn` and continue: PostgreSQL aborts the transaction (25P02) — there are no
 * savepoints in booking transactions. Let it propagate; the runner maps it after the rollback.
 *
 * Logs carry the transaction name, the error class, SQLSTATE, constraint name and attempt number only — never the
 * message (it can contain row values such as names or phone numbers) and never parameters.
 */
import type { DbPoolConfig } from "../config/db-pool-config";
import { classifyDbError, type DbErrorClass } from "../db/errors";
import type { SqlExecutor } from "../db/sql";
import { AppError } from "../lib/errors";

/** The part of a Prisma interactive-transaction client the runner uses. */
export interface TxQueryClient {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
}
export interface TxStartOptions {
  isolationLevel: "ReadCommitted";
  maxWait: number;
  timeout: number;
}
/** Starts one interactive transaction (app: `getPrisma().$transaction`). */
export type StartTx = <T>(fn: (tx: TxQueryClient) => Promise<T>, options: TxStartOptions) => Promise<T>;

export type TxLimits = Pick<DbPoolConfig, "txMaxWaitMs" | "txTimeoutMs" | "statementTimeoutMs" | "lockTimeoutMs">;

export interface RetryPolicy {
  /** Total attempts including the first (1 = no retry). */
  maxAttempts: number;
  /** Upper bound of the first retry delay; doubles per attempt, capped by maxDelayMs, full jitter. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Retry-After advertised with 503 DATABASE_BUSY. */
  retryAfterSeconds: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 25, maxDelayMs: 200, retryAfterSeconds: 2 };

export interface TxObservation {
  name: string;
  attempt: number;
  outcome: "committed" | "retry" | "failed";
  kind?: DbErrorClass["kind"] | "app_error" | "unknown";
  delayMs?: number;
}

export interface BookingTxDeps {
  startTx: StartTx;
  limits: TxLimits;
  retry?: RetryPolicy;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  observe?: (o: TxObservation) => void;
}

type ErrorFactory = () => AppError;

/** How a transaction maps constraint violations to domain errors. Anything not listed is a 500. */
export interface ConstraintRules {
  /** 23505 by constraint (index) name. */
  unique?: Readonly<Record<string, ErrorFactory>>;
  /** 23503 by constraint name. */
  foreignKey?: Readonly<Record<string, ErrorFactory>>;
  /** 23514 (CHECK at statement time, deferred constraint trigger at COMMIT): no name is available → context only. */
  check?: ErrorFactory;
  /** 23001 (immutability / ledger triggers): no name is available → context only. */
  restrict?: ErrorFactory;
}

export interface BookingTxRequest<T> {
  /** Short identifier for logs, e.g. "order.create". */
  name: string;
  fn: (tx: SqlExecutor) => Promise<T>;
  constraints?: ConstraintRules;
}

const TX_NAME = /^[a-z][a-z0-9_.:-]{0,63}$/;
const RETRYABLE = new Set<DbErrorClass["kind"]>(["deadlock", "serialization", "lock_timeout"]);
const BUSY = new Set<DbErrorClass["kind"]>(["statement_timeout", "tx_unavailable", "db_unreachable"]);

export function validateRetryPolicy(p: RetryPolicy): RetryPolicy {
  const ok =
    Number.isInteger(p.maxAttempts) && p.maxAttempts >= 1 && p.maxAttempts <= 5 &&
    Number.isInteger(p.baseDelayMs) && p.baseDelayMs >= 0 && p.baseDelayMs <= 1_000 &&
    Number.isInteger(p.maxDelayMs) && p.maxDelayMs >= p.baseDelayMs && p.maxDelayMs <= 2_000 &&
    Number.isInteger(p.retryAfterSeconds) && p.retryAfterSeconds >= 1 && p.retryAfterSeconds <= 30;
  if (!ok) throw new Error("invalid booking transaction retry policy");
  return p;
}

/** Full-jitter backoff: uniform in [0, min(maxDelay, base · 2^(retry-1))]. `retry` starts at 1. */
export function retryDelayMs(p: RetryPolicy, retry: number, random: () => number): number {
  const cap = Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** Math.max(0, retry - 1));
  return Math.floor(Math.min(Math.max(random(), 0), 1) * cap);
}

export function databaseBusy(retryAfterSeconds: number): AppError {
  return new AppError("DATABASE_BUSY", "요청이 많아 잠시 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.", { retryAfterSeconds });
}

function internal(): AppError {
  return new AppError("INTERNAL_ERROR", "일시적인 오류가 발생했습니다.");
}

function mapConstraint(c: Extract<DbErrorClass, { kind: "constraint" }>, rules: ConstraintRules | undefined): AppError | null {
  if (!rules) return null;
  const byName = (m: Readonly<Record<string, ErrorFactory>> | undefined) =>
    c.constraint !== null && m && Object.hasOwn(m, c.constraint) ? m[c.constraint]() : null;
  switch (c.sqlState) {
    case "23505":
      return byName(rules.unique);
    case "23503":
      return byName(rules.foreignKey);
    case "23514":
      return rules.check ? rules.check() : null;
    case "23001":
      return rules.restrict ? rules.restrict() : null;
    default:
      return null;
  }
}

function logLine(name: string, attempt: number, max: number, cls: DbErrorClass | null): string {
  if (!cls) return `[booking-tx] ${name} attempt=${attempt}/${max} kind=unknown`;
  const parts = [`[booking-tx] ${name}`, `attempt=${attempt}/${max}`, `kind=${cls.kind}`];
  if ("sqlState" in cls) parts.push(`sqlstate=${cls.sqlState}`);
  if ("prismaCode" in cls) parts.push(`prisma=${cls.prismaCode}`);
  if (cls.kind === "constraint") parts.push(`constraint=${cls.constraint ?? "none"}`);
  return parts.join(" ");
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runBookingTx<T>(deps: BookingTxDeps, req: BookingTxRequest<T>): Promise<T> {
  if (!TX_NAME.test(req.name)) throw new Error("invalid booking transaction name");
  const retry = validateRetryPolicy(deps.retry ?? DEFAULT_RETRY_POLICY);
  const { limits } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const observe = deps.observe ?? (() => {});
  const options: TxStartOptions = { isolationLevel: "ReadCommitted", maxWait: limits.txMaxWaitMs, timeout: limits.txTimeoutMs };

  for (let attempt = 1; ; attempt++) {
    try {
      const result = await deps.startTx(async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT set_config('lock_timeout', $1, true) AS "lock_timeout", set_config('statement_timeout', $2, true) AS "statement_timeout"`,
          `${limits.lockTimeoutMs}ms`,
          `${limits.statementTimeoutMs}ms`,
        );
        const exec: SqlExecutor = <R>(sql: string, params: unknown[]) => tx.$queryRawUnsafe<R[]>(sql, ...params);
        return req.fn(exec);
      }, options);
      observe({ name: req.name, attempt, outcome: "committed" });
      return result;
    } catch (e) {
      if (e instanceof AppError) {
        observe({ name: req.name, attempt, outcome: "failed", kind: "app_error" });
        throw e;
      }
      const cls = classifyDbError(e);
      if (cls && RETRYABLE.has(cls.kind)) {
        if (attempt < retry.maxAttempts) {
          const delayMs = retryDelayMs(retry, attempt, random);
          console.warn(logLine(req.name, attempt, retry.maxAttempts, cls), `retry_in_ms=${delayMs}`);
          observe({ name: req.name, attempt, outcome: "retry", kind: cls.kind, delayMs });
          await sleep(delayMs);
          continue;
        }
        console.error(logLine(req.name, attempt, retry.maxAttempts, cls), "retries_exhausted");
        observe({ name: req.name, attempt, outcome: "failed", kind: cls.kind });
        throw databaseBusy(retry.retryAfterSeconds);
      }
      if (cls && BUSY.has(cls.kind)) {
        console.error(logLine(req.name, attempt, retry.maxAttempts, cls));
        observe({ name: req.name, attempt, outcome: "failed", kind: cls.kind });
        throw databaseBusy(retry.retryAfterSeconds);
      }
      if (cls && cls.kind === "constraint") {
        const mapped = mapConstraint(cls, req.constraints);
        console[mapped ? "warn" : "error"](logLine(req.name, attempt, retry.maxAttempts, cls), mapped ? `mapped=${mapped.code}` : "unmapped");
        observe({ name: req.name, attempt, outcome: "failed", kind: "constraint" });
        throw mapped ?? internal();
      }
      if (cls && cls.kind === "aborted_tx") {
        console.error(logLine(req.name, attempt, retry.maxAttempts, cls), "statement_after_error");
        observe({ name: req.name, attempt, outcome: "failed", kind: "aborted_tx" });
        throw internal();
      }
      console.error(logLine(req.name, attempt, retry.maxAttempts, null));
      observe({ name: req.name, attempt, outcome: "failed", kind: "unknown" });
      throw e;
    }
  }
}
