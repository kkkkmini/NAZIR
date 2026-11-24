import "server-only";
import { getRuntimeConfig } from "../config/server-config";
import { loadSecurityConfig, type SecurityConfig } from "../lib/secrets";

let cached: SecurityConfig | null = null;

/** Lazily loaded so a missing key in local/test becomes a fail-closed 500 on use, not a crash at import. */
export function getSecurityConfig(): SecurityConfig {
  if (!cached) cached = loadSecurityConfig(process.env, getRuntimeConfig().runtimeEnv);
  return cached;
}
