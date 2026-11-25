import { formatWon } from "@/components/booking/format";
import type { HoldItemView } from "@/server/seats/seat-types";

/** 주문 좌석 표 — A안(화이트 미니멀). A3-4·A3-5가 함께 쓴다. 값은 서버가 준 것만 표시한다. */
export function OrderItemsTable({ items }: { items: HoldItemView[] }) {
  return (
    <table className="w-full border-y border-rule text-[0.9375rem]">
      <thead className="sr-only">
        <tr>
          <th>좌석</th>
          <th>등급</th>
          <th>가격</th>
        </tr>
      </thead>
      <tbody>
        {items.map((i) => (
          <tr key={i.sessionSeatId} className="border-b border-rule last:border-b-0">
            <td className="py-3 text-char">{i.label}</td>
            <td className="py-3 text-char-3">{i.label.split(" ")[0]}석</td>
            <td className="py-3 text-right tabular-nums text-char">{formatWon(i.price)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
