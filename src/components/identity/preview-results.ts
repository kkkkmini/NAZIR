/**
 * [DEV] 본인인증 화면 상태 미리보기용 결과 목록. 실제 인증 결과가 아니다.
 * A7의 실제 결과는 서버의 claim 응답(API §4.2)으로만 결정된다.
 */
export const PREVIEW_CALLBACK_RESULTS = ["success", "failed", "canceled", "expired", "binding-mismatch", "already-used"] as const;
export type PreviewCallbackResult = (typeof PREVIEW_CALLBACK_RESULTS)[number];

export const PREVIEW_START_RESULTS = ["ok", "provider-unavailable", "rate-limited"] as const;
export type PreviewStartResult = (typeof PREVIEW_START_RESULTS)[number];

export const PREVIEW_VID = "dev-preview";

export function isPreviewCallbackResult(v: unknown): v is PreviewCallbackResult {
  return typeof v === "string" && (PREVIEW_CALLBACK_RESULTS as readonly string[]).includes(v);
}

export const CALLBACK_LABEL: Record<PreviewCallbackResult, string> = {
  success: "성공",
  failed: "실패·검증 불일치",
  canceled: "인증 취소",
  expired: "시간 만료",
  "binding-mismatch": "다른 브라우저",
  "already-used": "이미 사용한 인증",
};
