/**
 * 공연장 메타데이터 — 프런트 콘텐츠 데이터(확정 2026-11-24, 사용자 제공).
 * - 공개 API의 공연장 정보(ApiVenue: name·address·timezone, src/server/api-contract/catalog.ts)가 연결되면
 *   API 값으로 대체한다. 지금은 API가 제공하는 것처럼 가장하지 않는다.
 * - 확인되지 않은 정보(주소·연락처·시설)는 넣지 않는다(null).
 */
export interface VenueContent {
  /** 현재 공연장명 */
  name: string;
  nameLatin: string;
  /** 지역(시 단위). 상세 주소는 미확정 */
  city: string;
  address: string | null;
  timezone: string;
  /** 내부 참고용. 화면에 표시하지 않는다. */
  formerNames: string[];
  /** 좌석 안내 이미지(디자인 참고 자료, docs/design/reference). 판매 좌석·좌석 ID의 근거가 아니다. */
  seatGuideReference: string;
}

export const luminaArtHall: VenueContent = {
  name: "루미나아트홀",
  nameLatin: "Lumina Art Hall",
  city: "서울",
  address: null,
  timezone: "Asia/Seoul",
  formerNames: ["시온아트홀"],
  seatGuideReference: "docs/design/reference/lumina-art-hall-seat-guide.jpg",
};
