"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { IdentityStartMode } from "@/server/identity/identity-start-mode";
import { saveStartedPurpose } from "./identity-purpose";
import {
  CALLBACK_LABEL,
  PREVIEW_CALLBACK_RESULTS,
  PREVIEW_START_RESULTS,
  PREVIEW_VID,
  type PreviewCallbackResult,
  type PreviewStartResult,
} from "./preview-results";

/**
 * A4-1 조회용 본인인증 시작 — A안(화이트 미니멀). A3-2(verify-start)와 같은 틀, 회차 선택 없음.
 * - not-ready: 인증 API·본인확인 서비스 연동 전 → 버튼 비활성 "본인인증 준비 중".
 * - dev-preview: 화면 상태 미리보기. 인증을 시작하지 않고 A7 미리보기로 이동한다.
 *   실제 연동 시 POST /identity-verifications {purpose:"LOOKUP"} 응답의 launch(인증 URL)로 같은 창에서 이동한다.
 * 이 화면은 인증 결과나 조회 권한을 판단하지 않는다.
 */
type ViewState = "idle" | "starting" | "error-provider" | "error-rate";

const STEPS = ["휴대전화 본인확인 서비스 화면으로 이동", "본인 명의 휴대전화로 인증", "이 사이트로 돌아와 인증 결과 확인", "내 예매 목록 확인"];

const NOTES = [
  "본인 명의 휴대전화로 인증해 주세요.",
  "인증을 시작한 브라우저를 닫지 말고 진행해 주세요.",
  "예매할 때 인증한 본인 명의 휴대전화로 인증해야 내 예매가 조회됩니다.",
  "인증을 취소하거나 인증에 실패하면 이 화면으로 돌아와 다시 인증할 수 있습니다.",
];

export function LookupStart({ mode }: { mode: IdentityStartMode }) {
  const router = useRouter();
  const dev = mode === "dev-preview";
  const [view, setView] = useState<ViewState>("idle");
  const [startResult, setStartResult] = useState<PreviewStartResult>("ok");
  const [callbackResult, setCallbackResult] = useState<PreviewCallbackResult>("success");
  const timer = useRef<number | null>(null);

  // 다른 화면에 다녀오면(Activity 상태 보존) 진행 중 상태를 푼다.
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      setView("idle");
    },
    [],
  );

  function start() {
    if (!dev) return;
    setView("starting");
    saveStartedPurpose("LOOKUP");
    // [DEV] 서버 응답 대신 미리보기 선택값으로 상태를 보여준다.
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (startResult === "provider-unavailable") return setView("error-provider");
      if (startResult === "rate-limited") return setView("error-rate");
      router.push(`/identity/complete?vid=${PREVIEW_VID}&result=${callbackResult}&purpose=LOOKUP`);
    }, 700);
  }

  const canStart = dev && view !== "starting";
  const label = mode === "not-ready" ? "본인인증 준비 중" : view === "starting" ? "인증 화면으로 이동 중…" : "휴대전화 본인인증";
  const error =
    view === "error-provider"
      ? "휴대전화 본인확인 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요."
      : view === "error-rate"
        ? "요청이 많습니다. 잠시 후 다시 시도해 주세요."
        : null;
  const helper =
    mode === "not-ready"
      ? "예매 확인 기능을 준비하고 있습니다. 준비가 끝나면 이곳에서 인증 후 내 예매를 조회할 수 있습니다."
      : "인증이 끝나면 내 예매 목록으로 이어집니다.";

  const button = (
    <button
      type="button"
      onClick={start}
      disabled={!canStart}
      aria-busy={view === "starting"}
      data-action="start-lookup"
      className="min-h-12 w-full rounded-[0.25rem] bg-btn px-6 text-[0.9375rem] font-semibold text-white transition-colors hover:bg-btn-hover disabled:cursor-not-allowed disabled:bg-wash disabled:text-char-3 lg:min-h-[3.25rem] lg:text-base"
    >
      {label}
      {dev && view !== "starting" && <span className="ml-2 rounded-sm bg-white/15 px-1.5 py-0.5 text-[0.6rem] font-semibold tracking-wider">DEV</span>}
    </button>
  );

  return (
    <div className="pb-[calc(7rem+env(safe-area-inset-bottom,0px))] lg:pb-0">
      <div className="grid grid-cols-1 gap-9 lg:grid-cols-[minmax(0,1fr)_21rem] lg:gap-0 lg:border-t-2 lg:border-char">
        <div className="flex min-w-0 flex-col gap-9 lg:border-r lg:border-rule lg:py-8 lg:pr-12">
          <section aria-labelledby="how-title" className="flex flex-col gap-3">
            <h2 id="how-title" className="text-[0.9375rem] font-bold text-char md:text-base">
              조회 방법
            </h2>
            <ul className="flex flex-col gap-1.5 text-sm leading-relaxed text-char-2 md:text-[0.9375rem]">
              <li>· 회원가입 없이, 예매할 때 인증한 본인 명의 휴대전화로 본인인증하면 내 예매를 조회할 수 있습니다.</li>
              <li>· 전화번호 입력이나 주문 번호만으로는 조회할 수 없습니다.</li>
              <li>· 예매한 기기가 아니어도 이 화면에서 인증하면 조회할 수 있습니다.</li>
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

          <section aria-labelledby="scope-title" className="flex flex-col gap-3" data-lookup-scope>
            <h2 id="scope-title" className="text-[0.9375rem] font-bold text-char md:text-base">
              조회 전용 인증입니다
            </h2>
            <div className="flex flex-col gap-1.5 border-l-2 border-char bg-wash px-4 py-3 text-sm leading-relaxed text-char-2 md:text-[0.9375rem]">
              <p className="font-medium text-char">이 인증으로는 예매 내역 확인만 할 수 있습니다.</p>
              <p>결제를 기다리는 예매를 결제하거나 취소하려면 예매용 본인인증을 다시 해야 합니다.</p>
              <p>결제가 끝난 예매의 취소·환불은 이 화면에서 할 수 없으며, 문의 안내를 따라 주세요.</p>
            </div>
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
                    data-dev-start-sim
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
                    data-dev-callback-sim
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

        <aside aria-label="조회 본인인증 시작" className="hidden lg:flex lg:flex-col lg:gap-5 lg:py-8 lg:pl-10">
          <h2 className="text-base font-bold text-char">조회 본인인증</h2>
          <p className="text-[0.9375rem] text-char-2">휴대전화 본인확인 서비스</p>
          {error && (
            <p role="alert" className="border-l-2 border-char pl-3 text-sm text-char">
              {error}
            </p>
          )}
          {button}
          <p className="text-[0.8125rem] leading-relaxed text-char-3">{helper}</p>
        </aside>
      </div>

      <aside
        aria-label="조회 본인인증 시작"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-rule bg-paper/95 pb-[env(safe-area-inset-bottom,0px)] backdrop-blur lg:hidden"
      >
        <div className="mx-auto flex max-w-[77.5rem] flex-col gap-2 px-5 py-3 sm:px-8">
          {error && (
            <p role="alert" className="text-[0.8125rem] text-char">
              {error}
            </p>
          )}
          {button}
          {mode === "not-ready" && <p className="text-xs text-char-3">{helper}</p>}
        </div>
      </aside>
    </div>
  );
}
