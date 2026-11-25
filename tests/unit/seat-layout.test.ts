import { describe, expect, it } from "vitest";
import { matchOrderSeats } from "@/components/seats/seat-layout";
import type { SeatView } from "@/server/seats/seat-types";

const seat = (id: string): SeatView => ({ sessionSeatId: id, svgSeatId: id, section: "VIP", row: "A", number: "1", label: id, price: 1, state: "AVAILABLE" });
const layout = [seat("s:1"), seat("s:2"), seat("s:3")];

describe("matchOrderSeats — 미니 배치도는 정확히 연결될 때만", () => {
  it("1석·여러 석이 모두 있으면 배치를 돌려준다", () => {
    expect(matchOrderSeats(layout, ["s:2"])).toBe(layout);
    expect(matchOrderSeats(layout, ["s:1", "s:3"])).toBe(layout);
  });
  it("하나라도 없으면 null(숨김)", () => {
    expect(matchOrderSeats(layout, ["s:1", "other:9"])).toBeNull();
  });
  it("배치가 없거나(운영) 비었거나 주문 좌석이 없으면 null", () => {
    expect(matchOrderSeats(null, ["s:1"])).toBeNull();
    expect(matchOrderSeats([], ["s:1"])).toBeNull();
    expect(matchOrderSeats(layout, [])).toBeNull();
  });
});
