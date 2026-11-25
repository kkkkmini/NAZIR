/**
 * 뮤지컬 〈나지르〉 공연 소개 콘텐츠 — A1 랜딩 전용 임시 정적 콘텐츠.
 *
 * - 확정된 값만 넣는다. 확정되지 않은 값은 `null`로 두고 화면은 "추후 공개"로 표시한다.
 * - 공연 콘텐츠의 저장 위치와 응답 구조는 개발팀 확인 사항이다(docs/design/01_IA.md R-D).
 *   API가 정해지면 이 파일은 그 응답으로 대체한다.
 * - 공연장 정보는 src/content/venue.ts에서 관리한다.
 * - 판매 상태·가격은 여기에 두지 않는다. 서버가 계산해 제공해야 한다(R-E).
 */

import { luminaArtHall } from "./venue";

export interface CreditEntry {
  role: string;
  name: string;
}

export interface ShowContent {
  /** 공연명 (확정: 뮤지컬 〈나지르〉) */
  title: string;
  /** 영문 표기 (서비스명 NAZIR) */
  titleLatin: string;
  genre: string;
  tagline: string | null;
  posterUrl: string | null;
  /** 히어로 키 비주얼(가로형). 제작 예정. 없으면 타이틀 카드로 표시한다. */
  keyVisualUrl: string | null;
  /** 공연장 표시명 (확정: src/content/venue.ts) */
  venue: string | null;
  period: string | null;
  runningTime: string | null;
  ageRating: string | null;
  synopsis: string[] | null;
  description: string[] | null;
  /** 작품 전체 출연진. 회차별 캐스팅은 표시하지 않는다(D3). */
  cast: CreditEntry[] | null;
  creatives: CreditEntry[] | null;
}

export const nazir: ShowContent = {
  title: "나지르",
  titleLatin: "NAZIR",
  genre: "뮤지컬",
  tagline: null,
  posterUrl: null,
  keyVisualUrl: null,
  venue: luminaArtHall.name,
  period: null,
  runningTime: null,
  ageRating: null,
  synopsis: null,
  description: null,
  cast: null,
  creatives: null,
};

/** 사업자 정보 — 확정 전(카드사 심사 게시 항목 E-008). */
export const businessInfo: { label: string; value: string | null }[] = [
  { label: "상호", value: null },
  { label: "대표자", value: null },
  { label: "사업자등록번호", value: null },
  { label: "통신판매업 신고번호", value: null },
  { label: "주소", value: null },
  { label: "고객 문의", value: null },
];
