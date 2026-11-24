/**
 * 본인인증·인증 세션 API 계약 — docs/API_SPEC.md §3.1~3.4, §4.1~4.2(v1.2) 문서 기준 타입.
 * 백엔드 Step 4는 아직 구현 전이다(원격에 Step 4 브랜치 없음, 2026-11-24 확인). 구현되면 이 타입을 실제 응답과 다시 대조한다.
 * 화면(A3-2·A4-1·A7)은 이 타입을 직접 쓰지 않는다. 연결 시 src/server/identity/ 아래 loader·adapter에서만 쓴다.
 */
export type ApiIdentityPurpose = "BOOKING" | "LOOKUP";

/** GET /bootstrap — 바인딩 쿠키 발급(없을 때), CSRF 토큰 반환. 캐시 금지. */
export interface ApiBootstrap {
  csrfToken: string;
}

/** POST /identity-verifications { purpose } (CSRF) */
export interface ApiStartVerificationRequest {
  purpose: ApiIdentityPurpose;
}
/** launch의 내부 형식은 문서에 "인증창을 여는 데 필요한 값(NICE: 인증 URL)"으로만 되어 있다(확인 필요). */
export interface ApiStartVerificationResponse {
  verificationId: string;
  launch: Record<string, unknown>;
}

/** POST /identity-verifications/{id}/claim (CSRF). 성공 시 쿠키가 설정된다. */
export interface ApiClaimResponse {
  purpose: ApiIdentityPurpose;
  expiresAt: string;
  displayName: string;
}

/** GET /identity-session — 문서에는 "현재 세션 정보(purpose, 만료)"만 있고 응답 형식은 없다(확인 필요). */
export interface ApiIdentitySessionDraft {
  purpose: ApiIdentityPurpose;
  expiresAt: string;
}

/** 인증 관련 오류 코드(API §2.1). 화면 문구 매핑은 연결 시 adapter에서 한다. */
export type ApiIdentityErrorCode =
  | "IDENTITY_SESSION_REQUIRED" // 401 세션 없음·만료
  | "CSRF_REJECTED" // 403 Origin/CSRF 검증 실패
  | "BROWSER_BINDING_MISMATCH" // 401
  | "SESSION_PURPOSE_MISMATCH" // 403 LOOKUP 세션으로 예매 시도 등
  | "IDENTITY_VERIFICATION_FAILED" // 422 실패·만료·재사용(취소·만료 구분 코드 없음 — 확인 필요)
  | "IDENTITY_SESSION_TIME_INSUFFICIENT" // 422 주문 생성 시 잔여 10분 미만
  | "RATE_LIMITED" // 429
  | "PROVIDER_UNAVAILABLE"; // 503
