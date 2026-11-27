import Link from "next/link";
import { PageTitle, SiteShell } from "./site-shell";

/**
 * 아직 내용이 확정되지 않은 안내 화면의 최소 임시 페이지(공통 셸, A안 화이트).
 * 완성된 화면처럼 보이지 않도록, 준비 중이라는 사실과 이유만 보여준다.
 */
export function PendingPage({ title, reason }: { title: string; reason: string }) {
  return (
    <SiteShell>
      <section className="flex flex-col items-start gap-5 border-t-2 border-char pt-8" data-pending-page>
        <PageTitle kicker="준비 중" title={title} />
        <p className="text-[0.9375rem] leading-relaxed text-char-2">{reason}</p>
        <Link href="/" className="text-sm font-medium text-char underline underline-offset-4">
          공연 소개로 돌아가기
        </Link>
      </section>
    </SiteShell>
  );
}
