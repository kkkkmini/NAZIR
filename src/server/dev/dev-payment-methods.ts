import "server-only";
import type { PaymentMethodView } from "@/server/orders/order-types";

/**
 * [DEV] 개발용 결제수단 목록. 확정된 1차 결제수단(D-011: 카드, 토스페이, 네이버페이)만 담는다.
 * 실제로는 서버가 활성화한 수단만 GET /payment-methods로 내려준다(D-012). 운영에서는 호출되지 않는다.
 */
export const DEV_PAYMENT_METHODS: PaymentMethodView[] = [
  { id: "CARD", label: "신용·체크카드", methodType: "CARD" },
  { id: "TOSSPAY", label: "토스페이", methodType: "EASY_PAY" },
  { id: "NAVERPAY", label: "네이버페이", methodType: "EASY_PAY" },
];
