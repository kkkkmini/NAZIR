import "server-only";
import { connection } from "next/server";
import { devPreviewEnabled } from "@/server/dev/dev-preview";
import type { OrderViewResult } from "@/server/orders/order-types";
import type { SeatMapResult } from "./seat-types";

/**
 * A3-3 좌석 배치·상태·구매 가능 수 조회.
 * - 운영: 좌석 API·인증 세션 검증이 준비되지 않았으므로 "not-ready"(좌석 선택·점유 불가).
 * - local/test: [DEV] 개발용 좌석 데이터. 개발용 모듈은 이때만 동적으로 불러온다.
 * - 판매 가능한 회차(AVAILABLE)가 아니면 "invalid-session".
 */
export async function getSeatMap(sessionId: string | undefined): Promise<SeatMapResult> {
  await connection();
  if (!devPreviewEnabled()) return { kind: "not-ready" };
  const session = await findDevSession(sessionId);
  if (!session) return { kind: "invalid-session" };
  const { devSeatMap } = await import("@/server/dev/dev-seat-fixture");
  return { kind: "dev-fixture", sessionId: session.id, sessionStartsAt: session.startsAt, ...devSeatMap(session.id, Date.now()) };
}

/** A3-4·A3-5: 주문 상태 조회(실제로는 GET /orders/{id}, GET /orders/{id}/payments/{paymentId}). */
export async function getOrderView(orderId: string | undefined): Promise<OrderViewResult> {
  await connection();
  if (!devPreviewEnabled()) return { kind: "not-ready" };
  if (!orderId) return { kind: "not-found" };
  const { devOrderView } = await import("@/server/dev/dev-seat-fixture");
  const order = devOrderView(orderId, Date.now());
  if (!order) return { kind: "not-found" };
  const session = await findDevSession(order.sessionId, { anyState: true });
  return { kind: "dev-order", ...order, sessionStartsAt: session?.startsAt ?? "" };
}

export async function findDevSession(sessionId: string | undefined, opts: { anyState?: boolean } = {}) {
  if (!sessionId) return null;
  const { devSessionFixture } = await import("@/server/dev/dev-session-fixture");
  return devSessionFixture(new Date()).find((s) => s.id === sessionId && (opts.anyState || s.state === "AVAILABLE")) ?? null;
}

/** A3-4 결제수단 목록(실제로는 GET /payment-methods). */
export async function getPaymentMethods(): Promise<import("@/server/orders/order-types").PaymentMethodsResult> {
  await connection();
  if (!devPreviewEnabled()) return { kind: "not-ready" };
  const { DEV_PAYMENT_METHODS } = await import("@/server/dev/dev-payment-methods");
  return { kind: "dev-fixture", methods: DEV_PAYMENT_METHODS };
}
