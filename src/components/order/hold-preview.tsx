"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { cancelOrderAction, simulatePaymentAction } from "@/app/booking/orders/actions";
import { PAYMENT_SIMULATIONS, type OrderView, type PaymentSimulation } from "@/server/orders/order-types";
import { ORDER_STATUS_UI } from "./order-status";
import { OrderSummary } from "./order-summary";
import { formatMmSs, useServerCountdown } from "./use-server-countdown";

/**
 * A3-4 주문 확인 — 임시 화면.
 * - PENDING: 확보 좌석·합계·서버 기준 남은 시간, 결제(준비 중), [DEV] 결제 결과 미리보기, 좌석 다시 고르기.
 * - EXPIRED·CANCELED: 종료 안내.
 * - 그 밖의 상태(결제 확인 중·결과 불명확·운영자 확인·완료·발권 불가): 결제·취소 없이 결제 결과(A3-5)로 안내.
 * 결제수단 선택·실제 결제는 구현하지 않았다.
 */
const SIM_LABEL: Record<PaymentSimulation, string> = {
  success: "결제 성공",
  "fail-pending": "결제 실패 (좌석 확보 시간 남음)",
  "fail-expired": "결제 실패 (좌석 확보 시간 만료)",
  "confirming-success": "결제 확인 중 → 5초 뒤 성공",
  "confirming-unknown": "결제 확인 중 → 3분 뒤 결과 불명확(UNKNOWN)",
  "review-amount": "운영자 확인 필요 (금액 불일치)",
  unfulfilled: "발권 불가 (UNFULFILLED)",
};

export function HoldPreview({ order, showTitle, dev }: { order: OrderView; showTitle: string; dev: boolean }) {
  const router = useRouter();
  const remaining = useServerCountdown(order.holdExpiresAt, order.serverNow);
  const asked = useRef(false);
  const resultHref = `/booking/orders/${encodeURIComponent(order.orderId)}/result`;
  const seatsHref = `/booking/seats?session=${encodeURIComponent(order.sessionId)}`;
  const pending = order.status === "PENDING";

  // 화면 시계가 0이 되면 상태를 직접 바꾸지 않고 서버에 다시 묻는다(한 번).
  useEffect(() => {
    if (pending && remaining === 0 && !asked.current) {
      asked.current = true;
      router.refresh();
    }
  }, [pending, remaining, router]);

  return (
    <div className="flex flex-col gap-6">
      {dev && (
        <p className="rounded-sm border border-st-pause/40 bg-st-pause-bg px-4 py-3 text-sm text-st-pause">
          [DEV] 좌석 확보 시뮬레이션입니다. 실제 좌석 확보·주문 생성이 아니며 실제 결제를 할 수 없습니다. 좌석·가격은 임시 값입니다.
        </p>
      )}

      {pending ? (
        <section
          aria-labelledby="hold-timer"
          className="flex flex-col gap-2 rounded-sm border border-line bg-s1 p-5 md:flex-row md:items-center md:justify-between md:p-6"
        >
          <div className="flex flex-col gap-1">
            <h2 id="hold-timer" className="text-sm font-semibold text-ink">
              좌석 확보 남은 시간 {dev && <span className="text-xs font-normal text-st-pause">(시뮬레이션)</span>}
            </h2>
            <p className="text-xs text-muted">시간이 지나면 좌석이 반환됩니다. 확보 시간은 연장되지 않습니다.</p>
          </div>
          <p
            role="timer"
            aria-live="off"
            data-remaining-ms={remaining ?? ""}
            className={"text-4xl font-semibold tabular-nums " + (remaining !== null && remaining < 60_000 ? "text-st-cancel" : "text-ink")}
          >
            {remaining === null ? "--:--" : formatMmSs(remaining)}
          </p>
        </section>
      ) : order.status === "EXPIRED" || order.status === "CANCELED" ? (
        <section role="alert" className="flex flex-col gap-3 rounded-sm border border-st-cancel/40 bg-st-cancel-bg p-5 md:p-6">
          <h2 className="text-lg font-semibold text-st-cancel">
            {order.status === "EXPIRED" ? "좌석 확보 시간이 끝났습니다" : "좌석 확보를 해제했습니다"}
            {dev && " (시뮬레이션)"}
          </h2>
          <p className="text-sm text-muted">확보했던 좌석은 반환되었습니다. 좌석을 다시 선택해 주세요.</p>
          <Link
            href={seatsHref}
            className="inline-flex min-h-12 items-center justify-center self-start rounded-sm bg-accent px-6 text-sm font-semibold text-white hover:bg-accent-hover"
          >
            좌석 다시 선택
          </Link>
        </section>
      ) : (
        <section role="status" data-status={order.status} className="flex flex-col gap-3 rounded-sm border border-line bg-s1 p-5 md:p-6">
          <h2 className="text-lg font-semibold text-ink">{ORDER_STATUS_UI[order.status].title}</h2>
          <p className="text-sm text-muted">이 주문은 결제 단계를 지났습니다. 결제 결과 화면에서 상태를 확인해 주세요.</p>
          <Link
            href={resultHref}
            className="inline-flex min-h-12 items-center justify-center self-start rounded-sm bg-accent px-6 text-sm font-semibold text-white hover:bg-accent-hover"
          >
            결제 결과 보기
          </Link>
        </section>
      )}

      <OrderSummary order={order} showTitle={showTitle} dev={dev} heading={pending ? "확보한 좌석" : "주문 내역"} />

      {pending && <PaymentArea order={order} dev={dev} resultHref={resultHref} seatsHref={seatsHref} />}
    </div>
  );
}

