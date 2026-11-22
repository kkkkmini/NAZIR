import "server-only";
import type { OrderActionResult, OrderStatus, OrderView, PaymentSimulation, PaymentStatus } from "@/server/orders/order-types";
import type { HoldSeatsResult, HoldSimulation, QuotaView, SeatState, SeatView } from "@/server/seats/seat-types";

/**
 * [DEV] 개발 환경 전용 좌석·주문·결제 시뮬레이션.
 * - 배치·가격은 prisma/seed.ts의 [DEV SEED] 임시 값과 같다(E-003, E-004 확정 전, 실제 데이터 아님).
 * - 주문·결제는 이 서버 프로세스 메모리에만 기록한다. DB 기록·실제 PG 결제는 일어나지 않는다.
 * - 상태 전이는 DATABASE v1.2 / User Flow 0.2의 규칙을 흉내 내며, 판단은 모두 이 서버 모듈이 한다.
 * 운영에서는 호출되지 않는다(devPreviewEnabled).
 */

const SECTIONS = [
  { name: "VIP", rows: ["A", "B", "C"], seatsPerRow: 10, price: 150_000 },
  { name: "R", rows: ["D", "E", "F", "G"], seatsPerRow: 12, price: 110_000 },
] as const;

const SEAT_LIMIT = 4; // D-006
export const DEV_HOLD_MS = 7 * 60_000; // D-002, 연장 없음
export const DEV_CONFIRM_PROTECT_MS = 3 * 60_000; // D-003 결제 확인 보호 3분
export const DEV_CONFIRM_RESOLVE_MS = 5_000; // [DEV] "확인 중 → 성공" 시나리오에서 승인 확인까지 걸리는 시간
const BLOCKED = new Set(["R-G-1", "R-G-12"]);

/** 좌석을 붙잡고 있는 주문 상태(점유 유효 PENDING 포함). PAID는 판매 완료로 따로 본다. */
const PROTECTING: OrderStatus[] = ["PENDING", "PAYMENT_CONFIRMING", "PAYMENT_UNKNOWN", "REVIEW_REQUIRED"];
/** 활성 주문(D-008, D-014) — 같은 회차에 1건만 */
const ACTIVE: OrderStatus[] = ["PENDING", "PAYMENT_CONFIRMING", "PAYMENT_UNKNOWN", "REVIEW_REQUIRED"];
/** 구매 한도에 계산되는 주문 */
const COUNTED: OrderStatus[] = [...ACTIVE, "PAID"];

type DevPayment = { id: string; status: PaymentStatus };
type DevOrder = {
  id: string;
  sessionId: string;
  seatIds: string[];
  expiresAt: number;
  status: OrderStatus;
  payments: DevPayment[];
  confirmProtectedUntil: number | null;
  /** "확인 중 → 성공" 시나리오: 이 시각이 지나면 승인 확인된 것으로 본다 */
  resolveAt: number | null;
  message: string | null;
};
type Store = { orders: Map<string, DevOrder>; others: Map<string, number>; seq: number };

const g = globalThis as typeof globalThis & { __nazirDevOrderStore?: Store };
const store: Store = (g.__nazirDevOrderStore ??= { orders: new Map(), others: new Map(), seq: 0 });

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

type BaseSeat = Omit<SeatView, "state"> & { base: SeatState };

function layout(sessionId: string): BaseSeat[] {
  const out: BaseSeat[] = [];
  for (const sec of SECTIONS) {
    for (const row of sec.rows) {
      for (let n = 1; n <= sec.seatsPerRow; n++) {
        const svgSeatId = `${sec.name}-${row}-${n}`;
        const r = hash(`${sessionId}:${svgSeatId}`) % 100;
        out.push({
          sessionSeatId: `${sessionId}:${svgSeatId}`,
          svgSeatId,
          section: sec.name,
          row,
          number: String(n),
          label: `${sec.name} ${row}열 ${n}번`,
          price: sec.price,
          base: BLOCKED.has(svgSeatId) ? "BLOCKED" : r < 10 ? "SOLD" : r < 16 ? "HELD" : "AVAILABLE",
        });
      }
    }
  }
  return out;
}

const nextId = (prefix: string, now: number) => `${prefix}-${++store.seq}-${now.toString(36)}`;

function lastPayment(o: DevOrder): DevPayment | null {
  return o.payments[o.payments.length - 1] ?? null;
}

/**
 * 시간이 지나면서 서버가 하는 상태 전이를 조회 시점에 반영한다(서버 작업 흉내).
 * - PENDING + 점유 만료 → EXPIRED (결제 확인 단계 전이므로 7분 만료 대상, UF 0.1)
 * - PAYMENT_CONFIRMING + 승인 확인 시각 경과 → PAID
 * - PAYMENT_CONFIRMING + 3분 보호 경과(결과 불명확) → PAYMENT_UNKNOWN. 좌석은 계속 보호한다.
 */
