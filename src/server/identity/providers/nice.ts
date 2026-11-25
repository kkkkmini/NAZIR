/**
 * NICE adapter placeholder (A-049). Real calls (token, auth URL, result) are NOT implemented in this step: the request
 * and response shapes beyond PROVIDERS.md §2.2 are unconfirmed (E-001) and there is no free test account. Until then
 * it fails closed with ProviderUnavailableError — it never pretends to start a verification.
 */
import type { IdentityProvider, StartVerificationResult, VerificationOutcome } from "./types";
import { ProviderUnavailableError } from "./types";

export class NiceIdentityProvider implements IdentityProvider {
  readonly name = "NICE" as const;
  async startVerification(): Promise<StartVerificationResult> {
    throw new ProviderUnavailableError("nice_not_implemented");
  }
  async completeVerification(): Promise<VerificationOutcome> {
    throw new ProviderUnavailableError("nice_not_implemented");
  }
}
