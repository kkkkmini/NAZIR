/**
 * Guard for the temporary development seed (prisma/seed.ts).
 *
 * The seed contains placeholder venue/seat/price data (E-003, E-004 are not settled), so it must
 * never reach a shared or production database. Fail-closed:
 *  - a missing/unknown NAZIR_RUNTIME_ENV resolves to `production` (same rule as the server startup guard)
 *  - only `local` and `test` may seed
 *  - the target database must also match the environment (assertDatabaseMatchesEnv)
 */
import { DatabaseConfigError, selectDirectDatabaseUrl, type DatabaseInfo, type DatabaseUrlVar } from "../config/database-config";
import { resolveRuntimeEnv, type RuntimeEnv } from "../config/runtime-config";

export const SEED_ALLOWED_ENVS: readonly RuntimeEnv[] = ["local", "test"];

export class SeedNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedNotAllowedError";
  }
}

/**
 * The seed connects like the Prisma CLI: DATABASE_URL_UNPOOLED (direct) when set, otherwise DATABASE_URL. Both URLs that
 * are set must belong to the environment and name the same database (`selectDirectDatabaseUrl`). `url` is the validated,
 * selected URL — it may hold a password: connect with it, never log it.
 */
export function assertDevSeedAllowed(env: Record<string, string | undefined>): {
  runtimeEnv: RuntimeEnv;
  database: DatabaseInfo;
  variable: DatabaseUrlVar;
  url: string;
} {
  const { runtimeEnv, assumed } = resolveRuntimeEnv(env);
  if (!SEED_ALLOWED_ENVS.includes(runtimeEnv)) {
    throw new SeedNotAllowedError(
      `The development seed only runs with NAZIR_RUNTIME_ENV=local or test ` +
        `(resolved: ${runtimeEnv}${assumed ? ", assumed because NAZIR_RUNTIME_ENV is missing or unknown" : ""}). Refusing to seed.`,
    );
  }
  const selected = selectDirectDatabaseUrl(runtimeEnv, env);
  if (!selected) throw new DatabaseConfigError("DATABASE_URL is not set");
  return { runtimeEnv, database: selected.database, variable: selected.variable, url: selected.url };
}
