import "server-only";
import { connection } from "next/server";
import { devPreviewEnabled } from "@/server/dev/dev-preview";
import type { OrderDetailResult } from "./order-list-types";

/**
 * A4-3 예매 상세 조회.
 * - 운영: 주문 상세·확인서 API와 인증 세션 확인이 없으므로 "not-ready". 주문 ID와 관계없이 샘플을 돌려주지 않는다.
 * - local/test: A4-2와 같은 [DEV] 고정 샘플(dev-sample-*)만. 샘플 모듈은 이때만 동적으로 불러온다.
 */
export async function getOrderDetail(orderId: string): Promise<OrderDetailResult> {
  await connection();
  if (!devPreviewEnabled()) return { kind: "not-ready" };
  const { devOrderDetailSample } = await import("@/server/dev/dev-order-list-fixture");
  const d = devOrderDetailSample(Date.now(), orderId);
  return d ? { kind: "dev-sample", ...d } : { kind: "not-found" };
}
