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
 *  - SHADOW_DATABASE_URL, when set, is checked with the SAME rule: the CLI resets and rewrites the shadow database
 *    (`migrate dev`, `migrate diff --from-migrations`), so a `_test` database as the shadow of a development database (or a
 *    development database as the shadow of a test run) would sidestep the separation. When unset, nothing changes.
 *  - DATABASE_URL and SHADOW_DATABASE_URL must not name the same database (the shadow is wiped).
 *  - Error messages name the variable and the database, never the URL (no credentials).
 *
 * Pure (no I/O): unit-tested without a database; the real CLI behaviour is covered by tests/contract/schema/cli-guard.test.ts.
 */
import { assertDatabaseMatchesEnv, DatabaseConfigError, isSameDatabase, type DatabaseInfo } from "./database-config";
import { resolveRuntimeEnv } from "./runtime-config";

/** Throws unless the CLI's databases belong to the runtime environment. Returns the main database (null when DATABASE_URL is unset). */
export function assertPrismaCliDatabase(env: Record<string, string | undefined>): DatabaseInfo | null {
  const { runtimeEnv, assumed } = resolveRuntimeEnv(env);
  const refuse = (message: string): never => {
    throw new DatabaseConfigError(
      `Prisma CLI refused before running any command: ${message}` +
        (assumed ? " (NAZIR_RUNTIME_ENV is missing or unknown, so production was assumed)" : ""),
    );
  };
  const check = (raw: string | undefined, label: string): DatabaseInfo => {
    try {
      return assertDatabaseMatchesEnv(runtimeEnv, raw, label);
    } catch (e) {
      if (e instanceof DatabaseConfigError) return refuse(`${label}: ${e.message}`);
      throw e;
    }
  };

  const rawDb = env.DATABASE_URL;
  const database = rawDb === undefined || rawDb.trim() === "" ? null : check(rawDb, "DATABASE_URL");

  // prisma.config.ts hands SHADOW_DATABASE_URL to the CLI only when it is a non-empty string; mirror that exactly.
  const rawShadow = env.SHADOW_DATABASE_URL;
  const shadow = rawShadow === undefined || rawShadow === "" ? null : check(rawShadow, "SHADOW_DATABASE_URL");

  if (database && shadow && isSameDatabase(database, shadow)) {
    refuse(`SHADOW_DATABASE_URL must not be the same database as DATABASE_URL ("${database.database}"): the CLI resets the shadow database`);
  }
  return database;
}
