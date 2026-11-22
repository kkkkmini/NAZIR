"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { cancelOrderAction, simulatePaymentAction, startPaymentAction } from "@/app/booking/orders/actions";
import { formatWon, timeFmt, weekdayFmt } from "@/components/booking/format";
import {
  PAYMENT_SIMULATIONS,
  PAYMENT_START_SIMULATIONS,
  type OrderView,
  type PaymentMethodView,
  type PaymentSimulation,
  type PaymentStartResult,
  type PaymentStartSimulation,
} from "@/server/orders/order-types";
import { SeatMiniMap } from "@/components/seats/seat-mini-map";
import type { SeatView } from "@/server/seats/seat-types";
import { OrderItemsTable } from "./order-items-table";
import { ORDER_STATUS_UI } from "./order-status";
import { formatMmSs, useServerCountdown } from "./use-server-countdown";

/**
 * A3-4 주문 확인·결제수단 — A안(화이트 미니멀). A3-5와 공유하는 다크 컴포넌트는 건드리지 않는다.
 * - 남은 시간은 서버 만료 시각 기준(useServerCountdown). 0이 되면 상태를 바꾸지 않고 서버에 다시 묻는다.
 * - 결제 가능 여부·결제 결과는 서버가 정한다. 실제 결제(결제창)는 구현하지 않았고, 개발 환경에서만 [DEV] 미리보기로 흐름을 확인한다.
 * - 결제 대기(PENDING)가 아니면 결제·취소를 두지 않고 결제 결과(A3-5)로 안내한다.
 */
const dateFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" });

const RESULT_LABEL: Record<PaymentSimulation, string> = {
  success: "결제 성공",
  "fail-pending": "결제 실패 (좌석 확보 시간 남음)",
  "fail-expired": "결제 실패 (좌석 확보 시간 만료)",
  "confirming-success": "결제 확인 중 → 5초 뒤 성공",
  "confirming-unknown": "결제 확인 중 → 3분 뒤 결과 불명확",
  "review-amount": "운영자 확인 필요 (금액 불일치)",
  unfulfilled: "발권 불가",
};
const START_LABEL: Record<PaymentStartSimulation, string> = {
  ok: "정상",
  "hold-time": "남은 좌석 확보 시간 부족",
  "method-unavailable": "결제수단 비활성",
  network: "네트워크 오류(응답 없음)",
};

function startError(r: Exclude<PaymentStartResult, { ok: true }>): string {
  switch (r.code) {
    case "HOLD_TIME_INSUFFICIENT":
      return "남은 좌석 확보 시간이 부족해 결제를 시작할 수 없습니다. 좌석을 다시 골라 예매해 주세요.";
    case "PAYMENT_METHOD_UNAVAILABLE":
      return "선택한 결제수단을 지금 사용할 수 없습니다. 다른 결제수단을 선택해 주세요.";
    default:
      return "결제를 시작하지 못했습니다. 주문 상태를 다시 확인해 주세요.";
  }
}

const secondaryBtn = "inline-flex min-h-11 items-center justify-center rounded-[0.25rem] border border-rule px-5 text-sm text-char hover:border-char-3";

