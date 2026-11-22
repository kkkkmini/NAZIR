import type { Metadata } from "next";
import { PendingPage } from "@/components/site/pending-page";

export const metadata: Metadata = { title: "개인정보처리방침 | NAZIR" };

/** A5-2 개인정보처리방침. 내용 미확정(Q-016, E-008). 경로는 임시. */
export default function Page() {
  return <PendingPage title="개인정보처리방침" reason="개인정보처리방침은 확정 후 게시합니다." />;
}
