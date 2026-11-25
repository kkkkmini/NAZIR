/**
 * IDP-U01~U05 (A-049): IdentityProvider selection and the Mock provider's environment fence.
 */
import { describe, expect, it } from "vitest";
import { ConfigError, loadRuntimeConfig } from "@/server/config/runtime-config";
import { createIdentityProvider } from "@/server/identity/providers/factory";
import { MOCK_TXN, MockIdentityProvider, MockProviderNotAllowedError } from "@/server/identity/providers/mock";
import { NiceIdentityProvider } from "@/server/identity/providers/nice";
import { ProviderUnavailableError } from "@/server/identity/providers/types";

const ORIGIN = "http://localhost:3000";
const mockCfg = (runtimeEnv: string) => ({ runtimeEnv, identity: { kind: "mock", stage: "MOCK", nice: null } }) as never;

describe("IDP-U01 Mock runs in local and test", () => {
  it.each(["local", "test"])("%s: start returns a mock transaction on our own origin; no identity input is taken", async (env) => {
    const p = createIdentityProvider(mockCfg(env), ORIGIN);
    expect(p.name).toBe("MOCK");
    const r = await p.startVerification({ verificationId: "00000000-0000-4000-8000-000000000001", purpose: "BOOKING", returnUrl: `${ORIGIN}/api/v1/identity-verifications/callback/mock?state=s` });
    expect(r.providerTransactionId).toMatch(MOCK_TXN);
    expect(new URL(r.launch.url).origin).toBe(ORIGIN);
    expect(r.launch.url).not.toContain("state=");
    expect(r.context).toEqual({ mock: "1", returnUrl: `${ORIGIN}/api/v1/identity-verifications/callback/mock?state=s`, purpose: "BOOKING" });
  });
  it("deterministic with an injected random source", async () => {
    const p = new MockIdentityProvider("test", ORIGIN, (n) => Buffer.alloc(n, 7));
    const a = await p.startVerification({ verificationId: "x", purpose: "LOOKUP", returnUrl: `${ORIGIN}/cb` });
    const b = await p.startVerification({ verificationId: "y", purpose: "LOOKUP", returnUrl: `${ORIGIN}/cb` });
    expect(a.providerTransactionId).toBe(b.providerTransactionId);
  });
});

describe("IDP-U02/03 Mock is refused in staging and production — by the factory AND by the class itself", () => {
  it.each(["staging", "production", "", "prod", "Production"])("%j", (env) => {
    expect(() => createIdentityProvider(mockCfg(env), ORIGIN)).toThrow(MockProviderNotAllowedError);
    expect(() => new MockIdentityProvider(env, ORIGIN)).toThrow(MockProviderNotAllowedError);
  });
  it("the startup guard refuses Mock outside local/test and treats a missing environment as production (PRV-01/02)", () => {
    for (const env of [{ NAZIR_RUNTIME_ENV: "production", IDENTITY_PROVIDER: "mock", PAYMENT_PROVIDER: "mock" }, { NAZIR_RUNTIME_ENV: "staging", IDENTITY_PROVIDER: "mock", PAYMENT_PROVIDER: "mock" }, { IDENTITY_PROVIDER: "mock", PAYMENT_PROVIDER: "mock" }])
      expect(() => loadRuntimeConfig(env)).toThrow(ConfigError);
  });
});

describe("IDP-U04 bad provider configuration is refused", () => {
  it.each(["MOCK", "nice-live", "fake", "none"])("IDENTITY_PROVIDER=%s", (v) => {
    expect(() => loadRuntimeConfig({ NAZIR_RUNTIME_ENV: "local", IDENTITY_PROVIDER: v, PAYMENT_PROVIDER: "mock" })).toThrow(ConfigError);
  });
  it("an unknown kind reaching the factory throws", () => {
    expect(() => createIdentityProvider({ runtimeEnv: "local", identity: { kind: "other" } } as never, ORIGIN)).toThrow();
  });
});

describe("IDP-U05 NICE adapter fails closed until implemented", () => {
  it("startVerification → ProviderUnavailableError (never a fake success)", async () => {
    await expect(new NiceIdentityProvider().startVerification()).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
