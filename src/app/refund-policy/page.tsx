import type { Metadata } from "next";
import { PolicyPage } from "@/components/site/PolicyPage";

export const metadata: Metadata = { title: "취소·환불 규정 · NAZIR" };

export default function Page() {
  return (
    <PolicyPage
      title="취소·환불 규정"
      source="취소·환불 정책(DECISIONS E-005)과 고객 문의 채널(U4)"
      needed={[
        "관람일 기준 취소 가능 기한",
        "기한별 취소 수수료(또는 수수료 없음)",
        "환불 방법과 소요 기간(결제수단별)",
        "공연 취소·변경 시 환불 기준",
        "취소·환불 요청 방법과 고객 문의 채널",
      ]}
    />
  );
}
