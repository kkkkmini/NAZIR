import type { Metadata } from "next";
import { Suspense } from "react";
import { LookupStart } from "@/components/identity/lookup-start";
import { DevNote } from "@/components/site/dev-note";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { getIdentityStartMode } from "@/server/identity/identity-start-mode";

export const metadata: Metadata = { title: "예매 확인 | 뮤지컬 〈나지르〉 | NAZIR" };

/**
 * A4 예매 확인 입구 (IA §4.1, User Flow 1.4) — A안 화이트 미니멀.
 * 유효한 조회·예매 인증 세션이 있으면 A4-2 목록을, 없으면 A4-1 조회 본인인증을 보여 주는 자리다.
 * 세션 조회 API(GET /identity-session)가 아직 없으므로 항상 A4-1을 보여 준다.
 * 인증 성공이나 세션 존재를 화면에서 가정하지 않는다.
 */
export default function OrdersPage() {
  return (
    <div className="theme-a flex flex-1 flex-col">
      <SiteHeader tone="light" />
      <main className="flex-1">
        <div className="mx-auto flex max-w-[77.5rem] flex-col gap-5 px-5 py-6 sm:px-8 md:gap-9 md:py-12">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-[1.375rem] font-bold tracking-[-0.03em] text-char md:text-[1.75rem]">예매 확인</h1>
            <p className="text-sm text-char-2">휴대전화 본인인증으로 내 예매를 조회합니다.</p>
          </div>
          <Suspense fallback={<div className="h-72 animate-pulse bg-wash motion-reduce:animate-none" />}>
            <OrdersEntry />
          </Suspense>
        </div>
      </main>
      <SiteFooter tone="light" />
    </div>
  );
}

async function OrdersEntry() {
  // 세션 조회 API가 생기면 여기서 서버가 세션을 확인해 A4-2로 분기한다. 지금은 확인할 방법이 없으므로 A4-1.
  const mode = await getIdentityStartMode();
  return (
    <div className="flex flex-col gap-6 md:gap-9">
      {mode === "dev-preview" && <DevNote>개발용 미리보기입니다. 실제 본인인증을 하지 않으며 조회 인증 세션도 발급되지 않습니다.</DevNote>}
      <LookupStart mode={mode} />
    </div>
  );
}
