import { SiteShell } from "@/components/site/site-shell";

/**
 * 백엔드 Step 3 공연·회차 화면(읽기 전용)을 관객 사이트 공통 셸 안에 표시한다. 화면 내용은 3단계에서 정리한다.
 * 운영(production)이 아니면 판매 준비 중 안내를 보인다(기존 SiteChrome의 PreLaunchNotice와 같은 조건·문구, D-013).
 */
export default function ShowsLayout({ children }: LayoutProps<"/shows">) {
  return (
    <SiteShell>
      {process.env.NAZIR_RUNTIME_ENV !== "production" && (
        <p className="border-l-2 border-char bg-wash px-4 py-3 text-sm text-char-2" role="note" data-prelaunch-notice>
          판매 준비 중인 사이트입니다. 표시되는 공연·회차·가격은 확정 정보가 아니며, 아직 예매할 수 없습니다.
        </p>
      )}
      {children}
    </SiteShell>
  );
}
