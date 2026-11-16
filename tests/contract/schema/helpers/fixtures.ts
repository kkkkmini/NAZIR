/**
 * Minimal valid-row builders (plain SQL, no Prisma Client) so tests exercise the database exactly
 * as a raw-SQL service would. Every builder returns the inserted row; `overrides` use snake_case
 * column names and replace the defaults.
 */
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { Queryable } from "../contract";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const IDENT = /^[a-z_][a-z0-9_]*$/;

export async function insert(q: Queryable, table: string, row: Row): Promise<Row> {
  const cols = Object.keys(row);
  for (const c of [table, ...cols]) if (!IDENT.test(c)) throw new Error(`bad identifier ${c}`);
  const sql = cols.length
    ? `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`
    : `INSERT INTO "${table}" DEFAULT VALUES RETURNING *`;
  const { rows } = await q.query(sql, cols.map((c) => row[c]));
  return rows[0] as Row;
}

export async function update(q: Queryable, table: string, id: string, set: Row): Promise<void> {
  const cols = Object.keys(set);
  for (const c of [table, ...cols]) if (!IDENT.test(c)) throw new Error(`bad identifier ${c}`);
  await q.query(
    `UPDATE "${table}" SET ${cols.map((c, i) => `"${c}" = $${i + 1}`).join(", ")} WHERE "id" = $${cols.length + 1}`,
    [...cols.map((c) => set[c]), id],
  );
}

const rnd = () => randomUUID().replace(/-/g, "").slice(0, 12);
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000);

export const mkVenue = (q: Queryable, o: Row = {}) => insert(q, "venues", { name: `venue-${rnd()}`, ...o });

export const mkShow = (q: Queryable, venueId: string, o: Row = {}) =>
  insert(q, "shows", { venue_id: venueId, title: "t", slug: `show-${rnd()}`, status: "PUBLISHED", ...o });

export const mkSession = (q: Queryable, showId: string, venueId: string, o: Row = {}) =>
  insert(q, "show_sessions", {
    show_id: showId,
    venue_id: venueId,
    starts_at: inMinutes(60 * 24 * 30),
    sales_status: "ON_SALE",
    ...o,
  });

export const mkSeat = (q: Queryable, venueId: string, o: Row = {}) => {
  const n = rnd();
  return insert(q, "seats", { venue_id: venueId, svg_seat_id: `svg-${n}`, section_name: "A", row_label: "1", seat_number: n, ...o });
};

export const mkSessionSeat = (q: Queryable, sessionId: string, seatId: string, venueId: string, o: Row = {}) =>
  insert(q, "session_seats", { show_session_id: sessionId, seat_id: seatId, venue_id: venueId, price: 100000, status: "AVAILABLE", ...o });

export const mkSubject = (q: Queryable, o: Row = {}) =>
  insert(q, "identity_subjects", { subject_key_hash: `hash-${rnd()}`, subject_key_type: "DI", key_version: 1, ...o });

/** Creates a VERIFIED verification and the identity session claiming it. Returns the session row. */
export async function mkIdentitySession(q: Queryable, subjectId: string, o: Row = {}) {
  const v = await insert(q, "identity_verifications", {
    purpose: "BOOKING",
    provider: "MOCK",
    provider_transaction_id: `txn-${rnd()}`,
    browser_binding_hash: `bind-${rnd()}`,
    state_nonce_hash: `nonce-${rnd()}`,
    status: "CONSUMED",
    identity_subject_id: subjectId,
    expires_at: inMinutes(10),
  });
  return insert(q, "identity_sessions", {
    identity_verification_id: v.id,
    identity_subject_id: subjectId,
    purpose: "BOOKING",
    token_hash: `tok-${rnd()}`,
    browser_binding_hash: v.browser_binding_hash,
    status: "ACTIVE",
    expires_at: inMinutes(30),
    ...o,
  });
}

export const mkOrder = (
  q: Queryable,
  ref: { sessionId: string; subjectId: string; identitySessionId: string },
  o: Row = {},
) =>
  insert(q, "orders", {
    order_number: `NZ-T-${rnd()}`,
    show_session_id: ref.sessionId,
    identity_subject_id: ref.subjectId,
    identity_session_id: ref.identitySessionId,
    status: "PENDING",
    customer_name: "n",
    customer_phone: "p",
    total_amount: 100000,
    hold_expires_at: inMinutes(7),
    ...o,
  });

export const mkOrderItem = (q: Queryable, ref: { orderId: string; sessionId: string; sessionSeatId: string }, o: Row = {}) =>
  insert(q, "order_items", { order_id: ref.orderId, show_session_id: ref.sessionId, session_seat_id: ref.sessionSeatId, price: 100000, ...o });

export const mkHold = (q: Queryable, ref: { orderId: string; orderItemId: string; sessionSeatId: string }, o: Row = {}) =>
  insert(q, "seat_holds", { order_id: ref.orderId, order_item_id: ref.orderItemId, session_seat_id: ref.sessionSeatId, status: "ACTIVE", ...o });

