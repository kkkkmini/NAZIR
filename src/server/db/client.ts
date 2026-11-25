import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { assertDatabaseMatchesEnv } from "../config/database-config";
import { loadDbPoolConfig, type DbPoolConfig } from "../config/db-pool-config";
import { getRuntimeConfig } from "../config/server-config";
import { buildPgPoolConfig } from "./pg-adapter";

/**
 * Server-only Prisma client (Prisma 7 requires a driver adapter).
 *
 * The connection is validated against the runtime environment before it is created, so a test
 * database can never be used outside `NAZIR_RUNTIME_ENV=test` and vice versa.
 *
 * Runtime connection = DATABASE_URL only (with Neon: the POOLED URL). DATABASE_URL_UNPOOLED (direct) is for the Prisma
 * CLI and the seed (prisma.config.ts, src/server/db/seed-guard.ts) and is deliberately not used here.
 *
 * Every pooled connection starts with session TimeZone=UTC (./pg-adapter.ts): the driver adapter reads timestamptz
 * correctly only under UTC (TEST_PLAN §2.3 S11). Do not `SET TIME ZONE` in application code.
 *
 * Pool size and time limits come from `loadDbPoolConfig` (review M8): development defaults in local/test, every value
 * required in staging/production. The same limits are Prisma's default interactive-transaction `maxWait`/`timeout`;
 * booking transactions also set them explicitly and add SET LOCAL lock/statement timeouts (src/server/booking/tx.ts).
 *
 * Reminder (DATABASE.md §13.2, §14.1): row locks (`FOR UPDATE`, `SKIP LOCKED`) are not expressible
 * through the Prisma Client API; write them as parameterised raw queries and start the transaction
 * with an explicit READ COMMITTED isolation level. Never call a PG/identity provider inside a
 * transaction.
 */
const globalForPrisma = globalThis as unknown as { __nazirPrisma?: PrismaClient; __nazirDbPool?: DbPoolConfig };

/** The validated pool / transaction limits of the application client. Throws DatabaseConfigError when invalid. */
export function getDbPoolConfig(): DbPoolConfig {
  if (!globalForPrisma.__nazirDbPool) globalForPrisma.__nazirDbPool = loadDbPoolConfig(process.env, getRuntimeConfig().runtimeEnv);
  return globalForPrisma.__nazirDbPool;
}

export function getPrisma(): PrismaClient {
  if (!globalForPrisma.__nazirPrisma) {
    const connectionString = process.env.DATABASE_URL;
    const runtimeEnv = getRuntimeConfig().runtimeEnv;
    assertDatabaseMatchesEnv(runtimeEnv, connectionString);
    const pool = getDbPoolConfig();
    globalForPrisma.__nazirPrisma = new PrismaClient({
      adapter: new PrismaPg(buildPgPoolConfig(connectionString, "DATABASE_URL", pool)),
      transactionOptions: { isolationLevel: "ReadCommitted", maxWait: pool.txMaxWaitMs, timeout: pool.txTimeoutMs },
    });
  }
  return globalForPrisma.__nazirPrisma;
}
