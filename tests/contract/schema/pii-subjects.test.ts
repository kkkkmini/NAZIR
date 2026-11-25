/**
 * SUBJ-01~08 and ERASE-01~08 (A-043, A-048) against a real PostgreSQL server.
 * DI and personal values are synthetic markers; tests assert they never reach a row or the erasure log.
 */
import { randomBytes } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { SqlExecutor } from "../../../src/server/db/sql";
import { encryptPii, decryptPii } from "../../../src/server/lib/crypto/pii";
import { DiUnavailableError } from "../../../src/server/lib/crypto/subject-key";
import { parseKeyring, type Keyring } from "../../../src/server/lib/secrets";
import { SubjectKeyConflictError, resolveSubjectInTx } from "../../../src/server/identity/subjects";
import { eraseOrderCustomerPii, eraseSubjectKey, eraseVerificationPii } from "../../../src/server/privacy/erasure";
import { mkAdmin, mkIdentitySession, mkOrder, mkVenue, mkShow, mkSession, mkSubject } from "./helpers/fixtures";
import { cloneTestDb, destroyTestDb, resolveTestServer, type TestDb } from "./helpers/pg";

const server = resolveTestServer();
let db: TestDb;
let pool: Pool;
beforeAll(async () => {
  db = await cloneTestDb(server, inject("templateDb"));
  pool = new Pool({ connectionString: db.url, max: 30 });
});
afterAll(async () => {
  await pool.end();
  await destroyTestDb(db);
});

const K1 = randomBytes(32).toString("base64url");
const K2 = randomBytes(32).toString("base64url");
const ring = (keys: string, cur: string, prefix = "NAZIR_SUBJECT_HMAC"): Keyring =>
  parseKeyring({ [`${prefix}_KEYS`]: keys, [`${prefix}_KEY_CURRENT`]: cur }, prefix, [])!;
const V1 = ring(`v1:${K1}`, "v1");
const V12 = ring(`v1:${K1},v2:${K2}`, "v2");
const V2only = ring(`v2:${K2}`, "v2");
const newDi = () => `DI-MARKER-${randomBytes(24).toString("base64url")}`;
const execOf = (c: Pool | PoolClient): SqlExecutor => async (sql, params) => (await c.query(sql, params)).rows;

