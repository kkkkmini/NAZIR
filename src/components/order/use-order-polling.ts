"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";
import { RESULT_POLLING } from "./order-status";

/**
 * 결과가 정해지지 않은 동안(active) 서버 상태를 주기적으로 다시 불러온다.
 * 처음 3분은 빠르게, 이후에는 느리게. 화면이 가려지면(다른 화면 이동) 효과 정리로 멈춘다.
 * 화면은 다시 불러온 서버 상태만 표시하며, 시간 경과로 상태를 직접 바꾸지 않는다.
 */
export function useOrderPolling(active: boolean) {
  const router = useRouter();
  const [startedAt] = useState(() => Date.now());
  const [checking, startCheck] = useTransition();

  const check = useCallback(() => startCheck(() => router.refresh()), [router]);

  useEffect(() => {
    if (!active) return;
    let timer: number;
    const schedule = () => {
      const fast = Date.now() - startedAt < RESULT_POLLING.fastWindowMs;
      timer = window.setTimeout(
        () => {
          check();
          schedule();
        },
        fast ? RESULT_POLLING.fastIntervalMs : RESULT_POLLING.slowIntervalMs,
      );
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [active, check, startedAt]);

  return { check, checking };
}
