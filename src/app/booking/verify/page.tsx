import type { Metadata } from "next";
import { Suspense } from "react";
import { BookingStepHeader } from "@/components/booking/booking-step-header";
import { VerifyStart } from "@/components/identity/verify-start";
import { DevNote } from "@/components/site/dev-note";
import { nazir } from "@/content/nazir";
import { getBookingSessions } from "@/server/booking/get-booking-sessions";
import { getIdentityStartMode } from "@/server/identity/identity-start-mode";

export const metadata: Metadata = { title: "본인인증 | 뮤지컬 〈나지르〉 | NAZIR" };

/**
 * A3-2 본인인증 시작 (IA §4.1, User Flow 1.1) — A안 화이트 미니멀.
 * 이 화면은 인증을 판단하지 않는다. 인증 시작·결과 확인·세션 발급은 서버 API(미구현)의 몫이다.
 */
export default function VerifyPage() {
  return (
    <div className="theme-a flex flex-1 flex-col">
      <BookingStepHeader current={2} showTitle={nazir.title} tone="light" />
      <main className="flex-1">
        <div className="mx-auto flex max-w-[77.5rem] flex-col gap-5 px-5 py-6 sm:px-8 md:gap-9 md:py-12">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-[1.375rem] font-bold tracking-[-0.03em] text-char md:text-[1.75rem]">본인인증</h1>
            <p className="text-sm text-char-2">좌석을 선택하기 전에 휴대전화 본인인증을 진행합니다.</p>
          </div>
          <Suspense fallback={<div className="h-72 animate-pulse bg-wash motion-reduce:animate-none" />}>
            <VerifyLoader />
          </Suspense>
        </div>
      </main>
    </div>
  );
}

async function VerifyLoader() {
  const [mode, sessions] = await Promise.all([getIdentityStartMode(), getBookingSessions()]);
  return (
    <div className="flex flex-col gap-6 md:gap-9">
      {mode === "dev-preview" && <DevNote>개발용 미리보기입니다. 실제 본인인증을 하지 않으며 예매 인증 세션도 발급되지 않습니다.</DevNote>}
      <VerifyStart mode={mode} showTitle={nazir.title} sessions={sessions.kind === "dev-fixture" ? sessions.sessions : null} />
    </div>
  );
}
