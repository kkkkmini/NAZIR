/**
 * Order creation (DATABASE.md §11.2, API_SPEC §4.4, DECISIONS D-002 D-006 D-008 D-015 A-010 A-011 A-029 A-053).
 *
 * ONE booking transaction (READ COMMITTED, runBookingTx). Statement order = lock order:
 *   1. BOOKING session row (UPDATE last_used_at → row lock; binding must match)   → 401 / 403
 *   2. idempotency record (acquire; owner = subject + binding)                     → replay | 409 REUSED / IN_PROGRESS
 *      ── an exact replay stops here: no rate-limit hit, no quota, no seat lock ──
 *   3. session remaining >= 10 minutes (D-015, DB time)                            → 422 IDENTITY_SESSION_TIME_INSUFFICIENT
 *   4. rate limits order.create.session, order.create.subject_session (A-053 ④) → 429 ORDER_CREATION_LIMITED / 503
 *      on the SAME transaction: a request that rolls back also rolls back its hits; a concurrent identical request
 *      waits on step 2 and replays, so it never hits the counters
 *   5. sales condition (§11.11, DB time)                                           → 404 NOT_FOUND / 422 SALES_NOT_OPEN
 *   6. purchase_quotas row ensured + FOR UPDATE (§13.2 step 1)                     → serialises the subject's orders
 *   7. active order (statement after the lock, A-029)                              → 409 ACTIVE_ORDER_EXISTS
 *   8. seat limit: counted + n <= seat_limit                                       → 422 PURCHASE_LIMIT_EXCEEDED
 *   9. session_seats FOR UPDATE in id order (lockSeatsSorted), same show session, AVAILABLE, no live hold
 *                                                                                  → 409 SEAT_UNAVAILABLE
 *  10. order number, order, items (DB prices), ACTIVE holds (hold_expires_at = now + 7 min), counter += n,
 *      status log, order access session, outbox event, idempotency COMPLETED
 * Any failure rolls back ALL of it. No provider call happens here.
 *
 * Expired-but-unprocessed orders/holds are NOT cleaned up here yet (expireOrder is the next unit): an expired ACTIVE
 * hold still makes its seat unavailable, an expired PENDING order still counts as the active order — never bypassed.
 */
import { randomBytes } from "node:crypto";
import type { PolicyName, RateLimitPolicy } from "../rate-limit/policies";
import { RateLimiter, RateLimitUnavailableError } from "../rate-limit/service";
import type { SqlExecutor } from "../db/sql";
import { sha256Hex } from "../lib/crypto/hmac";
import { decryptPii, encryptPii } from "../lib/crypto/pii";
import { POLICY } from "../lib/clock";
import { AppError } from "../lib/errors";
import type { Keyring } from "../lib/secrets";
import { acquireIdempotency, completeIdempotency, idempotencyOwnerHash, requestHash } from "./idempotency";
import { ensureAndLockQuota, lockSeatsSorted } from "./locks";
import { nextOrderNumber } from "./order-number";
import { runBookingTx, type BookingTxDeps, type ConstraintRules } from "./tx";

export const ORDER_SCOPE = "POST /orders";
/** API request bound: the business limit is the session's max_seats_per_identity (<= 4, D-006) → 422 beyond it. */
export const MAX_SEATS_PER_REQUEST = 10;
/** A-053 ⑤: access session lives until min(session end + 24 h, issue + 30 days). */
export const ACCESS_AFTER_SESSION_END_MS = 24 * 60 * 60 * 1000;
export const ACCESS_MAX_MS = 30 * 24 * 60 * 60 * 1000;
export const ACCESS_COOKIE_PREFIX = "__Host-nz_oa_";
const ACTIVE_STATUSES = `('PENDING','PAYMENT_CONFIRMING','PAYMENT_UNKNOWN','REVIEW_REQUIRED')`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface CreateOrderRequest {
  sessionId: string;
  /** Lowercase, unique, sorted (order-free). */
  sessionSeatIds: string[];
}

const invalid = (field?: string) => new AppError("VALIDATION_FAILED", "요청 형식이 올바르지 않습니다.", field ? { field } : {});

