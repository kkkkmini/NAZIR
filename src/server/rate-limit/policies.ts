/**
 * Rate limit policies (A-045). Numbers are NOT confirmed policy (DECISIONS Q-013 is "권장" only): every value here is a
 * draft default that NAZIR_RATE_LIMIT_POLICIES can override without a code change, e.g.
 *   NAZIR_RATE_LIMIT_POLICIES="identity.start.ip=10/600,identity.start.binding=5/600"
 * (`<policy>=<limit>/<window seconds>`). A registered policy with no draft and no configured value cannot be used:
 * `resolvePolicy` throws, and callers fail closed.
 */
type Env = Record<string, string | undefined>;

export interface RateLimitPolicy {
  name: string;
  limit: number;
  windowMs: number;
}

/** The fixed registry: a counter can only be written for one of these names (also guarded by a DB CHECK on shape). */
export const POLICY_DRAFTS = {
  /** Q-013 draft: identity start per IP, 10 per 10 minutes. */
  "identity.start.ip": { limit: 10, windowSec: 600 },
  /** Q-013 names this dimension (API_SPEC §7) but gives no number: must be configured. */
  "identity.start.binding": null,
  /** D-015 / Q-013 draft: orders per BOOKING session = 3 (window = the 30-minute session). */
  "order.create.session": { limit: 3, windowSec: 1800 },
  /** D-015 / Q-013 draft: orders per identity subject and show session = 5 per hour. */
  "order.create.subject_session": { limit: 5, windowSec: 3600 },
} as const satisfies Record<string, { limit: number; windowSec: number } | null>;

export type PolicyName = keyof typeof POLICY_DRAFTS;

export class RateLimitConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitConfigError";
  }
}

const MAX_WINDOW_SEC = 7 * 24 * 3600;

export function parsePolicyOverrides(env: Env): Map<PolicyName, RateLimitPolicy> {
  const out = new Map<PolicyName, RateLimitPolicy>();
  const raw = env.NAZIR_RATE_LIMIT_POLICIES?.trim();
  if (!raw) return out;
  for (const entry of raw.split(",")) {
    const m = /^\s*([a-z][a-z0-9_.]*)=(\d{1,6})\/(\d{1,7})\s*$/.exec(entry);
    if (!m) throw new RateLimitConfigError('NAZIR_RATE_LIMIT_POLICIES entries must be "<policy>=<limit>/<window seconds>"');
    const name = m[1] as PolicyName;
    if (!(name in POLICY_DRAFTS)) throw new RateLimitConfigError(`NAZIR_RATE_LIMIT_POLICIES: unknown policy ${m[1]}`);
    if (out.has(name)) throw new RateLimitConfigError(`NAZIR_RATE_LIMIT_POLICIES: ${name} appears twice`);
    const limit = Number(m[2]);
    const windowSec = Number(m[3]);
    if (limit < 1 || windowSec < 1 || windowSec > MAX_WINDOW_SEC)
      throw new RateLimitConfigError(`NAZIR_RATE_LIMIT_POLICIES: ${name} needs limit >= 1 and 1..${MAX_WINDOW_SEC} seconds`);
    out.set(name, { name, limit, windowMs: windowSec * 1000 });
  }
  return out;
}

export function resolvePolicy(name: PolicyName, overrides: Map<PolicyName, RateLimitPolicy>): RateLimitPolicy {
  const o = overrides.get(name);
  if (o) return o;
  const d = POLICY_DRAFTS[name];
  if (!d) throw new RateLimitConfigError(`rate limit policy ${name} has no value (set NAZIR_RATE_LIMIT_POLICIES)`);
  return { name, limit: d.limit, windowMs: d.windowSec * 1000 };
}
