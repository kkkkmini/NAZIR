import type { Metadata } from "next";
import { Suspense } from "react";
import { IdentityCompleteScreen } from "@/components/identity/identity-complete";
import { isIdentityPurpose } from "@/components/identity/purpose";
import { isPreviewCallbackResult, PREVIEW_VID } from "@/components/identity/preview-results";
import { SiteHeader } from "@/components/site/site-header";
import { nazir } from "@/content/nazir";
import { getBookingSessions } from "@/server/booking/get-booking-sessions";
import { getIdentityStartMode } from "@/server/identity/identity-start-mode";

export const metadata: Metadata = { title: "본인인증 확인 | 뮤지컬 〈나지르〉 | NAZIR" };

/**
 * A7 인증 복귀 처리 (API §4.2: 콜백 처리 후 303 /identity/complete?vid={id}) — BOOKING·LOOKUP 공통.
 * 결과와 성공 시 목적은 서버의 claim 응답으로만 정한다. URL 값만으로 성공을 표시하지 않는다.
 * [DEV] 미리보기는 local/test에서 vid=dev-preview일 때만 허용한다. 미리보기의 purpose 값은
 * claim 응답을 흉내 낸 것으로, 개발 환경 밖에서는 읽지 않는다(없으면 기존 BOOKING 미리보기로 본다).
 */
export default function IdentityCompletePage(props: PageProps<"/identity/complete">) {
  return (
    <Suspense
      fallback={
        <div className="theme-a flex flex-1 flex-col">
          <SiteHeader tone="light" />
          <div className="mx-auto h-48 w-full max-w-[45rem] animate-pulse bg-wash motion-reduce:animate-none" />
        </div>
      }
    >
      <CompleteLoader searchParams={props.searchParams} />
    </Suspense>
  );
}

async function CompleteLoader({ searchParams }: { searchParams: PageProps<"/identity/complete">["searchParams"] }) {
  const [params, mode] = await Promise.all([searchParams, getIdentityStartMode()]);
  const vid = typeof params.vid === "string" ? params.vid : null;
  const result = params.result;
  const purpose = params.purpose === undefined ? "BOOKING" : params.purpose;

  if (mode === "dev-preview" && vid === PREVIEW_VID && isPreviewCallbackResult(result) && isIdentityPurpose(purpose)) {
    const sessions = await getBookingSessions();
    return (
      <IdentityCompleteScreen
        kind="preview"
        result={result}
        claimPurpose={purpose}
        showTitle={nazir.title}
        sessions={sessions.kind === "not-connected" ? null : sessions.sessions}
      />
    );
  }
  return <IdentityCompleteScreen kind="not-ready" showTitle={nazir.title} />;
}
