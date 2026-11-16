/**
 * Guard for the temporary development seed (prisma/seed.ts).
 *
 * The seed contains placeholder venue/seat/price data (E-003, E-004 are not settled), so it must
 * never reach a shared or production database. Fail-closed:
 *  - a missing/unknown NAZIR_RUNTIME_ENV resolves to `production` (same rule as the server startup guard)
 *  - only `local` and `test` may seed
 *  - the target database must also match the environment (assertDatabaseMatchesEnv)
 */
import { assertDatabaseMatchesEnv, type DatabaseInfo } from "../config/database-config";
import { resolveRuntimeEnv, type RuntimeEnv } from "../config/runtime-config";

export const SEED_ALLOWED_ENVS: readonly RuntimeEnv[] = ["local", "test"];

export class SeedNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedNotAllowedError";
  }
}

export function assertDevSeedAllowed(env: Record<string, string | undefined>): {
  runtimeEnv: RuntimeEnv;
  database: DatabaseInfo;
} {
  const { runtimeEnv, assumed } = resolveRuntimeEnv(env);
  if (!SEED_ALLOWED_ENVS.includes(runtimeEnv)) {
    throw new SeedNotAllowedError(
      `The development seed only runs with NAZIR_RUNTIME_ENV=local or test ` +
        `(resolved: ${runtimeEnv}${assumed ? ", assumed because NAZIR_RUNTIME_ENV is missing or unknown" : ""}). Refusing to seed.`,
    );
  }
  const database = assertDatabaseMatchesEnv(runtimeEnv, env.DATABASE_URL);
  return { runtimeEnv, database };
}
