import type { Metadata } from "next";
import { BUSINESS_INFO, PENDING } from "@/components/site/business-info";

export const metadata: Metadata = { title: "사업자 정보 · NAZIR" };

/** Business details for the public site (card-company review, E-008). Values are pending until supplied. */
export default function Page() {
  const missing = BUSINESS_INFO.filter((f) => f.value === null).length;
  return (
    <article className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">사업자 정보</h1>
      {missing > 0 && (
        <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900" role="note">
          {PENDING}: {missing}개 항목이 아직 제공되지 않았습니다. 실제 정보로 채워지기 전에는 실제 판매를 시작하지 않습니다.
        </div>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
        {BUSINESS_INFO.map((f) => (
          <div key={f.label} className="contents">
            <dt className="text-neutral-600">{f.label}</dt>
            <dd data-pending={f.value === null || undefined}>{f.value ?? PENDING}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}
