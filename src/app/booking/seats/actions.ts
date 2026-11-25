"use server";

import { refresh } from "next/cache";
import { devPreviewEnabled } from "@/server/dev/dev-preview";
import { findDevSession } from "@/server/seats/get-seat-map";
import { HOLD_SIMULATIONS, type HoldSeatsResult, type HoldSimulation } from "@/server/seats/seat-types";

/**
 * [DEV] 좌석 점유 시뮬레이션 서버 액션.
 * 실제 구현에서는 POST /orders(BOOKING 세션, CSRF, Idempotency-Key)가 이 자리를 대신한다.
 * 운영 환경에서는 항상 거부한다. 성공·실패 판단은 서버(이 함수)가 하며 클라이언트는 결과만 표시한다.
 */
export async function holdSeatsAction(sessionId: unknown, sessionSeatIds: unknown, simulation: unknown): Promise<HoldSeatsResult> {
  if (!devPreviewEnabled()) return { ok: false, code: "NOT_AVAILABLE" };
  if (typeof sessionId !== "string" || !Array.isArray(sessionSeatIds) || !sessionSeatIds.every((s) => typeof s === "string")) {
    return { ok: false, code: "INVALID_REQUEST" };
  }
  const sim: HoldSimulation = HOLD_SIMULATIONS.includes(simulation as HoldSimulation) ? (simulation as HoldSimulation) : "auto";
  if (!(await findDevSession(sessionId))) return { ok: false, code: "INVALID_REQUEST" };

  const { devHoldSeats } = await import("@/server/dev/dev-seat-fixture");
  const result = devHoldSeats(sessionId, sessionSeatIds as string[], sim, Date.now());
  // 실패하면 최신 좌석 상태를 다시 내려보낸다.
  if (!result.ok) refresh();
  return result;
}
