/**
 * A3-1 회차 선택 화면의 view model.
 * 상태 값은 공개 API(GET /shows/{showId}, Session.status — src/server/api-contract/catalog.ts)의 서버 계산 값과 같다.
 * 화면은 판매 가능 여부를 계산하지 않고 서버의 sellable만 쓴다. 상태를 다른 상태로 합치지 않는다.
 */
import { API_SESSION_STATUSES, type ApiSessionStatus } from "@/server/api-contract/catalog";

export const SESSION_STATES = API_SESSION_STATUSES;
export type SessionState = ApiSessionStatus;

export interface BookingSessionView {
  id: string;
  /** ISO 8601 (UTC). 화면은 Asia/Seoul로 표시한다. */
  startsAt: string;
  /** 서버가 계산한 회차 판매 표시 상태 */
  state: SessionState;
  /** 서버가 계산한 판매 가능 여부(선택 가능 여부의 유일한 근거) */
  sellable: boolean;
  /** 판매 예정일 때 오픈 시각. API는 공연 단위 salesOpensAt만 준다(회차별 오픈 시각 없음). */
  opensAt?: string | null;
}

export type BookingSessionsResult =
  | { kind: "not-connected" }
  | { kind: "dev-fixture"; showTitle: string; sessions: BookingSessionView[] }
  /** 실제 공개 카탈로그(DB). 공연 ID는 이후 단계(A3-3)에서 같은 규칙으로 다시 결정한다. */
  | { kind: "live"; showId: string; showSlug: string; showTitle: string; sessions: BookingSessionView[]; testData: boolean };
