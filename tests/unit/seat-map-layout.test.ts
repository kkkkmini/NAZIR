/**
 * CAT-08b: temporary seat-map grid (src/components/seat-map/layout.ts). Layout only — status is never computed here.
 */
import { describe, expect, it } from "vitest";
import { gridLayout } from "@/components/seat-map/layout";
import type { PublicSeat } from "@/server/catalog/public-catalog";

const seat = (o: Partial<PublicSeat>): PublicSeat => ({
  id: `id-${o.key}`,
  key: "k",
  section: "R",
  row: "A",
  number: "1",
  label: null,
  price: 100000,
  status: "AVAILABLE",
  ...o,
});

describe("CAT-08b gridLayout", () => {
  const seats = [
    seat({ key: "R-A-1", section: "R", row: "A", number: "1" }),
    seat({ key: "R-A-2", section: "R", row: "A", number: "2", status: "SOLD" }),
    seat({ key: "R-B-1", section: "R", row: "B", number: "1" }),
    seat({ key: "VIP-A-1", section: "VIP", row: "A", number: "1", price: 150000, status: "HELD" }),
    seat({ key: "S-A-1", section: "S", row: "A", number: "1", price: 90000 }),
    seat({ key: "S-A-2", section: "S", row: "A", number: "2", price: 80000 }),
    seat({ key: "X-1", section: null, row: null, number: "1", price: 50000 }),
  ];

  it("places every seat exactly once and never changes its status", () => {
    const placed = gridLayout(seats).flatMap((s) => s.rows.flatMap((r) => r.seats));
    expect(placed.map((s) => s.key).sort()).toEqual(seats.map((s) => s.key).sort());
    for (const s of placed) expect(s.status).toBe(seats.find((x) => x.key === s.key)!.status);
  });

  it("orders sections by highest price, keeps the server's row and seat order", () => {
    const layout = gridLayout(seats);
    expect(layout.map((s) => s.name)).toEqual(["VIP", "R", "S", "구역 미지정"]);
    expect(layout[1].rows.map((r) => [r.label, r.seats.map((s) => s.number)])).toEqual([
      ["A", ["1", "2"]],
      ["B", ["1"]],
    ]);
  });

  it("shows one price per section, or none when a section mixes prices", () => {
    const byName = Object.fromEntries(gridLayout(seats).map((s) => [s.name, s.price]));
    expect(byName).toEqual({ VIP: 150000, R: 100000, S: null, "구역 미지정": 50000 });
  });

  it("an empty seat list gives an empty layout", () => {
    expect(gridLayout([])).toEqual([]);
  });
});
