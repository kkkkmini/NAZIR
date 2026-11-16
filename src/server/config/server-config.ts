import "server-only";
import { loadRuntimeConfig, type RuntimeConfig } from "./runtime-config";

let cached: RuntimeConfig | null = null;

/** Server-side accessor. Throws ConfigError on invalid configuration (same rules as startup). */
export function getRuntimeConfig(): RuntimeConfig {
  if (!cached) cached = loadRuntimeConfig(process.env);
  return cached;
}

/** Mock control routes exist only in local/test (PRV-05). Call at the top of such handlers. */
export function mockControlAllowed(): boolean {
  return getRuntimeConfig().mockControlRoutesEnabled;
}
