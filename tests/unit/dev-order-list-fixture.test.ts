import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { devOrderListSample, devOrderDetailSample } = await import("@/server/dev/dev-order-list-fixture");

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

  it("A4-3 detail keeps the list's ids, status and session; customer/payment only on PAID", () => {
    const list = devOrderListSample(now, "list").items;
    for (const o of list) {
      const d = devOrderDetailSample(now, o.orderId)!;
      expect(d).not.toBeNull();
      expect([d.status, d.session.startsAt, d.totalAmount]).toEqual([o.status, o.session.startsAt, o.totalAmount]);
      expect(d.customer !== null).toBe(o.status === "PAID");
      expect(d.payment !== null).toBe(o.status === "PAID");
      expect(d.canPay || d.canCancel).toBe(false);
    }
    expect(devOrderDetailSample(now, "dev-sample-99")).toBeNull();
    expect(devOrderDetailSample(now, "anything")).toBeNull();
  });

  it("PAID confirmation exposes only masked name and the last 4 phone digits", () => {
    const paid = devOrderListSample(now, "list").items.filter((o) => o.status === "PAID");
    for (const o of paid) {
      const c = devOrderDetailSample(now, o.orderId)!.customer!;
      expect(Object.keys(c).sort()).toEqual(["nameMasked", "phoneLast4"]);
      expect(c.phoneLast4).toMatch(/^\d{4}$/);
      expect(c.nameMasked).toContain("*");
    }
  });
});
