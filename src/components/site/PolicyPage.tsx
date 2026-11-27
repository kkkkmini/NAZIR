import { PENDING } from "./business-info";
import { PageTitle, SiteShell } from "./site-shell";

/**
 * Policy page frame (IA A5). The legal text is NOT written by the development team: until the operator supplies the
 * reviewed text, each page states that it is pending and lists exactly which inputs are needed.
 * 화면은 관객 사이트 공통 셸(A안 화이트)을 쓴다.
 */
export function PolicyPage({ title, source, needed }: { title: string; source: string; needed: readonly string[] }) {
  return (
    <SiteShell>
      <article className="flex flex-col gap-8" data-policy-pending>
        <PageTitle kicker="정책 및 안내" title={title} />
        <div className="flex flex-col gap-1 border-l-2 border-char bg-wash px-4 py-3" role="note">
          <p className="text-[0.9375rem] font-semibold text-char">{PENDING}</p>
          <p className="text-sm leading-relaxed text-char-2">
            {title} 본문은 {source} 확정 후 게시됩니다. 아래 항목이 확정되기 전에는 실제 판매를 시작하지 않습니다.
          </p>
        </div>
        <section className="flex flex-col gap-3 border-t-2 border-char pt-6">
          <h2 className="text-[0.9375rem] font-bold text-char md:text-base">게시에 필요한 내용</h2>
          <ul className="flex flex-col gap-1.5 text-sm leading-relaxed text-char-2 md:text-[0.9375rem]">
            {needed.map((n) => (
              <li key={n}>· {n}</li>
            ))}
          </ul>
        </section>
      </article>
    </SiteShell>
  );
}
