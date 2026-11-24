/**
 * Versioned secret keyrings and the app origin (DECISIONS A-043, A-044).
 *
 * Every keyring comes from its own environment variables, so CSRF, subject (DI) HMAC and personal-data encryption keys
 * can never share a key:
 *   <PREFIX>_KEYS         = "v1:<base64url>,v2:<base64url>"  (every version still accepted for verification/decryption)
 *   <PREFIX>_KEY_CURRENT  = "v2"                              (the version used to sign/encrypt new values)
 * Each key must decode to at least 32 bytes. The same key bytes under two names (or two versions) are refused.
 *
 * Pure (no I/O, no logging of values): errors name the variable, never the value.
 */

export class SecretConfigError extends Error {
  readonly violations: string[];
  constructor(violations: string[]) {
    super(`NAZIR secret configuration rejected (${violations.length} violation(s)):\n- ` + violations.join("\n- "));
    this.name = "SecretConfigError";
    this.violations = violations;
  }
}

type Env = Record<string, string | undefined>;

export interface Keyring {
  /** Variable prefix, e.g. NAZIR_CSRF — for error messages only. */
  readonly name: string;
  readonly currentVersion: string;
  /** Raw key bytes by version. Never log. */
  readonly keys: ReadonlyMap<string, Buffer>;
}

export const MIN_KEY_BYTES = 32;
const VERSION = /^v[1-9][0-9]{0,3}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

function read(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

/** Returns null when neither variable is set (the caller decides whether that is allowed). */
export function parseKeyring(env: Env, prefix: string, violations: string[]): Keyring | null {
  const keysVar = `${prefix}_KEYS`;
  const currentVar = `${prefix}_KEY_CURRENT`;
  const rawKeys = read(env, keysVar);
  const current = read(env, currentVar);
  if (!rawKeys && !current) return null;
  if (!rawKeys || !current) {
    violations.push(`${keysVar} and ${currentVar} must be set together`);
    return null;
  }
  const keys = new Map<string, Buffer>();
  let ok = true;
  for (const entry of rawKeys.split(",")) {
    const idx = entry.indexOf(":");
    const version = idx > 0 ? entry.slice(0, idx).trim() : "";
    const material = idx > 0 ? entry.slice(idx + 1).trim() : "";
    if (!VERSION.test(version)) {
      violations.push(`${keysVar}: each entry must be "v<N>:<base64url key>"`);
      ok = false;
      continue;
    }
    if (keys.has(version)) {
      violations.push(`${keysVar}: version ${version} appears twice`);
      ok = false;
      continue;
    }
    const bytes = B64URL.test(material) ? Buffer.from(material, "base64url") : Buffer.alloc(0);
    if (bytes.length < MIN_KEY_BYTES) {
      violations.push(`${keysVar}: key ${version} must be base64url and at least ${MIN_KEY_BYTES} bytes`);
      ok = false;
      continue;
    }
    for (const [other, b] of keys) {
      if (b.equals(bytes)) {
        violations.push(`${keysVar}: keys ${other} and ${version} are identical`);
        ok = false;
      }
    }
    keys.set(version, bytes);
  }
  if (ok && !keys.has(current)) {
    violations.push(`${currentVar} names a version that is not in ${keysVar}`);
    ok = false;
  }
  return ok ? { name: prefix, currentVersion: current, keys } : null;
}

/** Refuses the same key bytes in two different keyrings (A-043: CSRF / subject HMAC / encryption keys are separate). */
export function assertDistinctKeyrings(rings: Keyring[], violations: string[]): void {
  for (let i = 0; i < rings.length; i++)
    for (let j = i + 1; j < rings.length; j++)
      for (const a of rings[i].keys.values())
        for (const b of rings[j].keys.values())
          if (a.equals(b)) violations.push(`${rings[i].name} and ${rings[j].name} must not share a key`);
}

/**
 * NAZIR_APP_ORIGIN: the single exact origin allowed for state-changing requests (API_SPEC §3.3).
 * - production/staging: must be https, no path, no wildcard.
 * - local/test: https, or http only for localhost / 127.0.0.1 (browsers treat these as secure contexts, so
 *   `__Host-`/Secure cookies still work — no cookie attribute is relaxed).
 */
export function parseAppOrigin(env: Env, runtimeEnv: string, violations: string[]): string | null {
  const raw = read(env, "NAZIR_APP_ORIGIN");
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    violations.push("NAZIR_APP_ORIGIN must be an absolute origin like https://tickets.example.com");
    return null;
  }
  if (url.origin !== raw || raw.includes("*")) {
    violations.push("NAZIR_APP_ORIGIN must be exactly an origin (scheme://host[:port], no path or trailing slash)");
    return null;
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const devEnv = runtimeEnv === "local" || runtimeEnv === "test";
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && devEnv && loopback) return url.origin;
  violations.push(
    devEnv
      ? "NAZIR_APP_ORIGIN must be https, or http://localhost / http://127.0.0.1 in local/test"
      : `NAZIR_APP_ORIGIN must be https in ${runtimeEnv}`,
  );
  return null;
}

export interface SecurityConfig {
  appOrigin: string;
  csrfKeys: Keyring;
}

/**
 * Bootstrap/CSRF security settings.
 * - Malformed values are refused in every environment.
 * - Missing values are refused at startup in staging/production (`requireAll`). In local/test the server may start
 *   without them, but every request that needs them fails closed (500), never with a default key or origin.
 */
export function loadSecurityConfig(env: Env, runtimeEnv: string): SecurityConfig {
  const violations: string[] = [];
  const appOrigin = parseAppOrigin(env, runtimeEnv, violations);
  const csrfKeys = parseKeyring(env, "NAZIR_CSRF", violations);
  if (violations.length === 0) {
    if (!appOrigin) violations.push("NAZIR_APP_ORIGIN is required");
    if (!csrfKeys) violations.push("NAZIR_CSRF_KEYS and NAZIR_CSRF_KEY_CURRENT are required");
  }
  if (violations.length > 0) throw new SecretConfigError(violations);
  return { appOrigin: appOrigin!, csrfKeys: csrfKeys! };
}

/** Startup check (src/instrumentation-node.ts, check:config). */
export function assertStartupSecurityConfig(env: Env, runtimeEnv: string): void {
  const strict = runtimeEnv === "staging" || runtimeEnv === "production";
  const violations: string[] = [];
  parseAppOrigin(env, runtimeEnv, violations);
  parseKeyring(env, "NAZIR_CSRF", violations);
  if (violations.length > 0) throw new SecretConfigError(violations);
  if (strict) loadSecurityConfig(env, runtimeEnv);
}
