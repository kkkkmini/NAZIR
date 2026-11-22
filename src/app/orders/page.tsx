import type { Metadata } from "next";
import { PendingPage } from "@/components/site/pending-page";

export const metadata: Metadata = { title: "예매 확인 | NAZIR" };

/** A4 예매 확인(조회 본인인증 → 내 예매 목록 → 예매 상세) 화면은 아직 구현되지 않았다. 임시 페이지. */
export default function Page() {
  return <PendingPage title="예매 확인" reason="예매 확인 기능은 준비 중입니다. 휴대전화 본인인증으로 내 예매를 조회하는 화면이 이곳에 연결됩니다." />;
}
