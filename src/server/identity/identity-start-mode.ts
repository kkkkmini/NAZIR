import "server-only";
import { connection } from "next/server";
import { devPreviewEnabled } from "@/server/dev/dev-preview";

/**
 * A3-2에서 본인인증을 시작할 수 있는지 판단한다(요청 시점).
 * - "dev-preview": local/test 전용 화면 상태 미리보기. 실제 인증·세션 발급을 하지 않는다.
 * - "not-ready": 인증 API(POST /identity-verifications 등)와 NICE 연동이 아직 없으므로 시작 불가.
 * 인증 API가 구현되고 NICE 연동이 준비되면 여기서 "live"를 돌려주도록 확장한다.
 */
export type IdentityStartMode = "dev-preview" | "not-ready";

export async function getIdentityStartMode(): Promise<IdentityStartMode> {
  await connection();
  return devPreviewEnabled() ? "dev-preview" : "not-ready";
}
