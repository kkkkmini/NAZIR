/**
 * Database pool and transaction time limits per environment (review M8, Step 5 decision A-053 ⑦).
 *
 * Every value is explicit:
 *  - local / test: a documented development default is used when the variable is unset.
 *  - staging / production: every variable is REQUIRED. A missing value refuses the configuration (fail-closed) — there is
 *    deliberately no production default. The final production numbers depend on the Neon pooled-connection limit and the
 *    maximum number of Vercel function instances, which are not confirmed yet (E-007): until they are, the deployment is
 *    not "production ready" whatever is configured here.
 *
 * Ordering rules (checked in every environment, defaults included):
 *  - lock_timeout < statement_timeout < transaction timeout: a lock wait reports 55P03 (retryable) before the statement
 *    is cancelled (57014), and a statement is cancelled by PostgreSQL before Prisma expires the transaction (P2028).
 *    Prisma's `timeout` does NOT cancel a running statement (measured 2026-11-25): without statement_timeout a slow
 *    statement keeps its locks until it finishes.
 *  - connection timeout > transaction maxWait: when the pool is exhausted, Prisma's maxWait must fire first. It raises a
 *    classifiable P2028. pg's own connection timeout raises a plain `Error` with no code (measured 2026-11-25), which the
 *    application could only recognise by reading the message — which it never does.
 *
 * Pure (no I/O, no `server-only`): used by the Prisma client, the startup guard, `check:config` and unit tests.
 */
import { DatabaseConfigError } from "./database-config";
import type { RuntimeEnv } from "./runtime-config";

type Env = Record<string, string | undefined>;

export interface DbPoolConfig {
  /** pg Pool `max`: connections ONE server instance may open. Total = instances × poolMax (must stay below the pooler limit). */
  poolMax: number;
  /** pg Pool `connectionTimeoutMillis`. */
  connectionTimeoutMs: number;
  /** pg Pool `idleTimeoutMillis`. */
  idleTimeoutMs: number;
  /** Prisma interactive transaction `maxWait` (time to obtain a connection and start). */
  txMaxWaitMs: number;
  /** Prisma interactive transaction `timeout` (whole transaction, commit included). */
  txTimeoutMs: number;
  /** PostgreSQL `statement_timeout`, applied with SET LOCAL inside booking transactions. */
  statementTimeoutMs: number;
  /** PostgreSQL `lock_timeout`, applied with SET LOCAL inside booking transactions. */
  lockTimeoutMs: number;
}

interface Field {
  key: keyof DbPoolConfig;
  env: string;
  min: number;
  max: number;
  /** Development default for local/test only. */
  dev: number;
}

export const DB_POOL_FIELDS: readonly Field[] = [
  { key: "poolMax", env: "NAZIR_DB_POOL_MAX", min: 1, max: 50, dev: 5 },
  { key: "connectionTimeoutMs", env: "NAZIR_DB_CONNECTION_TIMEOUT_MS", min: 100, max: 60_000, dev: 5_000 },
  { key: "idleTimeoutMs", env: "NAZIR_DB_IDLE_TIMEOUT_MS", min: 1_000, max: 600_000, dev: 10_000 },
  { key: "txMaxWaitMs", env: "NAZIR_DB_TX_MAX_WAIT_MS", min: 100, max: 30_000, dev: 2_000 },
  { key: "txTimeoutMs", env: "NAZIR_DB_TX_TIMEOUT_MS", min: 500, max: 60_000, dev: 10_000 },
  { key: "statementTimeoutMs", env: "NAZIR_DB_STATEMENT_TIMEOUT_MS", min: 100, max: 60_000, dev: 5_000 },
  { key: "lockTimeoutMs", env: "NAZIR_DB_LOCK_TIMEOUT_MS", min: 50, max: 30_000, dev: 2_000 },
] as const;

const INT = /^[0-9]{1,7}$/;

function allowsDevDefaults(runtimeEnv: RuntimeEnv | string): boolean {
  return runtimeEnv === "local" || runtimeEnv === "test";
}

/**
 * Parses and validates the pool configuration. Throws DatabaseConfigError listing every violation (variable names and
 * rules only — the values are not secret, but nothing else is echoed).
 */
export function loadDbPoolConfig(env: Env, runtimeEnv: RuntimeEnv | string): DbPoolConfig {
  const v: string[] = [];
  const out: Partial<DbPoolConfig> = {};
  for (const f of DB_POOL_FIELDS) {
    const raw = env[f.env]?.trim();
    if (!raw) {
      if (allowsDevDefaults(runtimeEnv)) out[f.key] = f.dev;
      else v.push(`${f.env} is required in ${runtimeEnv} (no production default; size it from the pooler limit, E-007)`);
      continue;
    }
    if (!INT.test(raw)) {
      v.push(`${f.env} must be a whole number`);
      continue;
    }
    const n = Number(raw);
    if (n < f.min || n > f.max) {
      v.push(`${f.env} must be between ${f.min} and ${f.max}`);
      continue;
    }
    out[f.key] = n;
  }
  if (v.length === 0) {
    const c = out as DbPoolConfig;
    if (!(c.lockTimeoutMs < c.statementTimeoutMs)) v.push("NAZIR_DB_LOCK_TIMEOUT_MS must be less than NAZIR_DB_STATEMENT_TIMEOUT_MS");
    if (!(c.statementTimeoutMs < c.txTimeoutMs)) v.push("NAZIR_DB_STATEMENT_TIMEOUT_MS must be less than NAZIR_DB_TX_TIMEOUT_MS");
    if (!(c.connectionTimeoutMs > c.txMaxWaitMs))
      v.push("NAZIR_DB_CONNECTION_TIMEOUT_MS must be greater than NAZIR_DB_TX_MAX_WAIT_MS (pool exhaustion must surface as Prisma P2028)");
  }
  if (v.length > 0) throw new DatabaseConfigError(`Invalid database pool configuration:\n  - ${v.join("\n  - ")}`);
  return out as DbPoolConfig;
}

/**
 * Startup / check:config rule: validated whenever DATABASE_URL is configured (without a database there is no pool), and
 * ALWAYS in staging/production so a deployment cannot come up without explicit limits.
 */
export function assertStartupDbPoolConfig(env: Env, runtimeEnv: RuntimeEnv | string): DbPoolConfig | null {
  const hasDb = Boolean(env.DATABASE_URL?.trim());
  if (!hasDb && allowsDevDefaults(runtimeEnv)) return null;
  return loadDbPoolConfig(env, runtimeEnv);
}
