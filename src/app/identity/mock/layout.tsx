import { SiteShell } from "@/components/site/site-shell";

/** Mock 본인인증 화면(local·test 전용, 백엔드 Step 4)을 공통 셸 안에 표시한다. */
export default function MockIdentityLayout({ children }: LayoutProps<"/identity/mock">) {
  return <SiteShell>{children}</SiteShell>;
}
