"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { dayKeyFmt, fullFmt, timeFmt, weekdayFmt } from "./format";
import { saveSelectedSessionId } from "./selected-session";
import { SessionCalendar, type CalendarDay } from "./session-calendar";
import type { BookingSessionView, SessionState } from "@/server/booking/session-types";

/**
 * A3-1 회차 선택: 컴팩트 월간 달력 + 선택 날짜의 회차 목록 + 선택 요약.
 * - 회차 상태는 서버 값(state)을 그대로 표시한다. 선택 가능 여부는 서버의 sellable로만 정한다.
 * - 잔여 좌석 수는 회차 API가 제공하지 않으므로 표시하지 않는다(R-E).
 * - "다음"은 선택한 회차 ID를 sessionStorage에 저장하고 A3-2(/booking/verify)로 이동한다.
 *   유효한 예매 인증 세션이 있으면 A3-3으로 건너뛰어야 하지만, 세션 조회 API가 없어 지금은 항상 A3-2로 간다.
 */

const STATE_LABEL: Record<SessionState, string> = {
  ON_SALE: "예매 가능",
  TEMPORARILY_UNAVAILABLE: "일시 품절",
  SOLD_OUT: "매진",
  UPCOMING: "판매 예정",
  PAUSED: "판매 일시 중지",
  CLOSED: "판매 종료",
  CANCELED: "공연 취소",
};

const monthLabelFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric" });

function note(s: BookingSessionView): string | null {
  if (s.state === "UPCOMING") return s.opensAt ? `${fullFmt.format(new Date(s.opensAt))} 오픈` : "오픈 일정 추후 안내";
  if (s.state === "PAUSED") return "잠시 후 다시 확인해 주세요";
  if (s.state === "TEMPORARILY_UNAVAILABLE") return "다른 고객의 결제가 진행 중인 좌석입니다. 잠시 후 다시 확인해 주세요."; // 확정 문구(2026-11-21, 백엔드 labels.ts HELD_SEAT_NOTICE)
  if (s.state === "CANCELED") return "이 회차 공연이 취소되었습니다";
  return null;
}

