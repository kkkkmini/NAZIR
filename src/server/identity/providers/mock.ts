/**
 * Mock IdentityProvider — local/test ONLY (A-024, D-013, A-049).
 *
 * - The constructor itself refuses any runtime other than local/test, independent of the startup guard, so a wrong
 *   environment variable can never produce a working Mock in staging/production.
 * - Rows it creates carry provider = 'MOCK' (never 'NICE'); PRV-06 can find them in any shared database.
 * - Start takes NO identity input from the user. Whatever the Mock later "verifies" comes from fixed fake test data on
 *   the server, never from a DI/CI/name the request supplies, so nobody can claim to be someone else through it.
 * - Deterministic for tests: transaction ids come from the injected random source.
 */
import { randomBytes } from "node:crypto";
import type { IdentityProvider, StartVerificationInput, StartVerificationResult } from "./types";

export class MockProviderNotAllowedError extends Error {
  constructor(runtimeEnv: string) {
    super(`Mock identity provider is not allowed in ${runtimeEnv} (D-013)`);
    this.name = "MockProviderNotAllowedError";
  }
}

export const MOCK_TXN = /^mock_[A-Za-z0-9_-]{22}$/;

export class MockIdentityProvider implements IdentityProvider {
  readonly name = "MOCK" as const;

  constructor(
    runtimeEnv: string,
    private readonly appOrigin: string,
    private readonly random: (n: number) => Buffer = randomBytes,
  ) {
    if (runtimeEnv !== "local" && runtimeEnv !== "test") throw new MockProviderNotAllowedError(runtimeEnv);
  }

  async startVerification(input: StartVerificationInput): Promise<StartVerificationResult> {
    const txn = `mock_${this.random(16).toString("base64url")}`;
    // The mock "authentication page" is a same-origin page (added with the callback step). It is given only the
    // transaction id; the return URL stays in the encrypted context on the server.
    const url = new URL("/identity/mock", this.appOrigin);
    url.searchParams.set("txn", txn);
    return {
      providerTransactionId: txn,
      launch: { type: "redirect", url: url.toString() },
      validForMs: null,
      context: { mock: "1", returnUrl: input.returnUrl, purpose: input.purpose },
    };
  }
}
