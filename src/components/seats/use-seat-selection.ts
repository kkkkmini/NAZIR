"use client";

import { useCallback, useMemo, useState } from "react";
import type { SeatView } from "@/server/seats/seat-types";

/**
 * 좌석 선택 상태(화면 로직). 선택은 "점유 전" 상태이며 서버 점유와 무관하다.
 * - 서버 상태가 AVAILABLE인 좌석만 선택할 수 있다.
 * - limit(서버가 준 남은 구매 가능 수)를 넘겨 선택할 수 없다.
 * - 좌석 목록이 새로 오면(재조회) 더 이상 AVAILABLE이 아닌 좌석은 선택에서 자동으로 빠진다.
 */
export function useSeatSelection(seats: SeatView[], limit: number) {
  const [picked, setPicked] = useState<string[]>([]);

  const byId = useMemo(() => new Map(seats.map((s) => [s.sessionSeatId, s])), [seats]);
  const selected = useMemo(
    () => picked.map((id) => byId.get(id)).filter((s): s is SeatView => s?.state === "AVAILABLE").slice(0, Math.max(0, limit)),
    [picked, byId, limit],
  );

  const toggle = useCallback(
    (seat: SeatView): "added" | "removed" | "limit" | "unavailable" => {
      if (selected.some((s) => s.sessionSeatId === seat.sessionSeatId)) {
        setPicked((p) => p.filter((id) => id !== seat.sessionSeatId));
        return "removed";
      }
      if (seat.state !== "AVAILABLE") return "unavailable";
      if (selected.length >= limit) return "limit";
      setPicked(() => [...selected.map((s) => s.sessionSeatId), seat.sessionSeatId]);
      return "added";
    },
    [selected, limit],
  );

  const clear = useCallback(() => setPicked([]), []);

  return {
    selected,
    selectedIds: useMemo(() => new Set(selected.map((s) => s.sessionSeatId)), [selected]),
    /** 표시용 합계. 최종 금액은 서버가 점유 결과로 정한다. */
    displayTotal: selected.reduce((sum, s) => sum + s.price, 0),
    toggle,
    clear,
  };
}
