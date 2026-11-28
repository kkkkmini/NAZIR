/**
 * 좌석·점유 화면이 서버에서 받는 데이터 형태.
 * 실제 API(GET /sessions/{id}/seats, GET /sessions/{id}/my-quota, POST /orders)가 생기면
 * 같은 형태로 매핑해 화면 컴포넌트는 바꾸지 않는다.
 */

/** 서버가 DATABASE §11.1 우선순위로 계산한 좌석 표시 상태. HELD는 DB에 저장되지 않고 계산된다. */
export type SeatState = "AVAILABLE" | "HELD" | "SOLD" | "BLOCKED";

export type SeatView = {
  /** session_seats.id — 점유 요청에 쓰는 ID */
  sessionSeatId: string;
  /** seats.svg_seat_id — 배치도와 연결하는 키 */
  svgSeatId: string;
  section: string | null;
  row: string | null;
  number: string;
  /** seats.seat_label */
  label: string;
  /** session_seats.price (원). 서버가 정한 최종 가격. DB의 bigint는 서버에서 number로 바꿔 넘긴다. */
  price: number;
  state: SeatState;
};

/** GET /sessions/{id}/my-quota */
export type QuotaView = {
  seatLimit: number;
  countedSeats: number;
  remaining: number;
  activeOrderId: string | null;
};

export type SeatMapResult =
  | { kind: "not-ready" }
  | { kind: "invalid-session" }
  /**
   * 실제 공개 좌석(Step 3, 읽기 전용). 구매 한도(my-quota)와 좌석 확보(Step 5)가 연결되지 않았으므로 quota가 없다.
   * seatLimit은 회차의 maxSeatsPerIdentity(서버 값)이며 남은 구매 가능 수가 아니다.
   */
  | { kind: "live-readonly"; sessionId: string; sessionStartsAt: string; seats: SeatView[]; seatLimit: number; testData: boolean }
  | { kind: "dev-fixture"; sessionId: string; sessionStartsAt: string; seats: SeatView[]; quota: QuotaView };

/** [DEV] 점유 응답 미리보기 선택값. "auto"는 개발용 좌석 상태 그대로 판단한다. */
export const HOLD_SIMULATIONS = ["auto", "seat-taken", "limit", "active-order", "identity-time"] as const;
export type HoldSimulation = (typeof HOLD_SIMULATIONS)[number];

/** POST /orders 응답을 화면용으로 줄인 형태. 성공 여부는 서버가 정한다. */
export type HoldSeatsResult =
  | { ok: true; holdId: string }
  | { ok: false; code: "SEAT_UNAVAILABLE"; unavailableSeatIds: string[] }
  | { ok: false; code: "PURCHASE_LIMIT_EXCEEDED"; remaining: number }
  | { ok: false; code: "ACTIVE_ORDER_EXISTS"; activeOrderId: string | null }
  | { ok: false; code: "IDENTITY_SESSION_TIME_INSUFFICIENT" }
  | { ok: false; code: "INVALID_REQUEST" }
  | { ok: false; code: "NOT_AVAILABLE" };

export type HoldItemView = { sessionSeatId: string; label: string; price: number };
