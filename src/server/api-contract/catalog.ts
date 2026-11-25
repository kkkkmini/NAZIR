/**
 * 공개 조회 API 응답 계약 — 백엔드 문서 기준으로만 작성한 타입(코드 복사 아님).
 * 출처: docs/API_SPEC.md §4.3 "구현(Step 3, 2026-11-22)" (백엔드 브랜치 claude/epic-ptolemy-vy178w, v1.2.1)과
 *       docs/STEP3_HANDOFF.md. 이 프런트 브랜치의 API_SPEC에는 아직 이 기록이 없다(통합 시 반영).
 * 화면은 이 타입을 직접 쓰지 않는다. 서버 loader → adapter(src/server/booking/catalog-adapter.ts, src/server/seats/seat-adapter.ts) → 화면 view model 순서로만 쓴다.
 * 필드 이름·값을 프런트 편의로 바꾸지 않는다.
 */

/** 회차 판매 표시 상태. 서버가 계산한다. NOT_PUBLIC은 서버 내부 값이며 공개 API는 404로 응답한다(응답에 오지 않음). */
export const API_SESSION_STATUSES = ["ON_SALE", "TEMPORARILY_UNAVAILABLE", "SOLD_OUT", "UPCOMING", "PAUSED", "CLOSED", "CANCELED"] as const;
export type ApiSessionStatus = (typeof API_SESSION_STATUSES)[number];

/** 좌석 표시 상태(DATABASE §11.1). */
export type ApiSeatStatus = "AVAILABLE" | "HELD" | "SOLD" | "BLOCKED";

export interface ApiVenue {
  name: string;
  address: string | null;
  timezone: string;
}

export interface ApiShowSummary {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  posterUrl: string | null;
  venue: ApiVenue;
  salesOpensAt: string | null;
  salesClosesAt: string | null;
  priceRange: { min: number; max: number } | null;
}

export interface ApiSession {
  id: string;
  startsAt: string;
  endsAt: string | null;
  status: ApiSessionStatus;
  /** status === "ON_SALE"일 때만 true(서버 계산). */
  sellable: boolean;
  maxSeatsPerIdentity: number;
  /** 공개 노출 여부는 미결정(M6). 화면은 표시하지 않는다. */
  seats: { available: number; held: number; sold: number; blocked: number; total: number };
}

export interface ApiShowDetail extends ApiShowSummary {
  sessions: ApiSession[];
  priceTable: { section: string | null; price: number }[];
}

export interface ApiSeat {
  /** session_seats.id */
  id: string;
  /** seats.svg_seat_id — 배치도 매핑 키 */
  key: string;
  section: string | null;
  row: string | null;
  number: string;
  label: string | null;
  /** 정수 KRW */
  price: number;
  status: ApiSeatStatus;
}

/** GET /sessions/{sessionId}/seats */
export interface ApiSessionSeats {
  show: { id: string; slug: string; title: string; venue: ApiVenue };
  session: ApiSession;
  seatMap: { version: string | null; assetUrl: string | null };
  seats: ApiSeat[];
}

/** 공통 목록 응답(API §2). Step 3 리뷰 L: pagination 의미가 명세와 다를 수 있음(확인 필요). */
export interface ApiList<T> {
  items: T[];
  pagination: { page: number; limit: number; total: number };
}

/** 공통 오류 응답 { error: { code, message, details } } (src/server/lib/errors.ts, 백엔드). */
export interface ApiErrorBody {
  error: { code: string; message: string; details: Record<string, unknown> };
}
