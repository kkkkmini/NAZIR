"use client";

import { useSyncExternalStore } from "react";

/**
 * 본인인증을 시작한 목적(BOOKING/LOOKUP)을 같은 탭의 sessionStorage에 남긴다.
 * - 용도: A7에서 인증이 실패했을 때 어느 화면(A3-2 / A4-1)으로 되돌려 보낼지 정하는 것뿐이다.
 * - 이 값으로 인증 성공·세션 목적·접근 권한을 판단하지 않는다. 성공 시 목적은 서버 claim 응답의 purpose로만 정한다.
 * - 다른 기기·브라우저로 복귀하거나 값이 지워지면 null → A7은 중립 안내를 보인다.
 */
import { type IdentityPurpose, isIdentityPurpose } from "./purpose";

export type { IdentityPurpose };

const KEY = "nazir.identity.startedPurpose";

function read(): IdentityPurpose | null {
  try {
    const v = window.sessionStorage.getItem(KEY);
    return isIdentityPurpose(v) ? v : null;
  } catch {
    return null;
  }
}

export function saveStartedPurpose(purpose: IdentityPurpose) {
  try {
    window.sessionStorage.setItem(KEY, purpose);
  } catch {}
}

const subscribe = () => () => {};

/** 서버 렌더 중에는 undefined(아직 모름), 브라우저에서는 저장된 목적 또는 null. */
export function useStartedPurpose(): IdentityPurpose | null | undefined {
  return useSyncExternalStore(subscribe, read, () => undefined);
}
