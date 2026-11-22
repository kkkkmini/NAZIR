import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { devOrderListSample } = await import("@/server/dev/dev-order-list-fixture");

describe("[DEV] A4-2 order list sample", () => {
  const now = Date.parse("2026-11-22T03:00:00Z");

  it("covers every order status, with a past PAID order", () => {
    const { items } = devOrderListSample(now, "list");
    expect(new Set(items.map((o) => o.status))).toEqual(
      new Set(["PENDING", "PAYMENT_CONFIRMING", "PAYMENT_UNKNOWN", "REVIEW_REQUIRED", "UNFULFILLED", "PAID", "EXPIRED", "CANCELED", "REFUNDED"]),
    );
    expect(items.some((o) => o.status === "PAID" && Date.parse(o.session.startsAt) < now)).toBe(true);
  });

  it("is a LOOKUP preview: nothing can be paid or canceled", () => {
    const v = devOrderListSample(now, "list");
    expect(v.viewer.purpose).toBe("LOOKUP");
    expect(v.items.every((o) => !o.canPay && !o.canCancel)).toBe(true);
  });

  it("holdExpiresAt only on PENDING, total equals the listed prices, ids are dev-only", () => {
    for (const o of devOrderListSample(now, "list").items) {
      expect(o.holdExpiresAt !== null).toBe(o.status === "PENDING");
      expect(o.totalAmount).toBe(o.items.reduce((a, i) => a + i.price, 0));
      expect(o.orderId.startsWith("dev-sample-")).toBe(true);
    }
  });

  it("empty preview has no orders", () => {
    expect(devOrderListSample(now, "empty").items).toEqual([]);
  });
});
