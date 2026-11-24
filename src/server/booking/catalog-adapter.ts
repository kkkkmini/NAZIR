import type { ApiShowDetail } from "@/server/api-contract/catalog";
import type { BookingSessionView } from "./session-types";

/**
 * 공개 API 응답(ApiShowDetail) → A3-1 view model. 값은 바꾸지 않고 옮기기만 한다.
 * - state·sellable: 서버 값 그대로.
 * - opensAt: UPCOMING일 때만 공연의 salesOpensAt(회차별 값은 API에 없음 — 확인 필요).
 * 아직 이 함수를 부르는 loader는 없다(운영 연결 대기). 계약은 단위 테스트로 고정한다.
 */
export function toBookingSessions(show: ApiShowDetail): BookingSessionView[] {
  return show.sessions.map((s) => ({
    id: s.id,
    startsAt: s.startsAt,
    state: s.status,
    sellable: s.sellable,
    opensAt: s.status === "UPCOMING" ? show.salesOpensAt : null,
  }));
}
