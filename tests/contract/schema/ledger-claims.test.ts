/**
 * Step 2 follow-up hardening, proven on a real PostgreSQL:
 *
 *   A-038  SUCCEEDED payments carry approved_at (next to approved_amount, no DELETE)
 *   A-039  requested payment method and PG-reported method are separate facts (Q-027)
 *   A-040  identity claim integrity: verification status + browser binding <-> session (Q-028)
 *   A-041  append-only history and the refund ledger (Q-029)
 *
 * Deferred (commit-time) rules are asserted with `expectCommitError` (statements are accepted, the COMMIT is refused) and
 * with real COMMITs on committed data. Every scenario that must be rejected has a matching scenario that must still work.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { DB_CONSTRAINT } from "../../../src/server/db/constants";
import { paymentApprovalMethodColumns, paymentCreationMethodColumns } from "../../../src/server/db/payment-method";
import {
  checkAtCommit,
  confirmOrder,
  expectCommitError,
  expectDbError,
  expectInsertError,
  insert,
  mkAdmin,
  mkIdentitySession,
  mkOrder,
  mkOrderItem,
  mkPayment,
  mkRefund,
  mkSubject,
  mkWorld,
  PG,
  update,
} from "./helpers/fixtures";
import { cloneTestDb, destroyTestDb, resolveTestServer, type TestDb } from "./helpers/pg";

const server = resolveTestServer();
let db: TestDb;
beforeAll(async () => {
  db = await cloneTestDb(server, inject("templateDb"));
});
afterAll(() => destroyTestDb(db));

type C = Parameters<typeof insert>[0];
const orderFor = (c: C, w: Awaited<ReturnType<typeof mkWorld>>, who: "u1" | "u2" = "u1") =>
  mkOrder(c, who === "u1" ? w.ref(w.u1, w.is1) : w.ref(w.u2, w.is2));
const count = async (c: C, table: string, id: string) =>
  ((await c.query(`SELECT count(*)::int n FROM ${table} WHERE id = $1`, [id])).rows[0] as { n: number }).n;

// ═════════════════════════════ A-038: SUCCEEDED carries approved_at ═════════════════════════════

describe("A-038 — a SUCCEEDED payment carries approved_at", () => {
  const bad = { code: PG.checkViolation, constraint: DB_CONSTRAINT.paymentSucceededApprovedAtCheck };

  it("INSERT: SUCCEEDED without approved_at is rejected (EXCESS and PRIMARY); with it, accepted", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      await expectInsertError(c, () => mkPayment(c, order.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000, approved_at: null }), bad);
      await expectInsertError(c, () => mkPayment(c, order.id, { status: "SUCCEEDED", role: "PRIMARY", approved_amount: 100000, approved_at: null }), bad);
      const ok = await mkPayment(c, order.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000, approved_at: new Date() });
      expect(ok.approved_at).toBeInstanceOf(Date);
    }));

  it("UPDATE: cannot reach SUCCEEDED without it, nor erase it afterwards; the one-statement transition works", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      const p = await mkPayment(c, order.id);
      await expectDbError(c, `UPDATE payments SET status = 'SUCCEEDED', role = 'EXCESS', approved_amount = 100000 WHERE id = $1`, [p.id], bad);
      await c.query(`UPDATE payments SET status = 'SUCCEEDED', role = 'EXCESS', approved_amount = 100000, approved_at = now() WHERE id = $1`, [p.id]);
      await expectDbError(c, `UPDATE payments SET approved_at = NULL WHERE id = $1`, [p.id], bad); // NULL-safe: NULL cannot slip through
    }));

  it("other statuses may have no approval time, and the normal lifecycle is unaffected", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      const p = await mkPayment(c, order.id); // READY -> CONFIRMING -> UNKNOWN -> SUCCEEDED
      expect(p.approved_at).toBeNull();
      await update(c, "payments", p.id, { status: "CONFIRMING", confirm_started_at: new Date() });
      await update(c, "payments", p.id, { status: "UNKNOWN", unknown_since: new Date() });
      await update(c, "payments", p.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000, approved_at: new Date() });
      for (const status of ["FAILED", "CANCELED"]) await mkPayment(c, order.id, { status });
      await confirmOrder(c, await orderFor(c, w, "u2")); // PRIMARY + PAID still commits
    }));
});

// ═════════════════════════════ A-039: requested vs reported method (Q-027) ═════════════════════════════

describe("A-039 — requested_method_type and provider_method_raw", () => {
  it("a payment attempt records what the user chose; the column is mandatory and limited to CARD / EASY_PAY", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      for (const m of ["CARD", "EASY_PAY"] as const) {
        await c.query("SAVEPOINT s"); // one in-flight payment per order: try each choice on its own
        const p = await mkPayment(c, order.id, { ...paymentCreationMethodColumns(m) });
        expect(p).toMatchObject({ requested_method_type: m, method_type: m, provider_method_raw: null });
        await c.query("ROLLBACK TO SAVEPOINT s");
      }
      await expectInsertError(c, () => mkPayment(c, order.id, { requested_method_type: null }), { code: "23502" }); // NOT NULL
      for (const bad of ["OTHER", "VIRTUAL_ACCOUNT", "card", ""]) {
        await expectInsertError(c, () => mkPayment(c, order.id, { requested_method_type: bad }), { code: PG.checkViolation, constraint: DB_CONSTRAINT.requestedMethodTypeCheck });
      }
    }));

  it("the requested method cannot be changed afterwards (single row, bulk, any status), while a no-op write and all other updates still work", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      const p = await mkPayment(c, order.id, { requested_method_type: "CARD" });
      const immutable = { code: PG.restrictViolation, message: /requested_method_type is immutable/ };
      await expectDbError(c, `UPDATE payments SET requested_method_type = 'EASY_PAY' WHERE id = $1`, [p.id], immutable);
      await expectDbError(c, `UPDATE payments SET requested_method_type = 'EASY_PAY'`, [], immutable); // bulk
      await c.query(`UPDATE payments SET requested_method_type = 'CARD', failure_message = 'noop' WHERE id = $1`, [p.id]); // same value: allowed
      await c.query(`UPDATE payments SET status = 'SUCCEEDED', role = 'EXCESS', approved_amount = 100000, approved_at = now(), method_type = 'EASY_PAY' WHERE id = $1`, [p.id]);
      await expectDbError(c, `UPDATE payments SET requested_method_type = 'EASY_PAY' WHERE id = $1`, [p.id], immutable); // even after approval
      expect((await c.query(`SELECT requested_method_type FROM payments WHERE id = $1`, [p.id])).rows[0].requested_method_type).toBe("CARD");
    }));

  it.each([
    ["CARD requested, CARD approved", "CARD", { methodType: "CARD" as const, rawMethod: "카드", cardCompany: "SHINHAN" }, { method_type: "CARD", raw: "카드" }],
    ["CARD requested, EASY_PAY approved (an allowed mismatch)", "CARD", { methodType: "EASY_PAY" as const, rawMethod: "간편결제", easyPayProvider: "TOSSPAY" }, { method_type: "EASY_PAY", raw: "간편결제" }],
    ["CARD requested, OTHER approved", "CARD", { methodType: "DISALLOWED" as const, rawMethod: "가상계좌" }, { method_type: "OTHER", raw: "가상계좌" }],
    ["EASY_PAY requested, OTHER approved", "EASY_PAY", { methodType: "DISALLOWED" as const, rawMethod: "휴대폰" }, { method_type: "OTHER", raw: "휴대폰" }],
  ])("%s: both facts survive the approval (columns built by src/server/db/payment-method.ts)", (_label, requested, reported, expected) =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      const p = await mkPayment(c, order.id, { ...paymentCreationMethodColumns(requested as "CARD" | "EASY_PAY") });
      const cols = paymentApprovalMethodColumns(reported);
      await c.query(
        `UPDATE payments SET status = 'SUCCEEDED', role = 'EXCESS', approved_amount = 100000, approved_at = now(),
                method_type = $2, provider_method_raw = $3, card_company = $4, easy_pay_provider = $5 WHERE id = $1`,
        [p.id, cols.method_type, cols.provider_method_raw, cols.card_company, cols.easy_pay_provider],
      );
      const { rows } = await c.query(`SELECT requested_method_type, method_type, provider_method_raw FROM payments WHERE id = $1`, [p.id]);
      expect(rows[0]).toEqual({ requested_method_type: requested, method_type: expected.method_type, provider_method_raw: expected.raw });
    }),
  );

  it("OTHER without the PG label is rejected on INSERT and UPDATE; with it, accepted", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      const bad = { code: PG.checkViolation, constraint: DB_CONSTRAINT.otherRequiresRawCheck };
      const approved = { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000, approved_at: new Date(), method_type: "OTHER" };
      await expectInsertError(c, () => mkPayment(c, order.id, { ...approved, provider_method_raw: null }), bad);
      const p = await mkPayment(c, order.id, { status: "FAILED" });
      await expectDbError(c, `UPDATE payments SET status = 'SUCCEEDED', role = 'EXCESS', approved_amount = 100000, approved_at = now(), method_type = 'OTHER' WHERE id = $1`, [p.id], bad);
      const ok = await mkPayment(c, order.id, { ...approved, provider_method_raw: "가상계좌" });
      await expectDbError(c, `UPDATE payments SET provider_method_raw = NULL WHERE id = $1`, [ok.id], bad); // cannot be erased later
    }));

  it("the raw label is stored verbatim, and obviously personal / payment data is refused", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      const guard = { code: PG.checkViolation, constraint: DB_CONSTRAINT.providerMethodRawCheck };
      const verbatim = await mkPayment(c, order.id, { status: "FAILED", provider_method_raw: " 카드  " }); // untouched: not trimmed, not mapped
      expect(verbatim.provider_method_raw).toBe(" 카드  ");
      for (const ok of ["도서문화상품권", "Credit Card", "카드 12개월", "x".repeat(100)]) {
        await mkPayment(c, order.id, { status: "FAILED", provider_method_raw: ok });
      }
      for (const bad of ["", "   ", "카드 4111111111111111", "휴대폰 01012345678", "a@b.com", "카드\nVISA", "카드\t"]) {
        await expectInsertError(c, () => mkPayment(c, order.id, { status: "FAILED", provider_method_raw: bad }), guard);
      }
      await expectInsertError(c, () => mkPayment(c, order.id, { status: "FAILED", provider_method_raw: "x".repeat(101) }), { code: "22001" }); // varchar(100)
    }));

  it("OTHER stays confined to an approved EXCESS payment (A-034 is unchanged)", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      await expectInsertError(c, () => mkPayment(c, order.id, { method_type: "OTHER", provider_method_raw: "가상계좌" }), {
        code: PG.checkViolation,
        constraint: DB_CONSTRAINT.paymentMethodOtherCheck,
      });
      await expectInsertError(c, () => confirmOrder(c, order, { method_type: "OTHER", provider_method_raw: "가상계좌" }), {
        code: PG.checkViolation,
        constraint: DB_CONSTRAINT.paymentMethodOtherCheck,
      });
    }));
});

// ═════════════════════ A-039 (follow-up): method_type equals the request until the payment is SUCCEEDED ═════════════════════

describe("A-039 — an unapproved payment's method_type matches the requested method", () => {
  const mismatch = { code: PG.checkViolation, constraint: DB_CONSTRAINT.unapprovedMethodMatchesRequestCheck };
  const other = (m: "CARD" | "EASY_PAY") => (m === "CARD" ? "EASY_PAY" : "CARD");
  const NOT_APPROVED = ["READY", "CONFIRMING", "UNKNOWN", "FAILED", "CANCELED"] as const;
  const REQUESTS = ["CARD", "EASY_PAY"] as const;

  it.each(NOT_APPROVED.flatMap((status) => REQUESTS.map((req) => [status, req] as const)))(
    "INSERT: %s payment, %s requested, a different method_type is rejected; the matching one is accepted",
    (status, requested) =>
      db.rolledBack(async (c) => {
        const w = await mkWorld(c);
        const order = await orderFor(c, w);
        await expectInsertError(c, () => mkPayment(c, order.id, { status, requested_method_type: requested, method_type: other(requested) }), mismatch);
        const ok = await mkPayment(c, order.id, { status, requested_method_type: requested, method_type: requested });
        expect(ok).toMatchObject({ status, requested_method_type: requested, method_type: requested });
      }),
  );

  it("the two cases from the review: CARD + READY + EASY_PAY and EASY_PAY + READY + CARD", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      await expectInsertError(c, () => mkPayment(c, order.id, { status: "READY", requested_method_type: "CARD", method_type: "EASY_PAY" }), mismatch);
      await expectInsertError(c, () => mkPayment(c, order.id, { status: "READY", requested_method_type: "EASY_PAY", method_type: "CARD" }), mismatch);
      // the same pair is fine as soon as it is an approved payment
      await mkPayment(c, order.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000, requested_method_type: "CARD", method_type: "EASY_PAY" });
    }));

  it.each(NOT_APPROVED.flatMap((status) => REQUESTS.map((req) => [status, req] as const)))(
    "UPDATE: a %s payment (requested %s) cannot be given another method_type, alone or together with a state transition",
    (status, requested) =>
      db.rolledBack(async (c) => {
        const w = await mkWorld(c);
        const order = await orderFor(c, w);
        const p = await mkPayment(c, order.id, { status, requested_method_type: requested, method_type: requested });
        await expectDbError(c, `UPDATE payments SET method_type = $2 WHERE id = $1`, [p.id, other(requested)], mismatch); // single row
        await expectDbError(c, `UPDATE payments SET method_type = $1 WHERE requested_method_type = $2`, [other(requested), requested], mismatch); // bulk
        // writing the same value is fine
        await c.query(`UPDATE payments SET method_type = $2, failure_message = 'noop' WHERE id = $1`, [p.id, requested]);
        expect((await c.query(`SELECT method_type FROM payments WHERE id = $1`, [p.id])).rows[0].method_type).toBe(requested);
      }),
  );

  it.each([
    ["READY", "CONFIRMING"],
    ["READY", "FAILED"],
    ["READY", "CANCELED"],
    ["CONFIRMING", "UNKNOWN"],
    ["CONFIRMING", "FAILED"],
    ["UNKNOWN", "FAILED"],
  ] as const)("UPDATE: %s -> %s with a different method_type in the same statement is rejected", (from, to) =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      const p = await mkPayment(c, order.id, { status: from, requested_method_type: "CARD", method_type: "CARD" });
      await expectDbError(c, `UPDATE payments SET status = $2, method_type = 'EASY_PAY' WHERE id = $1`, [p.id, to], mismatch);
    }),
  );

  it("normal creation and every unapproved state transition stay possible while method_type equals the request", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      for (const requested of REQUESTS) {
        await c.query("SAVEPOINT lifecycle");
        const cols = paymentCreationMethodColumns(requested);
        expect(cols.method_type).toBe(cols.requested_method_type); // what the service writes satisfies the rule by construction
        const p = await mkPayment(c, order.id, { ...cols });
        for (const next of ["CONFIRMING", "UNKNOWN", "FAILED"]) {
          await c.query(`UPDATE payments SET status = $2, updated_at = now() WHERE id = $1`, [p.id, next]);
        }
        const q = await mkPayment(c, order.id, { ...cols, status: "READY" }); // a retry is a new attempt
        await c.query(`UPDATE payments SET status = 'CANCELED', canceled_at = now() WHERE id = $1`, [q.id]);
        await c.query("ROLLBACK TO SAVEPOINT lifecycle");
      }
    }));

  it.each([
    ["CARD", "CARD", "EXCESS"],
    ["CARD", "EASY_PAY", "EXCESS"],
    ["CARD", "OTHER", "EXCESS"],
    ["EASY_PAY", "EASY_PAY", "EXCESS"],
    ["EASY_PAY", "CARD", "EXCESS"],
    ["EASY_PAY", "OTHER", "EXCESS"],
    ["CARD", "CARD", "PRIMARY"],
    ["CARD", "EASY_PAY", "PRIMARY"],
    ["EASY_PAY", "CARD", "PRIMARY"],
    ["EASY_PAY", "EASY_PAY", "PRIMARY"],
  ] as const)("approval: %s requested -> %s reported (%s) is accepted and keeps the request", (requested, reported, role) =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      const p = await mkPayment(c, order.id, { ...paymentCreationMethodColumns(requested) });
      const cols = paymentApprovalMethodColumns({
        methodType: reported === "OTHER" ? "DISALLOWED" : reported,
        rawMethod: reported === "OTHER" ? "가상계좌" : reported === "CARD" ? "카드" : "간편결제",
      });
      await c.query(
        `UPDATE payments SET status = 'SUCCEEDED', role = $2, approved_amount = 100000, approved_at = now(),
                method_type = $3, provider_method_raw = $4 WHERE id = $1`,
        [p.id, role, cols.method_type, cols.provider_method_raw],
      );
      if (role === "PRIMARY") {
        await update(c, "orders", order.id, { status: "PAID", confirmed_payment_id: p.id, paid_at: new Date() });
        await checkAtCommit(c); // the deferred order <-> payment rules hold as well
      }
      const { rows } = await c.query(`SELECT requested_method_type, method_type FROM payments WHERE id = $1`, [p.id]);
      expect(rows[0]).toEqual({ requested_method_type: requested, method_type: reported });
    }),
  );

  it("an approved payment whose method differs from the request cannot be moved back out of SUCCEEDED", () =>
    db.rolledBack(async (c) => {
      const w = await mkWorld(c);
      const order = await orderFor(c, w);
      const p = await mkPayment(c, order.id, { status: "SUCCEEDED", role: "EXCESS", approved_amount: 100000, requested_method_type: "CARD", method_type: "EASY_PAY" });
      await expectDbError(c, `UPDATE payments SET status = 'FAILED', role = NULL, approved_amount = NULL, approved_at = NULL WHERE id = $1`, [p.id], mismatch);
    }));
});

// ═════════════════════════════ A-040: identity claim integrity (Q-028) ═════════════════════════════

describe("A-040 — a session needs a CONSUMED verification of the same subject, purpose and browser", () => {
  const verification = (c: C, subjectId: string | null, status: string, o: Record<string, unknown> = {}) =>
    insert(c, "identity_verifications", {
      purpose: "BOOKING",
      provider: "MOCK",
      browser_binding_hash: "bindA",
      state_nonce_hash: "n",
      status,
      identity_subject_id: subjectId,
      expires_at: new Date(Date.now() + 600_000),
      ...o,
    });
  const session = (c: C, v: Record<string, unknown>, o: Record<string, unknown> = {}) =>
    insert(c, "identity_sessions", {
      identity_verification_id: v.id,
      identity_subject_id: v.identity_subject_id,
      purpose: v.purpose,
      token_hash: `t-${randomUUID()}`,
      browser_binding_hash: v.browser_binding_hash,
      status: "ACTIVE",
      expires_at: new Date(Date.now() + 1_800_000),
      ...o,
    });
  const setStatus = (c: C, id: unknown, status: string) => c.query(`UPDATE identity_verifications SET status = $2 WHERE id = $1`, [id, status]);
  const noConsumed = { code: PG.checkViolation, constraint: DB_CONSTRAINT.sessionNeedsConsumedVerification };
  const noSession = { code: PG.checkViolation, constraint: DB_CONSTRAINT.consumedVerificationNeedsSession };

  it.each(["PENDING", "FAILED", "EXPIRED", "VERIFIED"])("a session for a %s verification (subject set) is refused at COMMIT", (status) =>
    db.rolledBack(async (c) => {
      const u = await mkSubject(c);
      const v = await verification(c, u.id, status);
      await expectCommitError(c, () => session(c, v), noConsumed);
    }),
  );

  it("an unverified verification (no subject yet) cannot get a session at all (composite FK)", () =>
    db.rolledBack(async (c) => {
      const u = await mkSubject(c);
      const v = await verification(c, null, "PENDING");
      await expectInsertError(c, () => session(c, { ...v, identity_subject_id: u.id }), { code: PG.foreignKeyViolation, constraint: DB_CONSTRAINT.identitySessionVerificationFk });
    }));

  it("CONSUMED without a session is refused at COMMIT (INSERT as CONSUMED, and VERIFIED -> CONSUMED without issuing one)", () =>
    db.rolledBack(async (c) => {
      const u = await mkSubject(c);
      await expectCommitError(c, () => verification(c, u.id, "CONSUMED"), noSession);
      const v = await verification(c, u.id, "VERIFIED");
      await expectCommitError(c, () => setStatus(c, v.id, "CONSUMED"), noSession);
    }));

  it("a session from another browser (different binding hash) is refused immediately", () =>
    db.rolledBack(async (c) => {
      const u = await mkSubject(c);
      const v = await verification(c, u.id, "VERIFIED");
      await expectInsertError(c, () => session(c, v, { browser_binding_hash: "bindB-OTHER-BROWSER" }), {
        code: PG.foreignKeyViolation,
        constraint: DB_CONSTRAINT.identitySessionVerificationFk,
      });
      await expectInsertError(c, () => session(c, v, { purpose: "LOOKUP" }), { code: PG.foreignKeyViolation, constraint: DB_CONSTRAINT.identitySessionVerificationFk });
    }));

  it("once the session exists the verification cannot be moved back (PENDING / FAILED / EXPIRED / VERIFIED), nor re-pointed", () =>
    db.rolledBack(async (c) => {
      const u = await mkSubject(c);
      const v = await verification(c, u.id, "VERIFIED");
      await session(c, v);
      await setStatus(c, v.id, "CONSUMED");
      await checkAtCommit(c);
      for (const back of ["PENDING", "FAILED", "EXPIRED", "VERIFIED"]) {
        await expectCommitError(c, () => setStatus(c, v.id, back), noConsumed);
      }
      // binding / subject / purpose of a claimed verification are frozen by the FK (ON UPDATE RESTRICT)
      await expectDbError(c, `UPDATE identity_verifications SET browser_binding_hash = 'other' WHERE id = $1`, [v.id], { code: PG.foreignKeyViolation, constraint: DB_CONSTRAINT.identitySessionVerificationFk });
      // moving the session to another verification leaves the old one CONSUMED without a session (and the new one not consumed)
      const s = (await c.query(`SELECT id FROM identity_sessions WHERE identity_verification_id = $1`, [v.id])).rows[0] as { id: string };
      await expectCommitError(
        c,
        async () => {
          const v2 = await verification(c, u.id, "CONSUMED"); // the new target is fine (CONSUMED and about to own the session)
          await c.query(`UPDATE identity_sessions SET identity_verification_id = $2 WHERE id = $1`, [s.id, v2.id]);
        },
        noSession, // ... but the OLD verification is left CONSUMED without a session
      );
      // moving it onto a verification that is not CONSUMED is refused for the opposite reason
      const v3 = await verification(c, u.id, "VERIFIED");
      await expectCommitError(c, () => c.query(`UPDATE identity_sessions SET identity_verification_id = $2 WHERE id = $1`, [s.id, v3.id]), noConsumed);
    }));

  describe("the legitimate claim works in either statement order", () => {
    it("PENDING -> VERIFIED -> session INSERT, then CONSUMED", () =>
      db.rolledBack(async (c) => {
        const u = await mkSubject(c);
        const v = await verification(c, null, "PENDING");
        await c.query(`UPDATE identity_verifications SET status = 'VERIFIED', identity_subject_id = $2, verified_at = now(), claim_expires_at = now() + interval '5 minutes' WHERE id = $1`, [v.id, u.id]);
        const claimed = { ...v, identity_subject_id: u.id };
        await session(c, claimed);
        await setStatus(c, v.id, "CONSUMED");
        await checkAtCommit(c);
      }));

    it("CONSUMED first, session INSERT second", () =>
      db.rolledBack(async (c) => {
        const u = await mkSubject(c);
        const v = await verification(c, u.id, "VERIFIED");
        await setStatus(c, v.id, "CONSUMED");
        await session(c, v);
        await checkAtCommit(c);
      }));

    it("a real COMMIT: the consistent claim is persisted; the inconsistent one fails at COMMIT and leaves nothing behind", async () => {
      const u = await mkSubject(db);
      const good = await verification(db, u.id, "VERIFIED");
      const bad = await verification(db, u.id, "VERIFIED", { browser_binding_hash: "bindC" });
      const c = await db.pool.connect();
      try {
        await c.query("BEGIN");
        await session(c, good);
        await setStatus(c, good.id, "CONSUMED");
        await c.query("COMMIT");

        await c.query("BEGIN");
        const s = await session(c, bad); // accepted statement by statement ...
        expect(s.status).toBe("ACTIVE");
        await expect(c.query("COMMIT")).rejects.toMatchObject(noConsumed); // ... refused at COMMIT: the verification was never CONSUMED
      } finally {
        c.release();
      }
      expect((await db.query(`SELECT status FROM identity_verifications WHERE id = $1`, [good.id])).rows[0].status).toBe("CONSUMED");
      expect((await db.query(`SELECT count(*)::int n FROM identity_sessions WHERE identity_verification_id = $1`, [good.id])).rows[0].n).toBe(1);
      expect((await db.query(`SELECT count(*)::int n FROM identity_sessions WHERE identity_verification_id = $1`, [bad.id])).rows[0].n).toBe(0);
    });
  });

  describe("everything else in the verification / session lifecycle still works", () => {
    it("PENDING -> FAILED and VERIFIED -> EXPIRED (claim window passed) without a session; subject on PENDING/FAILED rows is not restricted", () =>
      db.rolledBack(async (c) => {
        const u = await mkSubject(c);
        const p = await verification(c, null, "PENDING");
        await c.query(`UPDATE identity_verifications SET status = 'FAILED', failure_code = 'X' WHERE id = $1`, [p.id]);
        const v = await verification(c, u.id, "VERIFIED", { claim_expires_at: new Date(Date.now() - 60_000) });
        await setStatus(c, v.id, "EXPIRED");
        await verification(c, u.id, "PENDING");
        await verification(c, u.id, "FAILED");
        await checkAtCommit(c);
      }));

    it("the session's own lifecycle (ACTIVE -> REVOKED, ACTIVE -> EXPIRED) leaves the CONSUMED verification alone", () =>
      db.rolledBack(async (c) => {
        const u = await mkSubject(c);
        const s1 = await mkIdentitySession(c, u.id);
        await c.query(`UPDATE identity_sessions SET status = 'REVOKED', revoked_at = now() WHERE id = $1`, [s1.id]);
        const s2 = await mkIdentitySession(c, u.id);
        await c.query(`UPDATE identity_sessions SET status = 'EXPIRED', last_used_at = now() WHERE id = $1`, [s2.id]);
        await checkAtCommit(c);
      }));

    it("claim_expires_at is a service rule, not a database rule (documented: the DB does not read the clock here)", () =>
      db.rolledBack(async (c) => {
        const u = await mkSubject(c);
        const v = await verification(c, u.id, "VERIFIED", { claim_expires_at: new Date(Date.now() - 3_600_000) });
        await session(c, v);
        await setStatus(c, v.id, "CONSUMED");
        await checkAtCommit(c); // accepted: expiry of the claim window is validated by the claim endpoint
      }));
  });

  describe("retention and deletion: nothing legitimate is blocked, nothing is weakened", () => {
    it("a session that created an order can never be deleted (pre-existing orders FK); personal data is removed by UPDATE, which still works", () =>
      db.rolledBack(async (c) => {
        const w = await mkWorld(c);
        await orderFor(c, w); // orders.identity_session_id -> identity_sessions (ON DELETE RESTRICT)
        const verificationId = (await c.query(`SELECT identity_verification_id v FROM identity_sessions WHERE id = $1`, [w.is1.id])).rows[0].v;
        await expectDbError(c, `DELETE FROM identity_sessions WHERE id = $1`, [w.is1.id], { code: PG.foreignKeyViolation, constraint: "orders_identity_session_subject_fk" });
        await expectDbError(c, `DELETE FROM identity_verifications WHERE id = $1`, [verificationId], { code: PG.foreignKeyViolation, constraint: DB_CONSTRAINT.identitySessionVerificationFk });
        // anonymisation: nulling the PII columns is a plain UPDATE and is not touched by the claim triggers
        await c.query(`UPDATE identity_verifications SET verified_name = 'enc-name', verified_phone = 'enc-phone', provider_context_encrypted = 'ctx' WHERE id = $1`, [verificationId]);
        await c.query(`UPDATE identity_verifications SET verified_name = NULL, verified_phone = NULL, provider_context_encrypted = NULL WHERE id = $1`, [verificationId]);
        await checkAtCommit(c);
      }));

    it("an unreferenced claim is purged together: delete the session, then the verification, in ONE transaction", () =>
      db.rolledBack(async (c) => {
        const u = await mkSubject(c);
        const s = await mkIdentitySession(c, u.id);
        await c.query(`DELETE FROM identity_sessions WHERE id = $1`, [s.id]);
        await c.query(`DELETE FROM identity_verifications WHERE id = $1`, [s.identity_verification_id]);
        await checkAtCommit(c);
        expect(await count(c, "identity_sessions", s.id as string)).toBe(0);
        expect(await count(c, "identity_verifications", s.identity_verification_id as string)).toBe(0);
      }));

    it("deleting only the session of a CONSUMED verification is refused at COMMIT; deleting the verification first fails at once (FK)", () =>
      db.rolledBack(async (c) => {
        const u = await mkSubject(c);
        const s = await mkIdentitySession(c, u.id);
        await expectCommitError(c, () => c.query(`DELETE FROM identity_sessions WHERE id = $1`, [s.id]), noSession);
        await expectDbError(c, `DELETE FROM identity_verifications WHERE id = $1`, [s.identity_verification_id], {
          code: PG.foreignKeyViolation,
          constraint: DB_CONSTRAINT.identitySessionVerificationFk,
        });
      }));

    it("verifications that never became a claim (PENDING / FAILED / EXPIRED) can be cleaned up at any time", () =>
      db.rolledBack(async (c) => {
        const u = await mkSubject(c);
        for (const status of ["PENDING", "FAILED", "EXPIRED"]) {
          const v = await verification(c, status === "PENDING" ? null : u.id, status);
          await c.query(`DELETE FROM identity_verifications WHERE id = $1`, [v.id]);
        }
        await checkAtCommit(c);
      }));
  });
});

// ═════════════════════════════ A-041: append-only history and the refund ledger (Q-029) ═════════════════════════════

describe("A-041 — append-only history and the refund ledger", () => {
  const appendOnly = (table: string, op: "UPDATE" | "DELETE") => ({
    code: PG.restrictViolation,
    message: new RegExp(op === "UPDATE" ? `${table} rows are append-only: UPDATE rejected` : `${table} rows are a ledger and are never deleted: DELETE rejected`),
  });

  async function fixtures(c: C) {
    const w = await mkWorld(c);
    const order = await orderFor(c, w);
    const item = await mkOrderItem(c, { orderId: order.id, sessionId: w.s1.id, sessionSeatId: w.s1a.id });
    const payment = await confirmOrder(c, order);
    const admin = await mkAdmin(c);
    const audit = await insert(c, "admin_audit_logs", { admin_id: admin.id, action: "REFUND_REQUESTED", target_type: "refunds" });
    const log = await insert(c, "payment_status_logs", { payment_id: payment.id, from_status: "READY", to_status: "SUCCEEDED", source: "API" });
    const refund = await mkRefund(c, { orderId: order.id, paymentId: payment.id });
    const refundItem = await insert(c, "refund_items", { refund_id: refund.id, order_id: order.id, order_item_id: item.id, amount: 100000 });
    return { w, order, item, payment, admin, audit, log, refund, refundItem };
  }

  it.each([
    ["admin_audit_logs", "audit"],
    ["payment_status_logs", "log"],
    ["refund_items", "refundItem"],
  ] as const)("%s is append-only: UPDATE and DELETE are rejected (single row and bulk); INSERT still works", (table, key) =>
    db.rolledBack(async (c) => {
      const f = await fixtures(c);
      const row = f[key] as { id: string };
      const set = { admin_audit_logs: "action = 'tampered'", payment_status_logs: "to_status = 'TAMPERED'", refund_items: "amount = 1" }[table];
      await expectDbError(c, `UPDATE ${table} SET ${set} WHERE id = $1`, [row.id], appendOnly(table, "UPDATE"));
      await expectDbError(c, `UPDATE ${table} SET ${set}`, [], appendOnly(table, "UPDATE")); // bulk
      await expectDbError(c, `DELETE FROM ${table} WHERE id = $1`, [row.id], appendOnly(table, "DELETE"));
      await expectDbError(c, `DELETE FROM ${table}`, [], appendOnly(table, "DELETE")); // bulk
      expect(await count(c, table, row.id)).toBe(1);
      // appending is the normal operation
      if (table === "admin_audit_logs") await insert(c, table, { admin_id: f.admin.id, action: "X", target_type: "orders" });
      if (table === "payment_status_logs") await insert(c, table, { payment_id: f.payment.id, to_status: "SUCCEEDED", source: "WEBHOOK" });
      if (table === "refund_items") {
        // a further item belongs to a further SEAT refund of the same total (SUM(items) = total_amount is checked at COMMIT)
        const item2 = await mkOrderItem(c, { orderId: f.order.id, sessionId: f.w.s1.id, sessionSeatId: f.w.s1b.id });
        const refund2 = await mkRefund(c, { orderId: f.order.id, paymentId: f.payment.id }, { total_amount: 100000 });
        await insert(c, table, { refund_id: refund2.id, order_id: f.order.id, order_item_id: item2.id, amount: 100000 });
      }
    }),
  );

  it("refunds: DELETE is rejected (single and bulk) but the status lifecycle and every other UPDATE still work", () =>
    db.rolledBack(async (c) => {
      const f = await fixtures(c);
      await expectDbError(c, `DELETE FROM refunds WHERE id = $1`, [f.refund.id], appendOnly("refunds", "DELETE"));
      await expectDbError(c, `DELETE FROM refunds`, [], appendOnly("refunds", "DELETE"));
      // REQUESTED -> VERIFYING -> COMPLETED, and FAILED -> VERIFYING, WITHDRAWN (DATABASE.md §12.4)
      await update(c, "refunds", f.refund.id, { status: "VERIFYING", pg_executed_by_admin_id: f.admin.id, provider_refund_id: "pg-refund-1" });
      await update(c, "refunds", f.refund.id, { status: "FAILED", failure_reason: "not found at the PG" });
      await update(c, "refunds", f.refund.id, { status: "VERIFYING" });
      await update(c, "refunds", f.refund.id, { status: "COMPLETED", verified_at: new Date(), completed_at: new Date() });
      const second = await mkRefund(c, { orderId: f.order.id, paymentId: f.payment.id }, { total_amount: 1 });
      await insert(c, "refund_items", { refund_id: second.id, order_id: f.order.id, order_item_id: f.item.id, amount: 1 }); // SUM(items) = total_amount
      await update(c, "refunds", second.id, { status: "WITHDRAWN" });
      expect(await count(c, "refunds", f.refund.id)).toBe(1);
    }));

  it("the same protection holds for statements that are really committed, and a rolled-back INSERT is simply not there", async () => {
    const setup = await db.pool.connect();
    let f: Awaited<ReturnType<typeof fixtures>>;
    try {
      await setup.query("BEGIN"); // a confirmed order (PRIMARY payment + PAID order) must be committed as ONE transaction (S3)
      f = await fixtures(setup);
      await setup.query("COMMIT");
    } finally {
      setup.release();
    }
    await expect(db.query(`UPDATE admin_audit_logs SET action = 'tampered' WHERE id = $1`, [f.audit.id])).rejects.toMatchObject({ code: PG.restrictViolation });
    await expect(db.query(`DELETE FROM payment_status_logs WHERE id = $1`, [f.log.id])).rejects.toMatchObject({ code: PG.restrictViolation });
    await expect(db.query(`DELETE FROM refunds WHERE id = $1`, [f.refund.id])).rejects.toMatchObject({ code: PG.restrictViolation });
    await expect(db.query(`UPDATE refund_items SET amount = 2 WHERE id = $1`, [f.refundItem.id])).rejects.toMatchObject({ code: PG.restrictViolation });
    expect((await db.query(`SELECT action FROM admin_audit_logs WHERE id = $1`, [f.audit.id])).rows[0].action).toBe("REFUND_REQUESTED");
    expect((await db.query(`SELECT amount::int a FROM refund_items WHERE id = $1`, [f.refundItem.id])).rows[0].a).toBe(100000);

    const c = await db.pool.connect();
    let id = "";
    try {
      await c.query("BEGIN");
      id = (await insert(c, "admin_audit_logs", { admin_id: f.admin.id, action: "ROLLED_BACK", target_type: "orders" })).id as string;
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
    expect((await db.query(`SELECT count(*)::int n FROM admin_audit_logs WHERE id = $1`, [id])).rows[0].n).toBe(0);
  });
});
