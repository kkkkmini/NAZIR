import type { ApiSeat } from "@/server/api-contract/catalog";
import type { SeatView } from "./seat-types";

/**
 * 공개 좌석 API(GET /sessions/{id}/seats의 seats[]) → A3-3 view model. 상태·가격은 서버 값 그대로.
 * label이 null이면 표시용 문구를 구역·열·번호로 만든다(표시 전용, 서버 값 변경 아님 — 백엔드와 표기 규칙 확인 필요).
 * 좌석 확보·주문은 이 API의 범위가 아니다(읽기 전용).
 */
export function toSeatView(s: ApiSeat): SeatView {
  return {
    sessionSeatId: s.id,
    svgSeatId: s.key,
    section: s.section,
    row: s.row,
    number: s.number,
    label: s.label ?? [s.section, s.row ? `${s.row}열` : null, `${s.number}번`].filter(Boolean).join(" "),
    price: s.price,
    state: s.status,
  };
}
