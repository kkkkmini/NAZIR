import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { BookingStepHeader } from "@/components/booking/booking-step-header";
import { SeatPicker } from "@/components/seats/seat-picker";
import { SessionRedirect } from "@/components/seats/session-redirect";
import { DevNote } from "@/components/site/dev-note";
import { nazir } from "@/content/nazir";
import { getSeatMap } from "@/server/seats/get-seat-map";

export const metadata: Metadata = { title: "좌석 선택 | 뮤지컬 〈나지르〉 | NAZIR" };

/**
 * A3-3 좌석 선택 (IA §4.1, User Flow 1.1 4~5단계) — A안 화이트 미니멀.
 * - 좌석 상태·가격·구매 가능 수는 서버 값만 표시한다. 선택은 "확보 전"이다(7분 타이머는 A3-4).
 * - 이 화면에 도착했다는 사실은 본인인증 완료를 뜻하지 않는다. 실제로는 서버가 BOOKING 세션을 검증하고,
 *   없으면 A3-2로 보낸다(세션 조회 API 미구현).
 */
export default function SeatsPage(props: PageProps<"/booking/seats">) {
  return (
    <div className="theme-a flex flex-1 flex-col">
      <BookingStepHeader current={3} showTitle={nazir.title} tone="light" />
      <main className="flex-1">
        <div className="mx-auto flex max-w-[77.5rem] flex-col gap-5 px-5 py-6 sm:px-8 md:gap-9 md:py-12">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-[1.375rem] font-bold tracking-[-0.03em] text-char md:text-[1.75rem]">좌석 선택</h1>
            <p className="text-sm text-char-2">원하는 좌석을 선택한 뒤 좌석 확보를 눌러 주세요.</p>
          </div>
          <Suspense fallback={<div className="h-96 animate-pulse bg-wash motion-reduce:animate-none" />}>
            <SeatsLoader searchParams={props.searchParams} />
          </Suspense>
        </div>
      </main>
    </div>
  );
}

async function SeatsLoader({ searchParams }: { searchParams: PageProps<"/booking/seats">["searchParams"] }) {
  const { session } = await searchParams;
  const sessionId = typeof session === "string" ? session : undefined;
  const map = await getSeatMap(sessionId);

  if (map.kind === "not-ready") {
    return (
      <Panel title="좌석 선택을 준비하고 있습니다" body="본인인증과 좌석 정보가 연결되면 이곳에서 좌석을 선택할 수 있습니다.">
        <Link href="/" className="text-sm font-medium text-char underline underline-offset-4">
          공연 정보로 돌아가기
        </Link>
      </Panel>
    );
  }
  if (map.kind === "invalid-session") {
    if (!sessionId) return <SessionRedirect />;
    return (
      <Panel title="이 회차는 지금 좌석을 선택할 수 없습니다" body="판매 상태가 바뀌었을 수 있습니다. 회차를 다시 선택해 주세요.">
        <Link href="/booking" className="text-sm font-medium text-char underline underline-offset-4">
          회차 다시 선택
        </Link>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-6 md:gap-9">
      <DevNote>개발용 좌석 배치·가격·상태입니다. 이 화면에 도착했다고 본인인증이 완료된 것은 아니며, 좌석 확보도 시뮬레이션입니다.</DevNote>
      <SeatPicker
        key={map.sessionId}
        sessionId={map.sessionId}
        sessionStartsAt={map.sessionStartsAt}
        showTitle={`뮤지컬 ${nazir.title}`}
        seats={map.seats}
        quota={map.quota}
        dev
      />
    </div>
  );
}

function Panel({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <section className="flex flex-col items-start gap-2.5 border-y border-rule py-12 md:py-16">
      <h2 className="text-xl font-bold text-char">{title}</h2>
      <p className="text-[0.9375rem] text-char-2">{body}</p>
      {children}
    </section>
  );
}