function settle(o: DevOrder, now: number) {
  if (o.status === "PENDING" && now >= o.expiresAt) {
    o.status = "EXPIRED";
    const p = lastPayment(o);
    if (p?.status === "READY") p.status = "CANCELED";
  }
  if (o.status === "PAYMENT_CONFIRMING") {
    const p = lastPayment(o);
    if (o.resolveAt !== null && now >= o.resolveAt) {
      o.status = "PAID";
      if (p) p.status = "SUCCEEDED";
    } else if (o.confirmProtectedUntil !== null && now >= o.confirmProtectedUntil) {
      o.status = "PAYMENT_UNKNOWN";
      if (p) p.status = "UNKNOWN";
    }
  }
}

function ordersOf(sessionId: string, now: number): DevOrder[] {
  const list = [...store.orders.values()].filter((o) => o.sessionId === sessionId);
  list.forEach((o) => settle(o, now));
  return list;
}

/** §11.1 우선순위: SOLD → BLOCKED → 보호 중(HELD) → AVAILABLE */
function stateOf(seat: BaseSeat, orders: DevOrder[], now: number): SeatState {
  if (seat.base !== "AVAILABLE") return seat.base;
  const mine = orders.filter((o) => o.seatIds.includes(seat.sessionSeatId));
  if (mine.some((o) => o.status === "PAID")) return "SOLD";
  if (mine.some((o) => PROTECTING.includes(o.status))) return "HELD";
  const other = store.others.get(seat.sessionSeatId);
  if (other && other > now) return "HELD";
  return "AVAILABLE";
}

function quota(orders: DevOrder[]): QuotaView {
  const counted = orders.filter((o) => COUNTED.includes(o.status)).reduce((n, o) => n + o.seatIds.length, 0);
  const active = orders.find((o) => ACTIVE.includes(o.status)) ?? null;
  return { seatLimit: SEAT_LIMIT, countedSeats: counted, remaining: Math.max(0, SEAT_LIMIT - counted), activeOrderId: active?.id ?? null };
}

export function devSeatMap(sessionId: string, now: number): { seats: SeatView[]; quota: QuotaView } {
  const orders = ordersOf(sessionId, now);
  const seats = layout(sessionId).map(({ base, ...s }) => ({ ...s, state: stateOf({ base, ...s }, orders, now) }));
  return { seats, quota: quota(orders) };
}

/**
 * POST /orders의 좌석 점유 + 주문 생성을 흉내 낸다(DATABASE §11.2 순서).
 * 원자성: 선택 좌석 중 하나라도 점유할 수 없으면 아무 좌석도 점유하지 않고 실패 좌석 목록만 돌려준다.
 */
export function devHoldSeats(sessionId: string, ids: string[], sim: HoldSimulation, now: number): HoldSeatsResult {
  const seats = new Map(layout(sessionId).map((s) => [s.sessionSeatId, s]));
  if (ids.length < 1 || ids.length > SEAT_LIMIT || new Set(ids).size !== ids.length || ids.some((id) => !seats.has(id))) {
    return { ok: false, code: "INVALID_REQUEST" };
  }
  if (sim === "identity-time") return { ok: false, code: "IDENTITY_SESSION_TIME_INSUFFICIENT" };

  const orders = ordersOf(sessionId, now);
  const q = quota(orders);
  if (sim === "active-order") return { ok: false, code: "ACTIVE_ORDER_EXISTS", activeOrderId: null };
  if (q.activeOrderId) return { ok: false, code: "ACTIVE_ORDER_EXISTS", activeOrderId: q.activeOrderId };
  if (sim === "limit") return { ok: false, code: "PURCHASE_LIMIT_EXCEEDED", remaining: Math.max(0, ids.length - 1) };
  if (ids.length > q.remaining) return { ok: false, code: "PURCHASE_LIMIT_EXCEEDED", remaining: q.remaining };

  // [DEV] "다른 고객이 먼저 확보" — 마지막 선택 좌석을 다른 사람의 점유로 표시한 뒤 판단한다.
  if (sim === "seat-taken") store.others.set(ids[ids.length - 1], now + DEV_HOLD_MS);

  const unavailable = ids.filter((id) => stateOf(seats.get(id)!, orders, now) !== "AVAILABLE");
  if (unavailable.length > 0) return { ok: false, code: "SEAT_UNAVAILABLE", unavailableSeatIds: unavailable };

  const id = nextId("dev-order", now);
  store.orders.set(id, {
    id,
    sessionId,
    seatIds: [...ids],
    expiresAt: now + DEV_HOLD_MS,
    status: "PENDING",
    payments: [],
    confirmProtectedUntil: null,
    resolveAt: null,
    message: null,
  });
  return { ok: true, holdId: id };
}

/** GET /orders/{id} (+ 최근 결제 시도) 흉내. 세션 시작 시각은 호출하는 쪽이 채운다. */
export function devOrderView(orderId: string, now: number): Omit<OrderView, "sessionStartsAt"> | null {
  const o = store.orders.get(orderId);
  if (!o) return null;
  settle(o, now);
  const seats = new Map(layout(o.sessionId).map((s) => [s.sessionSeatId, s]));
  const items = o.seatIds.map((id) => ({ sessionSeatId: id, label: seats.get(id)!.label, price: seats.get(id)!.price }));
  const p = lastPayment(o);
  return {
    orderId: o.id,
    sessionId: o.sessionId,
    status: o.status,
    items,
    totalAmount: items.reduce((sum, i) => sum + i.price, 0),
    holdExpiresAt: new Date(o.expiresAt).toISOString(),
    serverNow: new Date(now).toISOString(),
    latestPayment: p ? { paymentId: p.id, status: p.status } : null,
    message: o.message,
  };
}

