import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { devSeatMap, devHoldSeats, devOrderView, devCancelOrder, devSimulatePayment, DEV_HOLD_MS, DEV_CONFIRM_PROTECT_MS, DEV_CONFIRM_RESOLVE_MS } =
  await import("@/server/dev/dev-seat-fixture");

const T0 = Date.parse("2026-11-20T10:00:00Z");
let n = 0;
const sid = () => `test-session-${++n}`;
const available = (s: string, now = T0) => devSeatMap(s, now).seats.filter((x) => x.state === "AVAILABLE").map((x) => x.sessionSeatId);
const stateOf = (s: string, ids: string[], now = T0) => devSeatMap(s, now).seats.filter((x) => ids.includes(x.sessionSeatId)).map((x) => x.state);

/** 새 회차에 좌석 k개를 확보한 주문을 만든다 */
function order(k = 2) {
  const s = sid();
  const ids = available(s).slice(0, k);
  const r = devHoldSeats(s, ids, "auto", T0);
  if (!r.ok) throw new Error("hold failed");
  return { s, ids, id: r.holdId };
}

describe("[DEV] 좌석 확보", () => {
  it("seed와 같은 78석 배치·구역 가격", () => {
    const { seats, quota } = devSeatMap(sid(), T0);
    expect(seats).toHaveLength(78);
    expect(new Set(seats.filter((s) => s.section === "VIP").map((s) => s.price))).toEqual(new Set([150_000]));
    expect(new Set(seats.filter((s) => s.section === "R").map((s) => s.price))).toEqual(new Set([110_000]));
    expect(quota).toEqual({ seatLimit: 4, countedSeats: 0, remaining: 4, activeOrderId: null });
  });

  it("전체 성공: PENDING 주문, 7분 만료, 좌석 HELD, 구매 가능 수 차감", () => {
    const { s, ids, id } = order(3);
    const v = devOrderView(id, T0)!;
    expect(v.status).toBe("PENDING");
    expect(Date.parse(v.holdExpiresAt) - T0).toBe(DEV_HOLD_MS);
    expect(v.totalAmount).toBe(v.items.reduce((a, i) => a + i.price, 0));
    expect(stateOf(s, ids)).toEqual(["HELD", "HELD", "HELD"]);
    expect(devSeatMap(s, T0).quota).toMatchObject({ remaining: 1, activeOrderId: id });
  });

  it("원자성: 한 좌석이라도 불가하면 아무 좌석도 점유하지 않음", () => {
    const s = sid();
    const free = available(s).slice(0, 2);
    const sold = devSeatMap(s, T0).seats.find((x) => x.state !== "AVAILABLE")!.sessionSeatId;
    expect(devHoldSeats(s, [...free, sold], "auto", T0)).toEqual({ ok: false, code: "SEAT_UNAVAILABLE", unavailableSeatIds: [sold] });
    expect(available(s)).toEqual(expect.arrayContaining(free));
    expect(devSeatMap(s, T0).quota.remaining).toBe(4);
  });

  it("다른 고객 선점 시뮬레이션: 전체 실패, 해당 좌석만 HELD", () => {
    const s = sid();
    const ids = available(s).slice(0, 3);
    expect(devHoldSeats(s, ids, "seat-taken", T0)).toEqual({ ok: false, code: "SEAT_UNAVAILABLE", unavailableSeatIds: [ids[2]] });
    expect(stateOf(s, ids)).toEqual(["AVAILABLE", "AVAILABLE", "HELD"]);
  });

  it("4석 초과·중복·빈 요청 거부", () => {
    const s = sid();
    const ids = available(s);
    expect(devHoldSeats(s, ids.slice(0, 5), "auto", T0)).toEqual({ ok: false, code: "INVALID_REQUEST" });
    expect(devHoldSeats(s, [ids[0], ids[0]], "auto", T0)).toEqual({ ok: false, code: "INVALID_REQUEST" });
    expect(devHoldSeats(s, [], "auto", T0)).toEqual({ ok: false, code: "INVALID_REQUEST" });
  });

  it("활성 주문이 있으면 새 확보 거부, 7분 만료 후 EXPIRED·좌석 반환", () => {
    const { s, ids, id } = order(1);
    expect(devHoldSeats(s, available(s).slice(0, 1), "auto", T0 + 1000)).toMatchObject({ code: "ACTIVE_ORDER_EXISTS", activeOrderId: id });
    const later = T0 + DEV_HOLD_MS;
    expect(devOrderView(id, later)!.status).toBe("EXPIRED");
    expect(stateOf(s, ids, later)).toEqual(["AVAILABLE"]);
    expect(devSeatMap(s, later).quota).toMatchObject({ remaining: 4, activeOrderId: null });
  });

  it("취소(좌석 다시 고르기): CANCELED, 좌석 반환, 다시 취소해도 멱등", () => {
    const { s, ids, id } = order(2);
    expect(devCancelOrder(id, T0 + 1)).toEqual({ ok: true, status: "CANCELED" });
    expect(devCancelOrder(id, T0 + 2)).toEqual({ ok: true, status: "CANCELED" });
    expect(stateOf(s, ids, T0 + 2)).toEqual(["AVAILABLE", "AVAILABLE"]);
  });
});

