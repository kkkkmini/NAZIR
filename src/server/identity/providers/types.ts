/**
 * IdentityProvider contract (A-049). The same contract for the Mock provider and the NICE adapter; nothing NICE-specific
 * (request_no, transaction_id, tokens) appears here — adapters keep such values in their opaque `context`.
 *
 * Start (A-049) and callback completion (A-050). The completion result is the provider-neutral, NORMALISED outcome;
 * adapters drop every field the policy does not need (birthdate, gender, CI, …) before returning.
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

/** What reached the callback endpoint. GET query for MOCK; NICE's method (GET/POST) is unconfirmed (PROVIDERS §2.2). */
export interface CallbackInput {
  query: URLSearchParams;
}

export interface CompleteVerificationInput {
  /** The decrypted per-transaction context this adapter returned at start (plus anything it stored since). */
  context: Record<string, string>;
  callback: CallbackInput;
}

/**
 * Normalised result.
 * - VERIFIED: the provider confirmed a person. `di` is required — there is no CI/phone fallback (A-043).
 * - CANCELED: the user closed/cancelled the provider window.
 * - FAILED: the provider reports a failed verification.
 * A result that fails integrity checks is NOT a FAILED outcome: the adapter throws ProviderRejectedError.
 */
export type VerificationOutcome =
  | { kind: "VERIFIED"; di: string; name: string; phone: string }
  | { kind: "CANCELED" }
  | { kind: "FAILED" };

export interface IdentityProvider {
  readonly name: ProviderName;
  startVerification(input: StartVerificationInput): Promise<StartVerificationResult>;
  completeVerification(input: CompleteVerificationInput): Promise<VerificationOutcome>;
}
