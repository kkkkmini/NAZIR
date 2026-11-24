import { Suspense } from "react";
import { SeatsContent } from "../../../../_catalog/content";

/**
 * Seat status of one session (read-only preview of IA A3-3). Selecting seats needs identity verification first
 * (D-004, Step 4) and order creation (Step 5), so nothing here is selectable.
 */
export default function Page(props: PageProps<"/shows/[slug]/sessions/[sessionId]">) {
  return (
    <Suspense fallback={<p className="text-neutral-500">좌석 정보를 불러오는 중입니다…</p>}>
      <SeatsContent params={props.params} />
    </Suspense>
  );
}
