/**
 * Display text for catalog states. The UI shows the SERVER's computed status as-is — it never recomputes one.
 *
 * Decided wording (user decision 2026-11-21, TEST_PLAN §2.4): ON_SALE 예매 가능 · SOLD_OUT 매진 ·
 * TEMPORARILY_UNAVAILABLE 일시 품절, and the HELD_SEAT_NOTICE below. The other labels are the working names from the
 * Step 3 scope (판매 예정 / 판매 중지 / 판매 종료 / 공연 취소); their precedence is still pending approval.
 */
import type { SalesDisplayStatus } from "@/server/catalog/sales-status";
import type { SeatDisplayStatus } from "@/server/catalog/seat-display";

export const SALES_STATUS_LABEL: Record<Exclude<SalesDisplayStatus, "NOT_PUBLIC">, string> = {
  ON_SALE: "예매 가능",
  TEMPORARILY_UNAVAILABLE: "일시 품절",
  SOLD_OUT: "매진",
  UPCOMING: "판매 예정",
  PAUSED: "판매 중지",
  CLOSED: "판매 종료",
  CANCELED: "공연 취소",
};

export const SEAT_STATUS_LABEL: Record<SeatDisplayStatus, string> = {
  AVAILABLE: "선택 가능",
  HELD: "결제 진행 중",
  SOLD: "판매 완료",
  BLOCKED: "판매 불가",
};

/** Decided copy (2026-11-21) for temporarily held seats / a temporarily unavailable session. */
export const HELD_SEAT_NOTICE = "다른 고객의 결제가 진행 중인 좌석입니다. 잠시 후 다시 확인해 주세요.";

const krw = new Intl.NumberFormat("ko-KR");
export const formatKrw = (amount: number) => `${krw.format(amount)}원`;

/** Date and time in the venue's time zone (DATABASE venues.timezone, default Asia/Seoul). */
export function formatDateTime(isoString: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone,
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(isoString));
}
