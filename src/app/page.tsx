import { Suspense } from "react";
import { HomeContent } from "./_catalog/content";

/** IA A1 (U1). Data loading lives in ./_catalog/content.tsx. */
export default function Page() {
  return (
    <Suspense fallback={<p className="text-neutral-500">공연 정보를 불러오는 중입니다…</p>}>
      <HomeContent />
    </Suspense>
  );
}
