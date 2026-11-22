"use server";

import { devPreviewEnabled } from "@/server/dev/dev-preview";
import { PAYMENT_SIMULATIONS, type OrderActionResult, type PaymentSimulation, type PaymentStartResult } from "@/server/orders/order-types";

/**
 * 주문 관련 서버 액션(개발용).
 * 실제 구현에서는 POST /orders/{id}/cancel, POST /orders/{id}/payments + PG 결제창 + 복귀 처리(API §4.5~4.7)가 대신한다.
 * 운영 환경에서는 항상 거부한다. 상태 판단은 서버 모듈(dev-seat-fixture)이 하며 클라이언트는 결과만 표시한다.
 */

/** [DEV] 결제 결과 미리보기 — 실제 결제가 아니다. */
export async function simulatePaymentAction(orderId: unknown, scenario: unknown): Promise<OrderActionResult> {
  if (!devPreviewEnabled()) return { ok: false, code: "NOT_AVAILABLE" };
  if (typeof orderId !== "string" || !PAYMENT_SIMULATIONS.includes(scenario as PaymentSimulation)) {
    return { ok: false, code: "INVALID_REQUEST" };
  }
  const { devSimulatePayment } = await import("@/server/dev/dev-seat-fixture");
  return devSimulatePayment(orderId, scenario as PaymentSimulation, Date.now());
}

/** [DEV] 주문 취소(좌석 다시 고르기). PENDING일 때만 가능하고, 결제 확인 중이면 PAYMENT_IN_PROGRESS로 거부된다. */
export async function cancelOrderAction(orderId: unknown): Promise<OrderActionResult> {
  if (!devPreviewEnabled()) return { ok: false, code: "NOT_AVAILABLE" };
  if (typeof orderId !== "string") return { ok: false, code: "INVALID_REQUEST" };
  const { devCancelOrder } = await import("@/server/dev/dev-seat-fixture");
  return devCancelOrder(orderId, Date.now());
}

/**
 * [DEV] 결제 시작 검사(실제로는 POST /orders/{id}/payments의 사전 조건 검사 부분).
 * 상태를 바꾸지 않는다. 결제 가능 조건과 미리보기 실패만 서버가 판단해 돌려준다.
 */
export async function startPaymentAction(orderId: unknown, methodId: unknown, simulation: unknown): Promise<PaymentStartResult> {
  if (!devPreviewEnabled()) return { ok: false, code: "NOT_AVAILABLE" };
  if (typeof orderId !== "string" || typeof methodId !== "string") return { ok: false, code: "INVALID_REQUEST" };
  const { DEV_PAYMENT_METHODS } = await import("@/server/dev/dev-payment-methods");
  if (!DEV_PAYMENT_METHODS.some((m) => m.id === methodId)) return { ok: false, code: "INVALID_REQUEST" };
  const { devOrderView } = await import("@/server/dev/dev-seat-fixture");
  const order = devOrderView(orderId, Date.now());
  if (!order) return { ok: false, code: "NOT_FOUND" };
  if (order.status === "PAYMENT_CONFIRMING" || order.status === "PAYMENT_UNKNOWN") return { ok: false, code: "PAYMENT_IN_PROGRESS", status: order.status };
  if (order.status === "EXPIRED") return { ok: false, code: "HOLD_EXPIRED", status: order.status };
  if (order.status !== "PENDING") return { ok: false, code: "INVALID_STATE_TRANSITION", status: order.status };
  if (simulation === "hold-time") return { ok: false, code: "HOLD_TIME_INSUFFICIENT" };
  if (simulation === "method-unavailable") return { ok: false, code: "PAYMENT_METHOD_UNAVAILABLE" };
  return { ok: true };
}
