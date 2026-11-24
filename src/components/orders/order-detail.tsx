import Link from "next/link";
import { formatWon, timeFmt, weekdayFmt } from "@/components/booking/format";
import { OrderItemsTable } from "@/components/order/order-items-table";
import { Actions, HoldRemaining, ResultMark, secondary } from "@/components/order/order-parts";
import { ORDER_STATUS_UI, type OrderAction } from "@/components/order/order-status";
import type { OrderDetailView } from "@/server/orders/order-list-types";
import { OrderConfirmation } from "./order-confirmation";

/**
 * A4-3 예매 상세 — A안(화이트 미니멀). 상태 문구·허용 행동은 A3-5와 같은 ORDER_STATUS_UI를 쓴다.
 * - 결제 계속·취소는 서버가 계산한 canPay·canCancel이 true일 때만 보인다(조회 인증이면 둘 다 false).
 * - CANCELED·EXPIRED는 처음부터 다시 예매만(좌석 재선택 버튼 없음).
 * - PAID는 확인서가 이 화면에 있으므로 "확인서 보기" 대신 확인서를 바로 보여 준다.
 * - [DEV] 고정 샘플에서는 결과 확인 중 상태를 다시 조회하지 않는다.
 */
const dateFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" });

export function OrderDetail({ order, dev, listHref }: { order: OrderDetailView; dev: boolean; listHref: string }) {
  const ui = ORDER_STATUS_UI[order.status];
  const actions: OrderAction[] = ui.actions.filter((a) => a !== "confirmation");
  const d = new Date(order.session.startsAt);
  const blocked = actions.includes("pay-again") && !order.canPay;

  if (order.status === "PAID" && order.customer && order.payment) {
    return (
      <div className="flex flex-col gap-6 md:gap-8">
        <p className="flex items-center gap-3" data-status="PAID" role="status">
          <ResultMark kind="done" />
          <span className="text-lg font-bold text-char md:text-xl">
            {ui.title}
            {dev && <span className="ml-2 text-sm font-normal text-char-3">(샘플)</span>}
          </span>
        </p>
        <OrderConfirmation order={order} customer={order.customer} payment={order.payment} dev={dev} />
        <BackToList href={listHref} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8 md:gap-10">
      <section data-status={order.status} role={ui.tone === "error" ? "alert" : "status"} className="flex flex-col gap-4 border-t-2 border-char pt-7 md:pt-9">
        <div className="flex items-start gap-3.5">
          <ResultMark kind={ui.poll ? "waiting" : "notice"} still={dev && ui.poll} />
          <div className="flex min-w-0 flex-col gap-2">
            <h2 className="text-xl font-bold tracking-[-0.02em] text-char md:text-2xl">
              {ui.title}
              {dev && <span className="ml-2 text-sm font-normal text-char-3">(샘플)</span>}
            </h2>
            <p className="text-[0.9375rem] leading-relaxed text-char-2">{ui.body}</p>
            <p className="text-sm text-char-3">{ui.seats}</p>
          </div>
        </div>

        {(ui.noRepay || order.message) && (
          <div className="flex flex-col gap-1 border-l-2 border-char bg-wash px-4 py-3 text-sm" data-no-repay={ui.noRepay || undefined}>
            {ui.noRepay && <p className="font-semibold text-char">다시 결제하지 마세요. 결과가 확인되면 이 화면과 예매 확인에 표시됩니다.</p>}
            {order.message && <p className="text-char-2">{order.message}</p>}
          </div>
        )}

        {order.status === "PENDING" && order.holdExpiresAt && <HoldRemaining holdExpiresAt={order.holdExpiresAt} serverNow={order.serverNow} />}

        {blocked && (
          <p className="border-l-2 border-char-3 pl-3 text-sm text-char-2" data-lookup-blocked>
            조회 전용 인증으로는 결제하거나 취소할 수 없습니다. 예매용 본인인증 후 가능합니다.
          </p>
        )}

        {ui.poll && dev && (
          <p className="text-[0.8125rem] text-char-3" data-dev-static>
            [DEV] 고정 샘플이라 결과를 다시 확인하지 않습니다. 실제 화면에서는 서버에 결과를 다시 확인합니다.
          </p>
        )}
      </section>

      <section aria-labelledby="detail-title" className="flex flex-col gap-3">
        <h2 id="detail-title" className="text-[0.9375rem] font-bold text-char md:text-base">
          주문 내역
        </h2>
        <dl className="border-t border-rule text-[0.9375rem]">
          <div className="grid grid-cols-[5rem_1fr] gap-3 border-b border-rule py-3 md:grid-cols-[6rem_1fr]">
            <dt className="text-char-3">공연</dt>
            <dd className="font-medium text-char">뮤지컬 {order.show.title}</dd>
          </div>
          <div className="grid grid-cols-[5rem_1fr] gap-3 py-3 md:grid-cols-[6rem_1fr]">
            <dt className="text-char-3">관람일시</dt>
            <dd className="font-medium text-char">
              {dateFmt.format(d)} ({weekdayFmt.format(d)}) <span className="tabular-nums">{timeFmt.format(d)}</span>
            </dd>
          </div>
        </dl>
        <OrderItemsTable items={order.items.map((i) => ({ sessionSeatId: i.seatId, label: i.label, price: i.price }))} />
        <p className="flex items-baseline justify-between tabular-nums">
          <span className="text-sm text-char-2">합계 {order.items.length}석</span>
          <span className="text-lg font-bold text-char">
            {formatWon(order.totalAmount)} {dev && <span className="text-[0.625rem] font-semibold text-char-3">[DEV]</span>}
          </span>
        </p>
        <p className="text-xs text-char-3">
          예매 번호 {order.orderNumber}
          {dev && " [DEV]"}
        </p>
      </section>

      <Actions
        orderId={order.orderId}
        sessionId={order.session.id}
        actions={actions}
        canPay={order.canPay}
        canCancel={order.canCancel}
        allowReselect={false}
        laterHref={listHref}
      />
      <BackToList href={listHref} />
    </div>
  );
}

function BackToList({ href }: { href: string }) {
  return (
    <div className="border-t border-rule pt-5">
      <Link href={href} className={secondary} data-action="to-list">
        내 예매 목록으로
      </Link>
    </div>
  );
}
