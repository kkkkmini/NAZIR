import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { BookingStepHeader } from "@/components/booking/booking-step-header";
import { OrderCheckout } from "@/components/order/order-checkout";
import { DevNote } from "@/components/site/dev-note";
import { nazir } from "@/content/nazir";
import { matchOrderSeats } from "@/components/seats/seat-layout";
import { getOrderView, getPaymentMethods, getSeatMap } from "@/server/seats/get-seat-map";

export const metadata: Metadata = { title: "주문 확인 | 뮤지컬 〈나지르〉 | NAZIR" };

/**
 * A3-4 주문 확인·결제수단 — A안 화이트 미니멀.
 * 확보 좌석·합계·남은 시간·주문 상태·결제수단은 서버가 준 값만 표시한다. 실제 결제창 연동은 구현하지 않았다.
 */
export default function OrderPage(props: PageProps<"/booking/order">) {
  return (
    <div className="theme-a flex flex-1 flex-col">
      <BookingStepHeader current={4} showTitle={nazir.title} tone="light" />
      <main className="flex-1">
        <div className="mx-auto flex max-w-[77.5rem] flex-col gap-5 px-5 py-6 sm:px-8 md:gap-9 md:py-12">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-[1.375rem] font-bold tracking-[-0.03em] text-char md:text-[1.75rem]">주문 확인·결제</h1>
            <p className="text-sm text-char-2">예매 정보를 확인하고 결제수단을 선택해 주세요.</p>
          </div>
          <Suspense fallback={<div className="h-80 animate-pulse bg-wash motion-reduce:animate-none" />}>
            <OrderLoader searchParams={props.searchParams} />
          </Suspense>
        </div>
      </main>
    </div>
  );
}

async function OrderLoader({ searchParams }: { searchParams: PageProps<"/booking/order">["searchParams"] }) {
  const { hold } = await searchParams;
  const [result, methods] = await Promise.all([getOrderView(typeof hold === "string" ? hold : undefined), getPaymentMethods()]);

  if (result.kind !== "dev-order") {
    return (
      <section className="flex flex-col items-start gap-2.5 border-y border-rule py-12 md:py-16">
        <h2 className="text-xl font-bold text-char">{result.kind === "not-ready" ? "주문 확인을 준비하고 있습니다" : "확보한 좌석 정보를 찾을 수 없습니다"}</h2>
        <p className="text-[0.9375rem] text-char-2">
          {result.kind === "not-ready" ? "좌석 확보와 결제 기능이 연결되면 이곳에서 주문을 확인할 수 있습니다." : "확보 정보가 없거나 이미 정리되었습니다. 회차를 다시 선택해 주세요."}
        </p>
        <Link href="/booking" className="text-sm font-medium text-char underline underline-offset-4">
          회차 선택으로 돌아가기
        </Link>
      </section>
    );
  }
  // 선택 좌석 위치 미리보기: 개발용 배치에서 주문 좌석이 모두 정확히 연결될 때만 쓴다(운영은 not-ready라 표시 안 함).
  const map = await getSeatMap(result.sessionId);
  const layout = matchOrderSeats(map.kind === "dev-fixture" ? map.seats : null, result.items.map((i) => i.sessionSeatId));

  return (
    <div className="flex flex-col gap-6 md:gap-9">
      <DevNote>좌석 확보·결제 시뮬레이션입니다. 실제 주문·결제가 아니며 결제 금액이 청구되지 않습니다. 좌석·가격은 임시 값입니다.</DevNote>
      <OrderCheckout
        key={`${result.orderId}:${result.status}`}
        order={result}
        methods={methods.kind === "dev-fixture" ? methods.methods : null}
        seatLayout={layout}
        showTitle={`뮤지컬 ${nazir.title}`}
        dev
      />
    </div>
  );
}
