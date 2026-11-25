import type { Metadata } from "next";
import { PendingPage } from "@/components/site/pending-page";

export const metadata: Metadata = { title: "고객 문의 안내 | NAZIR" };

/** A5-4 고객 문의 안내. 문의 채널 미결정(U4). 경로는 임시. */
export default function Page() {
  return <PendingPage title="고객 문의 안내" reason="고객 문의 방법은 확정 후 안내합니다." />;
}
