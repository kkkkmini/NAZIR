import "server-only";
import { connection } from "next/server";
import { devPreviewEnabled } from "@/server/dev/dev-preview";
import type { OrderListResult } from "./order-list-types";

/**
 * A4-2 내 예매 목록 조회.
 * - 운영: 인증 세션 조회(GET /identity-session)와 주문 목록(GET /orders) API가 없으므로 "not-ready".
 *   URL 값(preview)과 관계없이 샘플을 돌려주지 않는다.
 * - local/test: preview가 "list"/"empty"일 때만 [DEV] 고정 샘플. 샘플 모듈은 이때만 동적으로 불러온다.
 */
export async function getOrderList(preview: string | null): Promise<OrderListResult> {
  await connection();
  if (!devPreviewEnabled()) return { kind: "not-ready" };
  if (preview !== "list" && preview !== "empty") return { kind: "not-ready" };
  const { devOrderListSample } = await import("@/server/dev/dev-order-list-fixture");
  return { kind: "dev-sample", ...devOrderListSample(Date.now(), preview) };
}
