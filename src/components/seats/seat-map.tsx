"use client";

import { useEffect, useRef } from "react";
import { formatWon } from "@/components/booking/format";
import type { SeatState, SeatView } from "@/server/seats/seat-types";
import { groupBy } from "./seat-layout";

/**
 * 좌석 배치도(렌더링 전용) — A안 화이트 미니멀. 상태 판단·선택 규칙은 갖지 않고 props로 받은 값만 그린다.
 * 지금은 SVG가 없어(E-003) 구역·열·번호로 격자를 그린다. 실제 배치도 SVG가 오면
 * svgSeatId로 같은 props를 연결하는 컴포넌트로 교체한다.
 *
 * 화면에서는 선택 불가 상태(점유 중·판매 완료·판매 불가)를 같은 모양으로 그리고,
 * 실제 상태는 화면 낭독기 이름(aria-label)과 data-state로 구분한다.
 */

/** 좌석별 실제 상태 이름(화면 낭독기·확보 실패 안내용). HELD는 내 주문일 수도 있으므로 중립 표현을 쓴다. */
export const SEAT_STATE_LABEL: Record<SeatState, string> = {
  AVAILABLE: "선택 가능",
  HELD: "예매 진행 중",
  SOLD: "판매 완료",
  BLOCKED: "판매 불가",
};

const SEAT_BASE =
  "grid h-7 w-7 shrink-0 place-items-center rounded-[0.3125rem] border text-[0.6875rem] tabular-nums transition-colors md:h-8 md:w-8 md:text-xs";
const SEAT_AVAILABLE =
  "border-char-3/55 bg-paper text-char-2 hover:border-char hover:text-char";
const SEAT_SELECTED = "border-char bg-char font-bold text-white";
const SEAT_UNAVAILABLE =
  "cursor-not-allowed border-transparent bg-[#e9e9ec] text-transparent";

type Props = {
  seats: SeatView[];
  selectedIds: ReadonlySet<string>;
  /** 방금 확보에 실패한 좌석(안내 강조용) */
  failedIds: ReadonlySet<string>;
  onToggle: (seat: SeatView) => void;
  disabled?: boolean;
  dev: boolean;
};

export function SeatMap({
  seats,
  selectedIds,
  failedIds,
  onToggle,
  disabled,
  dev,
}: Props) {
  const sections = groupBy(seats, (s) => s.section ?? "");
  const scroller = useRef<HTMLDivElement>(null);

  // 좌석표가 화면보다 넓으면(모바일) 처음에 가운데가 보이도록 가로 위치를 맞춘다.
  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollWidth > el.clientWidth) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  }, []);

  return (
    <div
      ref={scroller}
      className="-mx-5 overflow-x-auto px-5 pb-2 sm:mx-0 sm:px-0"
      data-seat-scroll
    >
      <div className="mx-auto flex w-max min-w-full flex-col items-center gap-9 md:gap-10">
        <div className="flex w-full max-w-[26rem] flex-col items-center gap-1.5">
          <div className="h-1.5 w-full rounded-full bg-char/80" aria-hidden />
          <p className="text-[0.6875rem] font-semibold tracking-[0.4em] text-char-3">
            STAGE
          </p>
        </div>
        {[...sections].map(([section, list]) => {
          const prices = [...new Set(list.map((s) => s.price))];
          const rows = groupBy(list, (s) => s.row ?? "");
          return (
            <section
              key={section}
              aria-label={`${section} 구역`}
              className="flex flex-col gap-3.5"
            >
              <p className="flex flex-wrap items-baseline justify-center gap-x-2.5 gap-y-1 text-sm">
                <span className="font-bold text-char">{section}석</span>
                <span className="tabular-nums text-char-2">
                  {prices.map(formatWon).join(" / ")}
                </span>
                {dev && (
                  <span className="text-[0.625rem] font-semibold tracking-wider text-char-3">
                    [DEV] 임시 배치·가격
                  </span>
                )}
              </p>
              <div>
                <div className="flex w-max flex-col gap-1.5 md:gap-2">
                  {[...rows].map(([row, rowSeats]) => (
                    <div
                      key={row}
                      className="flex items-center gap-1.5 md:gap-2"
                    >
                      <span
                        className="w-5 shrink-0 text-center text-xs font-medium text-char-3"
                        aria-hidden
                      >
                        {row}
                      </span>
                      {rowSeats.map((s) => {
                        const selected = selectedIds.has(s.sessionSeatId);
                        const failed = failedIds.has(s.sessionSeatId);
                        const available = s.state === "AVAILABLE";
                        const selectable = available && !disabled;
                        return (
                          <button
                            key={s.sessionSeatId}
                            type="button"
                            data-seat={s.svgSeatId}
                            data-state={s.state}
                            aria-pressed={available ? selected : undefined}
                            aria-disabled={!selectable}
                            aria-label={`${s.label}, ${formatWon(s.price)}, ${selected ? "선택한 좌석" : SEAT_STATE_LABEL[s.state]}`}
                            onClick={() => selectable && onToggle(s)}
                            className={
                              SEAT_BASE +
                              " " +
                              (selected
                                ? SEAT_SELECTED
                                : available
                                  ? SEAT_AVAILABLE
                                  : SEAT_UNAVAILABLE) +
                              (available && !selectable
                                ? " cursor-not-allowed"
                                : "") +
                              (failed
                                ? " ring-2 ring-char ring-offset-2 ring-offset-paper"
                                : "")
                            }
                          >
                            {s.number}
                          </button>
                        );
                      })}
                      <span
                        className="hidden w-5 shrink-0 text-center text-xs font-medium text-char-3 md:inline"
                        aria-hidden
                      >
                        {row}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function SeatLegend() {
  const items = [
    { label: "선택 가능", cls: SEAT_AVAILABLE },
    { label: "선택한 좌석", cls: SEAT_SELECTED },
    { label: "선택 불가", cls: "border-transparent bg-[#e9e9ec]" },
  ];
  return (
    <ul
      className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[0.8125rem] text-char-2"
      aria-label="좌석 상태 범례"
    >
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-2">
          <span
            className={"h-4 w-4 rounded-[0.25rem] border " + i.cls}
            aria-hidden
          />
          {i.label}
        </li>
      ))}
    </ul>
  );
}
