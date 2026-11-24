/**
 * Node.js startup guard. A configuration violation terminates the process so the
 * server never comes up in an unsafe state (ARCHITECTURE.md §6.5 fail-closed provider
 * guard, TEST_PLAN PRV-01~04, PRV-07). Throwing alone is not enough: Next.js keeps the
 * HTTP listener alive and answers 500, which a hosting health check may treat as "up".
 */
import {
  DatabaseConfigError,
  assertRuntimeDatabaseConfig,
  describeDatabase,
} from "./server/config/database-config";
import { ConfigError, describeRuntimeConfig, loadRuntimeConfig } from "./server/config/runtime-config";
import { SecretConfigError, assertStartupSecurityConfig } from "./server/lib/secrets";

try {
  const config = loadRuntimeConfig(process.env);
  console.info("[nazir] runtime config", JSON.stringify(describeRuntimeConfig(config)));
  // When a database is configured it must belong to this environment (dev vs test vs shared).
  // DATABASE_URL is NOT required at startup: without it the server still starts, but every page and API that reads the
  // catalog (Step 3) answers with an error. Whether staging/production must require it is undecided (review M3).
  // The runtime connects with DATABASE_URL only (pooled). DATABASE_URL_UNPOOLED (direct, Prisma CLI + seed) is not used
  // here, but alone it is refused (the app would have no database), and next to DATABASE_URL it must belong to this
  // environment and be the same database.
  // Origin + CSRF keys (A-044): malformed is refused everywhere, missing is refused in staging/production.
  assertStartupSecurityConfig(process.env, config.runtimeEnv);
  const db = assertRuntimeDatabaseConfig(config.runtimeEnv, process.env);
  if (db) {
    console.info("[nazir] database", JSON.stringify(describeDatabase(db.pooled)));
  }
} catch (e) {
  if (e instanceof ConfigError || e instanceof DatabaseConfigError || e instanceof SecretConfigError) {
    console.error(`[nazir] refusing to start\n${e.message}`);
    process.exit(1);
  }
  throw e;
}