/** Strict body parsing + canonicalisation: exactly {sessionId, sessionSeatIds}; ids lowercased, de-duplicated (refused), sorted. */
export function parseCreateOrderBody(body: unknown): CreateOrderRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  const o = body as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== 2 || keys[0] !== "sessionId" || keys[1] !== "sessionSeatIds") throw invalid();
  if (typeof o.sessionId !== "string" || !UUID.test(o.sessionId.toLowerCase())) throw invalid("sessionId");
  const seats = o.sessionSeatIds;
  if (!Array.isArray(seats) || seats.length === 0 || seats.length > MAX_SEATS_PER_REQUEST) throw invalid("sessionSeatIds");
  const ids = seats.map((s) => {
    if (typeof s !== "string" || !UUID.test(s.toLowerCase())) throw invalid("sessionSeatIds");
    return s.toLowerCase();
  });
  if (new Set(ids).size !== ids.length) throw new AppError("VALIDATION_FAILED", "같은 좌석을 두 번 선택할 수 없습니다.", { field: "sessionSeatIds" });
  return { sessionId: o.sessionId.toLowerCase(), sessionSeatIds: ids.sort() };
}

export function createOrderRequestHash(r: CreateOrderRequest): string {
  return requestHash({ sessionId: r.sessionId, sessionSeatIds: r.sessionSeatIds });
}

export interface OrderCreatedBody {
  orderId: string;
  orderNumber: string;
  status: "PENDING";
  holdExpiresAt: string;
  items: { sessionSeatId: string; seatLabel: string; price: number }[];
  totalAmount: number;
}

export interface AccessGrant {
  cookieName: string;
  token: string;
  maxAgeSeconds: number;
}

export interface CreateOrderResult {
  status: 201;
  body: OrderCreatedBody;
  replayed: boolean;
  /** null on a replay whose access session can no longer be renewed (revoked / expired): the order body is still returned. */
  access: AccessGrant | null;
}

export interface CreateOrderDeps {
  tx: BookingTxDeps;
  piiKeys: Keyring;
  rateLimit: { keys: Keyring; policies: Map<PolicyName, RateLimitPolicy> };
  random?: (n: number) => Buffer;
}

export interface CreateOrderInput {
  sessionTokenHash: string;
  bindingHash: string;
  idempotencyKeyHash: string;
  request: CreateOrderRequest;
}

export function accessCookieName(orderId: string): string {
  return `${ACCESS_COOKIE_PREFIX}${orderId.replace(/-/g, "").slice(0, 16)}`;
}

export function seatLabel(section: string, row: string | null, number: string): string {
  return row ? `${section} ${row}열 ${number}번` : `${section} ${number}번`;
}

/** Backstops only: every one of these is checked first under the locks above, so they fire only on a race or a bug. */
const RULES: ConstraintRules = {
  unique: {
    seat_holds_active_seat_uq: () => seatUnavailable([]),
    orders_active_subject_session_uq: () => new AppError("ACTIVE_ORDER_EXISTS", "이미 진행 중인 예매가 있습니다."),
  },
  // 23514 / 23001 are deliberately not mapped here: with the seats and the quota locked and checked, a CHECK or
  // trigger violation (quota CHECK, S2 guard, order number format, immutability) means a bug → generic 500.
};

function seatUnavailable(ids: string[]): AppError {
  return new AppError("SEAT_UNAVAILABLE", "선택한 좌석 중 예약할 수 없는 좌석이 있습니다.", { unavailableSeatIds: ids });
}

interface SessionRow {
  id: string;
  purpose: string;
  identity_subject_id: string;
  identity_verification_id: string;
  remaining_ms: unknown;
}

async function lockBookingSession(tx: SqlExecutor, tokenHash: string, bindingHash: string): Promise<SessionRow> {
  const rows = await tx<SessionRow>(
    `UPDATE "identity_sessions" SET "last_used_at" = now(), "updated_at" = now()
      WHERE "token_hash" = $1 AND "browser_binding_hash" = $2 AND "status" = 'ACTIVE' AND "expires_at" > now()
      RETURNING "id", "purpose", "identity_subject_id", "identity_verification_id",
                floor(extract(epoch FROM ("expires_at" - now())) * 1000)::bigint AS "remaining_ms"`,
    [tokenHash, bindingHash],
  );
  if (rows.length === 1) return rows[0];
  const copied = await tx<{ n: number }>(
    `SELECT count(*)::int AS "n" FROM "identity_sessions" WHERE "token_hash" = $1 AND "status" = 'ACTIVE' AND "expires_at" > now()`,
    [tokenHash],
  );
  if (Number(copied[0]?.n) > 0) throw new AppError("BROWSER_BINDING_MISMATCH", "인증을 시작한 브라우저에서만 진행할 수 있습니다.");
  throw new AppError("IDENTITY_SESSION_REQUIRED", "본인인증이 필요합니다.");
}

