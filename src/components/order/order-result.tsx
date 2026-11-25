"use client";

import { formatWon, timeFmt, weekdayFmt } from "@/components/booking/format";
import type { OrderView } from "@/server/orders/order-types";
import { OrderItemsTable } from "./order-items-table";
import { Actions, HoldRemaining, ResultMark } from "./order-parts";
import { ORDER_STATUS_UI } from "./order-status";
import { useOrderPolling } from "./use-order-polling";

/**
 * A3-5 결제 결과 — A안(화이트 미니멀). 서버가 알려 준 주문 상태만 표시하고, 상태표(ORDER_STATUS_UI)에 있는 행동만 제공한다.
 * - 결과 확인 중(PAYMENT_CONFIRMING·PAYMENT_UNKNOWN)에는 서버 상태를 주기적으로 다시 불러오며, 다시 결제·취소 버튼을 렌더하지 않는다.
 * - 화면 시계나 경과 시간으로 상태를 바꾸지 않는다(3분이 지나도 실패로 표시하지 않음).
 * - 내부 결제 상태 코드는 화면에 표시하지 않는다.
 */
const secFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const dateFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" });


export function OrderResult({ order, showTitle, dev }: { order: OrderView; showTitle: string; dev: boolean }) {
  const ui = ORDER_STATUS_UI[order.status];
  const { check, checking } = useOrderPolling(ui.poll);
  const d = order.sessionStartsAt ? new Date(order.sessionStartsAt) : null;

  return (
    <div className="flex flex-col gap-8 md:gap-10">
      {/* 결과 */}
      <section data-status={order.status} role={ui.tone === "error" ? "alert" : "status"} className="flex flex-col gap-4 border-t-2 border-char pt-7 md:pt-9">
        <div className="flex items-start gap-3.5">
          <ResultMark kind={order.status === "PAID" ? "done" : ui.poll ? "waiting" : "notice"} />
          <div className="flex min-w-0 flex-col gap-2">
            <h2 className="text-xl font-bold tracking-[-0.02em] text-char md:text-2xl">
              {ui.title}
              {dev && <span className="ml-2 text-sm font-normal text-char-3">(시뮬레이션)</span>}
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

        {order.status === "PENDING" && <HoldRemaining holdExpiresAt={order.holdExpiresAt} serverNow={order.serverNow} />}

        {ui.poll && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem] text-char-3">
            <span aria-live="polite">{checking ? "확인 중…" : `마지막 확인 ${secFmt.format(new Date(order.serverNow))}`} · 자동으로 다시 확인합니다</span>
            <button type="button" onClick={check} disabled={checking} className="text-char-2 underline underline-offset-4 hover:text-char disabled:no-underline" data-action="recheck">
              지금 다시 확인
            </button>
          </div>
        )}
      </section>

      {/* 예매 내역 */}
      <section aria-labelledby="result-detail" className="flex flex-col gap-3">
        <h2 id="result-detail" className="text-[0.9375rem] font-bold text-char md:text-base">
          {order.status === "PAID" ? "예매 내역" : "주문 내역"}
        </h2>
        <dl className="border-t border-rule text-[0.9375rem]">
          <div className="grid grid-cols-[5rem_1fr] gap-3 border-b border-rule py-3 md:grid-cols-[6rem_1fr]">
            <dt className="text-char-3">공연</dt>
            <dd className="font-medium text-char">{showTitle}</dd>
          </div>
          <div className="grid grid-cols-[5rem_1fr] gap-3 py-3 md:grid-cols-[6rem_1fr]">
            <dt className="text-char-3">관람일시</dt>
            <dd className="font-medium text-char">
              {d ? (
                <>
                  {dateFmt.format(d)} ({weekdayFmt.format(d)}) <span className="tabular-nums">{timeFmt.format(d)}</span>
                </>
              ) : (
                "—"
              )}
            </dd>
          </div>
        </dl>
        <OrderItemsTable items={order.items} />
        <p className="flex items-baseline justify-between tabular-nums">
          <span className="text-sm text-char-2">합계 {order.items.length}석</span>
          <span className="text-lg font-bold text-char">
            {formatWon(order.totalAmount)} {dev && <span className="text-[0.625rem] font-semibold text-char-3">[DEV]</span>}
          </span>
        </p>
        <p className="text-xs text-char-3">
          주문 번호 {order.orderId}
          {dev && " [DEV]"}
        </p>
      </section>

      <Actions orderId={order.orderId} sessionId={order.sessionId} actions={ui.actions} />
    </div>
  );
}

