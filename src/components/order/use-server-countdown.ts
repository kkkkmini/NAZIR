"use client";

import { useState, useSyncExternalStore } from "react";

/**
 * 서버 시각 기준 남은 시간(ms).
 * - 서버가 준 만료 시각(expiresAt)과 응답 시점의 서버 현재 시각(serverNow)을 쓴다.
 * - 처음 화면에 붙을 때 브라우저 시계와 서버 시계의 차이(offset)를 한 번 구해 보정한다.
 *   그래서 브라우저 시계가 틀려도 남은 시간은 서버 기준으로 흐른다.
 * - 서버 렌더 중에는 null(표시 보류). 0이 되어도 상태를 바꾸지 않는다 — 상태는 서버가 다시 알려 준다.
 */
export function useServerCountdown(expiresAt: string, serverNow: string): number | null {
  const [offset] = useState(() => (typeof window === "undefined" ? 0 : Date.parse(serverNow) - Date.now()));
  const clientNow = useSyncExternalStore(subscribe, getTick, getServerSnapshot);
  if (clientNow === null) return null;
  const expires = Date.parse(expiresAt);
  // 서버가 응답 시점에 알려 준 남은 시간보다 커지지 않게 한다(틱 반올림 보정).
  return Math.max(0, Math.min(expires - Date.parse(serverNow), expires - (clientNow + offset)));
}

function subscribe(cb: () => void) {
  const t = window.setInterval(cb, 250);
  return () => window.clearInterval(t);
}
/** 250ms 단위로 끊은 브라우저 시각(같은 틱 안에서는 같은 값을 돌려줘야 한다). */
const getTick = () => Math.floor(Date.now() / 250) * 250;
const getServerSnapshot = () => null;

export function formatMmSs(ms: number): string {
  const total = Math.ceil(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