async function enforceOrderRateLimits(tx: SqlExecutor, deps: CreateOrderDeps, sessionId: string, subjectId: string, showSessionId: string) {
  const limiter = new RateLimiter({ exec: tx, keys: deps.rateLimit.keys, policies: deps.rateLimit.policies });
  const checks: [PolicyName, [string, string][]][] = [
    ["order.create.session", [["session", sessionId]]],
    ["order.create.subject_session", [["subject", subjectId], ["show_session", showSessionId]]],
  ];
  for (const [policy, parts] of checks) {
    let d;
    try {
      d = await limiter.consume(policy, parts);
    } catch (e) {
      if (e instanceof RateLimitUnavailableError) {
        console.error("[order-create] rate limit store unavailable:", e.causeName);
        throw new AppError("RATE_LIMIT_UNAVAILABLE", "일시적으로 요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.");
      }
      throw e;
    }
    if (!d.allowed) {
      throw new AppError("ORDER_CREATION_LIMITED", "주문 생성 횟수를 초과했습니다. 잠시 후 다시 시도해 주세요.", {
        retryAt: d.retryAt!.toISOString(),
        retryAfterSeconds: d.retryAfterSeconds,
      });
    }
  }
}

/** Replay: renew the access cookie of THIS browser's access session for the order — same row, same expiry, new token. */
async function renewAccess(tx: SqlExecutor, orderId: string, bindingHash: string, random: (n: number) => Buffer): Promise<AccessGrant | null> {
  const token = random(32).toString("base64url");
  const rows = await tx<{ max_age: unknown }>(
    `UPDATE "order_access_sessions" SET "token_hash" = $3, "updated_at" = now()
      WHERE "id" = (SELECT "id" FROM "order_access_sessions"
                     WHERE "order_id" = $1::uuid AND "browser_binding_hash" = $2 AND "status" = 'ACTIVE' AND "expires_at" > now()
                     ORDER BY "created_at" DESC LIMIT 1)
      RETURNING floor(extract(epoch FROM ("expires_at" - now())))::bigint AS "max_age"`,
    [orderId, bindingHash, sha256Hex(token)], // the raw token never leaves the process (not even as a parameter)
  );
  if (rows.length !== 1) return null;
  return { cookieName: accessCookieName(orderId), token, maxAgeSeconds: Math.max(1, Number(rows[0].max_age)) };
}

