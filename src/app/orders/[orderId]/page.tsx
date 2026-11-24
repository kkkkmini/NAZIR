import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { OrderDetail } from "@/components/orders/order-detail";
import { DevNote } from "@/components/site/dev-note";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { getOrderDetail } from "@/server/orders/get-order-detail";

export const metadata: Metadata = { title: "예매 상세 | 뮤지컬 〈나지르〉 | NAZIR", robots: { index: false } };

/**
 * A4-3 예매 상세·모바일 확인서 (IA §4.1·4.2, User Flow 1.4) — A안 화이트 미니멀.
 * 주문 접근 권한(인증 세션·주문 접근 세션)과 상세 API가 없으므로 운영은 항상 준비 중이다.
 * local/test에서만 A4-2와 같은 [DEV] 고정 샘플을 보여 준다(서버에서 환경 확인).
 */
export default function OrderDetailPage(props: PageProps<"/orders/[orderId]">) {
  return (
    <div className="theme-a flex flex-1 flex-col">
      <SiteHeader tone="light" />
      <main className="flex-1">
        <div className="mx-auto flex w-full max-w-[45rem] flex-col gap-5 px-5 py-6 sm:px-8 md:gap-8 md:py-12">
          <Suspense fallback={<div className="h-80 animate-pulse bg-wash motion-reduce:animate-none" />}>
            <DetailLoader params={props.params} />
          </Suspense>
        </div>
      </main>
      <SiteFooter tone="light" />
    </div>
  );
}

async function DetailLoader({ params }: { params: PageProps<"/orders/[orderId]">["params"] }) {
  const { orderId } = await params;
  const result = await getOrderDetail(orderId);
  const dev = result.kind === "dev-sample";
  const listHref = dev ? "/orders?preview=list" : "/orders";

  const header = (
    <div className="flex flex-col gap-3">
      <Link href={listHref} className="text-sm text-char-2 hover:text-char" data-action="back-list">
        ‹ 내 예매 목록
      </Link>
      <h1 className="text-[1.375rem] font-bold tracking-[-0.03em] text-char md:text-[1.75rem]">예매 상세</h1>
    </div>
  );

  if (result.kind !== "dev-sample") {
    return (
      <>
        {header}
        <section className="flex flex-col items-start gap-2.5 border-y border-rule py-12 md:py-16" data-detail-unavailable={result.kind}>
          <h2 className="text-xl font-bold text-char">{result.kind === "not-ready" ? "예매 상세를 확인할 수 없습니다" : "예매 정보를 찾을 수 없습니다"}</h2>
          <p className="text-[0.9375rem] text-char-2">
            {result.kind === "not-ready" ? "예매 확인 기능을 준비하고 있습니다. 준비가 끝나면 본인인증 후 이곳에서 예매 상세를 확인할 수 있습니다." : "예매 정보가 없거나 이 인증 정보로 볼 수 없는 예매입니다."}
          </p>
          <Link href="/orders" className="text-sm font-medium text-char underline underline-offset-4">
            예매 확인으로 돌아가기
          </Link>
        </section>
      </>
    );
  }
  return (
    <>
      {header}
      <DevNote>예매 상세 미리보기입니다. 고정 샘플이며 실제 주문·결제가 아닙니다. 주문 상세 API와 인증 세션은 아직 연결되지 않았습니다.</DevNote>
      <OrderDetail order={result} dev listHref={listHref} />
    </>
  );
}
