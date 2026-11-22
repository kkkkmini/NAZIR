import "server-only";
import { getRuntimeConfig } from "@/server/config/server-config";

/**
 * 개발 환경 전용 미리보기(가짜 회차 데이터, A1 → /booking 연결) 허용 여부.
 * NAZIR_RUNTIME_ENV가 local 또는 test일 때만 true. 값이 없거나 알 수 없으면 production으로
 * 간주되므로(fail-closed) 운영·스테이징에서는 항상 false다.
 * 반드시 요청 시점(connection() 이후)에 호출해 빌드 시점 환경값이 굳지 않게 한다.
 */
export function devPreviewEnabled(): boolean {
  const env = getRuntimeConfig().runtimeEnv;
  return env === "local" || env === "test";
}
