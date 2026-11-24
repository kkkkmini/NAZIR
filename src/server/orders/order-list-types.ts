import type { OrderStatus, PaymentStatus } from "./order-types";

/**
 * A4-2 내 예매 목록 항목 — GET /orders 항목의 제안 계약(사용자 승인 2026-11-22, Step 7에 제안).
 * 문서(API §4.10)에는 아직 항목 필드가 정해져 있지 않다. 실제 API가 생기면 이 형태로 매핑한다.
 * canPay·canCancel은 서버가 세션 목적(BOOKING/LOOKUP)과 주문 상태로 계산한 값이며, 화면은 판단하지 않는다.
 */
export type OrderListItem = {
  orderId: string;
  status: OrderStatus;
  show: { title: string };
  session: { id: string; startsAt: string };
  items: { seatId: string; label: string; price: number }[];
  totalAmount: number;
  /** PENDING일 때만 값이 있다(서버가 정한 점유 만료 시각, 연장 없음). */
  holdExpiresAt: string | null;
  createdAt: string;
  canPay: boolean;
  canCancel: boolean;
};

export type OrderListView = {
  items: OrderListItem[];
  serverNow: string;
  /** 인증 상태 표시용(IA §4.3). 실제로는 GET /identity-session 응답. */
  viewer: { purpose: "BOOKING" | "LOOKUP"; displayName: string };
};

/** not-ready: 세션·주문 목록 API가 없어 목록을 보여 줄 수 없음(운영). dev-sample: [DEV] 고정 샘플. */
export type OrderListResult = { kind: "not-ready" } | ({ kind: "dev-sample" } & OrderListView);

/**
 * A4-3 예매 상세 — GET /orders/{orderId}(·/confirmation)의 제안 계약(사용자 승인 2026-11-24, 확정 아님).
 * 목록 항목에 다음을 더한다. customer·payment는 PAID일 때만 서버가 채우고 그 외에는 null이다(개인정보 최소화).
 * 가리기(이름 가운데 글자, 휴대전화 뒤 4자리만)는 서버가 한다. 화면은 받은 값을 그대로 표시한다.
 */
export type OrderDetailView = OrderListItem & {
  orderNumber: string;
  message: string | null;
  /** 가장 최근 결제 시도(재조회용, DQ-6). 내부 상태 코드는 화면에 표시하지 않는다. */
  latestPayment: { paymentId: string; status: PaymentStatus } | null;
  customer: { nameMasked: string; phoneLast4: string } | null;
  payment: { methodLabel: string; paidAt: string } | null;
  serverNow: string;
  viewer: OrderListView["viewer"];
};

export type OrderDetailResult = { kind: "not-ready" } | { kind: "not-found" } | ({ kind: "dev-sample" } & OrderDetailView);
