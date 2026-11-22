/**
 * A3-1 회차 선택 화면이 쓰는 회차 데이터 형태.
 *
 * 회차 목록 API(`GET /shows/{id}/sessions`)의 응답 필드는 아직 정의되지 않았다(IA R-E).
 * 아래 상태 값은 디자인이 개발팀에 요청한 "서버 계산 상태"(User Flow 1.7, R1 제안)이며,
 * 화면은 이 값을 그대로 표시할 뿐 판매 가능 여부를 계산하지 않는다.
 */
export const SESSION_STATES = ["AVAILABLE", "SOLD_OUT", "UPCOMING", "PAUSED", "CLOSED", "CANCELED"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export interface BookingSessionView {
  id: string;
  /** ISO 8601 (UTC). 화면은 Asia/Seoul로 표시한다. */
  startsAt: string;
  /** 서버가 계산한 회차 상태 */
  state: SessionState;
  /** 판매 예정일 때 서버가 알려주는 오픈 시각(있을 때만) */
  opensAt?: string | null;
}

export type BookingSessionsResult =
  | { kind: "not-connected" }
  | { kind: "dev-fixture"; showTitle: string; sessions: BookingSessionView[] };
