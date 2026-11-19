import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { assertDatabaseMatchesEnv } from "../config/database-config";
import { getRuntimeConfig } from "../config/server-config";

/**
 * Server-only Prisma client (Prisma 7 requires a driver adapter).
 *
 * The connection is validated against the runtime environment before it is created, so a test
 * database can never be used outside `NAZIR_RUNTIME_ENV=test` and vice versa.
 *
 * Reminder (DATABASE.md §13.2, §14.1): row locks (`FOR UPDATE`, `SKIP LOCKED`) are not expressible
 * through the Prisma Client API; write them as parameterised raw queries and start the transaction
 * with an explicit READ COMMITTED isolation level. Never call a PG/identity provider inside a
 * transaction.
 */
const globalForPrisma = globalThis as unknown as { __nazirPrisma?: PrismaClient };

export function getPrisma(): PrismaClient {
  if (!globalForPrisma.__nazirPrisma) {
    const connectionString = process.env.DATABASE_URL;
    assertDatabaseMatchesEnv(getRuntimeConfig().runtimeEnv, connectionString);
    globalForPrisma.__nazirPrisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString }),
    });
  }
  return globalForPrisma.__nazirPrisma;
}
