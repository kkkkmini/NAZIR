import type { Metadata } from "next";
import { PendingPage } from "@/components/site/pending-page";

export const metadata: Metadata = { title: "취소·환불 규정 | NAZIR" };

/** A5-3 취소·환불 규정. 내용 미확정(E-005). 경로는 임시. */
export default function Page() {
  return <PendingPage title="취소·환불 규정" reason="취소·환불 규정은 확정 후 게시합니다." />;
}
