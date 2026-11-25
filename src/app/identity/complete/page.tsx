import type { Metadata } from "next";

export const metadata: Metadata = { title: "본인인증 확인 | NAZIR", robots: { index: false, follow: false }, referrer: "no-referrer" };

/**
 * Landing page after the identity callback's 303 (API_SPEC §4.2). It does NOT show success or failure from the URL:
 * the result is only known to the server and is read by the claim step (not implemented yet, Step 4 next unit), which
 * also checks that this is the same browser. Until then the page only explains what happens next.
 */
export default function IdentityCompletePage() {
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">본인인증 결과 확인</h1>
      <p className="text-neutral-700">인증 결과를 확인하고 있습니다. 인증을 시작한 같은 브라우저에서만 다음 단계로 진행할 수 있습니다.</p>
      <p className="text-sm text-neutral-500">예매 단계 연결은 준비 중입니다.</p>
    </section>
  );
}
