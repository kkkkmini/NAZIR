"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useState, useTransition } from "react";
import { holdSeatsAction } from "@/app/booking/seats/actions";
import { formatWon, fullFmt } from "@/components/booking/format";
import { HOLD_SIMULATIONS, type HoldSeatsResult, type HoldSimulation, type QuotaView, type SeatView } from "@/server/seats/seat-types";
import { SeatLegend, SeatMap } from "./seat-map";
import { useSeatSelection } from "./use-seat-selection";

/**
 * A3-3 좌석 선택 컨테이너: 선택 로직 + 점유 요청 + 결과 처리.
 * - 점유 성공·실패는 서버 응답으로만 정한다. 성공 응답(holdId)을 받은 뒤에만 A3-4로 이동한다.
 * - 실패 시 어떤 좌석도 점유되지 않는다(원자적). 실패 좌석을 안내하고, 서버가 최신 좌석 상태를 다시 내려주며,
 *   선택은 모두 비워 사용자가 다시 고르게 한다.
 * - readOnly(실제 공개 좌석, Step 5 연결 전): 좌석 상태·가격 조회만. 선택·확보 요청을 하지 않고, 구매 한도(quota)를
 *   추측하지 않는다. seatLimit은 회차의 1인 최대 좌석 수(서버 값)만 표시한다.
 */

type Notice = { tone: "error" | "info"; title: string; body?: string; failedLabels?: string[]; action?: { href: string; label: string } };

const SIM_LABEL: Record<HoldSimulation, string> = {
  auto: "자동(현재 좌석 상태로 판단)",
  "seat-taken": "다른 고객이 먼저 확보(좌석 1개)",
  limit: "구매 가능 수 초과",
  "active-order": "같은 회차 진행 중 예매 있음",
  "identity-time": "인증 남은 시간 10분 미만",
};

type SeatPickerProps = {
  sessionId: string;
  sessionStartsAt: string;
  showTitle: string;
  seats: SeatView[];
  dev: boolean;
} & ({ readOnly?: false; quota: QuotaView } | { readOnly: true; quota: null; seatLimit: number });

