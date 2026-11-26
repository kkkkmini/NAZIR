/**
 * Shared Step 5 fixtures: an on-sale show session with priced seats, a BOOKING person (verification + session with a
 * known token and browser binding, encrypted name/phone), and createOrder / runner dependencies on a Prisma client.
 * Orders are created through the REAL createOrder path, so lifecycle tests start from production-shaped rows.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "../../../../src/generated/prisma/client";
import { createOrder, parseCreateOrderBody, type CreateOrderDeps } from "../../../../src/server/booking/create-order";
import { idempotencyKeyHash } from "../../../../src/server/booking/idempotency";
import { DEFAULT_RETRY_POLICY, type BookingTxDeps, type TxLimits } from "../../../../src/server/booking/tx";
import { sha256Hex } from "../../../../src/server/lib/crypto/hmac";
import { encryptPii } from "../../../../src/server/lib/crypto/pii";
import { parseKeyring, type Keyring } from "../../../../src/server/lib/secrets";
import { parsePolicyOverrides } from "../../../../src/server/rate-limit/policies";
import { insert, mkSeat, mkSessionSeat, mkSubject, mkVenue } from "./fixtures";
import type { TestDb } from "./pg";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const testRing = (p: string): Keyring => parseKeyring({ [`${p}_KEYS`]: `v1:${randomBytes(32).toString("base64url")}`, [`${p}_KEY_CURRENT`]: "v1" }, p, [])!;

export interface BookingWorld {
  sessionId: string;
  seats: string[];
}
export interface BookingPerson {
  subjectId: string;
  sessionId: string;
  token: string;
  binding: string;
}

export function bookingFixtures(db: TestDb, prisma: () => PrismaClient, piiKeys: Keyring = testRing("PII"), rlKeys: Keyring = testRing("RL")) {
  const q = async <T = Row>(sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as T[];

  const txDeps = (limits: Partial<TxLimits> = {}, maxAttempts = 3): BookingTxDeps => ({
    startTx: (fn, options) => prisma().$transaction((tx) => fn(tx), options),
    limits: { txMaxWaitMs: 10000, txTimeoutMs: 20000, statementTimeoutMs: 15000, lockTimeoutMs: 10000, ...limits },
    retry: { ...DEFAULT_RETRY_POLICY, maxAttempts },
  });
  const orderDeps = (policies = "order.create.session=1000/1800,order.create.subject_session=1000/3600", tx = txDeps()): CreateOrderDeps => ({
    tx,
    piiKeys,
    rateLimit: { keys: rlKeys, policies: parsePolicyOverrides({ NAZIR_RATE_LIMIT_POLICIES: policies }) },
  });

  async function world(o: { session?: Row; prices?: number[] } = {}): Promise<BookingWorld> {
    const v = await mkVenue(db);
    const show = await insert(db, "shows", { venue_id: v.id, title: "t", slug: `s-${randomUUID()}`, status: "PUBLISHED" });
    const s = await insert(db, "show_sessions", {
      show_id: show.id,
      venue_id: v.id,
      starts_at: new Date(Date.now() + 30 * 86400_000),
      ends_at: new Date(Date.now() + 30 * 86400_000 + 3 * 3600_000),
      sales_status: "ON_SALE",
      ...o.session,
    });
    const seats: string[] = [];
    for (const [i, price] of (o.prices ?? [100000, 110000, 120000, 130000, 140000, 150000]).entries()) {
      const seat = await mkSeat(db, v.id, { section_name: "R", row_label: "A", seat_number: String(i + 1) });
      seats.push((await mkSessionSeat(db, s.id, seat.id, v.id, { price })).id);
    }
    return { sessionId: s.id, seats };
  }

  async function person(o: { subjectId?: string; expiresInMs?: number } = {}): Promise<BookingPerson> {
    const subjectId = o.subjectId ?? (await mkSubject(db)).id;
    const token = randomBytes(32).toString("base64url");
    const binding = randomBytes(32).toString("base64url");
    const [s] = await q<{ id: string }>(
      `WITH v AS (
         INSERT INTO identity_verifications (purpose, provider, provider_transaction_id, browser_binding_hash, state_nonce_hash, status, identity_subject_id, expires_at, verified_name, verified_phone, verified_at)
         VALUES ('BOOKING', 'MOCK', $1, $2, $3, 'CONSUMED', $4, now() + interval '10 min', $5, $6, now()) RETURNING id)
       INSERT INTO identity_sessions (identity_verification_id, identity_subject_id, purpose, token_hash, browser_binding_hash, status, expires_at)
       SELECT v.id, $4, 'BOOKING', $7, $2, 'ACTIVE', now() + $8::int * interval '1 millisecond' FROM v RETURNING id`,
      [
        `t-${randomUUID()}`,
        sha256Hex(binding),
        `n-${randomUUID()}`,
        subjectId,
        encryptPii(piiKeys, "identity_verifications.verified_name", "홍길동"),
        encryptPii(piiKeys, "identity_verifications.verified_phone", "01012345678"),
        sha256Hex(token),
        o.expiresInMs ?? 30 * 60_000,
      ],
    );
    return { subjectId, sessionId: s.id, token, binding };
  }

  const createFor = (p: BookingPerson, w: BookingWorld, seats: string[], o: { key?: string; deps?: CreateOrderDeps } = {}) =>
    createOrder(o.deps ?? orderDeps(), {
      sessionTokenHash: sha256Hex(p.token),
      bindingHash: sha256Hex(p.binding),
      idempotencyKeyHash: idempotencyKeyHash(o.key ?? randomUUID()),
      request: parseCreateOrderBody({ sessionId: w.sessionId, sessionSeatIds: seats }),
    });

  /** Moves the order's hold expiry into the past (the only way to "wait" 7 minutes in a test). */
  const makeDue = (orderId: string, agoMs = 1000) =>
    q(`UPDATE orders SET hold_expires_at = now() - $2::int * interval '1 millisecond', updated_at = now() WHERE id = $1`, [orderId, agoMs]);

  /** The order's state as one comparable object. */
  async function state(orderId: string) {
    const [o] = await q(
      `SELECT o.status, o.closed_at IS NOT NULL AS closed,
              (SELECT array_agg(h.status ORDER BY h.session_seat_id) FROM seat_holds h WHERE h.order_id = o.id) AS holds,
              (SELECT counted_seats FROM purchase_quotas q WHERE q.identity_subject_id = o.identity_subject_id AND q.show_session_id = o.show_session_id) AS counted,
              (SELECT array_agg(l.to_status || ':' || l.source ORDER BY l.created_at, l.to_status) FROM order_status_logs l WHERE l.order_id = o.id) AS logs,
              (SELECT array_agg(e.event_type || ':' || e.aggregate_version ORDER BY e.aggregate_version) FROM outbox_events e WHERE e.aggregate_id = o.id) AS outbox
         FROM orders o WHERE o.id = $1`,
      [orderId],
    );
    return o;
  }

  return { q, txDeps, orderDeps, world, person, createFor, makeDue, state };
}