export async function createOrder(deps: CreateOrderDeps, input: CreateOrderInput): Promise<CreateOrderResult> {
  const random = deps.random ?? randomBytes;
  const req = input.request;
  const n = req.sessionSeatIds.length;
  return runBookingTx(deps.tx, {
    name: "order.create",
    constraints: RULES,
    fn: async (tx) => {
      // 1. session
      const s = await lockBookingSession(tx, input.sessionTokenHash, input.bindingHash);
      if (s.purpose !== "BOOKING") throw new AppError("SESSION_PURPOSE_MISMATCH", "예매용 본인인증이 필요합니다.");

      // 2. idempotency
      const idem = await acquireIdempotency(tx, {
        scope: ORDER_SCOPE,
        ownerKeyHash: idempotencyOwnerHash(s.identity_subject_id, input.bindingHash),
        keyHash: input.idempotencyKeyHash,
        requestHash: createOrderRequestHash(req),
      });
      if (idem.kind === "replay") {
        const access = idem.resourceId ? await renewAccess(tx, idem.resourceId, input.bindingHash, random) : null;
        return { status: 201, body: idem.responseBody as OrderCreatedBody, replayed: true, access };
      }

      // 3. remaining session time (D-015: at least 10 minutes, DB time)
      if (Number(s.remaining_ms) < POLICY.minSessionRemainingForOrderMs) {
        throw new AppError("IDENTITY_SESSION_TIME_INSUFFICIENT", "본인인증 유효 시간이 부족합니다. 다시 인증해 주세요.");
      }

      // 4. rate limits — new requests only
      await enforceOrderRateLimits(tx, deps, s.id, s.identity_subject_id, req.sessionId);

      // 5. sales condition (§11.11)
      const [sale] = await tx<{ show_status: string; sales_status: string; window_open: boolean; not_started: boolean; max_seats: number }>(
        `SELECT sh."status" AS "show_status", ss."sales_status",
                ((sh."sales_opens_at" IS NULL OR sh."sales_opens_at" <= now()) AND (sh."sales_closes_at" IS NULL OR now() < sh."sales_closes_at")) AS "window_open",
                (ss."starts_at" > now()) AS "not_started", ss."max_seats_per_identity" AS "max_seats"
           FROM "show_sessions" ss JOIN "shows" sh ON sh."id" = ss."show_id"
          WHERE ss."id" = $1::uuid`,
        [req.sessionId],
      );
      if (!sale || sale.show_status === "DRAFT") throw new AppError("NOT_FOUND", "공연 회차를 찾을 수 없습니다.");
      if (sale.show_status !== "PUBLISHED" || sale.sales_status !== "ON_SALE" || !sale.window_open || !sale.not_started) {
        throw new AppError("SALES_NOT_OPEN", "지금은 이 회차를 예매할 수 없습니다.");
      }

      // 6. quota lock
      const quota = await ensureAndLockQuota(tx, s.identity_subject_id, req.sessionId);
      if (!quota) throw new AppError("NOT_FOUND", "공연 회차를 찾을 수 없습니다.");

      // 7. active order (after the lock)
      const active = await tx<{ id: string }>(
        `SELECT "id" FROM "orders" WHERE "identity_subject_id" = $1::uuid AND "show_session_id" = $2::uuid AND "status" IN ${ACTIVE_STATUSES} LIMIT 1`,
        [s.identity_subject_id, req.sessionId],
      );
      if (active.length > 0) throw new AppError("ACTIVE_ORDER_EXISTS", "이미 진행 중인 예매가 있습니다.", { activeOrderId: active[0].id });

      // 8. seat limit (snapshot in the quota row, A-029)
      const remaining = Math.max(0, quota.seatLimit - quota.countedSeats);
      if (n > remaining) throw new AppError("PURCHASE_LIMIT_EXCEEDED", "1인 구매 가능 좌석 수를 초과했습니다.", { remaining });

      // 9. seats (sorted locks), same show session, AVAILABLE, no live hold
      const locked = await lockSeatsSorted(tx, req.sessionSeatIds);
      const ok = new Set(locked.filter((x) => x.showSessionId === req.sessionId && x.status === "AVAILABLE").map((x) => x.id));
      const held = await tx<{ session_seat_id: string }>(
        `SELECT "session_seat_id" FROM "seat_holds" WHERE "session_seat_id" = ANY($1::uuid[]) AND "status" IN ('ACTIVE','CONFIRMING')`,
        [req.sessionSeatIds],
      );
      for (const h of held) ok.delete(h.session_seat_id);
      const unavailable = req.sessionSeatIds.filter((id) => !ok.has(id));
      if (unavailable.length > 0) throw seatUnavailable(unavailable);

      // 10. writes
      const seatInfo = await tx<{ id: string; price: unknown; section_name: string; row_label: string | null; seat_number: string }>(
        `SELECT ss."id", ss."price", se."section_name", se."row_label", se."seat_number"
           FROM "session_seats" ss JOIN "seats" se ON se."id" = ss."seat_id" WHERE ss."id" = ANY($1::uuid[])`,
        [req.sessionSeatIds],
      );
      const byId = new Map(seatInfo.map((x) => [x.id, x]));
      const items = req.sessionSeatIds.map((id) => {
        const x = byId.get(id)!;
        return { sessionSeatId: id, seatLabel: seatLabel(x.section_name, x.row_label, x.seat_number), price: BigInt(x.price as string) };
      });
      const total = items.reduce((a, b) => a + b.price, BigInt(0));

      const [v] = await tx<{ verified_name: string | null; verified_phone: string | null }>(
        `SELECT "verified_name", "verified_phone" FROM "identity_verifications" WHERE "id" = $1::uuid`,
        [s.identity_verification_id],
      );
      if (!v?.verified_name || !v.verified_phone) throw new AppError("IDENTITY_VERIFICATION_FAILED", "본인인증을 확인할 수 없습니다. 다시 인증해 주세요.");
      const customerName = encryptPii(deps.piiKeys, "orders.customer_name", decryptPii(deps.piiKeys, "identity_verifications.verified_name", v.verified_name));
      const customerPhone = encryptPii(deps.piiKeys, "orders.customer_phone", decryptPii(deps.piiKeys, "identity_verifications.verified_phone", v.verified_phone));

      const orderNumber = await nextOrderNumber(tx);
      const [order] = await tx<{ id: string; hold_expires_ms: unknown }>(
        `INSERT INTO "orders" ("order_number", "show_session_id", "identity_subject_id", "identity_session_id", "status",
                               "customer_name", "customer_phone", "total_amount", "hold_expires_at")
         VALUES ($1, $2::uuid, $3::uuid, $4::uuid, 'PENDING', $5, $6, $7::bigint, now() + $8::int * interval '1 millisecond')
         RETURNING "id", floor(extract(epoch FROM "hold_expires_at") * 1000)::bigint AS "hold_expires_ms"`,
        [orderNumber, req.sessionId, s.identity_subject_id, s.id, customerName, customerPhone, total.toString(), POLICY.holdDurationMs],
      );
      for (const it of items) {
        const [item] = await tx<{ id: string }>(
          `INSERT INTO "order_items" ("order_id", "show_session_id", "session_seat_id", "price") VALUES ($1::uuid, $2::uuid, $3::uuid, $4::bigint) RETURNING "id"`,
          [order.id, req.sessionId, it.sessionSeatId, it.price.toString()],
        );
        await tx(`INSERT INTO "seat_holds" ("order_id", "order_item_id", "session_seat_id", "status") VALUES ($1::uuid, $2::uuid, $3::uuid, 'ACTIVE')`, [
          order.id,
          item.id,
          it.sessionSeatId,
        ]);
      }
      await tx(
        `UPDATE "purchase_quotas" SET "counted_seats" = "counted_seats" + $3::int, "version" = "version" + 1, "updated_at" = now()
          WHERE "identity_subject_id" = $1::uuid AND "show_session_id" = $2::uuid`,
        [s.identity_subject_id, req.sessionId, n],
      );
      await tx(`INSERT INTO "order_status_logs" ("order_id", "from_status", "to_status", "source") VALUES ($1::uuid, NULL, 'PENDING', 'API')`, [order.id]);

      const token = random(32).toString("base64url");
      const [acc] = await tx<{ max_age: unknown }>(
        `INSERT INTO "order_access_sessions" ("order_id", "token_hash", "browser_binding_hash", "scope", "status", "expires_at")
         SELECT $1::uuid, $2, $3, 'CONFIRMATION_VIEW', 'ACTIVE',
                LEAST(COALESCE(ss."ends_at", ss."starts_at") + $5::bigint * interval '1 millisecond', now() + $6::bigint * interval '1 millisecond')
           FROM "show_sessions" ss WHERE ss."id" = $4::uuid
         RETURNING floor(extract(epoch FROM ("expires_at" - now())))::bigint AS "max_age"`,
        [order.id, sha256Hex(token), input.bindingHash, req.sessionId, ACCESS_AFTER_SESSION_END_MS, ACCESS_MAX_MS],
      );

      const body: OrderCreatedBody = {
        orderId: order.id,
        orderNumber,
        status: "PENDING",
        holdExpiresAt: new Date(Number(order.hold_expires_ms)).toISOString(),
        items: items.map((i) => ({ sessionSeatId: i.sessionSeatId, seatLabel: i.seatLabel, price: Number(i.price) })),
        totalAmount: Number(total),
      };
      await tx(
        `INSERT INTO "outbox_events" ("event_type", "aggregate_type", "aggregate_id", "aggregate_version", "payload", "status")
         VALUES ('ORDER_CREATED', 'ORDER', $1::uuid, 1, $2::jsonb, 'PENDING')`,
        [order.id, JSON.stringify({ orderNumber, status: "PENDING", showSessionId: req.sessionId, seatCount: n, totalAmount: Number(total), holdExpiresAt: body.holdExpiresAt })],
      );
      await completeIdempotency(tx, idem.recordId, { resourceType: "ORDER", resourceId: order.id, responseStatus: 201, responseBody: body });
      return {
        status: 201,
        body,
        replayed: false,
        access: { cookieName: accessCookieName(order.id), token, maxAgeSeconds: Math.max(1, Number(acc.max_age)) },
      };
    },
  });
}
