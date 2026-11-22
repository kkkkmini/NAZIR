import type { Metadata } from "next";
import { Suspense } from "react";
import { BookingStepHeader } from "@/components/booking/booking-step-header";
import { IdentityComplete } from "@/components/identity/identity-complete";
import { isPreviewCallbackResult, PREVIEW_VID } from "@/components/identity/preview-results";
import { DevNote } from "@/components/site/dev-note";
import { nazir } from "@/content/nazir";
import { getBookingSessions } from "@/server/booking/get-booking-sessions";
import { getIdentityStartMode } from "@/server/identity/identity-start-mode";

export const metadata: Metadata = { title: "본인인증 확인 | 뮤지컬 〈나지르〉 | NAZIR" };

/**
 * A7 인증 복귀 처리 (API §4.2: 콜백 처리 후 303 /identity/complete?vid={id}) — A안 화이트 미니멀.
 * 결과는 서버의 claim 응답으로만 정한다. URL의 값만으로 성공을 표시하지 않는다.
 * [DEV] 미리보기는 local/test에서 vid=dev-preview일 때만 허용한다.
 */
export default function IdentityCompletePage(props: PageProps<"/identity/complete">) {
  return (
    <div className="theme-a flex flex-1 flex-col">
      <BookingStepHeader current={2} showTitle={nazir.title} tone="light" />
      <main className="flex-1">
        <div className="mx-auto flex w-full max-w-[45rem] flex-col gap-5 px-5 py-6 sm:px-8 md:gap-9 md:py-12">
          <h1 className="text-[1.375rem] font-bold tracking-[-0.03em] text-char md:text-[1.75rem]">본인인증 확인</h1>
          <Suspense fallback={<div className="h-48 animate-pulse bg-wash motion-reduce:animate-none" />}>
            <CompleteLoader searchParams={props.searchParams} />
          </Suspense>
        </div>
      </main>
    </div>
  );
}

async function CompleteLoader({ searchParams }: { searchParams: PageProps<"/identity/complete">["searchParams"] }) {
  const [params, mode] = await Promise.all([searchParams, getIdentityStartMode()]);
  const vid = typeof params.vid === "string" ? params.vid : null;
  const result = params.result;

  if (mode === "dev-preview" && vid === PREVIEW_VID && isPreviewCallbackResult(result)) {
    const sessions = await getBookingSessions();
    return (
      <div className="flex flex-col gap-6 md:gap-9">
        <DevNote>본인인증 결과 미리보기입니다. 실제 본인인증이 아니며 예매 인증 세션은 발급되지 않습니다.</DevNote>
        <IdentityComplete kind="preview" result={result} showTitle={nazir.title} sessions={sessions.kind === "dev-fixture" ? sessions.sessions : null} />
      </div>
    );
  }
  return <IdentityComplete kind="not-ready" showTitle={nazir.title} />;
}
