/**
 * Runtime configuration and provider stage guard.
 *
 * Implements ARCHITECTURE.md §6.5 (A-024, D-013):
 * - Missing or unknown NAZIR_RUNTIME_ENV is treated as `production` (fail-closed).
 * - Production may only run LIVE providers (Toss live keys, NICE operating client).
 * - Mock providers (payment and identity) are allowed only in local/test (A-024).
 *   Staging and production reject them; production rejection is absolute (D-013).
 * - Toss live keys are allowed only in production.
 *
 * This module is pure (no I/O) so it can be unit-tested and reused by the
 * startup hook (src/instrumentation.ts) and the `check:config` script.
 */

export const RUNTIME_ENVS = ["local", "test", "staging", "production"] as const;
export type RuntimeEnv = (typeof RUNTIME_ENVS)[number];

export type PaymentProviderKind = "mock" | "toss";
export type IdentityProviderKind = "mock" | "nice";
export type ProviderStage = "MOCK" | "SANDBOX" | "LIVE";

export interface TossConfig {
  clientKey: string;
  secretKey: string;
  securityKey: string | null;
  keyMode: "test" | "live";
}

export interface NiceConfig {
  clientId: string;
  clientSecret: string;
}

export interface RuntimeConfig {
  runtimeEnv: RuntimeEnv;
  /** true when NAZIR_RUNTIME_ENV was missing/unknown and production was assumed */
  runtimeEnvAssumed: boolean;
  payment: { kind: PaymentProviderKind; stage: ProviderStage; toss: TossConfig | null };
  identity: { kind: IdentityProviderKind; stage: ProviderStage; nice: NiceConfig | null };
  mockControlRoutesEnabled: boolean;
}

export class ConfigError extends Error {
  readonly violations: string[];
  constructor(violations: string[]) {
    super(
      `NAZIR configuration rejected (${violations.length} violation(s)):\n- ` +
        violations.join("\n- "),
    );
    this.name = "ConfigError";
    this.violations = violations;
  }
}

type Env = Record<string, string | undefined>;

