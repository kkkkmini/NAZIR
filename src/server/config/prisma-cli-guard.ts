/**
 * Prisma CLI database guard (used by prisma.config.ts).
 *
 * The application (`getPrisma()`) and the dev seed already refuse a database that does not belong to the runtime
 * environment. The Prisma CLI is the more dangerous entry point — `migrate deploy`, `migrate reset` and `db seed` write
 * to whatever database it is given — so the same rule runs when the CLI loads its configuration, i.e. before any command.
 *
 * Which database the CLI uses (Neon: pooled vs direct):
 *  - DATABASE_URL_UNPOOLED (direct connection) when it is set; otherwise DATABASE_URL. A transaction-mode pooler does
 *    not support everything migrations need, so the CLI prefers the direct URL. Local development keeps working with
 *    DATABASE_URL alone.
 *  - The guard validates the URL that is actually selected AND every other main URL that is set: both must belong to the
 *    environment and, when both are set, name the same database (`selectDirectDatabaseUrl`, Neon pooler-aware).
 *
 * Rules (same as database-config.ts):
 *  - Neither URL set (or blank): nothing to check (`prisma validate` / `prisma generate` need no database).
 *  - NAZIR_RUNTIME_ENV missing or unknown resolves to `production` (fail-closed).
 *  - `test` accepts only a database whose name ends in `_test`; every other environment rejects such a database.
 *  - SHADOW_DATABASE_URL, when set, is checked with the SAME rule: the CLI resets and rewrites the shadow database
 *    (`migrate dev`, `migrate diff --from-migrations`), so a `_test` database as the shadow of a development database (or a
 *    development database as the shadow of a test run) would sidestep the separation. When unset, nothing changes.
 *  - The shadow database must not be the same database as DATABASE_URL or DATABASE_URL_UNPOOLED, under any spelling
 *    (loopback aliases, Neon pooled/direct host) — the shadow is wiped.
 *  - Error messages name the variable and the database, never the URL (no credentials).
 *
 * Pure (no I/O): unit-tested without a database; the real CLI behaviour is covered by tests/contract/schema/cli-guard.test.ts.
 */
import {
  assertDatabaseMatchesEnv,
  DatabaseConfigError,
  isSameDatabase,
  selectDirectDatabaseUrl,
  type DatabaseInfo,
  type DatabaseUrlVar,
} from "./database-config";
import { resolveRuntimeEnv } from "./runtime-config";

/** The database the CLI will use. `url` may hold a password: hand it to the CLI, never log it. */
export type CliDatabase = DatabaseInfo & { variable: DatabaseUrlVar; url: string };

/**
 * Throws unless the CLI's databases belong to the runtime environment. Returns the database the CLI must use
 * (DATABASE_URL_UNPOOLED when set, otherwise DATABASE_URL), or null when neither is set.
 */
export function assertPrismaCliDatabase(env: Record<string, string | undefined>): CliDatabase | null {
  const { runtimeEnv, assumed } = resolveRuntimeEnv(env);
  const refuse = (message: string): never => {
    throw new DatabaseConfigError(
      `Prisma CLI refused before running any command: ${message}` +
        (assumed ? " (NAZIR_RUNTIME_ENV is missing or unknown, so production was assumed)" : ""),
    );
  };
  const guarded = <T>(fn: () => T, label?: string): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof DatabaseConfigError) return refuse(label ? `${label}: ${e.message}` : e.message);
      throw e;
    }
  };

  // Every main URL that is set must belong to the environment (checked one by one so the error names the variable)…
  const mains = (["DATABASE_URL", "DATABASE_URL_UNPOOLED"] as const)
    .filter((v) => !(env[v] === undefined || env[v]!.trim() === ""))
    .map((v) => ({ variable: v, info: guarded(() => assertDatabaseMatchesEnv(runtimeEnv, env[v], v), v) }));
  // …and, when both are set, they must be the same database. This also picks the URL the CLI uses.
  const selected = guarded(() => selectDirectDatabaseUrl(runtimeEnv, env));

  // prisma.config.ts hands SHADOW_DATABASE_URL to the CLI only when it is a non-empty string; mirror that exactly.
  const rawShadow = env.SHADOW_DATABASE_URL;
  const shadow =
    rawShadow === undefined || rawShadow === ""
      ? null
      : guarded(() => assertDatabaseMatchesEnv(runtimeEnv, rawShadow, "SHADOW_DATABASE_URL"), "SHADOW_DATABASE_URL");

  if (shadow) {
    for (const main of mains) {
      if (isSameDatabase(main.info, shadow)) {
        refuse(
          `SHADOW_DATABASE_URL must not be the same database as ${main.variable} ("${main.info.database}"): the CLI resets the shadow database`,
        );
      }
    }
  }
  return selected ? { ...selected.database, variable: selected.variable, url: selected.url } : null;
}
