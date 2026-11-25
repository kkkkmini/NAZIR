import type { SeatView } from "@/server/seats/seat-types";

/** 좌석 배치 공통 도우미(A3-3 배치도와 A3-4 미니 배치도가 함께 쓴다). 표시용이며 상태 판단을 하지 않는다. */
export function groupBy<T>(list: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const t of list) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
  return m;
}

/**
 * 주문 좌석이 배치 데이터에 모두 정확히 있을 때만 배치를 돌려준다.
 * 하나라도 없거나 배치가 비어 있으면 null — 위치를 모르는 좌석을 임의로 그리지 않기 위함이다.
 */
export function matchOrderSeats(layout: SeatView[] | null, orderSeatIds: string[]): SeatView[] | null {
  if (!layout || layout.length === 0 || orderSeatIds.length === 0) return null;
  const ids = new Set(layout.map((s) => s.sessionSeatId));
  return orderSeatIds.every((id) => ids.has(id)) ? layout : null;
}
