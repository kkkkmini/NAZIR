import Link from "next/link";
import { PageTitle, SiteShell } from "@/components/site/site-shell";

export default function NotFound() {
  return (
    <SiteShell>
      <section className="flex flex-col items-start gap-5 border-t-2 border-char pt-8" data-not-found>
        <PageTitle kicker="404" title="페이지를 찾을 수 없습니다" />
        <p className="text-[0.9375rem] text-char-2">요청한 공연이나 회차가 없거나 공개되지 않았습니다.</p>
        <div className="flex flex-wrap gap-2">
          <Link href="/" className="inline-flex min-h-12 items-center justify-center rounded-[0.25rem] bg-btn px-7 text-[0.9375rem] font-semibold text-white hover:bg-btn-hover">
            처음으로
          </Link>
          <Link href="/orders" className="inline-flex min-h-12 items-center justify-center rounded-[0.25rem] border border-rule px-6 text-[0.9375rem] text-char hover:border-char-3">
            예매 확인
          </Link>
        </div>
      </section>
    </SiteShell>
  );
}
