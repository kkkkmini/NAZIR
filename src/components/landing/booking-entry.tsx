import Link from "next/link";
import { connection } from "next/server";
import { ChevronRightIcon } from "@/components/site/icons";
import { devPreviewEnabled } from "@/server/dev/dev-preview";
import { BookingCta, bookingButtonClass } from "./booking-cta";

/**
 * A1 예매 시작 진입점.
 * - 운영: 서버 판매 상태(R-E)가 없으므로 비활성 CTA 유지.
 * - local/test에서만 [DEV] 링크로 A3-1(/booking)에 연결한다(개발용 미리보기).
 * 요청 시점에 환경을 판단하므로 반드시 <Suspense fallback={<BookingCta …/>}> 안에서 렌더한다.
 */
export async function BookingEntry({ size = "lg" }: { size?: "lg" | "sm" }) {
  await connection();
  if (!devPreviewEnabled()) return <BookingCta size={size} label={size === "sm" ? "예매 준비 중" : undefined} />;
  return (
    <Link href="/booking" data-booking-state="dev-preview" className={bookingButtonClass(size) + " bg-btn text-white hover:bg-btn-hover"}>
      예매하기
      <ChevronRightIcon className={"h-4 w-4"} />
      <span className="ml-1 rounded-sm bg-white/15 px-1.5 py-0.5 text-[0.6rem] font-semibold tracking-wider">DEV</span>
    </Link>
  );
}
