/**
 * Validates the current environment's configuration with the same rules the server
 * applies at startup. Use before deploying: `npm run check:config`.
 * Prints only non-secret information.
 */
import {
  DatabaseConfigError,
  assertDatabaseMatchesEnv,
  describeDatabase,
} from "../src/server/config/database-config";
import { ConfigError, describeRuntimeConfig, loadRuntimeConfig } from "../src/server/config/runtime-config";

try {
  const c = loadRuntimeConfig(process.env);
  const summary: Record<string, unknown> = { ...describeRuntimeConfig(c) };
  if (process.env.DATABASE_URL) {
    summary.database = describeDatabase(assertDatabaseMatchesEnv(c.runtimeEnv, process.env.DATABASE_URL));
  }
  console.log(JSON.stringify(summary, null, 2));
} catch (e) {
  if (e instanceof ConfigError || e instanceof DatabaseConfigError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
