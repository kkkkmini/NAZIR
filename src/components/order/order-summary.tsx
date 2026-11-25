import { formatSessionDateTime, formatWon } from "@/components/booking/format";
import type { OrderView } from "@/server/orders/order-types";

/** 주문 좌석·합계 요약(표시 전용). 값은 모두 서버가 준 것이다. */
export function OrderSummary({ order, showTitle, dev, heading }: { order: OrderView; showTitle: string; dev: boolean; heading: string }) {
  return (
    <section aria-label={heading} className="flex flex-col gap-4 rounded-sm border border-line bg-s1 p-5 md:p-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-xs tracking-[0.2em] text-subtle">{heading}</h2>
        <p className="type-heading text-lg text-ink">뮤지컬 〈{showTitle}〉</p>
        {order.sessionStartsAt && (
          <p className="text-base font-semibold tabular-nums text-ink">
            {formatSessionDateTime(order.sessionStartsAt)} {dev && <span className="text-[0.65rem] text-st-pause">[DEV]</span>}
          </p>
        )}
      </div>
      <ul className="flex flex-col gap-2 border-t border-line pt-4 text-sm">
        {order.items.map((i) => (
          <li key={i.sessionSeatId} className="flex justify-between gap-4 tabular-nums">
            <span className="text-ink">{i.label}</span>
            <span className="text-muted">{formatWon(i.price)}</span>
          </li>
        ))}
      </ul>
      <p className="flex items-baseline justify-between gap-4 border-t border-line pt-4 tabular-nums">
        <span className="text-sm text-muted">합계 {order.items.length}석</span>
        <span className="text-2xl font-semibold text-ink">
          {formatWon(order.totalAmount)} {dev && <span className="text-[0.65rem] text-st-pause">[DEV]</span>}
        </span>
      </p>
    </section>
  );
}