/** POST /orders/{id}/cancel 흉내(D-001 취소 후 재예매). PENDING만 가능, 이미 끝난 주문은 멱등 성공. */
export function devCancelOrder(orderId: string, now: number): OrderActionResult {
  const o = store.orders.get(orderId);
  if (!o) return { ok: false, code: "NOT_FOUND" };
  settle(o, now);
  if (o.status === "CANCELED" || o.status === "EXPIRED") return { ok: true, status: o.status };
  if (o.status === "PAYMENT_CONFIRMING" || o.status === "PAYMENT_UNKNOWN" || o.status === "REVIEW_REQUIRED") {
    return { ok: false, code: "PAYMENT_IN_PROGRESS", status: o.status };
  }
  if (o.status !== "PENDING") return { ok: false, code: "INVALID_STATE_TRANSITION", status: o.status };
  o.status = "CANCELED";
  const p = lastPayment(o);
  if (p?.status === "READY") p.status = "CANCELED";
  return { ok: true, status: o.status };
}

const AMOUNT_MISMATCH_MESSAGE = "결제 승인 금액이 주문 금액과 달라 운영팀이 확인하고 있습니다. 좌석은 보호되고 있습니다.";
const UNFULFILLED_MESSAGE = "결제는 승인되었지만 좌석을 확정할 수 없어 발권되지 않았습니다. 결제 금액은 환불 대상입니다.";

/**
 * [DEV] 결제창 복귀 후 서버 처리(UF 0.2, API §4.7)의 결과를 시나리오로 흉내 낸다.
 * - 결제 시작 조건은 주문 PENDING + 점유 유효. 그 외(확인 중·결과 불명확·종료)는 상태를 바꾸지 않고 거부한다.
 *   같은 요청이 두 번 와도 두 번째는 PAYMENT_IN_PROGRESS 등으로 거부되어 상태가 한 번만 바뀐다.
 */
export function devSimulatePayment(orderId: string, sim: PaymentSimulation, now: number): OrderActionResult {
  const o = store.orders.get(orderId);
  if (!o) return { ok: false, code: "NOT_FOUND" };
  settle(o, now);
  if (o.status === "PAYMENT_CONFIRMING" || o.status === "PAYMENT_UNKNOWN") return { ok: false, code: "PAYMENT_IN_PROGRESS", status: o.status };
  if (o.status === "EXPIRED") return { ok: false, code: "HOLD_EXPIRED", status: o.status };
  if (o.status !== "PENDING") return { ok: false, code: "INVALID_STATE_TRANSITION", status: o.status };

  const payment: DevPayment = { id: nextId("dev-pay", now), status: "READY" };
  o.payments.push(payment);
  o.message = null;

  switch (sim) {
    case "success":
      o.status = "PAID";
      payment.status = "SUCCEEDED";
      break;
    case "fail-pending":
      // 실패 확정, 점유 시간이 남았으므로 결제 전으로 복귀(AF-10). 만료 시각은 바뀌지 않는다.
      payment.status = "FAILED";
      break;
    case "fail-expired":
      // [DEV] 결제창에 머무는 동안 점유가 만료된 상황: 만료 시각을 지금으로 당겨 흉내 낸다.
      // 승인 확인 진입 전 만료이므로 승인 요청을 하지 않고 결제 시도를 취소한다(UF 0.2 순서 1).
      o.expiresAt = now;
      o.status = "EXPIRED";
      payment.status = "CANCELED";
      break;
    case "confirming-success":
      o.status = "PAYMENT_CONFIRMING";
      payment.status = "CONFIRMING";
      o.confirmProtectedUntil = now + DEV_CONFIRM_PROTECT_MS;
      o.resolveAt = now + DEV_CONFIRM_RESOLVE_MS;
      break;
    case "confirming-unknown":
      o.status = "PAYMENT_CONFIRMING";
      payment.status = "CONFIRMING";
      o.confirmProtectedUntil = now + DEV_CONFIRM_PROTECT_MS;
      o.resolveAt = null;
      break;
    case "review-amount":
      // 승인은 됐으나 금액 불일치 → 자동 확정하지 않음, 좌석 보호(DATABASE §11.7)
      o.status = "REVIEW_REQUIRED";
      payment.status = "SUCCEEDED";
      o.message = AMOUNT_MISMATCH_MESSAGE;
      break;
    case "unfulfilled":
      // 운영자 확인 후 발권 불가 확정(REVIEW_REQUIRED → UNFULFILLED): 좌석·구매 한도 반환, 환불 대상
      o.status = "UNFULFILLED";
      payment.status = "SUCCEEDED";
      o.message = UNFULFILLED_MESSAGE;
      break;
  }
  return { ok: true, status: o.status };
}
