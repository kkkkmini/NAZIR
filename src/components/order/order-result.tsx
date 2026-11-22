"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLayoutEffect, useState, useTransition } from "react";
import { cancelOrderAction } from "@/app/booking/orders/actions";
import { formatWon, timeFmt, weekdayFmt } from "@/components/booking/format";
import type { OrderView } from "@/server/orders/order-types";
import { OrderItemsTable } from "./order-items-table";
import { ORDER_STATUS_UI, type OrderAction } from "./order-status";
import { formatMmSs, useServerCountdown } from "./use-server-countdown";
import { useOrderPolling } from "./use-order-polling";

/**
 * A3-5 결제 결과 — A안(화이트 미니멀). 서버가 알려 준 주문 상태만 표시하고, 상태표(ORDER_STATUS_UI)에 있는 행동만 제공한다.
 * - 결과 확인 중(PAYMENT_CONFIRMING·PAYMENT_UNKNOWN)에는 서버 상태를 주기적으로 다시 불러오며, 다시 결제·취소 버튼을 렌더하지 않는다.
 * - 화면 시계나 경과 시간으로 상태를 바꾸지 않는다(3분이 지나도 실패로 표시하지 않음).
 * - 내부 결제 상태 코드는 화면에 표시하지 않는다.
 */
const secFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const dateFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" });

const primary = "inline-flex min-h-12 items-center justify-center rounded-[0.25rem] bg-btn px-7 text-[0.9375rem] font-semibold text-white transition-colors hover:bg-btn-hover disabled:cursor-not-allowed disabled:bg-wash disabled:text-char-3";
const secondary = "inline-flex min-h-12 items-center justify-center rounded-[0.25rem] border border-rule px-6 text-[0.9375rem] text-char hover:border-char-3 disabled:text-char-3";

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

        {order.status === "PENDING" && <HoldRemaining order={order} />}

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

      <Actions order={order} actions={ui.actions} />
    </div>
  );
}

function ResultMark({ kind }: { kind: "done" | "waiting" | "notice" }) {
  const base = "mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full";
  if (kind === "done")
    return (
      <span aria-hidden data-mark="done" className={base + " bg-char text-white"}>
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.5}>
          <path d="m5 12.5 4.5 4.5L19 7.5" />
        </svg>
      </span>
    );
  if (kind === "waiting") return <span aria-hidden data-mark="waiting" className={base + " animate-spin border-2 border-rule border-t-char motion-reduce:animate-none"} />;
  return (
    <span aria-hidden data-mark="notice" className={base + " border-2 border-char text-char"}>
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={3}>
        <path d="M12 6v7M12 17.5v.5" />
      </svg>
    </span>
  );
}

function HoldRemaining({ order }: { order: OrderView }) {
  const remaining = useServerCountdown(order.holdExpiresAt, order.serverNow);
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 text-[0.9375rem] text-char">
      좌석 확보 남은 시간
      <span role="timer" className="font-bold tabular-nums">
        {remaining === null ? "--:--" : formatMmSs(remaining)}
      </span>
      <span className="text-xs text-char-3">(만료 {timeFmt.format(new Date(order.holdExpiresAt))}, 연장되지 않음)</span>
    </p>
  );
}

function Actions({ order, actions }: { order: OrderView; actions: OrderAction[] }) {
  const router = useRouter();
  const [canceling, startCancel] = useTransition();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seatsHref = `/booking/seats?session=${encodeURIComponent(order.sessionId)}`;

  // 다른 화면에 다녀오면(Activity 상태 보존) 확인 단계·오류를 닫는다.
  useLayoutEffect(
    () => () => {
      setConfirm(false);
      setError(null);
    },
    [],
  );

  if (actions.length === 0) return null;

  function cancel() {
    setError(null);
    startCancel(async () => {
      const r = await cancelOrderAction(order.orderId);
      if (r.ok) router.push(seatsHref);
      else {
        setConfirm(false);
        setError("지금은 취소할 수 없습니다. 주문 상태를 다시 확인했습니다.");
        router.refresh();
      }
    });
  }

  return (
    <section aria-label="다음 행동" className="flex flex-col gap-3 border-t border-rule pt-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        {actions.includes("confirmation") && (
          <>
            <button type="button" disabled className={primary} data-action="confirmation">
              확인서 보기 (준비 중)
            </button>
            <Link href="/orders" className={secondary} data-action="check-later">
              예매 확인으로 이동
            </Link>
          </>
        )}
        {actions.includes("pay-again") && (
          <Link href={`/booking/order?hold=${encodeURIComponent(order.orderId)}`} className={primary} data-action="pay-again">
            다시 결제하기
          </Link>
        )}
        {actions.includes("cancel-rebook") && !confirm && (
          <button type="button" onClick={() => setConfirm(true)} disabled={canceling} className={secondary} data-action="cancel-start">
            취소하고 좌석 다시 고르기
          </button>
        )}
        {actions.includes("rebook") && (
          <>
            <Link href="/booking" className={primary} data-action="rebook">
              처음부터 다시 예매
            </Link>
            <Link href={seatsHref} className={secondary} data-action="reselect-seats">
              같은 회차 좌석 다시 선택
            </Link>
          </>
        )}
        {actions.includes("check-later") && (
          <Link href="/orders" className={primary} data-action="check-later">
            예매 확인으로 이동
          </Link>
        )}
      </div>

      {actions.includes("cancel-rebook") && confirm && (
        <div className="flex flex-col gap-3 border-l-2 border-char bg-wash px-4 py-4" role="alertdialog" aria-label="좌석 다시 고르기 확인" data-cancel-confirm>
          <p className="text-[0.9375rem] font-semibold text-char">좌석을 다시 고르시겠습니까?</p>
          <p className="text-sm text-char-2">지금 확보한 좌석은 반환되며, 다른 고객이 선택할 수 있습니다.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={cancel} disabled={canceling} className={secondary + " border-char bg-paper font-semibold"} data-action="cancel-rebook">
              {canceling ? "취소 중…" : "취소하고 다시 고르기"}
            </button>
            <button type="button" onClick={() => setConfirm(false)} disabled={canceling} className={secondary + " bg-paper"} data-action="cancel-back">
              돌아가기
            </button>
          </div>
        </div>
      )}

      {actions.includes("contact") && (
        <div data-action="contact" className="flex flex-col gap-1 border-y border-rule py-4 text-sm">
          <p className="font-semibold text-char">문의 안내</p>
          <p className="text-char-3">문의 채널은 준비 중입니다. 확정되면 이곳에 안내됩니다.</p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-char">
          {error}
        </p>
      )}
    </section>
  );
}
