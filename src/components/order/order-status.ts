import type { OrderStatus } from "@/server/orders/order-types";

/**
 * 주문 상태별 관객 안내와 허용 행동(IA 4.2, User Flow AF-10~AF-13b). A3-4·A3-5가 함께 쓴다.
 * 상태는 서버가 정한다. 이 표는 "서버가 알려 준 상태에서 무엇을 보여 주고 무엇을 허용하는가"만 정의한다.
 * 여기에 없는 행동은 화면에 두지 않는다(예: PAYMENT_UNKNOWN에서 다시 결제·취소).
 */
export type OrderAction =
  | "confirmation" // 확인서 보기(A4-3, 준비 중)
  | "pay-again" // 같은 주문으로 다시 결제(A3-4)
  | "cancel-rebook" // 주문 취소 후 좌석 다시 고르기(D-001)
  | "rebook" // 처음부터 다시 예매
  | "check-later" // 예매 확인에서 나중에 보기
  | "contact"; // 문의 안내(채널 U4 미결정)

export type StatusTone = "ok" | "wait" | "notice" | "error";

export type OrderStatusUi = {
  tone: StatusTone;
  title: string;
  body: string;
  /** 좌석 상태 안내 한 줄 */
  seats: string;
  actions: OrderAction[];
  /** 서버 상태를 주기적으로 다시 확인하는가(결과가 아직 정해지지 않은 상태만) */
  poll: boolean;
  /** 다시 결제하면 안 된다는 경고를 보이는가 */
  noRepay: boolean;
};

export const ORDER_STATUS_UI: Record<OrderStatus, OrderStatusUi> = {
  PAID: {
    tone: "ok",
    title: "예매가 완료되었습니다",
    body: "결제가 승인되고 좌석이 확정되었습니다.",
    seats: "좌석이 확정되었습니다.",
    actions: ["confirmation"],
    poll: false,
    noRepay: false,
  },
  PENDING: {
    tone: "error",
    title: "결제가 완료되지 않았습니다",
    body: "확보한 좌석은 남은 시간 동안 유지됩니다. 같은 주문으로 다시 결제하거나, 취소하고 좌석을 다시 고를 수 있습니다.",
    seats: "좌석은 남은 시간 동안 유지됩니다. 시간은 연장되지 않습니다.",
    actions: ["pay-again", "cancel-rebook"],
    poll: false,
    noRepay: false,
  },
  PAYMENT_CONFIRMING: {
    tone: "wait",
    title: "결제 결과를 확인하고 있습니다",
    body: "결제 승인 결과를 확인하는 중입니다. 이 화면을 닫아도 확인은 계속되며, 나중에 예매 확인에서 결과를 볼 수 있습니다.",
    seats: "결과가 나올 때까지 좌석은 보호됩니다.",
    actions: ["check-later"],
    poll: true,
    noRepay: true,
  },
  PAYMENT_UNKNOWN: {
    tone: "wait",
    title: "결제 결과를 확인하고 있습니다",
    body: "결제 결과 확인이 늦어지고 있지만 확인은 계속 진행 중입니다. 이 화면을 닫아도 확인은 계속되며, 나중에 예매 확인에서 결과를 볼 수 있습니다.",
    seats: "결과가 나올 때까지 좌석은 보호됩니다.",
    actions: ["check-later"],
    poll: true,
    noRepay: true,
  },
  REVIEW_REQUIRED: {
    tone: "notice",
    title: "운영팀 확인이 필요한 예매입니다",
    body: "자동으로 확정할 수 없는 결제가 있어 운영팀이 확인하고 있습니다.",
    seats: "운영팀 확인이 끝날 때까지 좌석은 보호됩니다.",
    actions: ["contact"],
    poll: false,
    noRepay: true,
  },
  UNFULFILLED: {
    tone: "error",
    title: "결제는 되었으나 발권되지 않았습니다",
    body: "이 예매는 확정되지 않았습니다. 결제 금액은 환불 대상이며, 환불은 문의를 통해 안내합니다.",
    seats: "좌석은 반환되었습니다.",
    actions: ["contact"],
    poll: false,
    noRepay: true,
  },
  EXPIRED: {
    tone: "error",
    title: "예매 시간이 끝났습니다",
    body: "좌석 확보 시간이 지나 이 예매는 성립하지 않았습니다. 처음부터 다시 예매해 주세요.",
    seats: "좌석은 반환되었습니다.",
    actions: ["rebook"],
    poll: false,
    noRepay: false,
  },
  CANCELED: {
    tone: "error",
    title: "예매가 취소되었습니다",
    body: "이 예매는 취소되었습니다. 처음부터 다시 예매해 주세요.",
    seats: "좌석은 반환되었습니다.",
    actions: ["rebook"],
    poll: false,
    noRepay: false,
  },
  REFUNDED: {
    tone: "notice",
    title: "환불이 완료된 예매입니다",
    body: "이 예매는 환불되었습니다.",
    seats: "좌석은 반환되었습니다.",
    actions: [],
    poll: false,
    noRepay: false,
  },
};

/** 결과 확인 중 상태를 다시 불러오는 주기(DQ-3 미결정 — 개발팀 확인 후 이 값만 바꾼다). */
export const RESULT_POLLING = { fastIntervalMs: 3_000, fastWindowMs: 3 * 60_000, slowIntervalMs: 10_000 } as const;
