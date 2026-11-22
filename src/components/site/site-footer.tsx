import Link from "next/link";
import { businessInfo } from "@/content/nazir";

const policyLinks = [
  { href: "/policies/terms", label: "이용약관" },
  { href: "/policies/privacy", label: "개인정보처리방침" },
  { href: "/policies/refund", label: "취소·환불 규정" },
  { href: "/policies/support", label: "고객 문의 안내" },
];

/**
 * 관객 사이트 공통 푸터 (IA 4.3). 정책 내용·사업자 정보는 미확정(E-005, E-008, U4).
 * tone="light"는 A안(화이트 미니멀), 기본 dark는 아직 다크인 임시 안내 페이지용.
 */
export function SiteFooter({ tone = "dark" }: { tone?: "dark" | "light" }) {
  const pending = businessInfo.filter((b) => !b.value).map((b) => b.label);
  const known = businessInfo.filter((b) => b.value);
  const light = tone === "light";
  return (
    <footer className={light ? "border-t border-rule bg-wash text-char" : "border-t border-line bg-deep text-ink"}>
      <div className="mx-auto flex max-w-[77.5rem] flex-col gap-6 px-5 py-10 sm:px-8 md:flex-row md:justify-between md:py-12">
        <div className="flex flex-col gap-4">
          <p className={"text-sm font-extrabold tracking-[0.3em]" + (light ? " text-char" : "")}>NAZIR</p>
          <nav aria-label="정책 및 안내">
            <ul className={"flex flex-wrap gap-x-5 gap-y-2 text-sm " + (light ? "text-char-2" : "text-ink/85")}>
              {policyLinks.map((l) => (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    className={"underline-offset-4 hover:underline" + (light && l.href === "/policies/privacy" ? " font-semibold text-char" : "")}
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <div className={"flex max-w-md flex-col gap-1.5 text-xs leading-relaxed " + (light ? "text-char-3" : "text-subtle")}>
          {known.map((b) => (
            <p key={b.label}>
              {b.label} {b.value}
            </p>
          ))}
          {pending.length > 0 && <p>사업자 정보({pending.join(" · ")})는 확정 후 게시합니다.</p>}
        </div>
      </div>
    </footer>
  );
}
