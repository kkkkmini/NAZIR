import "server-only";
import type { OrderDetailView, OrderListItem, OrderListView } from "@/server/orders/order-list-types";
import type { OrderStatus, PaymentStatus } from "@/server/orders/order-types";

/**
 * [DEV] A4-2 내 예매 목록 고정 샘플. 화면 검수용이며 실제 주문이 아니다.
 * - 개발용 주문 저장소(dev-seat-fixture의 __nazirDevOrderStore)와 완전히 분리되어 있다. 이 샘플을 결제·취소할 수 없다.
 * - 좌석·가격은 임시 값이다(실제 공연 정보·가격 아님).
 * - A4-3 상세는 같은 10건을 주문 ID 그대로 확장한다(devOrderDetailSample). 예매자·결제 완료 정보는 PAID에만 있다.
 * - 조회 인증(LOOKUP) 미리보기이므로 canPay·canCancel은 모두 false다(조회 세션으로는 결제·취소 불가, UF 1.4).
 */
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

type Sample = { status: OrderStatus; startsInDays: number; seats: [string, number][]; createdAgoMin: number; holdLeftMin?: number; method?: string };

const SAMPLES: Sample[] = [
  { status: "PENDING", startsInDays: 9, seats: [["R D열 5번", 110000], ["R D열 6번", 110000]], createdAgoMin: 2, holdLeftMin: 5 },
  { status: "PAYMENT_CONFIRMING", startsInDays: 12, seats: [["VIP A열 3번", 150000]], createdAgoMin: 6 },
  { status: "PAYMENT_UNKNOWN", startsInDays: 16, seats: [["VIP B열 7번", 150000], ["VIP B열 8번", 150000]], createdAgoMin: 40 },
  { status: "REVIEW_REQUIRED", startsInDays: 20, seats: [["R E열 2번", 110000]], createdAgoMin: 300 },
  { status: "UNFULFILLED", startsInDays: 23, seats: [["R F열 9번", 110000]], createdAgoMin: 2000 },
  { status: "PAID", startsInDays: 5, seats: [["VIP C열 4번", 150000], ["VIP C열 5번", 150000], ["VIP C열 6번", 150000]], createdAgoMin: 3000, method: "신용·체크카드" },
  { status: "PAID", startsInDays: -10, seats: [["R G열 3번", 110000]], createdAgoMin: 30000, method: "토스페이" },
  { status: "EXPIRED", startsInDays: 9, seats: [["R D열 1번", 110000]], createdAgoMin: 60 },
  { status: "CANCELED", startsInDays: 12, seats: [["VIP A열 9번", 150000]], createdAgoMin: 120 },
  { status: "REFUNDED", startsInDays: 16, seats: [["R E열 10번", 110000], ["R E열 11번", 110000]], createdAgoMin: 9000 },
];

/** 19:30 공연 기준으로 날짜를 만든다(KST 19:30 = UTC 10:30). */
function startsAt(now: number, days: number) {
  const d = new Date(now + days * DAY);
  d.setUTCHours(10, 30, 0, 0);
  return d.toISOString();
}

function listItem(s: Sample, i: number, now: number): OrderListItem {
  return {
    orderId: `dev-sample-${i + 1}`,
    status: s.status,
    show: { title: "나지르" },
    session: { id: `dev-sample-session-${i + 1}`, startsAt: startsAt(now, s.startsInDays) },
    items: s.seats.map(([label, price], j) => ({ seatId: `dev-sample-${i + 1}-${j + 1}`, label, price })),
    totalAmount: s.seats.reduce((a, [, p]) => a + p, 0),
    holdExpiresAt: s.status === "PENDING" ? new Date(now + (s.holdLeftMin ?? 0) * MIN).toISOString() : null,
    createdAt: new Date(now - s.createdAgoMin * MIN).toISOString(),
    canPay: false,
    canCancel: false,
  };
}

const VIEWER: OrderListView["viewer"] = { purpose: "LOOKUP", displayName: "테*트" };

export function devOrderListSample(now: number, mode: "list" | "empty"): OrderListView {
  const items = mode === "empty" ? [] : SAMPLES.map((s, i) => listItem(s, i, now));
  return { items, serverNow: new Date(now).toISOString(), viewer: VIEWER };
}

/** 가장 최근 결제 시도의 상태(샘플). 화면에는 표시하지 않는다. */
const LATEST: Partial<Record<OrderStatus, PaymentStatus>> = {
  PENDING: "FAILED",
  PAYMENT_CONFIRMING: "CONFIRMING",
  PAYMENT_UNKNOWN: "UNKNOWN",
  REVIEW_REQUIRED: "SUCCEEDED",
  UNFULFILLED: "SUCCEEDED",
  PAID: "SUCCEEDED",
  REFUNDED: "SUCCEEDED",
};

/** A4-3 상세 샘플. 목록과 같은 ID·상태·관람 정보. 없는 ID면 null. */
export function devOrderDetailSample(now: number, orderId: string): OrderDetailView | null {
  const i = SAMPLES.findIndex((_, k) => `dev-sample-${k + 1}` === orderId);
  if (i < 0) return null;
  const s = SAMPLES[i];
  const base = listItem(s, i, now);
  const paid = s.status === "PAID";
  const latest = LATEST[s.status];
  return {
    ...base,
    orderNumber: `NZ-DEV-${String(i + 1).padStart(6, "0")}`,
    message: null,
    latestPayment: latest ? { paymentId: `dev-sample-pay-${i + 1}`, status: latest } : null,
    customer: paid ? { nameMasked: "테*트", phoneLast4: "0000" } : null,
    payment: paid ? { methodLabel: s.method ?? "신용·체크카드", paidAt: new Date(Date.parse(base.createdAt) + 2 * MIN).toISOString() } : null,
    serverNow: new Date(now).toISOString(),
    viewer: VIEWER,
  };
}
