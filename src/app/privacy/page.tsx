import type { Metadata } from "next";
import { PolicyPage } from "@/components/site/PolicyPage";

export const metadata: Metadata = { title: "개인정보처리방침 · NAZIR" };

export default function Page() {
  return (
    <PolicyPage
      title="개인정보처리방침"
      source="개인정보 처리 범위·보관 기간의 법률 검토(DECISIONS E-006, Q-016)"
      needed={[
        "수집 항목과 목적(본인인증 결과의 이름·휴대폰 번호, 동일인 식별값의 처리 방식, 선택 이메일)",
        "보관 기간과 파기 절차",
        "처리 위탁·제3자 제공(본인인증사, 결제대행사, 호스팅 등)",
        "정보주체의 권리와 행사 방법",
        "개인정보 보호책임자와 연락처",
        "시행일",
      ]}
    />
  );
}
