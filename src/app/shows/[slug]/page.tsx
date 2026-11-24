import { Suspense } from "react";
import { ShowContent } from "../../_catalog/content";

/** IA A1 for a given show (used once there is more than one show; also reachable directly). */
export default function Page(props: PageProps<"/shows/[slug]">) {
  return (
    <Suspense fallback={<p className="text-neutral-500">공연 정보를 불러오는 중입니다…</p>}>
      <ShowContent params={props.params} />
    </Suspense>
  );
}
