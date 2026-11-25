"use client";

import { ChevronRightIcon } from "@/components/site/icons";

/**
 * 컴팩트 월간 달력(표시 전용). 공연이 있는 날짜만 고를 수 있고, 나머지 날짜는 비활성이다.
 * 날짜 키는 KST 기준 "YYYY-MM-DD". 어떤 날짜에 공연이 있는지는 부모가 서버 회차 목록으로 정해 넘긴다.
 */
export type CalendarDay = { key: string; hasSessions: boolean; hasAvailable: boolean };

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

type Props = {
  month: string; // "YYYY-MM"
  days: Map<string, CalendarDay>;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  prevMonth: string | null;
  nextMonth: string | null;
  onMonth: (month: string) => void;
};

export function SessionCalendar({ month, days, selectedKey, onSelect, prevMonth, nextMonth, onMonth }: Props) {
  const [y, m] = month.split("-").map(Number);
  const firstWeekday = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const dayCount = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (number | null)[] = [...Array<null>(firstWeekday).fill(null), ...Array.from({ length: dayCount }, (_, i) => i + 1)];

  return (
    <div className="flex flex-col gap-2 sm:gap-3">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => prevMonth && onMonth(prevMonth)}
          disabled={!prevMonth}
          aria-label="이전 달"
          className="grid h-8 w-8 place-items-center rounded-full text-char-2 hover:bg-wash disabled:text-rule disabled:hover:bg-transparent"
        >
          <ChevronRightIcon className="h-4 w-4 rotate-180" />
        </button>
        <p className="text-base font-bold tabular-nums text-char lg:text-lg" aria-live="polite">
          {y}.{String(m).padStart(2, "0")}
        </p>
        <button
          type="button"
          onClick={() => nextMonth && onMonth(nextMonth)}
          disabled={!nextMonth}
          aria-label="다음 달"
          className="grid h-8 w-8 place-items-center rounded-full text-char-2 hover:bg-wash disabled:text-rule disabled:hover:bg-transparent"
        >
          <ChevronRightIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-7 text-center text-xs text-char-3 lg:text-[0.8125rem]" aria-hidden>
        {WEEKDAYS.map((w) => (
          <span key={w} className="py-0.5 sm:py-1 lg:py-1.5">
            {w}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-y-0.5 sm:gap-y-1 lg:gap-y-1.5">
        {cells.map((d, i) => {
          if (d === null) return <span key={`e${i}`} />;
          const key = `${month}-${String(d).padStart(2, "0")}`;
          const info = days.get(key);
          const active = Boolean(info?.hasSessions);
          const selected = key === selectedKey;
          return (
            <div key={key} className="flex justify-center">
              <button
                type="button"
                disabled={!active}
                aria-pressed={active ? selected : undefined}
                aria-label={`${m}월 ${d}일${active ? (info?.hasAvailable ? ", 예매 가능한 회차 있음" : ", 예매 가능한 회차 없음") : ", 공연 없음"}`}
                onClick={() => onSelect(key)}
                data-day={key}
                className={
                  "relative grid h-[2.125rem] w-[2.125rem] place-items-center sm:h-9 sm:w-9 lg:h-11 lg:w-11 lg:text-[0.9375rem] rounded-full text-sm tabular-nums transition-colors " +
                  (selected
                    ? "bg-char font-bold text-white"
                    : active
                      ? "font-semibold text-char hover:bg-wash"
                      : "cursor-default text-char-3/45")
                }
              >
                {d}
                {active && !selected && (
                  <span
                    aria-hidden
                    className={"absolute bottom-[0.1875rem] h-1 w-1 rounded-full sm:bottom-1 lg:bottom-1.5 " + (info?.hasAvailable ? "bg-char" : "bg-char-3/50")}
                  />
                )}
              </button>
            </div>
          );
        })}
      </div>
      <p className="flex items-center gap-3 pt-1 text-xs text-char-3 lg:pt-2">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-1 w-1 rounded-full bg-char" /> 예매 가능
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-1 w-1 rounded-full bg-char-3/50" /> 예매 불가 회차만 있음
        </span>
      </p>
    </div>
  );
}
