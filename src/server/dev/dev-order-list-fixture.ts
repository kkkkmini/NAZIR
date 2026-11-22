import "server-only";
import type { OrderListItem, OrderListView } from "@/server/orders/order-list-types";
import type { OrderStatus } from "@/server/orders/order-types";

/**
 * [DEV] A4-2 내 예매 목록 고정 샘플. 화면 검수용이며 실제 주문이 아니다.
 * - 개발용 주문 저장소(dev-seat-fixture의 __nazirDevOrderStore)와 완전히 분리되어 있다. 이 샘플을 결제·취소할 수 없다.
 * - 좌석·가격은 임시 값이다(실제 공연 정보·가격 아님).
 * - 조회 인증(LOOKUP) 미리보기이므로 canPay·canCancel은 모두 false다(조회 세션으로는 결제·취소 불가, UF 1.4).
 */
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

type Sample = { status: OrderStatus; startsInDays: number; seats: [string, number][]; createdAgoMin: number; holdLeftMin?: number };

const SAMPLES: Sample[] = [
  { status: "PENDING", startsInDays: 9, seats: [["R D열 5번", 110000], ["R D열 6번", 110000]], createdAgoMin: 2, holdLeftMin: 5 },
  { status: "PAYMENT_CONFIRMING", startsInDays: 12, seats: [["VIP A열 3번", 150000]], createdAgoMin: 6 },
  { status: "PAYMENT_UNKNOWN", startsInDays: 16, seats: [["VIP B열 7번", 150000], ["VIP B열 8번", 150000]], createdAgoMin: 40 },
  { status: "REVIEW_REQUIRED", startsInDays: 20, seats: [["R E열 2번", 110000]], createdAgoMin: 300 },
  { status: "UNFULFILLED", startsInDays: 23, seats: [["R F열 9번", 110000]], createdAgoMin: 2000 },
  { status: "PAID", startsInDays: 5, seats: [["VIP C열 4번", 150000], ["VIP C열 5번", 150000], ["VIP C열 6번", 150000]], createdAgoMin: 3000 },
  { status: "PAID", startsInDays: -10, seats: [["R G열 3번", 110000]], createdAgoMin: 30000 },
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

export function devOrderListSample(now: number, mode: "list" | "empty"): OrderListView {
  const items: OrderListItem[] =
    mode === "empty"
      ? []
      : SAMPLES.map((s, i) => ({
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
        }));
  return { items, serverNow: new Date(now).toISOString(), viewer: { purpose: "LOOKUP", displayName: "테*트" } };
}
