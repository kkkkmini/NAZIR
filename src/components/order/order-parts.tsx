"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLayoutEffect, useState, useTransition } from "react";
import { cancelOrderAction } from "@/app/booking/orders/actions";
import { timeFmt } from "@/components/booking/format";
import type { OrderAction } from "./order-status";
import { formatMmSs, useServerCountdown } from "./use-server-countdown";

/** A3-5 결제 결과와 A4-3 예매 상세가 함께 쓰는 부품(order-result.tsx에서 옮김, 동작 변경 없음). */
export const primary =
  "inline-flex min-h-12 items-center justify-center rounded-[0.25rem] bg-btn px-7 text-[0.9375rem] font-semibold text-white transition-colors hover:bg-btn-hover disabled:cursor-not-allowed disabled:bg-wash disabled:text-char-3";
export const secondary = "inline-flex min-h-12 items-center justify-center rounded-[0.25rem] border border-rule px-6 text-[0.9375rem] text-char hover:border-char-3 disabled:text-char-3";

/** still: 회전하지 않는 대기 표시([DEV] 고정 샘플처럼 실제로 확인하지 않을 때). */
export function ResultMark({ kind, still }: { kind: "done" | "waiting" | "notice"; still?: boolean }) {
  const base = "mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full";
  if (kind === "done")
    return (
      <span aria-hidden data-mark="done" className={base + " bg-char text-white"}>
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.5}>
          <path d="m5 12.5 4.5 4.5L19 7.5" />
        </svg>
      </span>
    );
  if (kind === "waiting") return <span aria-hidden data-mark="waiting" className={base + " border-2 border-rule border-t-char " + (still ? "" : "animate-spin motion-reduce:animate-none")} />;
  return (
    <span aria-hidden data-mark="notice" className={base + " border-2 border-char text-char"}>
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={3}>
        <path d="M12 6v7M12 17.5v.5" />
      </svg>
    </span>
  );
}

export function HoldRemaining({ holdExpiresAt, serverNow }: { holdExpiresAt: string; serverNow: string }) {
  const remaining = useServerCountdown(holdExpiresAt, serverNow);
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 text-[0.9375rem] text-char">
      좌석 확보 남은 시간
      <span role="timer" className="font-bold tabular-nums">
        {remaining === null ? "--:--" : formatMmSs(remaining)}
      </span>
      <span className="text-xs text-char-3">(만료 {timeFmt.format(new Date(holdExpiresAt))}, 연장되지 않음)</span>
    </p>
  );
}

/**
 * 상태별 행동 영역(ORDER_STATUS_UI.actions만 그린다). A3-5·A4-3 공용.
 * - canPay·canCancel: 서버가 계산한 값. 기본값 true는 A3-5(예매 인증 흐름) 기존 동작과 같다.
 * - allowReselect: "같은 회차 좌석 다시 선택" 표시 여부(A3-5 기존 동작 true, A4-3은 false).
 * - laterHref: "예매 확인으로 이동"의 주소.
 */
export function Actions({
  orderId,
  sessionId,
  actions,
  canPay = true,
  canCancel = true,
  allowReselect = true,
  laterHref = "/orders",
}: {
  orderId: string;
  sessionId: string;
  actions: OrderAction[];
  canPay?: boolean;
  canCancel?: boolean;
  allowReselect?: boolean;
  laterHref?: string;
}) {
  const router = useRouter();
  const [canceling, startCancel] = useTransition();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seatsHref = `/booking/seats?session=${encodeURIComponent(sessionId)}`;

  // 다른 화면에 다녀오면(Activity 상태 보존) 확인 단계·오류를 닫는다.
  useLayoutEffect(
    () => () => {
      setConfirm(false);
      setError(null);
    },
    [],
  );

  const show = (a: OrderAction) => actions.includes(a) && (a !== "pay-again" || canPay) && (a !== "cancel-rebook" || canCancel);
  if (!actions.some(show)) return null;

  function cancel() {
    setError(null);
    startCancel(async () => {
      const r = await cancelOrderAction(orderId);
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
        {show("confirmation") && (
          <>
            <button type="button" disabled className={primary} data-action="confirmation">
              확인서 보기 (준비 중)
            </button>
            <Link href={laterHref} className={secondary} data-action="check-later">
              예매 확인으로 이동
            </Link>
          </>
        )}
        {show("pay-again") && (
          <Link href={`/booking/order?hold=${encodeURIComponent(orderId)}`} className={primary} data-action="pay-again">
            다시 결제하기
          </Link>
        )}
        {show("cancel-rebook") && !confirm && (
          <button type="button" onClick={() => setConfirm(true)} disabled={canceling} className={secondary} data-action="cancel-start">
            취소하고 좌석 다시 고르기
          </button>
        )}
        {show("rebook") && (
          <>
            <Link href="/booking" className={primary} data-action="rebook">
              처음부터 다시 예매
            </Link>
            {allowReselect && (
              <Link href={seatsHref} className={secondary} data-action="reselect-seats">
                같은 회차 좌석 다시 선택
              </Link>
            )}
          </>
        )}
        {show("check-later") && (
          <Link href={laterHref} className={primary} data-action="check-later">
            예매 확인으로 이동
          </Link>
        )}
      </div>

      {show("cancel-rebook") && confirm && (
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

      {show("contact") && (
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