export function OrderCheckout({
  order,
  methods,
  seatLayout = null,
  showTitle,
  dev,
}: {
  order: OrderView;
  methods: PaymentMethodView[] | null;
  /** 선택 좌석 위치 미리보기용 배치. 주문 좌석이 모두 연결된 경우에만 넘어온다. */
  seatLayout?: SeatView[] | null;
  showTitle: string;
  dev: boolean;
}) {
  const router = useRouter();
  const remaining = useServerCountdown(order.holdExpiresAt, order.serverNow);
  const asked = useRef(false);
  const pending = order.status === "PENDING";
  const resultHref = `/booking/orders/${encodeURIComponent(order.orderId)}/result`;
  const seatsHref = `/booking/seats?session=${encodeURIComponent(order.sessionId)}`;

  const [method, setMethod] = useState<PaymentMethodView["id"] | null>(null);
  const [startSim, setStartSim] = useState<PaymentStartSimulation>("ok");
  const [resultSim, setResultSim] = useState<PaymentSimulation>("success");
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [paying, startPay] = useTransition();
  const [canceling, startCancel] = useTransition();
  const busy = paying || canceling;

  // 다른 화면에 다녀오면(Activity로 상태 보존) 오류·확인 단계를 지운다.
  useLayoutEffect(
    () => () => {
      setError(null);
      setConfirmCancel(false);
    },
    [],
  );

  // 화면 시계가 0이 되면 상태를 직접 바꾸지 않고 서버에 다시 묻는다(한 번).
  useEffect(() => {
    if (pending && remaining === 0 && !asked.current) {
      asked.current = true;
      router.refresh();
    }
  }, [pending, remaining, router]);

  function pay() {
    if (!dev || !method || busy) return;
    setError(null);
    startPay(async () => {
      if (startSim === "network") {
        // [DEV] 응답을 받지 못한 상황 — 서버를 호출하지 않으므로 서버 상태는 바뀌지 않는다.
        await new Promise((r) => setTimeout(r, 600));
        setError("네트워크 오류로 결제를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.");
        return;
      }
      const start = await startPaymentAction(order.orderId, method, startSim);
      if (!start.ok) {
        if (start.status && start.status !== "PENDING") return router.push(resultHref);
        if (start.code === "HOLD_EXPIRED") return router.refresh();
        return setError(startError(start));
      }
      // [DEV] 실제로는 여기서 같은 창으로 결제창에 이동하고, 복귀 후 서버가 처리한 결과를 A3-5에서 조회한다.
      const r = await simulatePaymentAction(order.orderId, resultSim);
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
        setConfirmCancel(false);
        setError("지금은 좌석을 다시 고를 수 없습니다. 주문 상태를 다시 확인했습니다.");
        router.refresh();
      }
    });
  }

  const d = order.sessionStartsAt ? new Date(order.sessionStartsAt) : null;
  const soon = remaining !== null && remaining < 60_000;
  const canPay = dev && pending && Boolean(method) && !busy && methods !== null;
  const payLabel = !dev ? "결제 준비 중" : paying ? "결제 진행 중…" : "결제하기";

  const timer = (
    <span className="flex items-baseline gap-2">
      <span role="timer" aria-live="off" data-remaining-ms={remaining ?? ""} className={"tabular-nums " + (soon ? "font-extrabold" : "font-bold")}>
        {remaining === null ? "--:--" : formatMmSs(remaining)}
      </span>
      {soon && remaining! > 0 && (
        <span className="text-[0.8125rem] font-bold text-char" data-soon>
          곧 만료됩니다
        </span>
      )}
    </span>
  );

  const payButton = (lg: boolean) => (
    <button
      type="button"
      onClick={pay}
      disabled={!canPay}
      aria-busy={paying}
      data-action="pay"
      className={
        "shrink-0 rounded-[0.25rem] bg-btn font-semibold text-white transition-colors hover:bg-btn-hover disabled:cursor-not-allowed disabled:bg-wash disabled:text-char-3 " +
        (lg ? "min-h-[3.25rem] w-full px-6 text-base" : "min-h-11 px-6 text-[0.9375rem]")
      }
    >
      {payLabel}
      {dev && !paying && <span className="ml-2 rounded-sm bg-white/15 px-1.5 py-0.5 text-[0.6rem] font-semibold tracking-wider">DEV</span>}
    </button>
  );

  // 결제 대기가 아닌 주문: 종료 안내 또는 결제 결과로 안내(결제·취소 없음)
  if (!pending) {
    const ended = order.status === "EXPIRED" || order.status === "CANCELED";
    return (
      <section role={ended ? "alert" : "status"} data-status={order.status} className="flex flex-col gap-4 border-t-2 border-char pt-7">
        <h2 className="text-xl font-bold text-char">
          {order.status === "EXPIRED" ? "좌석 확보 시간이 끝났습니다" : order.status === "CANCELED" ? "좌석 확보를 해제했습니다" : ORDER_STATUS_UI[order.status].title}
          {dev && <span className="ml-2 text-sm font-normal text-char-3">(시뮬레이션)</span>}
        </h2>
        <p className="text-[0.9375rem] text-char-2">
          {ended ? "확보했던 좌석은 반환되었습니다. 좌석을 다시 선택해 주세요." : "이 주문은 결제 단계를 지났습니다. 결제 결과 화면에서 상태를 확인해 주세요."}
        </p>
        <div>
          <Link
            href={ended ? seatsHref : resultHref}
            className="inline-flex min-h-12 items-center justify-center rounded-[0.25rem] bg-btn px-7 text-[0.9375rem] font-semibold text-white hover:bg-btn-hover"
            data-action={ended ? "rebook" : "to-result"}
          >
            {ended ? "좌석 다시 선택" : "결제 결과 보기"}
          </Link>
        </div>
      </section>
    );
  }

  return (
    <>
      {/* 모바일: 헤더 아래 남은 시간 고정 */}
      <div className="sticky top-0 z-20 -mx-5 -mt-1 flex items-center justify-between border-b border-rule bg-paper/95 px-5 py-2 backdrop-blur sm:-mx-8 sm:px-8 lg:hidden" data-mobile-timer>
        <span className="text-[0.8125rem] text-char-2">좌석 확보 남은 시간</span>
        <span className="text-lg text-char">{timer}</span>
      </div>

      <div className="pb-[calc(5.5rem+env(safe-area-inset-bottom,0px))] lg:pb-0">
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_21rem] lg:border-t-2 lg:border-char">
          <div className="flex min-w-0 flex-col gap-8 pt-4 lg:gap-9 lg:border-r lg:border-rule lg:py-8 lg:pr-12">
            {/* 예매 정보 */}
            <section aria-labelledby="order-info" className="flex flex-col gap-3">
              <h2 id="order-info" className="text-[0.9375rem] font-bold text-char md:text-base">
                예매 정보
              </h2>
              <dl className="border-y border-rule text-[0.9375rem]">
                <Row label="공연">{showTitle}</Row>
                <Row label="관람일시">
                  {d ? (
                    <>
                      {dateFmt.format(d)} ({weekdayFmt.format(d)}) <span className="tabular-nums">{timeFmt.format(d)}</span>
                    </>
                  ) : (
                    "—"
                  )}
                </Row>
                <Row label="주문 번호" last>
                  <span className="text-char-2">{order.orderId}</span>
                  {dev && <span className="ml-2 text-[0.625rem] font-semibold tracking-wider text-char-3">[DEV]</span>}
                </Row>
              </dl>
            </section>

            {/* 좌석·금액 */}
            <section aria-labelledby="order-seats" className="-order-1 flex flex-col gap-3 lg:order-none">
              <h2 id="order-seats" className="text-[0.9375rem] font-bold text-char md:text-base">
                좌석 {order.items.length}석
              </h2>
              <div className={seatLayout ? "flex flex-col gap-3 border-t border-rule pt-3 sm:grid sm:grid-cols-[13.5rem_minmax(0,1fr)] sm:items-start sm:gap-6 sm:border-t-0 sm:pt-0" : ""} data-seat-check>
              {seatLayout && (
                <SeatMiniMap layout={seatLayout} highlightIds={order.items.map((i) => i.sessionSeatId)} labels={order.items.map((i) => i.label)} dev={dev} />
              )}
              <OrderItemsTable items={order.items} />
              </div>
              <p className="flex items-baseline justify-between tabular-nums">
                <span className="text-sm text-char-2">합계</span>
                <span className="text-lg font-bold text-char">
                  {formatWon(order.totalAmount)} {dev && <span className="text-[0.625rem] font-semibold text-char-3">[DEV]</span>}
                </span>
              </p>
            </section>

            {/* 결제수단 */}
            <section aria-labelledby="pay-method" className="flex flex-col gap-3">
              <h2 id="pay-method" className="flex items-baseline gap-2 text-[0.9375rem] font-bold text-char md:text-base">
                결제수단
                {dev && methods && <span className="text-[0.6875rem] font-semibold text-char-3">[DEV] 개발용 목록 · 실제 결제창이 열리지 않습니다</span>}
              </h2>
              {methods ? (
                <div role="radiogroup" aria-labelledby="pay-method" className="grid gap-2 sm:grid-cols-3">
                  {methods.map((m) => {
                    const on = m.id === method;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        disabled={paying}
                        data-method={m.id}
                        onClick={() => {
                          setMethod(m.id);
                          setError(null);
                        }}
                        className={
                          "flex min-h-12 items-center justify-between gap-3 rounded-[0.25rem] border px-4 text-left text-[0.9375rem] transition-colors disabled:cursor-not-allowed " +
                          (on ? "border-char bg-wash/70 font-semibold text-char" : "border-rule text-char-2 hover:border-char-3")
                        }
                      >
                        {m.label}
                        <span aria-hidden className={"grid h-4 w-4 place-items-center rounded-full border " + (on ? "border-char bg-char" : "border-char-3/60")}>
                          {on && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="border-y border-rule py-5 text-[0.9375rem] text-char-3">결제수단 정보를 준비하고 있습니다.</p>
              )}
            </section>

            {/* 유의사항 */}
            <section aria-labelledby="pay-notes" className="flex flex-col gap-3">
              <h2 id="pay-notes" className="text-[0.9375rem] font-bold text-char md:text-base">
                유의사항
              </h2>
              <ul className="flex flex-col gap-1.5 text-sm leading-relaxed text-char-2">
                <li>· 좌석 확보 시간은 7분이며 연장되지 않습니다. 결제창에 머무는 시간도 포함됩니다.</li>
                <li>· 예매 후 좌석은 변경할 수 없습니다. 다른 좌석을 원하시면 결제 전에 취소한 뒤 다시 예매해 주세요.</li>
                <li>· 결제 결과를 확인하는 동안에는 다시 결제하지 마세요.</li>
                <li>
                  ·{" "}
                  <Link href="/policies/refund" className="underline underline-offset-4 hover:text-char">
                    취소·환불 규정
                  </Link>
                </li>
              </ul>
            </section>

            {/* 좌석 다시 고르기(UF 1.3) — 확인 단계 */}
            <section aria-label="좌석 다시 고르기" className="flex flex-col gap-3 border-t border-rule pt-5" data-cancel-area>
              {!confirmCancel ? (
                <button type="button" onClick={() => setConfirmCancel(true)} disabled={busy} className="self-start text-sm text-char-2 underline underline-offset-4 hover:text-char disabled:text-char-3" data-action="cancel-start">
                  좌석 다시 고르기
                </button>
              ) : (
                <div className="flex flex-col gap-3" role="alertdialog" aria-label="좌석 다시 고르기 확인" data-cancel-confirm>
                  <p className="text-[0.9375rem] font-semibold text-char">좌석을 다시 고르시겠습니까?</p>
                  <p className="text-sm text-char-2">지금 확보한 좌석은 반환되며, 다른 고객이 선택할 수 있습니다.</p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={cancel} disabled={busy} className={secondaryBtn + " border-char font-semibold"} data-action="cancel-rebook">
                      {canceling ? "취소 중…" : "취소하고 다시 고르기"}
                    </button>
                    <button type="button" onClick={() => setConfirmCancel(false)} disabled={canceling} className={secondaryBtn} data-action="cancel-back">
                      돌아가기
                    </button>
                  </div>
                </div>
              )}
            </section>

            {dev && (
              <details className="group border-y border-dashed border-char-3/40 py-3 text-sm" data-dev-panel>
                <summary className="cursor-pointer list-none text-[0.8125rem] font-semibold text-char-2">
                  <span className="mr-1 inline-block transition-transform group-open:rotate-90">›</span> [DEV] 결제 미리보기 — 실제 결제가 아닙니다
                </summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-xs text-char-3">
                    결제 시작 응답
                    <select data-dev-start-sim value={startSim} onChange={(e) => setStartSim(e.target.value as PaymentStartSimulation)} className="rounded-[0.25rem] border border-rule bg-paper px-2 py-2 text-sm text-char">
                      {PAYMENT_START_SIMULATIONS.map((s) => (
                        <option key={s} value={s}>
                          {START_LABEL[s]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-char-3">
                    결제 결과(결제창 복귀 후 서버 처리)
                    <select data-dev-pay-sim value={resultSim} onChange={(e) => setResultSim(e.target.value as PaymentSimulation)} className="rounded-[0.25rem] border border-rule bg-paper px-2 py-2 text-sm text-char">
                      {PAYMENT_SIMULATIONS.map((s) => (
                        <option key={s} value={s}>
                          {RESULT_LABEL[s]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </details>
            )}
          </div>

          {/* 결제 요약 — 데스크톱 */}
          <aside aria-label="결제 요약" className="hidden lg:block lg:pl-10">
            <div className="flex flex-col gap-5 lg:sticky lg:top-6 lg:py-8">
              <div className="flex flex-col gap-1 border-b border-rule pb-5">
                <p className="text-[0.8125rem] text-char-2">좌석 확보 남은 시간</p>
                <p className="text-[2rem] leading-tight text-char">{timer}</p>
                <p className="text-xs text-char-3">시간 안에 결제를 완료해 주세요. 연장되지 않습니다.</p>
              </div>
              <p className="flex items-baseline justify-between tabular-nums">
                <span className="text-sm text-char-2">최종 결제 금액</span>
                <span className="text-xl font-bold text-char" data-total>
                  {formatWon(order.totalAmount)}
                </span>
              </p>
              <p className="text-[0.8125rem] text-char-3">결제수단: {methods?.find((m) => m.id === method)?.label ?? "선택해 주세요"}</p>
              {error && (
                <p role="alert" className="border-l-2 border-char pl-3 text-sm text-char" data-pay-error>
                  {error}
                </p>
              )}
              {payButton(true)}
            </div>
          </aside>
        </div>
      </div>

      {/* 모바일·태블릿 하단: 결제 금액 + 결제하기 */}
      <aside aria-label="결제" data-pay-bar className="fixed inset-x-0 bottom-0 z-30 border-t border-rule bg-paper pb-[env(safe-area-inset-bottom,0px)] lg:hidden">
        <div className="mx-auto flex max-w-[77.5rem] flex-col gap-1.5 px-5 py-2 sm:px-8">
          {error && (
            <p role="alert" className="text-[0.8125rem] text-char" data-pay-error>
              {error}
            </p>
          )}
          <div className="flex items-center gap-4">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[0.6875rem] leading-tight text-char-3">{methods?.find((m) => m.id === method)?.label ?? "결제수단을 선택해 주세요"}</p>
              <p className="text-base font-bold leading-tight tabular-nums text-char">{formatWon(order.totalAmount)}</p>
            </div>
            {payButton(false)}
          </div>
        </div>
      </aside>
    </>
  );
}

function Row({ label, children, last = false }: { label: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={"grid grid-cols-[5rem_1fr] gap-3 py-3 md:grid-cols-[6rem_1fr] " + (last ? "" : "border-b border-rule")}>
      <dt className="text-char-3">{label}</dt>
      <dd className="font-medium text-char">{children}</dd>
    </div>
  );
}
