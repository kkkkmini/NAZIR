import type { Metadata } from "next";
import { BUSINESS_INFO, PENDING } from "@/components/site/business-info";
import { PageTitle, SiteShell } from "@/components/site/site-shell";

export const metadata: Metadata = { title: "사업자 정보 · NAZIR" };

/** Business details for the public site (card-company review, E-008). Values are pending until supplied. */
export default function Page() {
  const missing = BUSINESS_INFO.filter((f) => f.value === null).length;
  return (
    <SiteShell>
      <article className="flex flex-col gap-8">
        <PageTitle kicker="정책 및 안내" title="사업자 정보" />
        {missing > 0 && (
          <p className="border-l-2 border-char bg-wash px-4 py-3 text-sm leading-relaxed text-char-2" role="note">
            <span className="font-semibold text-char">{PENDING}</span>: {missing}개 항목이 아직 제공되지 않았습니다. 실제 정보로 채워지기 전에는 실제 판매를 시작하지 않습니다.
          </p>
        )}
        <dl className="border-t-2 border-char text-[0.9375rem]">
          {BUSINESS_INFO.map((f) => (
            <div key={f.label} className="grid grid-cols-[8rem_1fr] gap-3 border-b border-rule py-3 md:grid-cols-[10rem_1fr]">
              <dt className="text-char-3">{f.label}</dt>
              <dd data-pending={f.value === null || undefined} className={f.value === null ? "text-char-3" : "font-medium text-char"}>
                {f.value ?? PENDING}
              </dd>
            </div>
          ))}
        </dl>
      </article>
    </SiteShell>
  );
}