function read(env: Env, name: string): string | undefined {
  const v = env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

export function resolveRuntimeEnv(env: Env): { runtimeEnv: RuntimeEnv; assumed: boolean } {
  const raw = read(env, "NAZIR_RUNTIME_ENV");
  if (raw && (RUNTIME_ENVS as readonly string[]).includes(raw)) {
    return { runtimeEnv: raw as RuntimeEnv, assumed: false };
  }
  return { runtimeEnv: "production", assumed: true };
}

const TOSS_CLIENT_KEY = /^(test|live)_ck_[A-Za-z0-9]+$/;
const TOSS_SECRET_KEY = /^(test|live)_sk_[A-Za-z0-9]+$/;

/** Payment widget keys (gck/gsk) cannot call the orderId lookup API, so D-010 forbids them. */
const TOSS_WIDGET_KEY = /^(test|live)_g(ck|sk)_/;

function parseToss(env: Env, runtimeEnv: RuntimeEnv, violations: string[]): TossConfig | null {
  const clientKey = read(env, "TOSS_CLIENT_KEY");
  const secretKey = read(env, "TOSS_SECRET_KEY");
  const securityKey = read(env, "TOSS_SECURITY_KEY") ?? null;

  if (!clientKey || !secretKey) {
    violations.push("PAYMENT_PROVIDER=toss requires TOSS_CLIENT_KEY and TOSS_SECRET_KEY");
    return null;
  }
  if (TOSS_WIDGET_KEY.test(clientKey) || TOSS_WIDGET_KEY.test(secretKey)) {
    violations.push(
      "Toss widget keys (gck/gsk) are not allowed: D-010 requires API individual integration keys (ck/sk)",
    );
    return null;
  }
  const c = TOSS_CLIENT_KEY.exec(clientKey);
  const s = TOSS_SECRET_KEY.exec(secretKey);
  if (!c || !s) {
    violations.push("TOSS_CLIENT_KEY/TOSS_SECRET_KEY must look like test_ck_…/test_sk_… or live_ck_…/live_sk_…");
    return null;
  }
  if (c[1] !== s[1]) {
    violations.push("TOSS_CLIENT_KEY and TOSS_SECRET_KEY must be the same key set (both test_ or both live_)");
    return null;
  }
  const keyMode = c[1] as "test" | "live";

  if (runtimeEnv === "production" && keyMode !== "live") {
    violations.push("production requires Toss live_ keys");
  }
  if (runtimeEnv !== "production" && keyMode === "live") {
    violations.push(`Toss live_ keys are only allowed in production (current: ${runtimeEnv})`);
  }
  if (runtimeEnv === "production" && !securityKey) {
    violations.push("production requires TOSS_SECURITY_KEY (webhook signature verification)");
  }
  return { clientKey, secretKey, securityKey, keyMode };
}

function parseNice(env: Env, runtimeEnv: RuntimeEnv, violations: string[]): NiceConfig | null {
  const clientId = read(env, "NICE_CLIENT_ID");
  const clientSecret = read(env, "NICE_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    violations.push("IDENTITY_PROVIDER=nice requires NICE_CLIENT_ID and NICE_CLIENT_SECRET");
    return null;
  }
  // NICE does not document a test/live key prefix, so each environment declares the
  // client ids it is allowed to use (ARCHITECTURE.md §6.5 item 4).
  const allowed = (read(env, "NICE_ALLOWED_CLIENT_IDS") ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (runtimeEnv === "production" && allowed.length === 0) {
    violations.push("production requires NICE_ALLOWED_CLIENT_IDS");
  }
  if (allowed.length > 0 && !allowed.includes(clientId)) {
    violations.push("NICE_CLIENT_ID is not in NICE_ALLOWED_CLIENT_IDS for this environment");
  }
  return { clientId, clientSecret };
}

function defaultKind<T extends string>(runtimeEnv: RuntimeEnv, mock: T): T | undefined {
  return runtimeEnv === "local" || runtimeEnv === "test" ? mock : undefined;
}

export function loadRuntimeConfig(env: Env = process.env): RuntimeConfig {
  const violations: string[] = [];
  const { runtimeEnv, assumed } = resolveRuntimeEnv(env);

  const paymentRaw = read(env, "PAYMENT_PROVIDER") ?? defaultKind(runtimeEnv, "mock");
  const identityRaw = read(env, "IDENTITY_PROVIDER") ?? defaultKind(runtimeEnv, "mock");

  // ---- payment ----
  let paymentKind: PaymentProviderKind = "mock";
  let toss: TossConfig | null = null;
  if (paymentRaw !== "mock" && paymentRaw !== "toss") {
    violations.push(`PAYMENT_PROVIDER must be "mock" or "toss" (got: ${paymentRaw ?? "unset"})`);
  } else {
    paymentKind = paymentRaw;
    if (paymentKind === "mock" && runtimeEnv !== "local" && runtimeEnv !== "test") {
      violations.push(`Mock payment provider is not allowed in ${runtimeEnv}`);
    }
    if (paymentKind === "toss") toss = parseToss(env, runtimeEnv, violations);
  }

  // ---- identity ----
  let identityKind: IdentityProviderKind = "mock";
  let nice: NiceConfig | null = null;
  if (identityRaw !== "mock" && identityRaw !== "nice") {
    violations.push(`IDENTITY_PROVIDER must be "mock" or "nice" (got: ${identityRaw ?? "unset"})`);
  } else {
    identityKind = identityRaw;
    if (identityKind === "mock" && runtimeEnv === "production") {
      violations.push("Mock identity provider is never allowed in production (D-013)");
    } else if (identityKind === "mock" && runtimeEnv === "staging") {
      violations.push("Mock identity provider is not allowed in staging (A-024)");
    }
    if (identityKind === "nice") nice = parseNice(env, runtimeEnv, violations);
  }

  // When `assumed` is true, production rules above already applied (fail-closed).
  if (violations.length > 0) throw new ConfigError(violations);

  const paymentStage: ProviderStage =
    paymentKind === "mock" ? "MOCK" : toss?.keyMode === "live" ? "LIVE" : "SANDBOX";
  const identityStage: ProviderStage =
    identityKind === "mock" ? "MOCK" : runtimeEnv === "production" ? "LIVE" : "SANDBOX";

  return {
    runtimeEnv,
    runtimeEnvAssumed: assumed,
    payment: { kind: paymentKind, stage: paymentStage, toss },
    identity: { kind: identityKind, stage: identityStage, nice },
    mockControlRoutesEnabled: runtimeEnv === "local" || runtimeEnv === "test",
  };
}

/** Non-secret summary safe to log or expose on a status endpoint. */
export function describeRuntimeConfig(c: RuntimeConfig) {
  return {
    runtimeEnv: c.runtimeEnv,
    runtimeEnvAssumed: c.runtimeEnvAssumed,
    payment: { kind: c.payment.kind, stage: c.payment.stage },
    identity: { kind: c.identity.kind, stage: c.identity.stage },
    mockControlRoutesEnabled: c.mockControlRoutesEnabled,
  };
}
