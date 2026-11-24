/**
 * Seat-map LAYOUT — where each seat is drawn. Kept separate from seat STATUS, which always comes from the server.
 *
 * Seats are matched to a drawing by `key` = seats.svg_seat_id (DATABASE.md §4.4: "SVG는 시각적 배치만 담당하며 판매 상태는
 * DB에서 조회한다"). Today there is no venue drawing (DECISIONS E-003), so `gridLayout` arranges seats as
 * section → row → seat from their section/row/number. When the venue SVG arrives, a second layout that reads seat
 * positions from the SVG elements whose id (or data-seat-id) equals `key` replaces this one; the data, the status and
 * the `key` mapping stay unchanged.
 */
import type { PublicSeat } from "@/server/catalog/public-catalog";

export interface SeatMapRow {
  label: string;
  seats: PublicSeat[];
}

export interface SeatMapSection {
  name: string;
  price: number | null;
  rows: SeatMapRow[];
}

const NO_SECTION = "구역 미지정";
const NO_ROW = "-";

/**
 * Temporary grid: sections in descending price (then name), rows and seats in the server's order (section, row,
 * numeric seat number). Pure and deterministic — every seat appears exactly once.
 */
export function gridLayout(seats: readonly PublicSeat[]): SeatMapSection[] {
  const sections = new Map<string, { prices: Set<number>; rows: Map<string, PublicSeat[]> }>();
  for (const seat of seats) {
    const name = seat.section ?? NO_SECTION;
    const section = sections.get(name) ?? { prices: new Set<number>(), rows: new Map<string, PublicSeat[]>() };
    section.prices.add(seat.price);
    const row = seat.row ?? NO_ROW;
    section.rows.set(row, [...(section.rows.get(row) ?? []), seat]);
    sections.set(name, section);
  }
  return [...sections.entries()]
    .map(([name, s]) => ({
      name,
      // a single price per section is the common case; mixed prices are shown per seat instead
      price: s.prices.size === 1 ? [...s.prices][0] : null,
      maxPrice: Math.max(...s.prices),
      rows: [...s.rows.entries()].map(([label, rowSeats]) => ({ label, seats: rowSeats })),
    }))
    .sort((a, b) => b.maxPrice - a.maxPrice || a.name.localeCompare(b.name))
    .map(({ name, price, rows }) => ({ name, price, rows }));
}
