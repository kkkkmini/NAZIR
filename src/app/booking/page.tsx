import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { BookingStepHeader } from "@/components/booking/booking-step-header";
import { SessionPicker } from "@/components/booking/session-picker";
import { DevNote } from "@/components/site/dev-note";
import { nazir } from "@/content/nazir";
import { getBookingSessions } from "@/server/booking/get-booking-sessions";

export const metadata: Metadata = { title: "회차 선택 | 뮤지컬 〈나지르〉 | NAZIR" };

/**
 * A3-1 회차 선택 (docs/design/01_IA.md §4.1, 02_USER_FLOW.md 1.1) — A안 화이트 미니멀.
 * - 조회만 한다. 좌석 점유·주문 생성·본인인증은 이 화면에서 하지 않는다.
 * - 데이터 출처는 src/server/catalog/catalog-source.ts: 운영은 DB(공개 카탈로그), local/test는 기본 [DEV] 가짜 회차
 *   (NAZIR_CATALOG_SOURCE=db이면 테스트 DB). 출처가 없으면 "회차 정보 준비 중".
 */
export default function BookingSessionsPage() {
  return (
    <div className="theme-a flex flex-1 flex-col">
      <BookingStepHeader current={1} showTitle={nazir.title} tone="light" />
      <main className="flex-1">
        <div className="mx-auto flex max-w-[77.5rem] flex-col gap-5 px-5 py-6 sm:px-8 md:gap-9 md:py-12">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-[1.375rem] font-bold tracking-[-0.03em] text-char md:text-[1.75rem]">회차 선택</h1>
            <p className="text-sm text-char-2">관람할 날짜와 시간을 선택해 주세요.</p>
          </div>
          <Suspense fallback={<SessionsSkeleton />}>
            <SessionsLoader />
          </Suspense>
        </div>
      </main>
    </div>
  );
}

async function SessionsLoader() {
  let result;
  try {
    result = await getBookingSessions();
  } catch {
    return (
      <StatePanel title="회차 정보를 불러오지 못했습니다" body="잠시 후 다시 시도해 주세요.">
        <Link href="/booking" className="text-sm font-medium text-char underline underline-offset-4">
          다시 시도
        </Link>
      </StatePanel>
    );
  }

  if (result.kind === "not-connected") {
    return (
      <StatePanel title="회차 정보 준비 중" body="회차와 예매 일정은 확정되는 대로 안내합니다.">
        <Link href="/" className="text-sm font-medium text-char underline underline-offset-4">
          공연 소개로 돌아가기
        </Link>
      </StatePanel>
    );
  }

  if (result.kind === "live") {
    return (
      <div className="flex flex-col gap-6 md:gap-9">
        {result.testData && <DevNote>테스트 DB의 회차 데이터입니다(local/test). 실제 공연 일정이 아닐 수 있으며 운영 데이터와 분리되어 있습니다.</DevNote>}
        <SessionPicker sessions={result.sessions} dev={false} showTitle={`뮤지컬 ${nazir.title}`} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6 md:gap-9">
      <p className="flex gap-2 border-l-2 border-char-3 bg-wash px-3.5 py-2 text-xs md:py-2.5 md:text-[0.8125rem] leading-relaxed text-char-2">
        <span className="shrink-0 font-bold text-char">[DEV]</span>
        개발용 가짜 회차 데이터입니다. 실제 공연 일정이 아니며 운영 환경에서는 표시되지 않습니다.
      </p>
      <SessionPicker sessions={result.sessions} dev showTitle={`뮤지컬 ${nazir.title}`} />
    </div>
  );
}

function StatePanel({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2.5 border-y border-rule py-12 md:py-16">
      <h2 className="text-xl font-bold text-char">{title}</h2>
      <p className="text-[0.9375rem] text-char-2">{body}</p>
      {children}
    </div>
  );
}

function SessionsSkeleton() {
  return (
    <div className="grid gap-8 md:grid-cols-[17.5rem_1fr] md:gap-10" aria-busy="true" aria-label="회차 정보를 불러오는 중">
      <div className="h-72 animate-pulse rounded-[0.25rem] bg-wash motion-reduce:animate-none" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-[3.75rem] animate-pulse rounded-[0.25rem] bg-wash motion-reduce:animate-none" />
        ))}
      </div>
    </div>
  );
}
