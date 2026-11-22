/** 본인인증 목적(API §4.2 purpose). 서버·클라이언트 공용 상수. */
export const IDENTITY_PURPOSES = ["BOOKING", "LOOKUP"] as const;
export type IdentityPurpose = (typeof IDENTITY_PURPOSES)[number];

export function isIdentityPurpose(v: unknown): v is IdentityPurpose {
  return typeof v === "string" && (IDENTITY_PURPOSES as readonly string[]).includes(v);
}
