/**
 * Picks the IdentityProvider for the running environment (A-024, D-013). Mirrors the startup guard and adds its own
 * check: MOCK only in local/test, whatever IDENTITY_PROVIDER says.
 */
import type { RuntimeConfig } from "../../config/runtime-config";
import { MockIdentityProvider, MockProviderNotAllowedError } from "./mock";
import { NiceIdentityProvider } from "./nice";
import type { IdentityProvider } from "./types";

export function createIdentityProvider(config: Pick<RuntimeConfig, "runtimeEnv" | "identity">, appOrigin: string): IdentityProvider {
  if (config.identity.kind === "mock") {
    if (config.runtimeEnv !== "local" && config.runtimeEnv !== "test") throw new MockProviderNotAllowedError(config.runtimeEnv);
    return new MockIdentityProvider(config.runtimeEnv, appOrigin);
  }
  if (config.identity.kind === "nice") return new NiceIdentityProvider();
  throw new Error("unknown identity provider");
}
