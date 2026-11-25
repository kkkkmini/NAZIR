/**
 * IdentityProvider contract (A-049). The same contract for the Mock provider and the NICE adapter; nothing NICE-specific
 * (request_no, transaction_id, tokens) appears here — adapters keep such values in their opaque `context`.
 *
 * This step covers START only. Callback/result normalisation (VERIFIED/FAILED, DI, name, phone) is added with the
 * callback step and is deliberately not declared yet, so no shape is guessed before the NICE contract is confirmed.
 */
export type ProviderName = "MOCK" | "NICE";
export type VerificationPurpose = "BOOKING" | "LOOKUP";

export interface StartVerificationInput {
  /** Our verification id (uuid). Adapters may derive their own request number from it. */
  verificationId: string;
  purpose: VerificationPurpose;
  /** Absolute callback URL decided by the SERVER (API_SPEC §3.4). Never taken from the client. */
  returnUrl: string;
}

export interface StartVerificationResult {
  /** The provider's id for this transaction (stored in provider_transaction_id, unique per provider). */
  providerTransactionId: string;
  /** What the browser opens. Always an absolute https URL on the provider's own host (or the app origin for MOCK). */
  launch: { type: "redirect"; url: string };
  /** How long the provider says this transaction is valid, if it says so. The server uses min(this, its own TTL). */
  validForMs: number | null;
  /** Per-transaction values the adapter needs at callback time. Encrypted at rest; no fixed secrets, no personal data. */
  context: Record<string, string>;
}

/** The provider could not be reached / is not configured / timed out. Safe to retry later. → 503 PROVIDER_UNAVAILABLE */
export class ProviderUnavailableError extends Error {
  constructor(readonly reason: string) {
    super("identity provider unavailable");
    this.name = "ProviderUnavailableError";
  }
}

/** The provider answered but refused or returned something unusable. → 502 IDENTITY_START_FAILED */
export class ProviderRejectedError extends Error {
  constructor(readonly reason: string) {
    super("identity provider rejected the start request");
    this.name = "ProviderRejectedError";
  }
}

export interface IdentityProvider {
  readonly name: ProviderName;
  startVerification(input: StartVerificationInput): Promise<StartVerificationResult>;
}
