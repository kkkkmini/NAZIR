"use client";

import Link from "next/link";
import type { BookingSessionView } from "@/server/booking/session-types";
import { timeFmt, weekdayFmt } from "./format";
import { useSelectedSessionId } from "./selected-session";

/**
 * 선택한 회차 정보 — A안(화이트 미니멀) 버전. A3-2·A7에서 쓴다.
 * 기존 다크 버전(selected-session-summary.tsx)은 아직 다크인 화면을 위해 그대로 둔다.
 * 회차 ID는 sessionStorage에서 읽고, 회차 정보는 서버가 준 목록(sessions)에서 찾는다.
 */
const dateFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" });

/** undefined: 아직 모름(서버 렌더 중) / null: 선택한 회차 없음 */
export function useSelectedSession(sessions: BookingSessionView[] | null): BookingSessionView | null | undefined {
  const id = useSelectedSessionId();
  if (id === undefined) return undefined;
  return (id && sessions?.find((s) => s.id === id)) || null;
}

export function SessionInfo({
  showTitle,
  sessions,
  dev,
  editable = true,
  heading = "예매 정보",
}: {
  showTitle: string;
  sessions: BookingSessionView[] | null;
  dev: boolean;
  editable?: boolean;
  heading?: string;
}) {
  const session = useSelectedSession(sessions);
  const d = session ? new Date(session.startsAt) : null;

  return (
    <section aria-labelledby="selected-title" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="selected-title" className="text-[0.9375rem] font-bold text-char md:text-base">
          {heading}
        </h2>
        {editable && session && (
          <Link href="/booking" className="text-[0.8125rem] text-char-3 underline-offset-4 hover:text-char hover:underline">
            회차 변경
          </Link>
        )}
      </div>
      {session === undefined ? (
        <div className="h-[8.5rem] animate-pulse border-y border-rule bg-wash/60 motion-reduce:animate-none" aria-label="불러오는 중" />
      ) : session && d ? (
        <dl className="border-y border-rule text-[0.9375rem]" data-session-info>
          <Row label="공연">뮤지컬 {showTitle}</Row>
          <Row label="관람일">
            {dateFmt.format(d)} ({weekdayFmt.format(d)})
          </Row>
          <Row label="시간" last>
            <span className="tabular-nums">{timeFmt.format(d)}</span>
            {dev && <span className="ml-2 text-[0.625rem] font-semibold tracking-wider text-char-3">[DEV]</span>}
          </Row>
        </dl>
      ) : (
        <div className="flex flex-col gap-2 border-y border-rule py-5" data-session-info="missing">
          <p className="text-[0.9375rem] text-char">선택한 회차 정보가 없습니다.</p>
          <Link href="/booking" className="self-start text-sm font-medium text-char underline underline-offset-4">
            회차를 먼저 선택해 주세요
          </Link>
        </div>
      )}
    </section>
  );
}

function Row({ label, children, last = false }: { label: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={"grid grid-cols-[4.5rem_1fr] gap-3 py-3 md:grid-cols-[5.5rem_1fr] " + (last ? "" : "border-b border-rule")}>
      <dt className="text-char-3">{label}</dt>
      <dd className="font-medium text-char">{children}</dd>
    </div>
  );
}