export const mkPayment = (q: Queryable, orderId: string, o: Row = {}) =>
  insert(q, "payments", {
    order_id: orderId,
    provider: "MOCK",
    merchant_payment_ref: `pay-${rnd()}${rnd()}`,
    status: "READY",
    method_type: "CARD",
    requested_amount: 100000,
    return_nonce_hash: `rn-${rnd()}`,
    checkout_expires_at: inMinutes(7),
    ...o,
  });

export const mkRefund = (q: Queryable, ref: { orderId: string; paymentId: string }, o: Row = {}) =>
  insert(q, "refunds", {
    order_id: ref.orderId,
    payment_id: ref.paymentId,
    refund_type: "SEAT",
    provider: "MOCK",
    total_amount: 100000,
    status: "REQUESTED",
    ...o,
  });

export const mkTicket = (q: Queryable, ref: { orderItemId: string; sessionSeatId: string }, o: Row = {}) =>
  insert(q, "tickets", {
    ticket_number: `T-${rnd()}`,
    order_item_id: ref.orderItemId,
    session_seat_id: ref.sessionSeatId,
    status: "ISSUED",
    issued_at: new Date(),
    ...o,
  });

export const mkAdmin = (q: Queryable, o: Row = {}) =>
  insert(q, "admins", { email: `a-${rnd()}@example.test`, password_hash: "x", name: "a", role: "STAFF", ...o });

export const mkQuota = (q: Queryable, subjectId: string, sessionId: string, o: Row = {}) =>
  insert(q, "purchase_quotas", { identity_subject_id: subjectId, show_session_id: sessionId, seat_limit: 4, ...o });

/**
 * A ready-to-use world: venue V1 / show / sessions S1, S2 (both V1) / seats a,b,c in V1 with session
 * seats in S1 (and `a` in S2) / a second venue V2 with one seat / two identity subjects with sessions.
 */
export async function mkWorld(q: Queryable) {
  const v1 = await mkVenue(q);
  const v2 = await mkVenue(q);
  const show = await mkShow(q, v1.id);
  const s1 = await mkSession(q, show.id, v1.id);
  const s2 = await mkSession(q, show.id, v1.id);
  const seatA = await mkSeat(q, v1.id);
  const seatB = await mkSeat(q, v1.id);
  const seatC = await mkSeat(q, v1.id);
  const seatV2 = await mkSeat(q, v2.id);
  const s1a = await mkSessionSeat(q, s1.id, seatA.id, v1.id);
  const s1b = await mkSessionSeat(q, s1.id, seatB.id, v1.id);
  const s1c = await mkSessionSeat(q, s1.id, seatC.id, v1.id);
  const s2a = await mkSessionSeat(q, s2.id, seatA.id, v1.id);
  const u1 = await mkSubject(q);
  const u2 = await mkSubject(q);
  const is1 = await mkIdentitySession(q, u1.id);
  const is2 = await mkIdentitySession(q, u2.id);
  const ref = (subject: Row, identitySession: Row, session: Row = s1) => ({
    sessionId: session.id as string,
    subjectId: subject.id as string,
    identitySessionId: identitySession.id as string,
  });
  return { v1, v2, show, s1, s2, seatA, seatB, seatC, seatV2, s1a, s1b, s1c, s2a, u1, u2, is1, is2, ref };
}

/**
 * Runs `sql` inside a SAVEPOINT, asserts PostgreSQL rejects it with the expected SQLSTATE (and
 * constraint name when given), then rolls back to the savepoint so the transaction stays usable.
 */
export async function expectDbError(
  q: Queryable,
  sql: string,
  values: unknown[],
  expected: { code: string; constraint?: string; message?: RegExp },
): Promise<void> {
  await q.query("SAVEPOINT expect_err");
  let err: (Error & { code?: string; constraint?: string }) | undefined;
  try {
    await q.query(sql, values);
  } catch (e) {
    err = e as Error & { code?: string; constraint?: string };
  }
  await q.query("ROLLBACK TO SAVEPOINT expect_err");
  await q.query("RELEASE SAVEPOINT expect_err");
  expect(err, `expected the database to reject: ${sql}`).toBeDefined();
  expect(err!.code, `SQLSTATE (${err!.message})`).toBe(expected.code);
  if (expected.constraint) expect(err!.constraint, "constraint name").toBe(expected.constraint);
  if (expected.message) expect(err!.message).toMatch(expected.message);
}

/** Convenience wrapper for the builders above, which throw the raw pg error on violation. */
export async function expectInsertError(
  q: Queryable,
  build: () => Promise<unknown>,
  expected: { code: string; constraint?: string },
): Promise<void> {
  await q.query("SAVEPOINT expect_err");
  let err: (Error & { code?: string; constraint?: string }) | undefined;
  try {
    await build();
  } catch (e) {
    err = e as Error & { code?: string; constraint?: string };
  }
  await q.query("ROLLBACK TO SAVEPOINT expect_err");
  await q.query("RELEASE SAVEPOINT expect_err");
  expect(err, "expected the database to reject the statement").toBeDefined();
  expect(err!.code, `SQLSTATE (${err!.message})`).toBe(expected.code);
  if (expected.constraint) expect(err!.constraint, "constraint name").toBe(expected.constraint);
}

export const PG = {
  uniqueViolation: "23505",
  checkViolation: "23514",
  foreignKeyViolation: "23503",
  restrictViolation: "23001",
} as const;
