"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { SessionInfo, useSelectedSession } from "@/components/booking/session-info";
import { fullFmt } from "@/components/booking/format";
import type { BookingSessionView } from "@/server/booking/session-types";
import type { IdentityStartMode } from "@/server/identity/identity-start-mode";
import {
  CALLBACK_LABEL,
  PREVIEW_CALLBACK_RESULTS,
  PREVIEW_START_RESULTS,
  PREVIEW_VID,
  type PreviewCallbackResult,
  type PreviewStartResult,
} from "./preview-results";

/**
 * A3-2 본인인증 시작 — A안(화이트 미니멀).
 * - not-ready: 인증 API·휴대전화 본인확인 서비스 연동 전이므로 버튼 비활성 "본인인증 준비 중".
 * - dev-preview: 화면 상태 미리보기. 인증을 시작하지 않고, A7 미리보기로 이동한다.
 *   실제 연동 시에는 POST /identity-verifications 응답의 launch(인증 URL)로 같은 창에서 이동한다.
 * 인증 성공 여부는 이 화면이 판단하지 않는다(A7에서 서버 응답으로만 정한다).
 */
type ViewState = "idle" | "starting" | "error-provider" | "error-rate";

const STEPS = ["휴대전화 본인확인 서비스 화면으로 이동", "본인 명의 휴대전화로 인증", "이 사이트로 돌아와 인증 결과 확인", "좌석 선택"];

const NOTES = [
  "본인 명의 휴대전화로 인증해 주세요.",
  "인증을 시작한 브라우저를 닫지 말고 진행해 주세요.",
  "인증 후 30분 동안 예매를 진행할 수 있으며, 이 시간은 연장되지 않습니다.",
  "인증을 취소하거나 인증에 실패하면 이 화면으로 돌아와 다시 인증할 수 있습니다.",
];

