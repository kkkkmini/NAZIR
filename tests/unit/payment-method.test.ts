import { describe, expect, it } from "vitest";
import {
  PaymentMethodError,
  assertSafeRawMethod,
  paymentApprovalMethodColumns,
  paymentCreationMethodColumns,
} from "../../src/server/db/payment-method";

describe("paymentCreationMethodColumns (requested method is recorded and fixed at creation)", () => {
  it.each(["CARD", "EASY_PAY"] as const)("%s: requested_method_type and method_type start equal", (m) => {
    expect(paymentCreationMethodColumns(m)).toEqual({ requested_method_type: m, method_type: m });
  });
  it("rejects anything else, including OTHER", () => {
    for (const bad of ["OTHER", "VIRTUAL_ACCOUNT", "", "card"]) {
      expect(() => paymentCreationMethodColumns(bad as never)).toThrow(PaymentMethodError);
    }
  });
});

describe("paymentApprovalMethodColumns (what the PG reported; the request is never rewritten)", () => {
  it("never returns requested_method_type", () => {
    for (const methodType of ["CARD", "EASY_PAY", "DISALLOWED"] as const) {
      const cols = paymentApprovalMethodColumns({ methodType, rawMethod: "카드" });
      expect(cols).not.toHaveProperty("requested_method_type");
    }
  });
  it("a supported method keeps its type and stores the raw label verbatim (no trimming, no mapping)", () => {
    expect(paymentApprovalMethodColumns({ methodType: "CARD", rawMethod: " 카드 ", cardCompany: "SHINHAN" })).toEqual({
      method_type: "CARD",
      provider_method_raw: " 카드 ",
      card_company: "SHINHAN",
      easy_pay_provider: null,
    });
    expect(paymentApprovalMethodColumns({ methodType: "EASY_PAY", rawMethod: null, easyPayProvider: "TOSSPAY" }).provider_method_raw).toBeNull();
  });
  it("an unsupported method becomes OTHER and MUST keep the PG label", () => {
    expect(paymentApprovalMethodColumns({ methodType: "DISALLOWED", rawMethod: "가상계좌" })).toMatchObject({ method_type: "OTHER", provider_method_raw: "가상계좌" });
    expect(() => paymentApprovalMethodColumns({ methodType: "DISALLOWED", rawMethod: null })).toThrow(/must keep the PG's method label/);
  });
});

describe("assertSafeRawMethod mirrors payments_provider_method_raw_ck", () => {
  it.each(["카드", "가상계좌", "간편결제", "휴대폰", "계좌이체", "도서문화상품권", "Credit Card 2", "x"])("accepts %s", (v) => {
    expect(() => assertSafeRawMethod(v)).not.toThrow();
  });
  it.each([
    ["blank", "   "],
    ["empty", ""],
    ["card-number-like digits", "카드 4111111111111111"],
    ["phone-number-like digits", "휴대폰 01012345678"],
    ["e-mail marker", "a@b.c"],
    ["control character", "카드\n"],
    ["too long", "x".repeat(101)],
  ])("rejects %s", (_n, v) => {
    expect(() => assertSafeRawMethod(v)).toThrow(PaymentMethodError);
  });
  it("short digit runs (e.g. an installment label) are fine", () => {
    expect(() => assertSafeRawMethod("카드 12개월")).not.toThrow();
  });
});
