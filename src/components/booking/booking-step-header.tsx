import Link from "next/link";

const STEPS = ["회차 선택", "본인인증", "좌석 선택", "결제"] as const;

/**
 * 예매 단계 헤더 (IA 4.3): 현재 단계, 작품명, 예매 나가기. 사이트 메뉴는 두지 않는다.
 * tone="light"는 A안(화이트 미니멀). 아직 다크인 A3-2 이후 화면은 기본 dark 톤을 쓴다.
 */
export function BookingStepHeader({ current, showTitle, tone = "dark" }: { current: number; showTitle: string; tone?: "dark" | "light" }) {
  if (tone === "light") return <LightStepHeader current={current} showTitle={showTitle} />;
  return (
    <header className="border-b border-line bg-night">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 py-4 sm:px-8 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center justify-between gap-6">
          <div className="flex items-center gap-4">
            <span className="text-xs font-bold tracking-[0.32em] text-ink">NAZIR</span>
            <span className="h-4 w-px bg-line" aria-hidden />
            <span className="type-heading text-base text-ink">뮤지컬 〈{showTitle}〉</span>
          </div>
          <Link href="/" className="text-sm text-muted underline-offset-4 hover:text-ink hover:underline md:hidden">
            예매 나가기
          </Link>
        </div>
        <div className="flex items-center gap-8">
          <ol className="flex items-center gap-2 text-xs sm:gap-3 sm:text-sm" aria-label="예매 단계">
            {STEPS.map((s, i) => {
              const n = i + 1;
              const state = n === current ? "current" : n < current ? "done" : "todo";
              return (
                <li key={s} aria-current={state === "current" ? "step" : undefined} className="flex items-center gap-2 sm:gap-3">
                  <span
                    className={
                      "flex items-center gap-1.5 " +
                      (state === "current" ? "font-semibold text-ink" : state === "done" ? "text-muted" : "text-subtle")
                    }
                  >
                    <span
                      className={
                        "grid h-5 w-5 place-items-center rounded-full text-[0.65rem] " +
                        (state === "current" ? "bg-ink text-night" : "border border-line")
                      }
                    >
                      {n}
                    </span>
                    <span className={state === "current" ? "" : "hidden sm:inline"}>{s}</span>
                  </span>
                  {n < STEPS.length && <span className="h-px w-3 bg-line sm:w-5" aria-hidden />}
                </li>
              );
            })}
          </ol>
          <Link href="/" className="hidden text-sm text-muted underline-offset-4 hover:text-ink hover:underline md:inline">
            예매 나가기
          </Link>
        </div>
      </div>
    </header>
  );
}

function LightStepHeader({ current, showTitle }: { current: number; showTitle: string }) {
  return (
    <header className="border-b border-rule bg-paper">
      <div className="mx-auto flex h-14 max-w-[77.5rem] items-center justify-between gap-6 px-5 sm:px-8 md:h-16">
        <div className="flex min-w-0 items-center gap-3.5">
          <Link href="/" className="text-base font-extrabold tracking-[0.3em] text-char md:text-lg" aria-label="NAZIR 홈">
            NAZIR
          </Link>
          <span className="h-3.5 w-px bg-rule" aria-hidden />
          <span className="truncate text-sm font-medium text-char-2 md:text-[0.9375rem]">뮤지컬 {showTitle}</span>
        </div>
        <div className="flex shrink-0 items-center gap-5 md:gap-10">
          {/* 모바일: 현재 단계만 */}
          <p className="text-[0.8125rem] text-char-3 md:hidden" aria-hidden>
            <span className="font-semibold text-char">{STEPS[current - 1]}</span> {current}/{STEPS.length}
          </p>
          <ol className="hidden items-center gap-1 text-sm md:flex" aria-label="예매 단계">
            {STEPS.map((s, i) => {
              const n = i + 1;
              const on = n === current;
              return (
                <li key={s} aria-current={on ? "step" : undefined} className="flex items-center gap-1">
                  <span className={"flex items-baseline gap-1.5 px-1 " + (on ? "font-semibold text-char" : "text-char-3/80")}>
                    <span className="text-xs tabular-nums">{String(n).padStart(2, "0")}</span>
                    {s}
                  </span>
                  {n < STEPS.length && (
                    <svg aria-hidden viewBox="0 0 24 24" className="h-3.5 w-3.5 text-rule" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path d="m9 6 6 6-6 6" />
                    </svg>
                  )}
                </li>
              );
            })}
          </ol>
          <Link href="/" className="text-[0.8125rem] text-char-3 hover:text-char md:text-sm">
            예매 나가기
          </Link>
        </div>
      </div>
    </header>
  );
}
