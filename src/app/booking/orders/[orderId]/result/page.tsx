import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { BookingStepHeader } from "@/components/booking/booking-step-header";
import { OrderResult } from "@/components/order/order-result";
import { DevNote } from "@/components/site/dev-note";
import { nazir } from "@/content/nazir";
import { getOrderView } from "@/server/seats/get-seat-map";

export const metadata: Metadata = { title: "결제 결과 | 뮤지컬 〈나지르〉 | NAZIR" };

/**
 * A3-5 결제 결과 (IA §4.1·4.2, User Flow 0.2·AF-10~AF-13b, API §4.7·4.8).
 * 결제창 복귀 후 서버가 처리한 주문 상태를 조회해 표시만 한다. 결제 성공 여부를 화면이 판단하지 않는다.
 * - 운영: 결제 연동·주문 접근 자격(쿠키) 검증이 준비되지 않았으므로 결과를 보여 주지 않는다.
 * - local/test: [DEV] 개발용 주문 상태.
 */
export default function PaymentResultPage(props: PageProps<"/booking/orders/[orderId]/result">) {
  return (
    <div className="theme-a flex flex-1 flex-col">
      <BookingStepHeader current={4} showTitle={nazir.title} tone="light" />
      <main className="flex-1">
        <div className="mx-auto flex w-full max-w-[45rem] flex-col gap-5 px-5 py-6 pb-12 sm:px-8 md:gap-9 md:py-12">
          <h1 className="text-[1.375rem] font-bold tracking-[-0.03em] text-char md:text-[1.75rem]">결제 결과</h1>
          <Suspense fallback={<div className="h-80 animate-pulse bg-wash motion-reduce:animate-none" />}>
            <ResultLoader params={props.params} />
          </Suspense>
        </div>
      </main>
    </div>
  );
}

async function ResultLoader({ params }: { params: PageProps<"/booking/orders/[orderId]/result">["params"] }) {
  const { orderId } = await params;
  const result = await getOrderView(orderId);

  if (result.kind !== "dev-order") {
    return (
      <section className="flex flex-col items-start gap-2.5 border-y border-rule py-12 md:py-16">
        <h2 className="text-xl font-bold text-char">{result.kind === "not-ready" ? "결제 결과를 확인할 수 없습니다" : "주문 정보를 찾을 수 없습니다"}</h2>
        <p className="text-[0.9375rem] text-char-2">
          {result.kind === "not-ready" ? "결제 기능을 준비하고 있습니다. 준비가 끝나면 이곳에서 결제 결과를 확인할 수 있습니다." : "주문 정보가 없거나 이미 정리되었습니다."}
        </p>
        <Link href="/booking" className="text-sm font-medium text-char underline underline-offset-4">
          회차 선택으로 돌아가기
        </Link>
      </section>
    );
  }
  return (
    <div className="flex flex-col gap-6 md:gap-9">
      <DevNote>결제 결과 시뮬레이션입니다. 실제 결제·예매가 아니며 결제 금액이 청구되지 않습니다. 좌석·가격은 임시 값입니다.</DevNote>
      <OrderResult key={result.orderId} order={result} showTitle={`뮤지컬 ${nazir.title}`} dev />
    </div>
  );
}
