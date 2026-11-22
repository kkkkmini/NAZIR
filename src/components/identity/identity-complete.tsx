"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSelectedSessionId } from "@/components/booking/selected-session";
import { SessionInfo } from "@/components/booking/session-info";
import type { BookingSessionView } from "@/server/booking/session-types";
import type { PreviewCallbackResult } from "./preview-results";

/**
 * A7 인증 복귀 처리 — A안(화이트 미니멀).
 * 실제 연동 시: 화면이 POST /identity-verifications/{vid}/claim 을 호출하고, 서버 응답으로만 결과를 정한다.
 * 지금은 claim API가 없으므로
 *  - preview(개발 환경): [DEV] 결과 미리보기. 성공 시뮬레이션도 인증 세션을 만들지 않는다.
 *  - not-ready(그 외): 결과를 확인할 수 없음 — 성공으로 처리하지 않는다.
 */
type Props =
  | { kind: "preview"; result: PreviewCallbackResult; showTitle: string; sessions: BookingSessionView[] | null }
  | { kind: "not-ready"; showTitle: string };

const FAILURE: Record<Exclude<PreviewCallbackResult, "success">, { title: string; body: string }> = {
  failed: { title: "본인인증에 실패했습니다", body: "인증 정보를 확인하지 못했습니다. 다시 인증해 주세요." },
  canceled: { title: "본인인증이 취소되었습니다", body: "인증을 마치지 않았습니다. 예매를 계속하려면 다시 인증해 주세요." },
  expired: { title: "인증 시간이 지났습니다", body: "인증 유효 시간이 지나 확인할 수 없습니다. 다시 인증해 주세요." },
  "binding-mismatch": {
    title: "인증을 시작한 브라우저에서 진행해 주세요",
    body: "본인인증은 시작한 브라우저에서만 이어서 진행할 수 있습니다. 이 브라우저에서 다시 인증해 주세요.",
  },
  "already-used": { title: "이미 사용된 인증입니다", body: "같은 인증 결과는 한 번만 사용할 수 있습니다. 다시 인증해 주세요." },
};

const primary =
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-[0.25rem] bg-btn px-7 text-[0.9375rem] font-semibold text-white transition-colors hover:bg-btn-hover";
const secondary = "inline-flex min-h-12 items-center justify-center rounded-[0.25rem] border border-rule px-6 text-[0.9375rem] text-char hover:border-char-3";

export function IdentityComplete(props: Props) {
  const [checking, setChecking] = useState(props.kind === "preview");
  const selectedId = useSelectedSessionId();

  useEffect(() => {
    if (props.kind !== "preview") return;
    const t = window.setTimeout(() => setChecking(false), 800);
    return () => window.clearTimeout(t);
  }, [props.kind]);

  if (props.kind === "not-ready") {
    return (
      <Result title="본인인증 결과를 확인할 수 없습니다" body="본인인증 기능을 준비하고 있습니다. 준비가 끝나면 이곳에서 인증 결과를 확인합니다.">
        <div className="flex">
          <Link href="/booking" className={secondary}>
            회차 선택으로 돌아가기
          </Link>
        </div>
      </Result>
    );
  }

  const { result, showTitle, sessions } = props;

  if (checking) {
    return <Result title="본인인증 결과를 확인하고 있습니다" body="잠시만 기다려 주세요." busy />;
  }

  if (result === "success") {
    return (
      <Result
        status="success"
        title="본인인증이 완료되었습니다 (시뮬레이션)"
        body="개발용 결과이므로 예매 인증 세션은 발급되지 않았습니다. 실제 연동 시 이곳에 인증된 이름(일부 가림)과 인증 유효 시간(30분)이 표시됩니다."
      >
        <SessionInfo showTitle={showTitle} sessions={sessions} dev editable={false} heading="예매 정보" />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Link href={selectedId ? `/booking/seats?session=${encodeURIComponent(selectedId)}` : "/booking/seats"} className={primary} data-action="to-seats">
            좌석 선택으로 이동
            <span className="rounded-sm bg-white/15 px-1.5 py-0.5 text-[0.6rem] font-semibold tracking-wider">DEV</span>
          </Link>
        </div>
      </Result>
    );
  }

  return (
    <Result status="error" title={FAILURE[result].title} body={FAILURE[result].body}>
      <SessionInfo showTitle={showTitle} sessions={sessions} dev editable={false} heading="선택한 회차 (유지됨)" />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Link href="/booking/verify" className={primary} data-action="retry">
          다시 인증하기
        </Link>
        <Link href="/booking" className={secondary} data-action="reselect">
          회차 다시 선택
        </Link>
      </div>
    </Result>
  );
}

function Result({
  title,
  body,
  children,
  status,
  busy,
}: {
  title: string;
  body: string;
  children?: React.ReactNode;
  status?: "success" | "error";
  busy?: boolean;
}) {
  return (
    <section
      aria-busy={busy || undefined}
      role={status === "error" ? "alert" : "status"}
      data-result={status ?? (busy ? "checking" : "none")}
      className="flex flex-col gap-8 border-t-2 border-char pt-7 md:pt-9"
    >
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-3">
          <ResultMark status={status} busy={busy} />
          <h2 className="text-xl font-bold tracking-[-0.02em] text-char md:text-2xl">{title}</h2>
        </div>
        <p className="text-[0.9375rem] leading-relaxed text-char-2">{body}</p>
      </div>
      {children}
    </section>
  );
}

function ResultMark({ status, busy }: { status?: "success" | "error"; busy?: boolean }) {
  const base = "grid h-7 w-7 shrink-0 place-items-center rounded-full";
  if (busy) return <span aria-hidden className={base + " animate-spin border-2 border-rule border-t-char motion-reduce:animate-none"} />;
  if (status === "success")
    return (
      <span aria-hidden className={base + " bg-char text-white"}>
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.5}>
          <path d="m5 12.5 4.5 4.5L19 7.5" />
        </svg>
      </span>
    );
  if (status === "error")
    return (
      <span aria-hidden className={base + " border-2 border-char text-char"}>
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={3}>
          <path d="M12 6v7M12 17.5v.5" />
        </svg>
      </span>
    );
  return null;
}
