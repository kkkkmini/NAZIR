/**
 * Read-only seat map (Step 3). Shows each seat's server-computed status; no selection — seat selection needs the
 * identity step first (D-004, Step 4) and order creation (Step 5).
 *
 * Every seat element carries `data-seat-key` (= seats.svg_seat_id) and `data-status` (= the API status), so the
 * rendered map can be checked against the database (tests/contract/schema/catalog.test.ts) and later mapped onto the
 * venue SVG by key. Status is shown by text/pattern as well as colour (legend + aria-label).
 */
import type { PublicSeat } from "@/server/catalog/public-catalog";
import type { SeatDisplayStatus } from "@/server/catalog/seat-display";
import { formatKrw, HELD_SEAT_NOTICE, SEAT_STATUS_LABEL } from "../catalog/labels";
import { gridLayout } from "./layout";

const SEAT_CLASS: Record<SeatDisplayStatus, string> = {
  AVAILABLE: "border-neutral-500 bg-white text-neutral-900",
  HELD: "border-dashed border-amber-600 bg-amber-50 text-amber-900",
  SOLD: "border-neutral-300 bg-neutral-300 text-neutral-500 line-through",
  BLOCKED: "border-neutral-200 bg-neutral-100 text-neutral-300",
};

const ORDER: SeatDisplayStatus[] = ["AVAILABLE", "HELD", "SOLD", "BLOCKED"];

function seatName(seat: PublicSeat): string {
  return seat.label ?? [seat.section, seat.row && `${seat.row}열`, `${seat.number}번`].filter(Boolean).join(" ");
}

export function SeatLegend() {
  return (
    <ul className="flex flex-wrap gap-4 text-sm text-neutral-700" aria-label="좌석 상태 범례">
      {ORDER.map((status) => (
        <li key={status} className="flex items-center gap-2" data-legend={status}>
          <span aria-hidden className={`inline-block h-4 w-4 rounded-sm border ${SEAT_CLASS[status]}`} />
          {SEAT_STATUS_LABEL[status]}
        </li>
      ))}
    </ul>
  );
}

export function SeatMap({ seats }: { seats: readonly PublicSeat[] }) {
  if (seats.length === 0) {
    return <p className="text-neutral-600">이 회차에 등록된 좌석이 없습니다.</p>;
  }
  const sections = gridLayout(seats);
  const hasHeld = seats.some((s) => s.status === "HELD");
  return (
    <div className="flex flex-col gap-6" data-seat-map>
      <div className="rounded border border-neutral-300 py-2 text-center text-sm text-neutral-500">무대</div>
      {sections.map((section) => (
        <section key={section.name} aria-label={`${section.name} 구역`} className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">
            {section.name}
            {section.price !== null && <span className="ml-2 font-normal text-neutral-600">{formatKrw(section.price)}</span>}
          </h3>
          <div className="overflow-x-auto">
            {section.rows.map((row) => (
              <div key={row.label} className="flex items-center gap-0.5 py-0.5 sm:gap-1">
                <span className="w-6 shrink-0 pr-1 text-right text-xs text-neutral-500 sm:w-8">{row.label}</span>
                <ul className="flex gap-0.5 sm:gap-1">
                  {row.seats.map((seat) => (
                    <li
                      key={seat.id}
                      data-seat-key={seat.key}
                      data-status={seat.status}
                      aria-label={`${seatName(seat)} · ${SEAT_STATUS_LABEL[seat.status]} · ${formatKrw(seat.price)}`}
                      title={`${seatName(seat)} · ${SEAT_STATUS_LABEL[seat.status]}`}
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border text-[10px] sm:h-7 sm:w-7 ${SEAT_CLASS[seat.status]}`}
                    >
                      {seat.number}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}
      <SeatLegend />
      {hasHeld && (
        <p className="text-sm text-amber-900" data-held-notice>
          {HELD_SEAT_NOTICE}
        </p>
      )}
    </div>
  );
}
