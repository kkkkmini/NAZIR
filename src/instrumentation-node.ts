/**
 * Node.js startup guard. A configuration violation terminates the process so the
 * server never comes up in an unsafe state (ARCHITECTURE.md §6.5 fail-closed provider
 * guard, TEST_PLAN PRV-01~04, PRV-07). Throwing alone is not enough: Next.js keeps the
 * HTTP listener alive and answers 500, which a hosting health check may treat as "up".
 */
import {
  DatabaseConfigError,
  assertDatabaseMatchesEnv,
  describeDatabase,
} from "./server/config/database-config";
import { ConfigError, describeRuntimeConfig, loadRuntimeConfig } from "./server/config/runtime-config";

try {
  const config = loadRuntimeConfig(process.env);
  console.info("[nazir] runtime config", JSON.stringify(describeRuntimeConfig(config)));
  // Step 2: when a database is configured it must belong to this environment (dev vs test vs shared).
  // DATABASE_URL is not required yet: nothing in the app reads the database before Step 3.
  if (process.env.DATABASE_URL) {
    const db = assertDatabaseMatchesEnv(config.runtimeEnv, process.env.DATABASE_URL);
    console.info("[nazir] database", JSON.stringify(describeDatabase(db)));
  }
} catch (e) {
  if (e instanceof ConfigError || e instanceof DatabaseConfigError) {
    console.error(`[nazir] refusing to start\n${e.message}`);
    process.exit(1);
  }
  throw e;
}
