import { formatWon, timeFmt, weekdayFmt } from "@/components/booking/format";
import { OrderItemsTable } from "@/components/order/order-items-table";
import type { OrderDetailView } from "@/server/orders/order-list-types";

/**
 * A4-3 예매 확인서(PAID만) — A안(화이트 미니멀). 결제가 완료된 예매 내역을 보여 주는 문서다.
 * - 입장권·현장 입장 수단이 아니다. QR을 만들지 않는다(IA U3, Phase 1).
 * - 개인정보 최소화: 이름 가운데 가림, 휴대전화 뒤 4자리만. 생년월일·이메일·전체 번호·카드 번호·승인번호는 표시하지 않는다.
 * - 표시 항목은 V-6(현장 대조 항목) 결정에 따라 바뀔 수 있다.
 */
const dateFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" });
const paidFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

export function OrderConfirmation({
  order,
  customer,
  payment,
  dev,
}: {
  order: OrderDetailView;
  customer: NonNullable<OrderDetailView["customer"]>;
  payment: NonNullable<OrderDetailView["payment"]>;
  dev: boolean;
}) {
  const d = new Date(order.session.startsAt);
  const devTag = dev ? <span className="ml-1.5 text-[0.625rem] font-semibold text-char-3">[DEV]</span> : null;
  return (
    <section aria-labelledby="conf-title" className="flex flex-col gap-5 border-t-2 border-char pt-6 md:pt-8" data-confirmation>
      <div className="flex flex-col gap-1">
        <h2 id="conf-title" className="text-lg font-bold tracking-[-0.02em] text-char md:text-xl">
          예매 확인서{devTag}
        </h2>
        <p className="text-sm text-char-3">결제가 완료된 예매 내역입니다.</p>
      </div>

      <div className="flex flex-col gap-1 border-y border-rule py-4">
        <span className="text-xs text-char-3">예매 번호</span>
        <span className="text-xl font-bold tracking-[0.02em] tabular-nums text-char md:text-2xl" data-order-number>
          {order.orderNumber}
        </span>
      </div>

      <dl className="text-[0.9375rem]">
        <Row label="공연">뮤지컬 {order.show.title}</Row>
        <Row label="관람일시">
          {dateFmt.format(d)} ({weekdayFmt.format(d)}) <span className="tabular-nums">{timeFmt.format(d)}</span>
        </Row>
        <Row label="예매자">
          {customer.nameMasked}
          {devTag}
        </Row>
        <Row label="휴대전화" last>
          <span className="tabular-nums">뒤 4자리 {customer.phoneLast4}</span>
          {devTag}
        </Row>
      </dl>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-bold text-char">좌석 {order.items.length}석</h3>
        <OrderItemsTable items={order.items.map((i) => ({ sessionSeatId: i.seatId, label: i.label, price: i.price }))} />
      </div>

      <dl className="text-[0.9375rem]">
        <Row label="총 결제 금액">
          <span className="text-lg font-bold tabular-nums">{formatWon(order.totalAmount)}</span>
          {devTag}
        </Row>
        <Row label="결제수단">{payment.methodLabel}</Row>
        <Row label="결제 완료" last>
          <span className="tabular-nums">{paidFmt.format(new Date(payment.paidAt))}</span>
        </Row>
      </dl>

      <p className="bg-wash px-4 py-3 text-sm text-char-2" data-onsite-note>
        현장 확인 방법은 별도로 안내됩니다.
      </p>
    </section>
  );
}

function Row({ label, children, last }: { label: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={"grid grid-cols-[5.5rem_1fr] items-baseline gap-3 py-2.5 md:grid-cols-[7rem_1fr] " + (last ? "" : "border-b border-rule")}>
      <dt className="text-sm text-char-3">{label}</dt>
      <dd className="font-medium text-char">{children}</dd>
    </div>
  );
}
