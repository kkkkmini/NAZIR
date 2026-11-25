/**
 * RL-U01~U08 (A-045): trusted client IP, policy values, configuration, service outcomes with a fake store.
 * The real atomic SQL is tested against PostgreSQL in tests/contract/schema/rate-limit.test.ts.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ClientIpUnavailableError, normalizeIp, parseClientIpSource, resolveClientIp } from "@/server/rate-limit/client-ip";
import { assertStartupRateLimitConfig, loadRateLimitConfig } from "@/server/rate-limit/config";
import { CONFIRMED_POLICIES, POLICY_DRAFTS, RateLimitConfigError, parsePolicyOverrides, resolvePolicy } from "@/server/rate-limit/policies";
import { RateLimitUnavailableError, RateLimiter, rateLimitKey } from "@/server/rate-limit/service";
import type { SqlExecutor } from "@/server/rate-limit/store";
import { AppError, ERROR_STATUS } from "@/server/lib/errors";
import { SecretConfigError, parseKeyring } from "@/server/lib/secrets";

const k = () => randomBytes(32).toString("base64url");
const RL = k();
const CSRF = k();
const PROD = {
  NAZIR_RATE_LIMIT_KEYS: `v1:${RL}`,
  NAZIR_RATE_LIMIT_KEY_CURRENT: "v1",
  NAZIR_CSRF_KEYS: `v1:${CSRF}`,
  NAZIR_CSRF_KEY_CURRENT: "v1",
  NAZIR_CLIENT_IP_SOURCE: "vercel",
};
const keys = parseKeyring(PROD, "NAZIR_RATE_LIMIT", [])!;
const violations = (fn: () => unknown) => {
  try {
    fn();
    return [];
  } catch (e) {
    if (e instanceof SecretConfigError) return e.violations;
    throw e;
  }
};

describe("RL-U01 trusted client IP", () => {
  const vercel = { kind: "vercel" } as const;
  it("uses only x-vercel-forwarded-for; spoofable headers are ignored", () => {
    const h = new Headers({ "x-vercel-forwarded-for": "203.0.113.7", "x-forwarded-for": "1.1.1.1", "x-real-ip": "2.2.2.2" });
    expect(resolveClientIp(h, vercel)).toBe("203.0.113.7");
    expect(() => resolveClientIp(new Headers({ "x-forwarded-for": "1.1.1.1", "x-real-ip": "2.2.2.2" }), vercel)).toThrow(ClientIpUnavailableError);
  });
  it.each(["", "not-an-ip", "203.0.113.7, 10.0.0.1", "999.1.1.1"])("refuses %j (fail-closed, no guessing)", (v) => {
    expect(() => resolveClientIp(new Headers({ "x-vercel-forwarded-for": v }), vercel)).toThrow(ClientIpUnavailableError);
  });
  it("A-047: addresses in one /64 share a bucket, other /64s do not, IPv4 stays /32", () => {
    const v = (ip: string) => resolveClientIp(new Headers({ "x-vercel-forwarded-for": ip }), vercel);
    // privacy (temporary) addresses rotate the interface id inside the same /64
    expect(v("2001:db8:1:2:a1b2:c3d4:e5f6:7788")).toBe(v("2001:db8:1:2::1"));
    expect(v("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe(v("2001:0db8:0001:0002:0000:0000:0000:0000"));
    expect(v("2001:db8:1:3::1")).not.toBe(v("2001:db8:1:2::1"));
    expect(v("2001:db8:2:2::1")).not.toBe(v("2001:db8:1:2::1"));
    expect(v("::ffff:203.0.113.9")).toBe(v("203.0.113.9"));
    expect(v("::ffff:cb00:7109")).toBe("203.0.113.9");
    expect(v("0:0:0:0:0:ffff:cb00:710a")).toBe("203.0.113.10");
    expect(v("203.0.113.9")).not.toBe(v("203.0.113.10"));
  });
  it("IPv6 is reduced to /64; mapped IPv4 becomes IPv4", () => {
    expect(normalizeIp("2001:db8:abcd:12:1:2:3:4")).toBe("2001:db8:abcd:12::/64");
    expect(normalizeIp("2001:DB8:ABCD:0012::9")).toBe("2001:db8:abcd:12::/64");
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(normalizeIp("::ffff:198.51.100.2")).toBe("198.51.100.2");
  });
  it("fixed source: local/test only, explicit valid address; staging/production must be vercel", () => {
    expect(resolveClientIp(new Headers({ "x-vercel-forwarded-for": "1.2.3.4" }), parseClientIpSource({ NAZIR_CLIENT_IP_SOURCE: "fixed", NAZIR_CLIENT_IP_FIXED: "127.0.0.1" }, "test"))).toBe("127.0.0.1");
    expect(() => parseClientIpSource({ NAZIR_CLIENT_IP_SOURCE: "fixed", NAZIR_CLIENT_IP_FIXED: "127.0.0.1" }, "production")).toThrow();
    expect(() => parseClientIpSource({ NAZIR_CLIENT_IP_SOURCE: "fixed" }, "local")).toThrow();
    expect(() => parseClientIpSource({}, "local")).toThrow();
    expect(() => parseClientIpSource({ NAZIR_CLIENT_IP_SOURCE: "x-forwarded-for" }, "local")).toThrow();
  });
});

describe("RL-U02 policy values are configuration, not code", () => {
  it("confirmed identity-start values (A-047) and drafts resolve", () => {
    expect(resolvePolicy("identity.start.ip", new Map())).toEqual({ name: "identity.start.ip", limit: 60, windowMs: 600_000 });
    expect(resolvePolicy("identity.start.binding", new Map())).toEqual({ name: "identity.start.binding", limit: 5, windowMs: 600_000 });
    expect(CONFIRMED_POLICIES).toEqual(["identity.start.ip", "identity.start.binding"]);
    expect(POLICY_DRAFTS["order.create.session"]).toEqual({ limit: 3, windowSec: 1800 });
    const o = parsePolicyOverrides({ NAZIR_RATE_LIMIT_POLICIES: "identity.start.binding=5/600, identity.start.ip=3/60" });
    expect(resolvePolicy("identity.start.binding", o)).toEqual({ name: "identity.start.binding", limit: 5, windowMs: 600_000 });
    expect(resolvePolicy("identity.start.ip", o).limit).toBe(3);
  });
  it.each(["x=1/1", "identity.start.ip=0/60", "identity.start.ip=5/0", "identity.start.ip=5", "identity.start.ip=1/60,identity.start.ip=2/60", "identity.start.ip=1/9999999"])(
    "refuses %j",
    (v) => expect(() => parsePolicyOverrides({ NAZIR_RATE_LIMIT_POLICIES: v })).toThrow(RateLimitConfigError),
  );
});

describe("RL-U03 configuration (fail-closed)", () => {
  it("production/staging need the keyring and vercel IP source", () => {
    expect(violations(() => assertStartupRateLimitConfig(PROD, "production"))).toEqual([]);
    expect(violations(() => assertStartupRateLimitConfig({ ...PROD, NAZIR_RATE_LIMIT_KEYS: "" , NAZIR_RATE_LIMIT_KEY_CURRENT: ""}, "staging")).length).toBe(1);
    expect(violations(() => assertStartupRateLimitConfig({ ...PROD, NAZIR_CLIENT_IP_SOURCE: "" }, "production")).length).toBe(1);
  });
  it("the rate limit key must differ from the CSRF key", () => {
    const v = violations(() => assertStartupRateLimitConfig({ ...PROD, NAZIR_RATE_LIMIT_KEYS: `v1:${CSRF}` }, "local"));
    expect(v).toEqual(["NAZIR_CSRF and NAZIR_RATE_LIMIT must not share a key"]);
  });
  it("local/test start without values but cannot load them (use fails closed)", () => {
    expect(violations(() => assertStartupRateLimitConfig({}, "local"))).toEqual([]);
    expect(violations(() => loadRateLimitConfig({}, "test")).length).toBeGreaterThan(0);
    expect(violations(() => assertStartupRateLimitConfig({ NAZIR_CLIENT_IP_SOURCE: "bogus" }, "local")).length).toBe(1);
    expect(JSON.stringify(violations(() => assertStartupRateLimitConfig({ NAZIR_RATE_LIMIT_KEYS: `v1:${RL}x!`, NAZIR_RATE_LIMIT_KEY_CURRENT: "v1" }, "local")))).not.toContain(RL);
  });
});

describe("RL-U04 keys never contain the identifier", () => {
  it("HMAC key is versioned, deterministic, policy- and dimension-separated, and hides the IP", () => {
    const a = rateLimitKey(keys, "identity.start.ip", [["ip", "203.0.113.7"]]);
    expect(a).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/);
    expect(a).not.toContain("203");
    expect(rateLimitKey(keys, "identity.start.ip", [["ip", "203.0.113.7"]])).toBe(a);
    expect(rateLimitKey(keys, "order.create.session", [["ip", "203.0.113.7"]])).not.toBe(a);
    expect(rateLimitKey(keys, "identity.start.ip", [["binding", "203.0.113.7"]])).not.toBe(a);
    expect(rateLimitKey(keys, "identity.start.ip", [["ip", "203.0.113.8"]])).not.toBe(a);
    // no ambiguity between part boundaries
    expect(rateLimitKey(keys, "p", [["a", "x&b=y"]])).not.toBe(rateLimitKey(keys, "p", [["a", "x"], ["b", "y"]]));
  });
});

describe("RL-U05 service outcomes", () => {
  const fake = (count: number): SqlExecutor => async () => [{ count, nowMs: BigInt(1_000_000), expiresAtMs: BigInt(1_059_001) }] as never;
  const limiter = (exec: SqlExecutor) => new RateLimiter({ exec, keys, policies: parsePolicyOverrides({ NAZIR_RATE_LIMIT_POLICIES: "identity.start.ip=3/60" }) });

  it("allowed with remaining; rejected with retryAt and Retry-After from DB time", async () => {
    expect(await limiter(fake(1)).consume("identity.start.ip", [["ip", "1.2.3.4"]])).toMatchObject({ allowed: true, remaining: 2, retryAt: null });
    expect(await limiter(fake(3)).consume("identity.start.ip", [["ip", "1.2.3.4"]])).toMatchObject({ allowed: true, remaining: 0 });
    const d = await limiter(fake(4)).consume("identity.start.ip", [["ip", "1.2.3.4"]]);
    expect(d).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 60 });
    expect(d.retryAt!.getTime()).toBe(1_059_001);
  });

  it("429 RATE_LIMITED for the user's limit vs 503 RATE_LIMIT_UNAVAILABLE for a store failure", async () => {
    const err = async (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof AppError ? `${e.code}:${e.status}` : String(e)));
    expect(await err(limiter(fake(4)).enforce("identity.start.ip", [["ip", "1.2.3.4"]]))).toBe("RATE_LIMITED:429");
    const broken: SqlExecutor = async () => {
      throw new Error("connection refused 203.0.113.7");
    };
    await expect(limiter(broken).consume("identity.start.ip", [["ip", "1.2.3.4"]])).rejects.toBeInstanceOf(RateLimitUnavailableError);
    expect(await err(limiter(broken).enforce("identity.start.ip", [["ip", "1.2.3.4"]]))).toBe("RATE_LIMIT_UNAVAILABLE:503");
    expect(ERROR_STATUS.RATE_LIMIT_UNAVAILABLE).toBe(503);
    // an invalid key part (configuration/programming error) is unavailable (fail-closed), not unlimited
    expect(await err(limiter(fake(1)).enforce("identity.start.binding", [["Bad-Dim", "x"]]))).toBe("RATE_LIMIT_UNAVAILABLE:503");
    // malformed store answers fail closed too
    expect(await err(limiter(async () => [] as never).enforce("identity.start.ip", [["ip", "1.2.3.4"]]))).toBe("RATE_LIMIT_UNAVAILABLE:503");
  });
});
