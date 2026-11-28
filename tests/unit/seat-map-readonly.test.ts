/**
 * A3-3 좌석 상태별 렌더링(조회 전용 포함). DB 없이 SeatMap만 정적으로 렌더해 확인한다.
 * 상태 값은 공개 좌석 API 계약(AVAILABLE/HELD/SOLD/BLOCKED)과 같다. 입력은 테스트용 최소 좌석이다.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SeatMap, SEAT_STATE_LABEL } from "@/components/seats/seat-map";
import type { SeatState, SeatView } from "@/server/seats/seat-types";

const STATES: SeatState[] = ["AVAILABLE", "HELD", "SOLD", "BLOCKED"];
const seats: SeatView[] = STATES.map((state, i) => ({
  sessionSeatId: `ss-${i}`,
  svgSeatId: `T-A-${i + 1}`,
  section: "T",
  row: "A",
  number: String(i + 1),
  label: `T A열 ${i + 1}번`,
  price: 100000,
  state,
}));

function render(disabled: boolean) {
  const html = renderToStaticMarkup(
    createElement(SeatMap, { seats, selectedIds: new Set<string>(), failedIds: new Set<string>(), onToggle: () => {}, disabled, dev: false }),
  );
  const buttons = [...html.matchAll(/<button[^>]*data-seat="([^"]+)"[^>]*>/g)].map((m) => m[0]);
  return Object.fromEntries(
    buttons.map((b) => [/data-state="([^"]+)"/.exec(b)![1], { disabled: /aria-disabled="true"/.test(b), label: /aria-label="([^"]+)"/.exec(b)![1] }]),
  );
}

describe("A3-3 seat states", () => {
  it("renders every API state as-is with its screen-reader label", () => {
    const r = render(false);
    expect(Object.keys(r).sort()).toEqual([...STATES].sort());
    for (const s of STATES) expect(r[s].label).toContain(SEAT_STATE_LABEL[s]);
  });

  it("only AVAILABLE is clickable in the normal (dev) mode", () => {
    const r = render(false);
    expect(r.AVAILABLE.disabled).toBe(false);
    for (const s of ["HELD", "SOLD", "BLOCKED"] as const) expect(r[s].disabled).toBe(true);
  });

  it("read-only mode (disabled) makes every seat, including AVAILABLE, non-clickable", () => {
    const r = render(true);
    for (const s of STATES) expect(r[s].disabled).toBe(true);
  });
});
