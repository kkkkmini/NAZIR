import type { Metadata } from "next";
import { PolicyPage } from "@/components/site/PolicyPage";

export const metadata: Metadata = { title: "이용약관 · NAZIR" };

export default function Page() {
  return (
    <PolicyPage
      title="이용약관"
      source="사업자의 법률 검토"
      needed={[
        "약관 전문(서비스 내용, 이용 계약, 예매·결제, 취소·환불 연결, 책임과 면책, 분쟁 해결, 시행일)",
        "사업자 정보(사업자 정보 페이지와 동일)",
        "약관 시행일과 변경 고지 방법",
      ]}
    />
  );
}
