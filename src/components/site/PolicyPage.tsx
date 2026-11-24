import { PENDING } from "./business-info";

/**
 * Policy page frame (IA A5). The legal text is NOT written by the development team: until the operator supplies the
 * reviewed text, each page states that it is pending and lists exactly which inputs are needed.
 */
export function PolicyPage({ title, source, needed }: { title: string; source: string; needed: readonly string[] }) {
  return (
    <article className="flex flex-col gap-6" data-policy-pending>
      <h1 className="text-2xl font-semibold">{title}</h1>
      <div className="rounded border border-amber-300 bg-amber-50 p-4 text-amber-900" role="note">
        <p className="font-medium">{PENDING}</p>
        <p className="text-sm">
          {title} 본문은 {source} 확정 후 게시됩니다. 아래 항목이 확정되기 전에는 실제 판매를 시작하지 않습니다.
        </p>
      </div>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">게시에 필요한 내용</h2>
        <ul className="list-disc pl-5 text-neutral-700">
          {needed.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </section>
    </article>
  );
}
