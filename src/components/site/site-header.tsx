import Link from "next/link";
import { TicketIcon } from "./icons";

/**
 * 관객 사이트 공통 헤더 (IA 4.3): 로고 → `/`, 예매 확인 → A4 `/orders`.
 * tone="light"는 A안(화이트 미니멀). 아직 다크 화면(임시 안내 페이지)에서는 기본 dark 톤을 쓴다.
 */
export function SiteHeader({ overlay = false, tone = "dark" }: { overlay?: boolean; tone?: "dark" | "light" }) {
  if (tone === "light") {
    return (
      <header className="border-b border-rule bg-paper">
        <div className="mx-auto flex h-14 max-w-[77.5rem] items-center justify-between px-5 sm:px-8 md:h-16">
          <Link href="/" className="text-base font-extrabold tracking-[0.3em] text-char md:text-lg" aria-label="NAZIR 홈">
            NAZIR
          </Link>
          <Link href="/orders" className="flex items-center gap-1.5 text-sm font-medium text-char-2 transition-colors hover:text-char">
            <TicketIcon className="h-5 w-5" />
            예매 확인
          </Link>
        </div>
      </header>
    );
  }
  return (
    <header className={overlay ? "absolute inset-x-0 top-0 z-20" : "border-b border-line bg-night"}>
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
        <Link href="/" className="text-sm font-bold tracking-[0.32em] text-ink" aria-label="NAZIR 홈">
          NAZIR
        </Link>
        <Link
          href="/orders"
          className="rounded-full border border-white/20 px-4 py-2 text-sm font-medium text-ink/90 transition-colors hover:border-white/60"
        >
          예매 확인
        </Link>
      </div>
    </header>
  );
}
