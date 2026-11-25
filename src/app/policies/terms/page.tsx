import type { Metadata } from "next";
import { PendingPage } from "@/components/site/pending-page";

export const metadata: Metadata = { title: "이용약관 | NAZIR" };

/** A5-1 이용약관. 내용 미확정(E-008). 경로는 임시이며 개발팀 확정 필요. */
export default function Page() {
  return <PendingPage title="이용약관" reason="이용약관은 확정 후 게시합니다." />;
}
