/**
 * Validates the current environment's configuration with the same rules the server
 * applies at startup. Use before deploying: `npm run check:config`.
 * Prints only non-secret information.
 */
import { ConfigError, describeRuntimeConfig, loadRuntimeConfig } from "../src/server/config/runtime-config";

try {
  const c = loadRuntimeConfig(process.env);
  console.log(JSON.stringify(describeRuntimeConfig(c), null, 2));
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
