import Link from "next/link";
import { BUSINESS_INFO, PENDING } from "./business-info";

/** IA §4.3 common header: logo → home. "예매 확인" is added with Step 7 (order lookup). */
export function SiteHeader() {
  return (
    <header className="border-b border-neutral-200">
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-4">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          NAZIR
        </Link>
      </div>
    </header>
  );
}

/**
 * Shown outside production: the site is not selling yet (D-013: no real sales until identity verification is live;
 * the current catalog data is the temporary development seed).
 */
export function PreLaunchNotice() {
  if (process.env.NAZIR_RUNTIME_ENV === "production") return null;
  return (
    <div className="border-b border-amber-300 bg-amber-50 text-amber-900" role="note">
      <p className="mx-auto w-full max-w-3xl px-4 py-2 text-sm">
        판매 준비 중인 사이트입니다. 표시되는 공연·회차·가격은 확정 정보가 아니며, 아직 예매할 수 없습니다.
      </p>
    </div>
  );
}

const POLICY_LINKS = [
  { href: "/terms", label: "이용약관" },
  { href: "/privacy", label: "개인정보처리방침" },
  { href: "/refund-policy", label: "취소·환불 규정" },
  { href: "/business-info", label: "사업자 정보" },
];

/** IA §4.3 common footer: policies and business details. */
export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-neutral-200 text-sm text-neutral-600">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8">
        <nav aria-label="정책 및 안내">
          <ul className="flex flex-wrap gap-x-4 gap-y-2">
            {POLICY_LINKS.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="underline-offset-4 hover:underline">
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1" aria-label="사업자 정보">
          {BUSINESS_INFO.map((f) => (
            <div key={f.label} className="contents">
              <dt>{f.label}</dt>
              <dd data-pending={f.value === null || undefined}>{f.value ?? PENDING}</dd>
            </div>
          ))}
        </dl>
      </div>
    </footer>
  );
}
