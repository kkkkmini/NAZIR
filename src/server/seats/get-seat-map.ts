import "server-only";
import { connection } from "next/server";
import { devPreviewEnabled } from "@/server/dev/dev-preview";
import type { OrderViewResult } from "@/server/orders/order-types";
import { appCatalogDeps } from "@/server/catalog/app-deps";
import { catalogSource } from "@/server/catalog/catalog-source";
import { loadCurrentShow } from "@/server/catalog/current-show";
import { getPublicSeatMap } from "@/server/catalog/public-catalog";
import { toSeatView } from "./seat-adapter";
import type { SeatMapResult } from "./seat-types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A3-3 좌석 배치·상태 조회. 출처는 catalogSource()가 정한다.
 * - "db": 공개 좌석 서비스(getPublicSeatMap, Step 3)를 toSeatView로 변환한 읽기 전용 결과("live-readonly").
 *   회차는 현재 공연(공개 공연 1개)에 속하고 서버 sellable이어야 한다. 구매 한도·좌석 확보는 Step 5 연결 전이라 없다.
 * - "dev-fixture"(local/test 기본): [DEV] 개발용 좌석·구매 가능 수·확보 시뮬레이션.
 * - "none": "not-ready". 판매 가능한 회차가 아니면 "invalid-session". DB 오류는 던진다.
 */
export async function getSeatMap(sessionId: string | undefined): Promise<SeatMapResult> {
  await connection();
  const source = catalogSource();
  if (source.kind === "db") {
    if (!sessionId || !UUID.test(sessionId)) return { kind: "invalid-session" };
    const current = await loadCurrentShow();
    if (current.kind !== "show") return { kind: "not-ready" };
    const { db, clock } = appCatalogDeps();
    const map = await getPublicSeatMap(db, sessionId, await clock.now(), current.show.slug);
    if (!map || !map.session.sellable) return { kind: "invalid-session" };
    return {
      kind: "live-readonly",
      sessionId: map.session.id,
      sessionStartsAt: map.session.startsAt,
      seats: map.seats.map(toSeatView),
      seatLimit: map.session.maxSeatsPerIdentity,
      testData: source.testData,
    };
  }
  if (source.kind === "none" || !devPreviewEnabled()) return { kind: "not-ready" };
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
  return devSessionFixture(new Date()).find((s) => s.id === sessionId && (opts.anyState || s.sellable)) ?? null;
}

/** A3-4 결제수단 목록(실제로는 GET /payment-methods). */
export async function getPaymentMethods(): Promise<import("@/server/orders/order-types").PaymentMethodsResult> {
  await connection();
  if (!devPreviewEnabled()) return { kind: "not-ready" };
  const { DEV_PAYMENT_METHODS } = await import("@/server/dev/dev-payment-methods");
  return { kind: "dev-fixture", methods: DEV_PAYMENT_METHODS };
}
