"use client";

import Link from "next/link";
import type { BookingSessionView } from "@/server/booking/session-types";
import { formatSessionDateTime } from "./format";
import { useSelectedSessionId } from "./selected-session";

/**
 * sessionStorage의 선택 회차 ID로 회차 정보를 찾아 보여준다.
 * sessions가 null이면 회차 데이터가 연결되지 않은 환경이다.
 */
export function SelectedSessionSummary({
  showTitle,
  sessions,
  dev,
  editable = true,
}: {
  showTitle: string;
  sessions: BookingSessionView[] | null;
  dev: boolean;
  editable?: boolean;
}) {
  const id = useSelectedSessionId();
  const session = id && sessions ? sessions.find((s) => s.id === id) : null;

  return (
    <section aria-labelledby="selected-title" className="flex flex-col gap-4 rounded-sm border border-line bg-s1 p-5 md:p-6">
      <div className="flex items-center justify-between gap-4">
        <h2 id="selected-title" className="text-xs tracking-[0.2em] text-subtle">
          선택한 회차
        </h2>
        {editable && (
          <Link href="/booking" className="text-sm text-muted underline-offset-4 hover:text-ink hover:underline">
            회차 다시 선택
          </Link>
        )}
      </div>
      <p className="type-heading text-lg text-ink">뮤지컬 〈{showTitle}〉</p>
      {id === undefined ? (
        <p className="h-6 w-48 animate-pulse rounded-sm bg-s3 motion-reduce:animate-none" aria-label="불러오는 중" />
      ) : session ? (
        <p className="flex items-baseline gap-3 text-xl font-semibold tabular-nums text-ink">
          {formatSessionDateTime(session.startsAt)}
          {dev && <span className="text-[0.65rem] font-semibold tracking-wider text-st-pause">[DEV]</span>}
        </p>
      ) : (
        <p className="text-sm text-muted">
          선택한 회차 정보가 없습니다.{" "}
          <Link href="/booking" className="text-ink underline underline-offset-4">
            회차를 먼저 선택해 주세요.
          </Link>
        </p>
      )}
    </section>
  );
}

/** 회차가 선택돼 있는지(다음 단계 진행 가능 여부의 화면 조건). 판매 가능 여부는 서버가 다음 단계에서 다시 판단한다. */
export function useHasSelectedSession(sessions: BookingSessionView[] | null): boolean {
  const id = useSelectedSessionId();
  return Boolean(id && sessions?.some((s) => s.id === id));
}
