import { SiteFooter } from "./site-footer";
import { SiteHeader } from "./site-header";

/**
 * 관객 사이트 공통 셸(A안 화이트): 헤더 + 본문 + 푸터. 예매 단계 화면(단계 헤더 사용)은 쓰지 않는다.
 * 정책·사업자 정보·안내·404·오류 화면이 같은 틀로 보이게 한다.
 */
export function SiteShell({ children, narrow = true }: { children: React.ReactNode; narrow?: boolean }) {
  return (
    <div className="theme-a flex flex-1 flex-col">
      <SiteHeader tone="light" />
      <main className="flex-1">
        <div className={"mx-auto flex w-full flex-col gap-6 px-5 py-10 sm:px-8 md:gap-8 md:py-16 " + (narrow ? "max-w-[45rem]" : "max-w-[77.5rem]")}>{children}</div>
      </main>
      <SiteFooter tone="light" />
    </div>
  );
}

/** 화면 제목 블록(작은 분류 + 제목). */
export function PageTitle({ kicker, title }: { kicker?: string; title: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      {kicker && <p className="text-xs font-semibold tracking-[0.12em] text-char-3">{kicker}</p>}
      <h1 className="text-[1.375rem] font-bold tracking-[-0.03em] text-char md:text-[1.75rem]">{title}</h1>
    </div>
  );
}
