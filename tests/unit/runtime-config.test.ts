import { describe, expect, it } from "vitest";
import { ConfigError, loadRuntimeConfig } from "@/server/config/runtime-config";

const TOSS_TEST = { TOSS_CLIENT_KEY: "test_ck_abc123", TOSS_SECRET_KEY: "test_sk_abc123" };
const TOSS_LIVE = {
  TOSS_CLIENT_KEY: "live_ck_abc123",
  TOSS_SECRET_KEY: "live_sk_abc123",
  TOSS_SECURITY_KEY: "sec_dummy",
};
const NICE = {
  NICE_CLIENT_ID: "nice-prod-client",
  NICE_CLIENT_SECRET: "dummy",
  NICE_ALLOWED_CLIENT_IDS: "nice-prod-client",
};
const PROD_OK = {
  NAZIR_RUNTIME_ENV: "production",
  PAYMENT_PROVIDER: "toss",
  IDENTITY_PROVIDER: "nice",
  ...TOSS_LIVE,
  ...NICE,
};

function violationsOf(env: Record<string, string>): string[] {
  try {
    loadRuntimeConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) return e.violations;
    throw e;
  }
  return [];
}

describe("provider stage guard (ARCHITECTURE §6.5)", () => {
  it("accepts a correct production configuration as LIVE/LIVE", () => {
    const c = loadRuntimeConfig(PROD_OK);
    expect(c.runtimeEnv).toBe("production");
    expect(c.payment.stage).toBe("LIVE");
    expect(c.identity.stage).toBe("LIVE");
    expect(c.mockControlRoutesEnabled).toBe(false);
  });

  it("PRV-01: missing NAZIR_RUNTIME_ENV is treated as production and rejects Mock", () => {
    const v = violationsOf({ PAYMENT_PROVIDER: "mock", IDENTITY_PROVIDER: "mock" });
    expect(v.join("\n")).toMatch(/Mock payment provider is not allowed in production/);
    expect(v.join("\n")).toMatch(/Mock identity provider is never allowed in production/);
  });

  it("PRV-01: missing NAZIR_RUNTIME_ENV with nothing configured fails (no silent mock default)", () => {
    expect(violationsOf({}).length).toBeGreaterThan(0);
  });

  it("PRV-01: unknown NAZIR_RUNTIME_ENV value is treated as production", () => {
    const v = violationsOf({ NAZIR_RUNTIME_ENV: "prod", PAYMENT_PROVIDER: "mock", IDENTITY_PROVIDER: "nice", ...NICE });
    expect(v.join("\n")).toMatch(/not allowed in production/);
  });

  it("PRV-02: production with Mock payment fails", () => {
    expect(violationsOf({ ...PROD_OK, PAYMENT_PROVIDER: "mock" }).join("\n")).toMatch(/Mock payment/);
  });

  it("PRV-02: production with Mock identity fails (D-013)", () => {
    expect(violationsOf({ ...PROD_OK, IDENTITY_PROVIDER: "mock" }).join("\n")).toMatch(/Mock identity/);
  });

  it("PRV-03: production with Toss test_ keys fails", () => {
    expect(violationsOf({ ...PROD_OK, ...TOSS_TEST }).join("\n")).toMatch(/requires Toss live_ keys/);
  });

  it("PRV-03: mismatched Toss key set fails", () => {
    const v = violationsOf({ ...PROD_OK, TOSS_SECRET_KEY: "test_sk_abc123" });
    expect(v.join("\n")).toMatch(/same key set/);
  });

  it("PRV-03: Toss widget keys (gck/gsk) are rejected (D-010)", () => {
    const v = violationsOf({ ...PROD_OK, TOSS_CLIENT_KEY: "live_gck_abc", TOSS_SECRET_KEY: "live_gsk_abc" });
    expect(v.join("\n")).toMatch(/widget keys/);
  });

  it("PRV-03: production without Toss security key fails", () => {
    const { TOSS_SECURITY_KEY: _omit, ...rest } = PROD_OK;
    void _omit;
    expect(violationsOf(rest).join("\n")).toMatch(/TOSS_SECURITY_KEY/);
  });

  const STAGING_NICE = {
    NICE_CLIENT_ID: "nice-stg-client",
    NICE_CLIENT_SECRET: "dummy",
    NICE_ALLOWED_CLIENT_IDS: "nice-stg-client",
  };

  it("PRV-04: staging with Toss live_ keys fails", () => {
    const v = violationsOf({
      NAZIR_RUNTIME_ENV: "staging",
      PAYMENT_PROVIDER: "toss",
      IDENTITY_PROVIDER: "nice",
      ...TOSS_LIVE,
      ...STAGING_NICE,
    });
    expect(v.join("\n")).toMatch(/only allowed in production/);
  });

  it("staging: Mock payment and Mock identity are both rejected (A-024)", () => {
    const v = violationsOf({ NAZIR_RUNTIME_ENV: "staging", PAYMENT_PROVIDER: "mock", IDENTITY_PROVIDER: "mock" }).join("\n");
    expect(v).toMatch(/Mock payment provider is not allowed in staging/);
    expect(v).toMatch(/Mock identity provider is not allowed in staging/);
    expect(
      violationsOf({ NAZIR_RUNTIME_ENV: "staging", PAYMENT_PROVIDER: "toss", IDENTITY_PROVIDER: "mock", ...TOSS_TEST }).join("\n"),
    ).toMatch(/Mock identity provider is not allowed in staging/);
  });

  it("staging: Toss test keys + NICE is accepted as SANDBOX/SANDBOX", () => {
    const c = loadRuntimeConfig({
      NAZIR_RUNTIME_ENV: "staging",
      PAYMENT_PROVIDER: "toss",
      IDENTITY_PROVIDER: "nice",
      ...TOSS_TEST,
      ...STAGING_NICE,
    });
    expect(c.payment.stage).toBe("SANDBOX");
    expect(c.identity.stage).toBe("SANDBOX");
    expect(c.mockControlRoutesEnabled).toBe(false);
  });

  it("PRV-05: Mock control routes are enabled only in local/test", () => {
    expect(loadRuntimeConfig({ NAZIR_RUNTIME_ENV: "local" }).mockControlRoutesEnabled).toBe(true);
    expect(loadRuntimeConfig({ NAZIR_RUNTIME_ENV: "test" }).mockControlRoutesEnabled).toBe(true);
    expect(loadRuntimeConfig(PROD_OK).mockControlRoutesEnabled).toBe(false);
  });

  it("PRV-07: production with NICE settings missing fails", () => {
    const v = violationsOf({ ...PROD_OK, NICE_CLIENT_SECRET: "" });
    expect(v.join("\n")).toMatch(/NICE_CLIENT_ID and NICE_CLIENT_SECRET/);
  });

  it("PRV-07: production NICE client id must be in the environment allow-list", () => {
    expect(violationsOf({ ...PROD_OK, NICE_ALLOWED_CLIENT_IDS: "" }).join("\n")).toMatch(/NICE_ALLOWED_CLIENT_IDS/);
    expect(violationsOf({ ...PROD_OK, NICE_ALLOWED_CLIENT_IDS: "other" }).join("\n")).toMatch(/not in NICE_ALLOWED/);
  });

  it("local defaults to Mock providers", () => {
    const c = loadRuntimeConfig({ NAZIR_RUNTIME_ENV: "local" });
    expect(c.payment.kind).toBe("mock");
    expect(c.identity.kind).toBe("mock");
  });

  it("local rejects Toss live_ keys", () => {
    const v = violationsOf({ NAZIR_RUNTIME_ENV: "local", PAYMENT_PROVIDER: "toss", ...TOSS_LIVE });
    expect(v.join("\n")).toMatch(/only allowed in production/);
  });

  it("error messages never contain secret values", () => {
    try {
      loadRuntimeConfig({ ...PROD_OK, TOSS_SECRET_KEY: "test_sk_SUPERSECRET" });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("SUPERSECRET");
    }
  });
});
