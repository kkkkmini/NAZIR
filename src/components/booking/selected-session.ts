"use client";

import { useSyncExternalStore } from "react";

/**
 * 선택한 회차 ID를 같은 탭의 sessionStorage에 유지한다(A3-1 → A3-2 → 외부 인증 → A7 → A3-3).
 * - 회차 ID만 저장한다. 인증 결과·세션 정보는 저장하지 않는다.
 * - 실제 NICE 연동 시 같은 브라우저·탭으로 복귀해 이 값이 유지되는지는 개발팀 확인 사항이다.
 * - 이 값은 표시·이동용일 뿐이며, 판매 가능 여부와 인증 여부는 항상 서버가 판단한다.
 */
const KEY = "nazir.booking.selectedSessionId";

function read(): string | null {
  try {
    return window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function saveSelectedSessionId(id: string) {
  try {
    window.sessionStorage.setItem(KEY, id);
  } catch {}
}

const subscribe = () => () => {};

/** 서버 렌더 중에는 undefined(아직 모름), 브라우저에서는 저장된 값 또는 null. */
export function useSelectedSessionId(): string | null | undefined {
  return useSyncExternalStore(subscribe, read, () => undefined);
}
