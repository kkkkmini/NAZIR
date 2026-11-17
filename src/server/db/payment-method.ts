/**
 * Payment-method columns of the `payments` ledger (DATABASE.md §7.1, A-039).
 *
 * Three different facts, three columns:
 *   requested_method_type  what the USER chose when the attempt was created (CARD | EASY_PAY); immutable in the DB
 *   method_type            normalised effective method: the requested one until approval, afterwards the PG-reported
 *                          one (CARD | EASY_PAY | OTHER). OTHER only for an approved EXCESS payment
 *   provider_method_raw    the PG-reported method label, VERBATIM; mandatory when method_type = OTHER
 *
 * These pure functions are the single place that turns a payment request / an approval report into those column
 * values, so the Step 6 payment service cannot forget the requested method or rewrite the raw label. They never
 * touch `requested_method_type` after creation and never normalise `rawMethod`. They are pure (no I/O) and mirror the
 * database CHECKs so that a bad value fails fast in code as well as in the database.
 */
import { PAYMENT_REQUEST_METHOD_TYPE } from "./constants";

export type RequestedMethodType = (typeof PAYMENT_REQUEST_METHOD_TYPE)[number];

/** What the PaymentProvider adapter reports for an APPROVED payment (ARCHITECTURE.md §6.2). */
export interface ReportedMethod {
  /** CARD / EASY_PAY when the reported method is one NAZIR supports, DISALLOWED otherwise (adapter-side normalisation). */
  methodType: "CARD" | "EASY_PAY" | "DISALLOWED";
  /** The PG's own label exactly as received (Toss: the Korean `method` string). Not parsed, not trimmed, not mapped. */
  rawMethod: string | null;
  cardCompany?: string | null;
  easyPayProvider?: string | null;
}

export class PaymentMethodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentMethodError";
  }
}

/** Mirrors `payments_provider_method_raw_ck`: a method label, never personal or payment data. */
export function assertSafeRawMethod(raw: string): void {
  if (raw.length > 100) throw new PaymentMethodError("provider_method_raw is longer than 100 characters");
  if (raw.trim() === "") throw new PaymentMethodError("provider_method_raw is blank");
  if (/[0-9]{9,}/.test(raw)) throw new PaymentMethodError("provider_method_raw contains a long digit run (card / phone / account number?)");
  if (raw.includes("@")) throw new PaymentMethodError("provider_method_raw contains an e-mail marker");
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new PaymentMethodError("provider_method_raw contains control characters");
}

/** Columns for INSERT when a payment attempt is created (status READY): the requested method is recorded and fixed. */
export function paymentCreationMethodColumns(requested: RequestedMethodType) {
  if (!(PAYMENT_REQUEST_METHOD_TYPE as readonly string[]).includes(requested)) {
    throw new PaymentMethodError(`a payment can only be requested as ${PAYMENT_REQUEST_METHOD_TYPE.join(" or ")}, got "${requested}"`);
  }
  return { requested_method_type: requested, method_type: requested } as const;
}

/**
 * Columns to set in the SAME UPDATE that moves a payment to SUCCEEDED. `requested_method_type` is deliberately absent:
 * the original choice is never rewritten. A method NAZIR does not support becomes OTHER and must keep the PG label.
 */
export function paymentApprovalMethodColumns(reported: ReportedMethod) {
  const raw = reported.rawMethod;
  if (raw !== null) assertSafeRawMethod(raw);
  if (reported.methodType === "DISALLOWED") {
    if (raw === null) throw new PaymentMethodError("an approved payment with an unsupported method must keep the PG's method label (provider_method_raw)");
    return {
      method_type: "OTHER" as const,
      provider_method_raw: raw,
      card_company: reported.cardCompany ?? null,
      easy_pay_provider: reported.easyPayProvider ?? null,
    };
  }
  return {
    method_type: reported.methodType,
    provider_method_raw: raw,
    card_company: reported.cardCompany ?? null,
    easy_pay_provider: reported.easyPayProvider ?? null,
  };
}
