import Link from "next/link";
import { SiteFooter } from "./site-footer";
import { SiteHeader } from "./site-header";

/**
 * 아직 구현되지 않은 화면의 최소 임시 페이지.
 * 완성된 화면처럼 보이지 않도록, 준비 중이라는 사실과 이유만 보여준다.
 */
export function PendingPage({ title, reason }: { title: string; reason: string }) {
  return (
    <>
      <SiteHeader />
      <main className="flex flex-1 bg-s1">
        <div className="mx-auto flex w-full max-w-2xl flex-col items-start gap-5 px-5 py-24 sm:px-8">
          <p className="text-xs font-semibold tracking-[0.2em] text-subtle">준비 중</p>
          <h1 className="type-heading text-3xl text-ink sm:text-4xl">{title}</h1>
          <p className="text-base leading-relaxed text-muted">{reason}</p>
          <Link href="/" className="mt-2 text-sm font-medium text-ink underline underline-offset-4">
            공연 소개로 돌아가기
          </Link>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
