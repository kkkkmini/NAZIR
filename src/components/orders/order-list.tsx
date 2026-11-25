import Link from "next/link";
import { formatWon, fullFmt, timeFmt } from "@/components/booking/format";
import { ORDER_STATUS_UI } from "@/components/order/order-status";
import type { OrderListItem, OrderListView } from "@/server/orders/order-list-types";
import type { OrderStatus } from "@/server/orders/order-types";

/**
 * A4-2 내 예매 목록 — A안(화이트 미니멀). 서버가 준 주문 상태를 묶어서 보여 주기만 한다.
 * - 목록에는 결제·취소 버튼을 두지 않는다. 행 전체가 상세(A4-3 /orders/{orderId})로 이어진다.
 * - 자동 재조회하지 않는다. 결과 확인 중 주문은 상세·결과 화면에서 다시 확인한다.
 * - 상태 문구의 기준은 A3-5와 같은 ORDER_STATUS_UI다.
 */
const ATTENTION: OrderStatus[] = ["PENDING", "PAYMENT_CONFIRMING", "PAYMENT_UNKNOWN", "REVIEW_REQUIRED", "UNFULFILLED"];
const INVALID: OrderStatus[] = ["EXPIRED", "CANCELED", "REFUNDED"];

/** 목록용 짧은 상태 이름. 의미는 ORDER_STATUS_UI(A3-5)와 같다. */
const LABEL: Record<OrderStatus, string> = {
  PENDING: "결제 대기",
  PAYMENT_CONFIRMING: "결제 결과 확인 중",
  PAYMENT_UNKNOWN: "결제 결과 확인 중",
  REVIEW_REQUIRED: "운영팀 확인 중",
  UNFULFILLED: "발권되지 않음 · 환불 대상",
  PAID: "예매 완료",
  EXPIRED: "시간 만료",
  CANCELED: "취소됨",
  REFUNDED: "환불 완료",
};

export function OrderList({ view, dev }: { view: OrderListView; dev: boolean }) {
  const now = Date.parse(view.serverNow);
  const at = (o: OrderListItem) => Date.parse(o.session.startsAt);
  const attention = view.items.filter((o) => ATTENTION.includes(o.status)).sort((a, b) => at(a) - at(b));
  const done = view.items.filter((o) => o.status === "PAID" && at(o) >= now).sort((a, b) => at(a) - at(b));
  const past = view.items.filter((o) => INVALID.includes(o.status) || (o.status === "PAID" && at(o) < now)).sort((a, b) => at(b) - at(a));

  return (
    <div className="flex flex-col gap-8 md:gap-10">
      <ViewerBar view={view} dev={dev} />
      {view.items.length === 0 ? (
        <Empty />
      ) : (
        <>
          <Group id="attention" title="확인이 필요한 예매" items={attention} dev={dev} />
          <Group id="done" title="예매 완료" items={done} dev={dev} />
          <Group id="past" title="지난 공연 · 무효 예매" items={past} dev={dev} muted />
        </>
      )}
    </div>
  );
}

function ViewerBar({ view, dev }: { view: OrderListView; dev: boolean }) {
  const lookup = view.viewer.purpose === "LOOKUP";
  return (
    <section aria-label="인증 상태" className="flex flex-col gap-1.5 border-t-2 border-char pt-5 sm:flex-row sm:items-baseline sm:justify-between" data-viewer>
      <p className="text-[0.9375rem] text-char">
        <span className="font-semibold">{view.viewer.displayName}</span> 님의 예매
        {dev && <span className="ml-1.5 text-xs font-semibold text-char-3">[DEV]</span>}
      </p>
      <p className="text-[0.8125rem] text-char-3">{lookup ? "조회 전용 인증 · 결제·취소는 예매용 인증 후 가능" : "예매용 인증"}</p>
    </section>
  );
}

function Group({ id, title, items, dev, muted }: { id: string; title: string; items: OrderListItem[]; dev: boolean; muted?: boolean }) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={`g-${id}`} className="flex flex-col gap-3" data-group={id}>
      <h2 id={`g-${id}`} className="flex items-baseline gap-2 text-[0.9375rem] font-bold text-char md:text-base">
        {title}
        <span className="text-sm font-normal tabular-nums text-char-3">{items.length}</span>
      </h2>
      <ul className="border-t border-rule">
        {items.map((o) => (
          <li key={o.orderId} className="border-b border-rule">
            <Row order={o} dev={dev} muted={muted} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Row({ order, dev, muted }: { order: OrderListItem; dev: boolean; muted?: boolean }) {
  const ui = ORDER_STATUS_UI[order.status];
  const d = new Date(order.session.startsAt);
  const seats = order.items.length > 1 ? `${order.items[0].label} 외 ${order.items.length - 1}석` : order.items[0]?.label ?? "—";
  const waiting = ui.poll;
  return (
    <Link
      href={`/orders/${encodeURIComponent(order.orderId)}`}
      data-order-row={order.status}
      className="group grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 py-4 transition-colors hover:bg-wash md:grid-cols-[11rem_minmax(0,1fr)_minmax(0,1fr)_7rem_1.25rem] md:gap-x-6 md:px-2"
    >
      <span className={"flex items-center gap-2 text-[0.9375rem] font-semibold " + (muted ? "text-char-3" : "text-char")}>
        {waiting && <span aria-hidden className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-rule border-t-char motion-reduce:animate-none" />}
        {LABEL[order.status]}
      </span>
      <span className={"text-right text-sm tabular-nums md:text-left md:text-[0.9375rem] " + (muted ? "text-char-3" : "text-char")}>{fullFmt.format(d)}</span>
      <span className="truncate text-sm text-char-2 md:text-[0.9375rem]">
        {seats}
        <span className="sr-only">, 공연 {order.show.title}</span>
      </span>
      <span className="text-right text-sm font-medium tabular-nums text-char md:text-[0.9375rem]">
        {formatWon(order.totalAmount)}
        {dev && <span className="ml-1 text-[0.625rem] font-semibold text-char-3">[DEV]</span>}
      </span>
      <span aria-hidden className="hidden text-char-3 group-hover:text-char md:block">
        ›
      </span>
      {(order.status === "PENDING" || ui.noRepay) && (
        <span className="col-span-2 text-xs text-char-3 md:col-start-2 md:col-end-6" data-row-note>
          {order.status === "PENDING"
            ? `좌석 유지 ${order.holdExpiresAt ? timeFmt.format(new Date(order.holdExpiresAt)) + "까지" : ""} · ${order.canPay ? "상세에서 결제를 이어갈 수 있습니다" : "결제·취소는 예매용 본인인증 후 가능합니다"}`
            : waiting
              ? "좌석 보호 중 · 다시 결제하지 마세요"
              : "좌석 보호 중 · 문의 안내를 확인해 주세요"}
        </span>
      )}
    </Link>
  );
}

function Empty() {
  return (
    <section className="flex flex-col items-start gap-3 border-y border-rule py-12" data-empty>
      <h2 className="text-lg font-bold text-char">이 인증 정보로 예매한 내역이 없습니다</h2>
      <p className="text-[0.9375rem] text-char-2">다른 휴대전화 번호로 본인인증해 예매했다면, 그 번호로 다시 인증해 주세요.</p>
      <Link href="/booking" className="mt-2 inline-flex min-h-12 items-center justify-center rounded-[0.25rem] bg-btn px-7 text-[0.9375rem] font-semibold text-white hover:bg-btn-hover">
        예매하기
      </Link>
    </section>
  );
}