export function SessionPicker({ sessions, dev, showTitle }: { sessions: BookingSessionView[]; dev: boolean; showTitle: string }) {
  const { byDay, days, months } = useMemo(() => {
    const byDay = new Map<string, BookingSessionView[]>();
    for (const s of [...sessions].sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
      const k = dayKeyFmt.format(new Date(s.startsAt));
      byDay.set(k, [...(byDay.get(k) ?? []), s]);
    }
    const days = new Map<string, CalendarDay>();
    for (const [key, list] of byDay) days.set(key, { key, hasSessions: true, hasAvailable: list.some((s) => s.sellable) });
    const months = [...new Set([...byDay.keys()].map((k) => k.slice(0, 7)))];
    return { byDay, days, months };
  }, [sessions]);

  const firstKey = [...days.values()].find((d) => d.hasAvailable)?.key ?? [...days.keys()][0] ?? null;
  const [dayKey, setDayKey] = useState<string | null>(firstKey);
  const [month, setMonth] = useState<string | null>(firstKey?.slice(0, 7) ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const router = useRouter();

  const daySessions = dayKey ? (byDay.get(dayKey) ?? []) : [];
  const selected = sessions.find((s) => s.id === selectedId) ?? null;

  if (!month || days.size === 0) {
    return <p className="border-y border-rule py-10 text-center text-char-2">현재 예매할 수 있는 회차가 없습니다. 회차 일정은 확정되는 대로 안내합니다.</p>;
  }

  const mi = months.indexOf(month);
  const dayDate = daySessions[0] ? new Date(daySessions[0].startsAt) : null;

  function pickDay(k: string) {
    setDayKey(k);
    setSelectedId(null);
  }

  function next() {
    if (!selected) return;
    saveSelectedSessionId(selected.id);
    router.push("/booking/verify");
  }

  const selDate = selected ? new Date(selected.startsAt) : null;

  return (
    <div className="pb-[calc(7rem+env(safe-area-inset-bottom,0px))] lg:pb-0">
      <div className="flex flex-col gap-8 md:grid md:grid-cols-[20rem_minmax(0,1fr)] md:gap-10 lg:grid-cols-[minmax(0,23.5rem)_minmax(0,1fr)_minmax(0,21rem)] lg:gap-0 lg:border-y lg:border-b-rule lg:border-t-char lg:[border-top-width:2px]">
        {/* 날짜 */}
        <section aria-labelledby="date-title" className="flex flex-col gap-3 lg:gap-5 lg:border-r lg:border-rule lg:py-8 lg:pr-10">
          <h2 id="date-title" className="text-[0.9375rem] font-bold text-char lg:text-base">
            날짜 선택
          </h2>
          <div className="border-y border-rule py-3 lg:border-0 lg:py-0">
            <SessionCalendar
              month={month}
              days={days}
              selectedKey={dayKey}
              onSelect={pickDay}
              prevMonth={mi > 0 ? months[mi - 1] : null}
              nextMonth={mi < months.length - 1 ? months[mi + 1] : null}
              onMonth={setMonth}
            />
          </div>
        </section>

        {/* 회차 */}
        <section aria-labelledby="session-title" className="flex min-w-0 flex-col gap-3 lg:gap-5 lg:border-r lg:border-rule lg:px-10 lg:py-8">
          <h2 id="session-title" className="flex items-baseline gap-2 text-[0.9375rem] font-bold text-char lg:text-base">
            회차 선택
            {dayDate && (
              <span className="font-medium text-char-2">
                {monthLabelFmt.format(dayDate)} ({weekdayFmt.format(dayDate)})
              </span>
            )}
          </h2>
          <div role="radiogroup" aria-labelledby="session-title" className="flex flex-col gap-2 lg:gap-2.5">
            {daySessions.map((s) => {
              const selectable = s.sellable;
              const checked = s.id === selectedId;
              const n = note(s);
              return (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-disabled={!selectable}
                  data-state={s.state}
                  onClick={() => selectable && setSelectedId(s.id)}
                  className={
                    "flex min-h-[3.75rem] items-center justify-between gap-4 rounded-[0.25rem] border px-4 py-3 text-left transition-colors md:px-5 lg:min-h-[4.25rem] lg:px-6 " +
                    (checked
                      ? "border-char bg-wash/70"
                      : selectable
                        ? "border-rule bg-paper hover:border-char-3"
                        : "cursor-not-allowed border-rule bg-paper")
                  }
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex items-baseline gap-2.5">
                      <span
                        className={
                          "text-lg font-bold tabular-nums lg:text-xl " +
                          (selectable ? "text-char" : "text-char-3") +
                          (s.state === "CANCELED" ? " line-through" : "")
                        }
                      >
                        {timeFmt.format(new Date(s.startsAt))}
                      </span>
                      {dev && <span className="text-[0.625rem] font-semibold tracking-wider text-char-3">[DEV]</span>}
                    </span>
                    {n && <span className="truncate text-xs text-char-3 lg:text-[0.8125rem]">{n}</span>}
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    <span className={"text-[0.8125rem] lg:text-sm " + (selectable ? "font-semibold text-char" : "text-char-3")}>{STATE_LABEL[s.state]}</span>
                    {selectable && (
                      <span
                        aria-hidden
                        className={"grid h-5 w-5 place-items-center rounded-full border " + (checked ? "border-char bg-char" : "border-char-3/60")}
                      >
                        {checked && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="text-xs leading-relaxed text-char-3 lg:hidden">잔여석은 좌석 선택 단계에서 확인할 수 있습니다. 한 회차에 1인 최대 4석까지 예매할 수 있습니다.</p>
        </section>

        {/* 선택 요약 — 데스크톱 */}
        <aside aria-label="선택한 회차" className="hidden lg:flex lg:flex-col lg:gap-6 lg:py-8 lg:pl-10">
          <h2 className="text-base font-bold text-char">선택한 회차</h2>
          <dl className="flex flex-col border-y border-rule text-[0.9375rem]">
            <div className="grid grid-cols-[4.5rem_1fr] gap-3 border-b border-rule py-3.5">
              <dt className="text-char-3">공연</dt>
              <dd className="font-medium text-char">{showTitle}</dd>
            </div>
            <div className="grid grid-cols-[4.5rem_1fr] gap-3 border-b border-rule py-3.5">
              <dt className="text-char-3">관람일</dt>
              <dd className={selDate ? "font-medium text-char" : "text-char-3"}>
                {selDate ? `${monthLabelFmt.format(selDate)} (${weekdayFmt.format(selDate)})` : "날짜를 선택해 주세요"}
              </dd>
            </div>
            <div className="grid grid-cols-[4.5rem_1fr] gap-3 py-3.5">
              <dt className="text-char-3">시간</dt>
              <dd className={selDate ? "font-medium tabular-nums text-char" : "text-char-3"} data-selected-session>
                {selDate ? timeFmt.format(selDate) : "회차를 선택해 주세요"}
              </dd>
            </div>
          </dl>
          <button
            type="button"
            disabled={!selected}
            onClick={next}
            className="min-h-[3.25rem] rounded-[0.25rem] bg-btn px-7 text-base font-semibold text-white transition-colors hover:bg-btn-hover disabled:cursor-not-allowed disabled:bg-wash disabled:text-char-3"
          >
            다음
          </button>
          <ul className="flex flex-col gap-1.5 text-[0.8125rem] leading-relaxed text-char-3">
            <li>· 다음 단계에서 휴대전화 본인인증을 진행합니다.</li>
            <li>· 한 회차에 1인 최대 4석까지 예매할 수 있습니다.</li>
            <li>· 잔여석은 좌석 선택 단계에서 확인할 수 있습니다.</li>
          </ul>
        </aside>
      </div>

      {/* 선택 요약 — 모바일·태블릿 하단 바. 회차를 선택했을 때만 나타난다. */}
      <aside
        aria-label="선택한 회차"
        aria-hidden={!selected}
        inert={!selected}
        className={
          "fixed inset-x-0 bottom-0 z-30 border-t border-rule bg-paper/95 pb-[env(safe-area-inset-bottom,0px)] backdrop-blur transition-transform duration-200 motion-reduce:transition-none lg:hidden " +
          (selected ? "translate-y-0" : "translate-y-full")
        }
      >
        <div className="mx-auto flex max-w-[77.5rem] items-center gap-4 px-5 py-3 sm:px-8">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-char-3">선택한 회차</p>
            <p className="truncate text-[0.9375rem] font-semibold text-char" data-selected-session>
              {selected ? fullFmt.format(new Date(selected.startsAt)) : ""}
            </p>
          </div>
          <button
            type="button"
            disabled={!selected}
            onClick={next}
            className="min-h-12 shrink-0 rounded-[0.25rem] bg-btn px-8 text-[0.9375rem] font-semibold text-white transition-colors hover:bg-btn-hover disabled:bg-wash disabled:text-char-3"
          >
            다음
          </button>
        </div>
      </aside>
    </div>
  );
}
