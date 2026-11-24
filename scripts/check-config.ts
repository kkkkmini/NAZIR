/**
 * Validates the current environment's configuration with the same rules the server
 * applies at startup. Use before deploying: `npm run check:config`.
 * Prints only non-secret information (never a URL or password). Pure configuration check: it does not connect.
 * DATABASE_URL (pooled, app) and DATABASE_URL_UNPOOLED (direct, Prisma CLI + seed) follow the server's startup rule
 * (`assertRuntimeDatabaseConfig`): each must belong to NAZIR_RUNTIME_ENV, both must name the same database, and
 * DATABASE_URL_UNPOOLED alone is refused.
 */
import {
  DatabaseConfigError,
  assertRuntimeDatabaseConfig,
  describeDatabase,
} from "../src/server/config/database-config";
import { ConfigError, describeRuntimeConfig, loadRuntimeConfig } from "../src/server/config/runtime-config";

try {
  const c = loadRuntimeConfig(process.env);
  const summary: Record<string, unknown> = { ...describeRuntimeConfig(c) };
  const db = assertRuntimeDatabaseConfig(c.runtimeEnv, process.env);
  if (db) {
    summary.database = describeDatabase(db.pooled);
    if (db.direct) summary.directDatabase = describeDatabase(db.direct);
  }
  console.log(JSON.stringify(summary, null, 2));
} catch (e) {
  if (e instanceof ConfigError || e instanceof DatabaseConfigError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
