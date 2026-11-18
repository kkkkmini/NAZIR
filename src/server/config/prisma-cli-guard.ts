/**
 * Prisma CLI database guard (used by prisma.config.ts).
 *
 * The application (`getPrisma()`) and the dev seed already refuse a database that does not belong to the runtime
 * environment. The Prisma CLI is the more dangerous entry point — `migrate deploy`, `migrate reset` and `db seed` write
 * to whatever DATABASE_URL names — so the same rule runs when the CLI loads its configuration, i.e. before any command.
 *
 * Rules (same as database-config.ts):
 *  - DATABASE_URL unset or blank: nothing to check (`prisma validate` / `prisma generate` need no database).
 *  - NAZIR_RUNTIME_ENV missing or unknown resolves to `production` (fail-closed).
 *  - `test` accepts only a database whose name ends in `_test`; every other environment rejects such a database.
 *  - SHADOW_DATABASE_URL is passed through untouched by prisma.config.ts (it is not validated here).
 *
 * Pure (no I/O): unit-tested without a database; the real CLI behaviour is covered by tests/contract/schema/cli-guard.test.ts.
 */
import { assertDatabaseMatchesEnv, DatabaseConfigError, type DatabaseInfo } from "./database-config";
import { resolveRuntimeEnv } from "./runtime-config";

export function assertPrismaCliDatabase(env: Record<string, string | undefined>): DatabaseInfo | null {
  const raw = env.DATABASE_URL;
  if (raw === undefined || raw.trim() === "") return null;
  const { runtimeEnv, assumed } = resolveRuntimeEnv(env);
  try {
    return assertDatabaseMatchesEnv(runtimeEnv, raw);
  } catch (e) {
    if (e instanceof DatabaseConfigError) {
      throw new DatabaseConfigError(
        `Prisma CLI refused before running any command: ${e.message}` +
          (assumed ? " (NAZIR_RUNTIME_ENV is missing or unknown, so production was assumed)" : ""),
      );
    }
    throw e;
  }
}