async function tx<T>(fn: (exec: SqlExecutor, c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const r = await fn(execOf(c), c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
const subjectRow = async (id: string) =>
  (await db.query(`SELECT subject_key_type, key_version, subject_key_hash, erased_at FROM identity_subjects WHERE id = $1`, [id])).rows[0];

describe("SUBJ subject key (DI HMAC)", () => {
  it("SUBJ-01 first verification creates a DI subject under the current version; the raw DI is stored nowhere", async () => {
    const di = newDi();
    const r = await tx((e) => resolveSubjectInTx(e, V1, di));
    expect(r).toMatchObject({ created: true, rekeyed: false });
    const row = await subjectRow(r.id);
    expect(row).toMatchObject({ subject_key_type: "DI", key_version: 1, erased_at: null });
    expect(row.subject_key_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const dump = (await db.query(`SELECT row_to_json(s)::text t FROM identity_subjects s`)).rows.map((x) => x.t).join("\n");
    expect(dump).not.toContain(di);
    expect(dump).not.toContain("DI-MARKER");
  });

  it("SUBJ-02 the same DI finds the same subject; another DI gets another subject", async () => {
    const di = newDi();
    const a = await tx((e) => resolveSubjectInTx(e, V1, di));
    const b = await tx((e) => resolveSubjectInTx(e, V1, di));
    const c = await tx((e) => resolveSubjectInTx(e, V1, newDi()));
    expect(b).toEqual({ id: a.id, created: false, rekeyed: false });
    expect(c.id).not.toBe(a.id);
  });

  it("SUBJ-03 key rotation: a v1 subject is found with keyring {v1,v2}, moved to v2 (same id), then found with {v2} alone", async () => {
    const di = newDi();
    const a = await tx((e) => resolveSubjectInTx(e, V1, di));
    const b = await tx((e) => resolveSubjectInTx(e, V12, di));
    expect(b).toEqual({ id: a.id, created: false, rekeyed: true });
    const row = await subjectRow(a.id);
    expect(row.key_version).toBe(2);
    const c = await tx((e) => resolveSubjectInTx(e, V2only, di));
    expect(c).toEqual({ id: a.id, created: false, rekeyed: false });
    expect((await db.query(`SELECT count(*)::int n FROM identity_subjects WHERE id = $1`, [a.id])).rows[0].n).toBe(1);
  });

  it("SUBJ-04 removing a version too early is visible (would create a new subject) — rotation procedure is required", async () => {
    const di = newDi();
    const a = await tx((e) => resolveSubjectInTx(e, V1, di));
    const b = await tx((e) => resolveSubjectInTx(e, V2only, di)); // v1 dropped before migrating: documented misuse
    expect(b.created).toBe(true);
    expect(b.id).not.toBe(a.id);
    // ...and once both rows exist, a keyring that sees both refuses to guess
    await expect(tx((e) => resolveSubjectInTx(e, V12, di))).rejects.toBeInstanceOf(SubjectKeyConflictError);
  });

  it("SUBJ-05 concurrent first verifications of one person create exactly one subject (overlapping transactions)", async () => {
    const di = newDi();
    const results = await Promise.all(Array.from({ length: 20 }, () => tx((e) => resolveSubjectInTx(e, V1, di))));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it("SUBJ-06 rotation step 2: instances on {v1,v2}/current v1 and {v1,v2}/current v2 at once agree on one subject", async () => {
    const V12cur1 = ring(`v1:${K1},v2:${K2}`, "v1");
    for (const preexisting of [false, true]) {
      const di = newDi();
      if (preexisting) await tx((e) => resolveSubjectInTx(e, V1, di)); // a person first seen before the rotation
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => tx((e) => resolveSubjectInTx(e, i % 2 ? V12cur1 : V12, di))),
      );
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(preexisting ? 0 : 1);
      // ends on the newest version and the old-current instance never moved it back down
      expect((await subjectRow(results[0].id)).key_version).toBe(2);
      expect((await tx((e) => resolveSubjectInTx(e, V12cur1, di))).rekeyed).toBe(false);
      expect((await subjectRow(results[0].id)).key_version).toBe(2);
    }
  });

  it("SUBJ-06b skipping rotation step 1 ({v1}-only instance next to current v2) can duplicate — the procedure is mandatory", async () => {
    const di = newDi();
    const a = await tx((e) => resolveSubjectInTx(e, V1, di));
    await tx((e) => resolveSubjectInTx(e, V12, di)); // moved to v2
    const b = await tx((e) => resolveSubjectInTx(e, V1, di)); // cannot see v2
    expect(b.created).toBe(true);
    expect(b.id).not.toBe(a.id);
  });

  it("SUBJ-07 no DI → DiUnavailableError, nothing written (no CI/phone fallback)", async () => {
    const before = (await db.query(`SELECT count(*)::int n FROM identity_subjects`)).rows[0].n;
    for (const di of [undefined, null, "", "  "]) await expect(tx((e) => resolveSubjectInTx(e, V1, di))).rejects.toBeInstanceOf(DiUnavailableError);
    expect((await db.query(`SELECT count(*)::int n FROM identity_subjects`)).rows[0].n).toBe(before);
  });

  it("SUBJ-08 an erased subject never matches; the same DI afterwards becomes a new subject", async () => {
    const di = newDi();
    const a = await tx((e) => resolveSubjectInTx(e, V1, di));
    await tx((e) => eraseSubjectKey(e, a.id, "RETENTION_EXPIRED", { type: "SYSTEM" }));
    const b = await tx((e) => resolveSubjectInTx(e, V1, di));
    expect(b.created).toBe(true);
    expect(b.id).not.toBe(a.id);
  });
});

describe("ERASE selective personal-data erasure", () => {
  const PII = ring(`v1:${randomBytes(32).toString("base64url")}`, "v1", "NAZIR_PII_ENC");
  const NAME = "NAME-MARKER-홍길동";
  const PHONE = "PHONE-MARKER-01000000000";

  async function world() {
    const v = await mkVenue(db);
    const show = await mkShow(db, v.id);
    const s = await mkSession(db, show.id, v.id);
    const subject = await mkSubject(db);
    const is = await mkIdentitySession(db, subject.id);
    const verificationId = is.identity_verification_id as string;
    await db.query(`UPDATE identity_verifications SET verified_name = $2, verified_phone = $3, provider_context_encrypted = 'ctx' WHERE id = $1`, [
      verificationId,
      encryptPii(PII, "identity_verifications.verified_name", NAME),
      encryptPii(PII, "identity_verifications.verified_phone", PHONE),
    ]);
    const order = await mkOrder(db, { sessionId: s.id, subjectId: subject.id, identitySessionId: is.id }, {
      customer_name: encryptPii(PII, "orders.customer_name", NAME),
      customer_phone: encryptPii(PII, "orders.customer_phone", PHONE),
      customer_email: encryptPii(PII, "orders.customer_email", "mail@example.test"),
    });
    return { subject, verificationId, order };
  }
  const logs = async (id: string) =>
    (await db.query(`SELECT target_type, fields, reason, actor_type, admin_id, row_to_json(l)::text t FROM pii_erasure_logs l WHERE target_id = $1 ORDER BY created_at`, [id])).rows;

  it("ERASE-01 stored values are ciphertext and decrypt back", async () => {
    const { verificationId } = await world();
    const { rows } = await db.query(`SELECT verified_name FROM identity_verifications WHERE id = $1`, [verificationId]);
    expect(rows[0].verified_name).not.toContain("MARKER");
    expect(decryptPii(PII, "identity_verifications.verified_name", rows[0].verified_name)).toBe(NAME);
  });

  it("ERASE-02 verification PII is cleared although a session and an order reference it (RESTRICT FKs do not block)", async () => {
    const { verificationId } = await world();
    const r = await tx((e) => eraseVerificationPii(e, verificationId, "RETENTION_EXPIRED", { type: "SYSTEM" }));
    expect(r).toEqual({ found: true, erased: ["verified_name", "verified_phone", "provider_context_encrypted"] });
    const { rows } = await db.query(`SELECT verified_name, verified_phone, provider_context_encrypted, pii_erased_at, status FROM identity_verifications WHERE id = $1`, [verificationId]);
    expect(rows[0]).toMatchObject({ verified_name: null, verified_phone: null, provider_context_encrypted: null, status: "CONSUMED" });
    expect(rows[0].pii_erased_at).toBeInstanceOf(Date);
    // once erased, the DB refuses to put personal data back
    await expect(db.query(`UPDATE identity_verifications SET verified_name = 'x' WHERE id = $1`, [verificationId])).rejects.toMatchObject({ code: "23514" });
    // a second erasure is a no-op and writes no log
    expect(await tx((e) => eraseVerificationPii(e, verificationId, "RETENTION_EXPIRED", { type: "SYSTEM" }))).toEqual({ found: true, erased: [] });
    expect(await logs(verificationId)).toHaveLength(1);
  });

  it("ERASE-03 order customer fields are erased one by one; the order, its amount and status stay", async () => {
    const { order } = await world();
    const admin = await mkAdmin(db);
    expect(await tx((e) => eraseOrderCustomerPii(e, order.id, ["customer_email"], "USER_REQUEST", { type: "ADMIN", adminId: admin.id }))).toEqual({ found: true, erased: ["customer_email"] });
    let row = (await db.query(`SELECT customer_name, customer_phone, customer_email, customer_pii_erased_at, total_amount, status FROM orders WHERE id = $1`, [order.id])).rows[0];
    expect(row.customer_email).toBeNull();
    expect(row.customer_name).not.toBeNull();
    expect(row.customer_pii_erased_at).toBeInstanceOf(Date);
    await tx((e) => eraseOrderCustomerPii(e, order.id, ["customer_name", "customer_phone"], "RETENTION_EXPIRED", { type: "SYSTEM" }));
    row = (await db.query(`SELECT customer_name, customer_phone, total_amount, status FROM orders WHERE id = $1`, [order.id])).rows[0];
    expect(row).toMatchObject({ customer_name: null, customer_phone: null, total_amount: "100000", status: "PENDING" });
    const l = await logs(order.id);
    expect(l.map((x) => [x.fields, x.reason, x.actor_type])).toEqual([
      [["customer_email"], "USER_REQUEST", "ADMIN"],
      [["customer_name", "customer_phone"], "RETENTION_EXPIRED", "SYSTEM"],
    ]);
    expect(l[0].admin_id).toBe(admin.id);
  });

  it("ERASE-04 an order cannot drop name/phone without the erasure marker (CHECK)", async () => {
    const { order } = await world();
    await expect(db.query(`UPDATE orders SET customer_name = NULL WHERE id = $1`, [order.id])).rejects.toMatchObject({ code: "23514" });
  });

  it("ERASE-05 the DI HMAC is erased separately; the subject row stays for orders/quotas", async () => {
    const { subject, order } = await world();
    expect(await tx((e) => eraseSubjectKey(e, subject.id, "RETENTION_EXPIRED", { type: "SYSTEM" }))).toEqual({ found: true, erased: ["subject_key_hash"] });
    const row = await subjectRow(subject.id);
    expect(row.subject_key_hash).toBeNull();
    expect(row.erased_at).toBeInstanceOf(Date);
    expect((await db.query(`SELECT identity_subject_id FROM orders WHERE id = $1`, [order.id])).rows[0].identity_subject_id).toBe(subject.id);
    await expect(db.query(`UPDATE identity_subjects SET erased_at = NULL WHERE id = $1`, [subject.id])).rejects.toMatchObject({ code: "23514" });
  });

  it("ERASE-06 the erasure log holds field names only — never a value — and is append-only", async () => {
    const { verificationId, order, subject } = await world();
    await tx(async (e) => {
      await eraseVerificationPii(e, verificationId, "RETENTION_EXPIRED", { type: "SYSTEM" });
      await eraseOrderCustomerPii(e, order.id, ["customer_name", "customer_phone", "customer_email"], "RETENTION_EXPIRED", { type: "SYSTEM" });
      await eraseSubjectKey(e, subject.id, "RETENTION_EXPIRED", { type: "SYSTEM" });
    });
    const all = (await db.query(`SELECT row_to_json(l)::text t, id FROM pii_erasure_logs l WHERE target_id = ANY($1::uuid[])`, [[verificationId, order.id, subject.id]])).rows;
    expect(all).toHaveLength(3);
    const text = all.map((x) => x.t).join("\n");
    for (const marker of ["MARKER", "홍길동", "01000000000", "mail@example", "v1."]) expect(text).not.toContain(marker);
    await expect(db.query(`UPDATE pii_erasure_logs SET reason = 'X_X_X' WHERE id = $1`, [all[0].id])).rejects.toMatchObject({ code: "23001" });
    await expect(db.query(`DELETE FROM pii_erasure_logs WHERE id = $1`, [all[0].id])).rejects.toMatchObject({ code: "23001" });
  });

  it("ERASE-07 free-text reasons, unknown fields and inconsistent actors are refused (no PII can be smuggled into the log)", async () => {
    const { order } = await world();
    await expect(tx((e) => eraseOrderCustomerPii(e, order.id, ["customer_email"], "홍길동 요청", { type: "SYSTEM" }))).rejects.toThrow(/reason/);
    await expect(tx((e) => eraseOrderCustomerPii(e, order.id, ["total_amount" as never], "USER_REQUEST", { type: "SYSTEM" }))).rejects.toThrow(/field/);
    const ins = (fields: string[], reason: string, actor: string, admin: string | null) =>
      db.query(`INSERT INTO pii_erasure_logs (target_type, target_id, fields, reason, actor_type, admin_id) VALUES ('ORDER', $1, $2, $3, $4, $5)`, [order.id, fields, reason, actor, admin]);
    for (const args of [
      [["customer_email"], "has space", "SYSTEM", null],
      [["홍길동"], "USER_REQUEST", "SYSTEM", null],
      [[], "USER_REQUEST", "SYSTEM", null],
      [["customer_email"], "USER_REQUEST", "ADMIN", null],
    ] as const) await expect(ins([...args[0]], args[1], args[2], args[3])).rejects.toMatchObject({ code: "23514" });
  });

  it("ERASE-08 an unknown id is reported as not found and logs nothing", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    expect(await tx((e) => eraseVerificationPii(e, id, "RETENTION_EXPIRED", { type: "SYSTEM" }))).toEqual({ found: false, erased: [] });
    expect(await logs(id)).toHaveLength(0);
  });
});
