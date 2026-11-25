import type { HoldItemView } from "@/server/seats/seat-types";

/**
 * 주문·결제 화면이 서버에서 받는 데이터 형태(A3-4, A3-5).
 * 상태 값은 DATABASE.md v1.2의 orders.status / payments.status와 같다.
 * 실제 API(GET /orders/{id}, GET /orders/{id}/payments/{paymentId})가 생기면 같은 형태로 매핑한다.
 */
export type OrderStatus =
  | "PENDING"
  | "PAYMENT_CONFIRMING"
  | "PAYMENT_UNKNOWN"
  | "REVIEW_REQUIRED"
  | "UNFULFILLED"
  | "PAID"
  | "CANCELED"
  | "EXPIRED"
  | "REFUNDED";

export type PaymentStatus = "READY" | "CONFIRMING" | "UNKNOWN" | "SUCCEEDED" | "FAILED" | "CANCELED";

export type OrderView = {
  orderId: string;
  sessionId: string;
  sessionStartsAt: string;
  status: OrderStatus;
  items: HoldItemView[];
  totalAmount: number;
  /** 서버가 정한 점유 만료 시각(생성 + 7분, 연장 없음). PENDING일 때만 의미가 있다. */
  holdExpiresAt: string;
  /** 응답 시점의 서버 현재 시각 */
  serverNow: string;
  /** 가장 최근 결제 시도. 실제 화면이 어떤 결제 시도를 조회할지는 개발팀 확인 사항(DQ-6). */
  latestPayment: { paymentId: string; status: PaymentStatus } | null;
  /** 서버가 정한 상태 안내 문구(예: 금액 불일치). 화면은 그대로 표시만 한다. */
  message: string | null;
};

export type OrderViewResult = { kind: "not-ready" } | { kind: "not-found" } | ({ kind: "dev-order" } & OrderView);

/** [DEV] 결제 결과 미리보기 시나리오 — 실제 PG 결제가 아니다. */
export const PAYMENT_SIMULATIONS = [
  "success",
  "fail-pending",
  "fail-expired",
  "confirming-success",
  "confirming-unknown",
  "review-amount",
  "unfulfilled",
] as const;
export type PaymentSimulation = (typeof PAYMENT_SIMULATIONS)[number];

export type OrderActionResult =
  | { ok: true; status: OrderStatus }
  | {
      ok: false;
      code: "PAYMENT_IN_PROGRESS" | "INVALID_STATE_TRANSITION" | "HOLD_EXPIRED" | "NOT_FOUND" | "INVALID_REQUEST" | "NOT_AVAILABLE";
      status?: OrderStatus;
    };

/** 결제수단(GET /payment-methods를 화면용으로 줄인 형태). 서버가 활성화한 수단만 내려준다(D-011, D-012). */
export type PaymentMethodView = { id: "CARD" | "TOSSPAY" | "NAVERPAY"; label: string; methodType: "CARD" | "EASY_PAY" };
export type PaymentMethodsResult = { kind: "not-ready" } | { kind: "dev-fixture"; methods: PaymentMethodView[] };

/** [DEV] 결제 시작 실패 미리보기. "network"는 화면에서만 흉내 내며 서버를 호출하지 않는다. */
export const PAYMENT_START_SIMULATIONS = ["ok", "hold-time", "method-unavailable", "network"] as const;
export type PaymentStartSimulation = (typeof PAYMENT_START_SIMULATIONS)[number];

export type PaymentStartResult =
  | { ok: true }
  | { ok: false; code: "HOLD_TIME_INSUFFICIENT" | "PAYMENT_METHOD_UNAVAILABLE" | "PAYMENT_IN_PROGRESS" | "HOLD_EXPIRED" | "INVALID_STATE_TRANSITION" | "NOT_FOUND" | "INVALID_REQUEST" | "NOT_AVAILABLE"; status?: OrderStatus };