export function SeatPicker(props: SeatPickerProps) {
  const { sessionId, sessionStartsAt, showTitle, seats, dev, readOnly, quota } = props;
  const router = useRouter();
  const seatLimit = props.readOnly ? props.seatLimit : props.quota.seatLimit;
  const remaining = props.readOnly ? 0 : props.quota.remaining;
  const { selected, selectedIds, displayTotal, toggle, clear } = useSeatSelection(seats, remaining);
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sim, setSim] = useState<HoldSimulation>("auto");
  const [pending, startTransition] = useTransition();

  // 다른 화면에 다녀오면(Activity로 상태가 보존됨) 이전 선택·안내를 지운다.
  useLayoutEffect(
    () => () => {
      clear();
      setFailedIds(new Set());
      setNotice(null);
    },
    [clear],
  );

  // 확보에 실패한 좌석의 외곽선 강조는 잠시만 보여준다(좌석명은 상단 안내에 남는다).
  useEffect(() => {
    if (failedIds.size === 0) return;
    const t = window.setTimeout(() => setFailedIds(new Set()), 4000);
    return () => window.clearTimeout(t);
  }, [failedIds]);

  function onToggle(seat: SeatView) {
    const r = toggle(seat);
    if (r === "limit") {
      setNotice({ tone: "info", title: `이 회차에서는 최대 ${remaining}석까지 선택할 수 있습니다.`, body: "1인 최대 4석 기준은 본인인증 정보로 적용됩니다." });
    } else if (notice?.tone === "info") {
      setNotice(null);
    }
  }

  function submit() {
    if (readOnly || selected.length === 0 || pending) return;
    const ids = selected.map((s) => s.sessionSeatId);
    const labels = new Map(seats.map((s) => [s.sessionSeatId, s.label]));
    setNotice(null);
    setFailedIds(new Set());
    startTransition(async () => {
      const result = await holdSeatsAction(sessionId, ids, sim);
      if (result.ok) {
        router.push(`/booking/order?hold=${encodeURIComponent(result.holdId)}`);
        return;
      }
      clear();
      if (result.code === "SEAT_UNAVAILABLE") setFailedIds(new Set(result.unavailableSeatIds));
      setNotice(failureNotice(result, labels));
    });
  }

  const noQuota = remaining <= 0;
  const when = fullFmt.format(new Date(sessionStartsAt));
  const summaryLine =
    selected.length === 0 ? "" : selected.length === 1 ? selected[0].label : `${selected[0].label} 외 ${selected.length - 1}석`;
  // 사전 안내(서버 판단은 그대로): 진행 중 주문이 있거나, 더 고를 수 있는 좌석이 없을 때
  const preNotice: Notice | null = readOnly
    ? {
        tone: "info",
        title: "지금은 좌석 조회만 가능합니다.",
        body: "실제 예매(좌석 확보)는 아직 지원되지 않습니다. 좌석 상태와 가격만 확인할 수 있습니다.",
      }
    : quota?.activeOrderId
    ? {
        tone: "info",
        title: "이 회차에 진행 중인 예매가 있습니다.",
        action: { href: `/booking/order?hold=${encodeURIComponent(quota!.activeOrderId!)}`, label: "진행 중인 예매 보기" },
      }
    : noQuota
      ? { tone: "info", title: "이 회차에서 더 선택할 수 있는 좌석이 없습니다.", body: "1인 최대 4석 기준은 본인인증 정보로 적용됩니다." }
      : null;

  const holdButton = (size: "lg" | "sm") =>
    readOnly ? (
      <button
        type="button"
        disabled
        data-action="hold-unavailable"
        className={
          "shrink-0 cursor-not-allowed rounded-[0.25rem] bg-wash font-semibold text-char-3 " +
          (size === "lg" ? "min-h-[3.25rem] w-full px-6 text-base" : "min-h-12 px-6 text-[0.9375rem]")
        }
      >
        예매 준비 중
      </button>
    ) : (
    <button
      type="button"
      onClick={submit}
      disabled={selected.length === 0 || pending}
      aria-busy={pending}
      data-action="hold"
      className={
        "shrink-0 rounded-[0.25rem] bg-btn font-semibold text-white transition-colors hover:bg-btn-hover disabled:cursor-not-allowed disabled:bg-wash disabled:text-char-3 " +
        (size === "lg" ? "min-h-[3.25rem] w-full px-6 text-base" : "min-h-12 px-6 text-[0.9375rem]")
      }
    >
      {pending ? "좌석 확보 중…" : "좌석 확보"}
      {dev && !pending && <span className="ml-2 rounded-sm bg-white/15 px-1.5 py-0.5 text-[0.6rem] font-semibold tracking-wider">DEV</span>}
    </button>
    );

  return (
    <div className="pb-[calc(8rem+env(safe-area-inset-bottom,0px))] lg:pb-0">
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_21rem] lg:border-t-2 lg:border-char">
        {/* 좌석 배치 */}
        <div className="flex min-w-0 flex-col gap-6 lg:border-r lg:border-rule lg:py-8 lg:pr-12">
          <div className="flex flex-col gap-1.5 border-b border-rule pb-4 lg:pb-5">
            <div className="flex items-baseline justify-between gap-4">
              <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                <span className="text-[0.9375rem] font-bold text-char md:text-base">{showTitle}</span>
                <span className="text-[0.9375rem] font-medium tabular-nums text-char md:text-base">{when}</span>
                {dev && <span className="text-[0.625rem] font-semibold tracking-wider text-char-3">[DEV]</span>}
              </p>
              <Link href="/booking" className="shrink-0 text-[0.8125rem] text-char-3 underline-offset-4 hover:text-char hover:underline">
                회차 변경
              </Link>
            </div>
            <p className="text-[0.8125rem] text-char-3">
              {readOnly ? (
                <>1인 최대 {seatLimit}석 · 지금은 좌석 조회만 가능합니다</>
              ) : (
                <>
                  1인 최대 {seatLimit}석 · 이 회차에서 <strong className="font-semibold text-char">{remaining}석</strong>까지 선택할 수 있습니다
                </>
              )}
            </p>
          </div>

          {notice && <NoticeBox notice={notice} />}
          {!notice && preNotice && <NoticeBox notice={preNotice} />}

          <div className="flex flex-col gap-2">
            <SeatLegend />
            <p className="text-xs text-char-3 md:hidden">좌석표가 화면보다 넓으면 좌우로 밀어 전체 좌석을 볼 수 있습니다.</p>
          </div>
          <SeatMap seats={seats} selectedIds={selectedIds} failedIds={failedIds} onToggle={onToggle} disabled={pending || noQuota} dev={dev} />

          <ul className="flex flex-col gap-1 border-t border-rule pt-4 text-[0.8125rem] leading-relaxed text-char-3 lg:hidden">
            <li>· 좌석 확보를 누르면 선택한 좌석 전체를 7분간 확보합니다.</li>
            <li>· 한 좌석이라도 확보할 수 없으면 모두 확보되지 않습니다.</li>
            <li>· 확보 후에는 좌석을 바꿀 수 없으며, 취소 후 다시 예매해야 합니다.</li>
          </ul>

          {dev && (
            <details className="group border-y border-dashed border-char-3/40 py-3 text-sm" data-dev-panel>
              <summary className="cursor-pointer list-none text-[0.8125rem] font-semibold text-char-2">
                <span className="mr-1 inline-block transition-transform group-open:rotate-90">›</span> [DEV] 좌석 확보 응답 — 실제 확보가 아닙니다
              </summary>
              <label className="mt-3 flex flex-col gap-1 text-xs text-char-3 sm:max-w-xs">
                확보 응답
                <SimSelect value={sim} onChange={setSim} />
              </label>
            </details>
          )}
        </div>

        {/* 선택 요약 — 데스크톱 */}
        <aside aria-label="선택한 좌석" className="hidden lg:block lg:pl-10">
          <div className="flex flex-col gap-5 lg:sticky lg:top-6 lg:py-8">
            <div className="flex items-baseline justify-between">
              <h2 className="text-base font-bold text-char">선택 좌석</h2>
              <p className="text-[0.8125rem] tabular-nums text-char-3" data-selected-count>
                {readOnly ? (
                  "조회 전용"
                ) : (
                  <>
                    <strong className="font-semibold text-char">{selected.length}</strong> / 최대 {remaining}석
                  </>
                )}
              </p>
            </div>
            <p className="text-[0.8125rem] text-char-2">
              {showTitle} · <span className="tabular-nums">{when}</span>
            </p>
            <div className="border-y border-rule">
              {selected.length === 0 ? (
                <p className="py-6 text-center text-sm text-char-3">{readOnly ? "지금은 좌석 조회만 가능합니다." : "좌석을 선택해 주세요."}</p>
              ) : (
                <ul className="flex flex-col py-1.5 text-[0.9375rem]" data-selected-list>
                  {selected.map((s) => (
                    <li key={s.sessionSeatId} className="flex justify-between gap-4 py-2 tabular-nums">
                      <span className="text-char">{s.label}</span>
                      <span className="text-char-2">{formatWon(s.price)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {!readOnly && (
            <p className="flex items-baseline justify-between tabular-nums">
              <span className="text-sm text-char-2">총 금액</span>
              <span className="flex items-baseline gap-1.5">
                <span className="text-xl font-bold text-char" data-total>
                  {formatWon(displayTotal)}
                </span>
                {dev && <span className="text-[0.625rem] font-semibold text-char-3">[DEV]</span>}
              </span>
            </p>
            )}
            {holdButton("lg")}
            <ul className="flex flex-col gap-1 text-[0.8125rem] leading-relaxed text-char-3">
              <li>· 좌석 확보를 누르면 선택한 좌석 전체를 7분간 확보합니다.</li>
              <li>· 한 좌석이라도 확보할 수 없으면 모두 확보되지 않습니다.</li>
              <li>· 확보 후에는 좌석을 바꿀 수 없으며, 취소 후 다시 예매해야 합니다.</li>
            </ul>
          </div>
        </aside>
      </div>

      {/* 선택 요약 — 모바일·태블릿 하단 바. 좌석을 하나 이상 선택했을 때만 나타난다. */}
      <aside
        aria-label="선택한 좌석"
        aria-hidden={selected.length === 0}
        inert={selected.length === 0}
        className={
          "fixed inset-x-0 bottom-0 z-30 border-t border-rule bg-paper/95 pb-[env(safe-area-inset-bottom,0px)] backdrop-blur transition-[transform,visibility] duration-200 motion-reduce:transition-none lg:hidden " +
          (selected.length > 0 ? "visible translate-y-0" : "invisible translate-y-full")
        }
      >
        <div className="mx-auto flex max-w-[77.5rem] items-center gap-4 px-5 py-3 sm:px-8">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-char-3">
              {selected.length}석 · {summaryLine}
            </p>
            <p className="flex items-baseline gap-1.5 tabular-nums">
              <span className="text-lg font-bold text-char">{formatWon(displayTotal)}</span>
              {dev && <span className="text-[0.6rem] font-semibold text-char-3">[DEV]</span>}
            </p>
          </div>
          {holdButton("sm")}
        </div>
      </aside>
    </div>
  );
}

function SimSelect({ value, onChange }: { value: HoldSimulation; onChange: (v: HoldSimulation) => void }) {
  return (
    <select
      data-dev-sim
      value={value}
      onChange={(e) => onChange(e.target.value as HoldSimulation)}
      className="rounded-[0.25rem] border border-rule bg-paper px-2 py-2 text-sm text-char"
    >
      {HOLD_SIMULATIONS.map((s) => (
        <option key={s} value={s}>
          {SIM_LABEL[s]}
        </option>
      ))}
    </select>
  );
}

function failureNotice(r: Exclude<HoldSeatsResult, { ok: true }>, labels: Map<string, string>): Notice {
  switch (r.code) {
    case "SEAT_UNAVAILABLE":
      return {
        tone: "error",
        title: "선택한 좌석 중 확보할 수 없는 좌석이 있어 좌석을 확보하지 못했습니다.",
        body: "어떤 좌석도 확보되지 않았습니다. 최신 좌석 상태를 다시 불러왔으니 좌석을 다시 선택해 주세요.",
        failedLabels: r.unavailableSeatIds.map((id) => labels.get(id) ?? id),
      };
    case "PURCHASE_LIMIT_EXCEEDED":
      return { tone: "error", title: `이 회차에서 더 예매할 수 있는 좌석은 ${r.remaining}석입니다.`, body: "좌석이 확보되지 않았습니다. 좌석 수를 줄여 다시 선택해 주세요." };
    case "ACTIVE_ORDER_EXISTS":
      return {
        tone: "error",
        title: "같은 회차에 진행 중인 예매가 있습니다.",
        body: "새 좌석은 확보되지 않았습니다. 진행 중인 예매를 먼저 확인해 주세요.",
        action: r.activeOrderId ? { href: `/booking/order?hold=${encodeURIComponent(r.activeOrderId)}`, label: "진행 중인 예매 보기" } : undefined,
      };
    case "IDENTITY_SESSION_TIME_INSUFFICIENT":
      return {
        tone: "error",
        title: "본인인증 남은 시간이 부족해 좌석을 확보할 수 없습니다.",
        body: "좌석이 확보되지 않았습니다. 본인인증을 다시 진행한 뒤 좌석을 선택해 주세요.",
        action: { href: "/booking/verify", label: "다시 인증하기" },
      };
    case "NOT_AVAILABLE":
      return { tone: "error", title: "지금은 좌석을 확보할 수 없습니다.", body: "좌석 선택 기능을 준비하고 있습니다." };
    case "INVALID_REQUEST":
      return { tone: "error", title: "요청을 처리하지 못했습니다.", body: "회차를 다시 선택해 주세요.", action: { href: "/booking", label: "회차 다시 선택" } };
  }
}

function NoticeBox({ notice }: { notice: Notice }) {
  const err = notice.tone === "error";
  return (
    <div
      role={err ? "alert" : "status"}
      data-notice={notice.tone}
      className={"flex flex-col gap-1.5 px-4 py-3 text-sm " + (err ? "border-l-2 border-char bg-wash" : "border-l-2 border-char-3/60 bg-wash/70")}
    >
      <p className="font-semibold text-char">{notice.title}</p>
      {notice.failedLabels && notice.failedLabels.length > 0 && (
        <p className="text-char" data-failed-seats>
          확보하지 못한 좌석: {notice.failedLabels.join(", ")}
        </p>
      )}
      {notice.body && <p className="text-char-2">{notice.body}</p>}
      {notice.action && (
        <Link href={notice.action.href} className="mt-0.5 self-start text-sm font-medium text-char underline underline-offset-4">
          {notice.action.label}
        </Link>
      )}
    </div>
  );
}
