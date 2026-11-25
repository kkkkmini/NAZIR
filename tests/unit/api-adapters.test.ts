/**
 * 공개 조회 API 계약(API_SPEC §4.3 Step 3 기록) → 화면 view model 변환.
 * 입력은 계약 타입의 최소 예시이며 실제 공연 데이터가 아니다.
 */
import { describe, expect, it } from "vitest";
import { API_SESSION_STATUSES, type ApiSeat, type ApiSession, type ApiShowDetail } from "@/server/api-contract/catalog";
import { toBookingSessions } from "@/server/booking/catalog-adapter";
import { SESSION_STATES } from "@/server/booking/session-types";
import { toSeatView } from "@/server/seats/seat-adapter";

const session = (status: ApiSession["status"], i: number): ApiSession => ({
  id: `s-${i}`,
  startsAt: "2026-12-01T10:30:00.000Z",
  endsAt: null,
  status,
  sellable: status === "ON_SALE",
  maxSeatsPerIdentity: 4,
  seats: { available: 0, held: 0, sold: 0, blocked: 0, total: 0 },
});

const show: ApiShowDetail = {
  id: "show-1",
  slug: "example",
  title: "예시",
  description: null,
  posterUrl: null,
  venue: { name: "예시 공연장", address: null, timezone: "Asia/Seoul" },
  salesOpensAt: "2026-11-30T05:00:00.000Z",
  salesClosesAt: null,
  priceRange: null,
  sessions: API_SESSION_STATUSES.map(session),
  priceTable: [],
};

describe("catalog adapter (A3-1)", () => {
  it("the view model accepts exactly the API session statuses", () => {
    expect([...SESSION_STATES]).toEqual([...API_SESSION_STATUSES]);
  });

  it("keeps every server status and sellable as given, never merging statuses", () => {
    const v = toBookingSessions(show);
    expect(v.map((s) => s.state)).toEqual([...API_SESSION_STATUSES]);
    expect(v.map((s) => s.sellable)).toEqual(show.sessions.map((s) => s.sellable));
    expect(v.find((s) => s.state === "TEMPORARILY_UNAVAILABLE")!.sellable).toBe(false);
  });

  it("uses the show's salesOpensAt only for UPCOMING", () => {
    for (const s of toBookingSessions(show)) expect(s.opensAt).toBe(s.state === "UPCOMING" ? show.salesOpensAt : null);
  });
});

describe("seat adapter (A3-3)", () => {
  const seat: ApiSeat = { id: "ss-1", key: "R-D-5", section: "R", row: "D", number: "5", label: "R석 D열 5번", price: 110000, status: "HELD" };

  it("maps ids, keeps status and price from the server", () => {
    expect(toSeatView(seat)).toEqual({ sessionSeatId: "ss-1", svgSeatId: "R-D-5", section: "R", row: "D", number: "5", label: "R석 D열 5번", price: 110000, state: "HELD" });
  });

  it("builds a display label only when the API label is null", () => {
    expect(toSeatView({ ...seat, label: null }).label).toBe("R D열 5번");
    expect(toSeatView({ ...seat, label: null, section: null, row: null }).label).toBe("5번");
  });
});