function PaymentArea({ order, dev, resultHref, seatsHref }: { order: OrderView; dev: boolean; resultHref: string; seatsHref: string }) {
  const router = useRouter();
  const [sim, setSim] = useState<PaymentSimulation>("success");
  const [error, setError] = useState<string | null>(null);
  const [paying, startPay] = useTransition();
  const [canceling, startCancel] = useTransition();
  const busy = paying || canceling;

  // 다른 화면에 다녀오면 이전 오류 안내를 지운다(Activity 상태 보존).
  useLayoutEffect(() => () => setError(null), []);

  function simulate() {
    setError(null);
    startPay(async () => {
      const r = await simulatePaymentAction(order.orderId, sim);
      // 성공이든, 이미 다른 상태여서 거부됐든 서버가 판단한 결과 화면으로 간다.
      if (r.ok || (r.status && r.status !== "PENDING")) router.push(resultHref);
      else setError("결제 결과를 반영하지 못했습니다. 주문 상태를 다시 확인해 주세요.");
    });
  }

  function cancel() {
    setError(null);
    startCancel(async () => {
      const r = await cancelOrderAction(order.orderId);
      if (r.ok) router.push(seatsHref);
      else {
        setError("지금은 좌석을 다시 고를 수 없습니다. 주문 상태를 다시 확인했습니다.");
        router.refresh();
      }
    });
  }

  return (
    <section className="flex flex-col gap-4 rounded-sm border border-dashed border-line p-5 md:p-6">
      <h2 className="text-sm font-semibold text-ink">결제수단 선택</h2>
      <p className="text-sm text-subtle">결제 기능은 준비 중입니다. 결제수단·이메일 입력이 이곳에 연결됩니다.</p>
      <button
        type="button"
        disabled
        className="min-h-12 rounded-sm bg-s3 px-6 text-sm font-semibold text-subtle sm:self-start"
        data-action="pay"
      >
        결제하기 (준비 중)
      </button>

      {dev && (
        <div className="flex flex-col gap-3 border-t border-dashed border-st-pause/40 pt-4">
          <p className="text-xs font-semibold text-st-pause">[DEV] 결제 결과 미리보기 — 실제 결제가 아닙니다. 결과는 서버가 정합니다.</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <select
              data-dev-pay-sim
              value={sim}
              onChange={(e) => setSim(e.target.value as PaymentSimulation)}
              className="rounded-sm border border-line bg-night px-2 py-2 text-sm text-ink"
            >
              {PAYMENT_SIMULATIONS.map((s) => (
                <option key={s} value={s}>
                  {SIM_LABEL[s]}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={simulate}
              disabled={busy}
              aria-busy={paying}
              data-action="simulate-pay"
              className="min-h-11 rounded-sm border border-st-pause/60 px-4 text-sm font-semibold text-st-pause hover:bg-st-pause-bg disabled:opacity-50"
            >
              {paying ? "결과 반영 중…" : "결제 결과 미리보기 DEV"}
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3 border-t border-dashed border-line pt-4 sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={cancel}
          disabled={busy}
          data-action="cancel-rebook"
          className="min-h-12 shrink-0 whitespace-nowrap rounded-sm border border-line px-5 text-sm text-ink hover:border-muted disabled:text-subtle"
        >
          {canceling ? "취소 중…" : "좌석 다시 고르기 (주문 취소)"}
        </button>
        <p className="text-xs text-muted">좌석은 바꿀 수 없습니다. 다시 고르면 지금 확보한 좌석은 반환되고, 다른 고객이 가져갈 수 있습니다.</p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-st-cancel">
          {error}
        </p>
      )}
    </section>
  );
}