describe("[DEV] 결제 결과 시뮬레이션", () => {
  it("성공: PAID, 좌석 SOLD, 구매 한도에 계속 포함, 활성 주문 아님", () => {
    const { s, ids, id } = order(2);
    expect(devSimulatePayment(id, "success", T0 + 1)).toEqual({ ok: true, status: "PAID" });
    expect(devOrderView(id, T0 + DEV_HOLD_MS * 2)!).toMatchObject({ status: "PAID", latestPayment: { status: "SUCCEEDED" } });
    expect(stateOf(s, ids, T0 + DEV_HOLD_MS * 2)).toEqual(["SOLD", "SOLD"]);
    expect(devSeatMap(s, T0 + 2).quota).toMatchObject({ countedSeats: 2, remaining: 2, activeOrderId: null });
    // PAID 이후 같은 회차 추가 예매는 활성 주문 제한이 아니라 남은 수로 판단
    expect(devHoldSeats(s, available(s, T0 + 3).slice(0, 2), "auto", T0 + 3).ok).toBe(true);
  });

  it("실패(시간 남음): PENDING 유지, 만료 시각 그대로, 다시 결제 가능", () => {
    const { s, ids, id } = order(2);
    const before = devOrderView(id, T0)!.holdExpiresAt;
    expect(devSimulatePayment(id, "fail-pending", T0 + 1)).toEqual({ ok: true, status: "PENDING" });
    const v = devOrderView(id, T0 + 2)!;
    expect(v).toMatchObject({ status: "PENDING", holdExpiresAt: before, latestPayment: { status: "FAILED" } });
    expect(stateOf(s, ids, T0 + 2)).toEqual(["HELD", "HELD"]);
    expect(devSimulatePayment(id, "success", T0 + 3)).toEqual({ ok: true, status: "PAID" });
  });

  it("실패(만료): EXPIRED, 결제 시도 취소(승인 요청 없음), 좌석·한도 반환, 다시 결제 거부", () => {
    const { s, ids, id } = order(2);
    expect(devSimulatePayment(id, "fail-expired", T0 + 1)).toEqual({ ok: true, status: "EXPIRED" });
    expect(devOrderView(id, T0 + 2)).toMatchObject({ status: "EXPIRED", latestPayment: { status: "CANCELED" } });
    expect(stateOf(s, ids, T0 + 2)).toEqual(["AVAILABLE", "AVAILABLE"]);
    expect(devSeatMap(s, T0 + 2).quota.remaining).toBe(4);
    expect(devSimulatePayment(id, "success", T0 + 3)).toMatchObject({ ok: false, code: "HOLD_EXPIRED" });
  });

  it("확인 중 → 성공: 7분이 지나도 좌석 보호, 승인 확인 후 PAID", () => {
    const { s, ids, id } = order(1);
    expect(devSimulatePayment(id, "confirming-success", T0 + 1)).toEqual({ ok: true, status: "PAYMENT_CONFIRMING" });
    expect(devOrderView(id, T0 + 2)!.status).toBe("PAYMENT_CONFIRMING");
    expect(stateOf(s, ids, T0 + 2)).toEqual(["HELD"]);
    expect(devOrderView(id, T0 + 1 + DEV_CONFIRM_RESOLVE_MS)!).toMatchObject({ status: "PAID", latestPayment: { status: "SUCCEEDED" } });
  });

  it("확인 중 → 3분 경과 시 UNKNOWN: 실패로 바꾸지 않음, 좌석 보호, 재결제·취소 거부", () => {
    const { s, ids, id } = order(1);
    devSimulatePayment(id, "confirming-unknown", T0);
    expect(devOrderView(id, T0 + DEV_CONFIRM_PROTECT_MS - 1)!.status).toBe("PAYMENT_CONFIRMING");
    const late = T0 + DEV_HOLD_MS + DEV_CONFIRM_PROTECT_MS; // 7분 점유 만료 시각도 지남
    expect(devOrderView(id, late)!).toMatchObject({ status: "PAYMENT_UNKNOWN", latestPayment: { status: "UNKNOWN" } });
    expect(stateOf(s, ids, late)).toEqual(["HELD"]);
    expect(devSimulatePayment(id, "success", late)).toEqual({ ok: false, code: "PAYMENT_IN_PROGRESS", status: "PAYMENT_UNKNOWN" });
    expect(devCancelOrder(id, late)).toEqual({ ok: false, code: "PAYMENT_IN_PROGRESS", status: "PAYMENT_UNKNOWN" });
    expect(devSeatMap(s, late).quota.activeOrderId).toBe(id);
  });

  it("운영자 확인(금액 불일치): REVIEW_REQUIRED, 서버 안내 문구, 좌석 보호, 재결제·취소 거부", () => {
    const { s, ids, id } = order(2);
    expect(devSimulatePayment(id, "review-amount", T0 + 1)).toEqual({ ok: true, status: "REVIEW_REQUIRED" });
    const late = T0 + DEV_HOLD_MS * 3;
    expect(devOrderView(id, late)!.message).toContain("금액");
    expect(stateOf(s, ids, late)).toEqual(["HELD", "HELD"]);
    expect(devSimulatePayment(id, "success", late)).toMatchObject({ ok: false, code: "INVALID_STATE_TRANSITION" });
    expect(devCancelOrder(id, late)).toMatchObject({ ok: false, code: "PAYMENT_IN_PROGRESS" });
    expect(devSeatMap(s, late).quota).toMatchObject({ remaining: 2, activeOrderId: id });
  });

  it("발권 불가: UNFULFILLED, 좌석·한도 반환, 활성 주문 아님", () => {
    const { s, ids, id } = order(2);
    expect(devSimulatePayment(id, "unfulfilled", T0 + 1)).toEqual({ ok: true, status: "UNFULFILLED" });
    expect(devOrderView(id, T0 + 2)!).toMatchObject({ status: "UNFULFILLED", latestPayment: { status: "SUCCEEDED" } });
    expect(stateOf(s, ids, T0 + 2)).toEqual(["AVAILABLE", "AVAILABLE"]);
    expect(devSeatMap(s, T0 + 2).quota).toMatchObject({ remaining: 4, activeOrderId: null });
  });

  it("중복 요청: 같은 주문에 결과 요청이 두 번 와도 상태는 한 번만 바뀜", () => {
    const { id } = order(1);
    expect(devSimulatePayment(id, "confirming-unknown", T0 + 1)).toEqual({ ok: true, status: "PAYMENT_CONFIRMING" });
    expect(devSimulatePayment(id, "confirming-unknown", T0 + 2)).toEqual({ ok: false, code: "PAYMENT_IN_PROGRESS", status: "PAYMENT_CONFIRMING" });
    const { id: id2 } = order(1);
    devSimulatePayment(id2, "success", T0 + 1);
    expect(devSimulatePayment(id2, "success", T0 + 2)).toEqual({ ok: false, code: "INVALID_STATE_TRANSITION", status: "PAID" });
    expect(devOrderView(id2, T0 + 3)!.latestPayment).toMatchObject({ status: "SUCCEEDED" });
  });
});