export function VerifyStart({
  mode,
  showTitle,
  sessions,
}: {
  mode: IdentityStartMode;
  showTitle: string;
  sessions: BookingSessionView[] | null;
}) {
  const router = useRouter();
  const dev = mode === "dev-preview";
  const session = useSelectedSession(sessions);
  const hasSession = Boolean(session);
  const [view, setView] = useState<ViewState>("idle");
  const [startResult, setStartResult] = useState<PreviewStartResult>("ok");
  const [callbackResult, setCallbackResult] = useState<PreviewCallbackResult>("success");

  const timer = useRef<number | null>(null);

  // cacheComponents 환경에서는 이 화면으로 돌아올 때(A7 → "다시 인증하기", 뒤로 가기) 이전 상태가 보존된다.
  // 화면이 가려질 때 진행 중 상태를 풀어, 돌아왔을 때 버튼이 "이동 중"에 멈춰 있지 않게 한다.
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      setView("idle");
    },
    [],
  );

  function start() {
    if (!dev || !hasSession) return;
    setView("starting");
    // [DEV] 서버 응답 대신 미리보기 선택값으로 상태를 보여준다.
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (startResult === "provider-unavailable") return setView("error-provider");
      if (startResult === "rate-limited") return setView("error-rate");
      router.push(`/identity/complete?vid=${PREVIEW_VID}&result=${callbackResult}`);
    }, 700);
  }

  const canStart = dev && hasSession && view !== "starting";
  const label = mode === "not-ready" ? "본인인증 준비 중" : view === "starting" ? "인증 화면으로 이동 중…" : "휴대전화 본인인증";
  const error =
    view === "error-provider"
      ? "휴대전화 본인확인 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요."
      : view === "error-rate"
        ? "요청이 많습니다. 잠시 후 다시 시도해 주세요."
        : null;
  const helper =
    mode === "not-ready"
      ? "본인인증 기능을 준비하고 있습니다. 준비가 끝나면 이곳에서 인증을 시작할 수 있습니다."
      : hasSession
        ? "인증이 끝나면 좌석 선택으로 이어집니다."
        : "회차를 먼저 선택해 주세요.";

  const button = (
    <button
      type="button"
      onClick={start}
      disabled={!canStart}
      aria-busy={view === "starting"}
      data-action="start-verify"
      className="min-h-12 w-full rounded-[0.25rem] bg-btn px-6 text-[0.9375rem] font-semibold text-white transition-colors hover:bg-btn-hover disabled:cursor-not-allowed disabled:bg-wash disabled:text-char-3 lg:min-h-[3.25rem] lg:text-base"
    >
      {label}
      {dev && view !== "starting" && <span className="ml-2 rounded-sm bg-white/15 px-1.5 py-0.5 text-[0.6rem] font-semibold tracking-wider">DEV</span>}
    </button>
  );

  return (
    <div className="pb-[calc(7rem+env(safe-area-inset-bottom,0px))] lg:pb-0">
      <div className="grid grid-cols-1 gap-9 lg:grid-cols-[minmax(0,1fr)_21rem] lg:gap-0 lg:border-t-2 lg:border-char">
        {/* 본문 */}
        <div className="flex min-w-0 flex-col gap-9 lg:border-r lg:border-rule lg:py-8 lg:pr-12">
          <SessionInfo showTitle={showTitle} sessions={sessions} dev={dev} />

          <section aria-labelledby="why-title" className="flex flex-col gap-3">
            <h2 id="why-title" className="text-[0.9375rem] font-bold text-char md:text-base">
              본인인증이 필요한 이유
            </h2>
            <ul className="flex flex-col gap-1.5 text-sm leading-relaxed text-char-2 md:text-[0.9375rem]">
              <li>· 좌석을 고르기 전에 휴대전화 본인인증이 필요합니다. 회원가입 없이 비회원으로 예매할 수 있습니다.</li>
              <li>· 한 회차에 1인 최대 4석 기준은 본인인증 정보로 적용됩니다.</li>
            </ul>
          </section>

          <section aria-labelledby="steps-title" className="flex flex-col gap-3">
            <h2 id="steps-title" className="text-[0.9375rem] font-bold text-char md:text-base">
              진행 순서
            </h2>
            <ol className="grid border-t border-rule sm:grid-cols-4 sm:border-t-0">
              {STEPS.map((s, i) => (
                <li
                  key={s}
                  className="flex items-baseline gap-3 border-b border-rule py-2.5 text-sm text-char-2 sm:flex-col sm:gap-1.5 sm:border-b-0 sm:border-t-2 sm:border-t-rule sm:py-0 sm:pr-4 sm:pt-3 first:sm:border-t-char"
                >
                  <span className="text-xs font-semibold tabular-nums text-char-3">{String(i + 1).padStart(2, "0")}</span>
                  <span className={i === 0 ? "font-semibold text-char" : ""}>{s}</span>
                </li>
              ))}
            </ol>
          </section>

          <section aria-labelledby="notes-title" className="flex flex-col gap-3">
            <h2 id="notes-title" className="text-[0.9375rem] font-bold text-char md:text-base">
              유의사항
            </h2>
            <ul className="flex flex-col gap-1.5 text-sm leading-relaxed text-char-2 md:text-[0.9375rem]">
              {NOTES.map((n, i) => (
                <li key={n} className={i < 2 ? "font-medium text-char" : ""}>
                  · {n}
                </li>
              ))}
            </ul>
          </section>

          {dev && (
            <details className="group border-y border-dashed border-char-3/40 py-3 text-sm" data-dev-panel>
              <summary className="cursor-pointer list-none text-[0.8125rem] font-semibold text-char-2">
                <span className="mr-1 inline-block transition-transform group-open:rotate-90">›</span> [DEV] 상태 미리보기 — 실제 인증이 아닙니다
              </summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-xs text-char-3">
                  인증 시작 응답
                  <select
                    value={startResult}
                    onChange={(e) => {
                      setStartResult(e.target.value as PreviewStartResult);
                      setView("idle");
                    }}
                    className="rounded-[0.25rem] border border-rule bg-paper px-2 py-2 text-sm text-char"
                  >
                    {PREVIEW_START_RESULTS.map((r) => (
                      <option key={r} value={r}>
                        {r === "ok" ? "정상" : r === "provider-unavailable" ? "인증사 장애" : "요청 과다"}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-char-3">
                  인증 결과(복귀 후)
                  <select
                    value={callbackResult}
                    onChange={(e) => setCallbackResult(e.target.value as PreviewCallbackResult)}
                    className="rounded-[0.25rem] border border-rule bg-paper px-2 py-2 text-sm text-char"
                  >
                    {PREVIEW_CALLBACK_RESULTS.map((r) => (
                      <option key={r} value={r}>
                        {CALLBACK_LABEL[r]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </details>
          )}
        </div>

        {/* 인증 시작 — 데스크톱 */}
        <aside aria-label="본인인증 시작" className="hidden lg:flex lg:flex-col lg:gap-5 lg:py-8 lg:pl-10">
          <h2 className="text-base font-bold text-char">본인인증</h2>
          <p className="text-[0.9375rem] font-semibold text-char">
            {session ? fullFmt.format(new Date(session.startsAt)) : <span className="font-normal text-char-3">선택한 회차 없음</span>}
          </p>
          {error && (
            <p role="alert" className="border-l-2 border-char pl-3 text-sm text-char">
              {error}
            </p>
          )}
          {button}
          <p className="text-[0.8125rem] leading-relaxed text-char-3">{helper}</p>
        </aside>
      </div>

      {/* 인증 시작 — 모바일·태블릿 하단 고정 */}
      <aside
        aria-label="본인인증 시작"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-rule bg-paper/95 pb-[env(safe-area-inset-bottom,0px)] backdrop-blur lg:hidden"
      >
        <div className="mx-auto flex max-w-[77.5rem] flex-col gap-2 px-5 py-3 sm:px-8">
          {error && (
            <p role="alert" className="text-[0.8125rem] text-char">
              {error}
            </p>
          )}
          {button}
          {!hasSession || mode === "not-ready" ? <p className="text-xs text-char-3">{helper}</p> : null}
        </div>
      </aside>
    </div>
  );
}
