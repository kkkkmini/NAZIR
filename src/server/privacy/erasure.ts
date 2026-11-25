/**
 * Selective personal-data erasure (A-048). Clears personal-data COLUMNS; never deletes the row, because orders,
 * payments, quotas and sessions reference identity rows with RESTRICT FKs and the order/payment record has its own
 * retention purpose. Every erasure that cleared something writes one `pii_erasure_logs` row with the target, the
 * column NAMES, a reason code and the actor — never a value. Run inside the caller's transaction so the UPDATE and the
 * log commit together.
 *
 * Retention periods are NOT decided (E-006): this module only provides the mechanism; who calls it and when is decided
 * with the privacy policy before real sales.
 */
import type { SqlExecutor } from "../db/sql";

export type ErasureActor = { type: "SYSTEM" } | { type: "ADMIN"; adminId: string };

export interface ErasureResult {
  found: boolean;
  /** Column names that held a value and were cleared now (empty if already erased). */
  erased: string[];
}

const REASON = /^[A-Z][A-Z0-9_]{2,49}$/;

export class ErasureInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErasureInputError";
  }
}

async function log(tx: SqlExecutor, target: string, id: string, fields: string[], reason: string, actor: ErasureActor) {
  await tx(
    `INSERT INTO "pii_erasure_logs" ("target_type", "target_id", "fields", "reason", "actor_type", "admin_id")
     VALUES ($1, $2::uuid, $3::varchar(40)[], $4, $5, $6::uuid)`,
    [target, id, fields, reason, actor.type, actor.type === "ADMIN" ? actor.adminId : null],
  );
}

function checkReason(reason: string) {
  if (!REASON.test(reason)) throw new ErasureInputError("reason must be a code like RETENTION_EXPIRED (no free text)");
}

/** Generic: lock the row, find which of `columns` hold a value, clear them, set the marker, log. */
async function eraseColumns(
  tx: SqlExecutor,
  opts: { table: string; target: string; id: string; columns: string[]; marker: string; extraSet?: string },
  reason: string,
  actor: ErasureActor,
): Promise<ErasureResult> {
  checkReason(reason);
  const probe = opts.columns.map((c) => `("${c}" IS NOT NULL) AS "${c}"`).join(", ");
  const rows = await tx<Record<string, boolean>>(
    `SELECT ${probe} FROM "${opts.table}" WHERE "id" = $1::uuid FOR UPDATE`,
    [opts.id],
  );
  if (rows.length === 0) return { found: false, erased: [] };
  const erased = opts.columns.filter((c) => rows[0][c]);
  if (erased.length === 0) return { found: true, erased };
  const set = [...opts.columns.map((c) => `"${c}" = NULL`), `"${opts.marker}" = coalesce("${opts.marker}", now())`];
  if (opts.extraSet) set.push(opts.extraSet);
  await tx(`UPDATE "${opts.table}" SET ${set.join(", ")}, "updated_at" = now() WHERE "id" = $1::uuid`, [opts.id]);
  await log(tx, opts.target, opts.id, erased, reason, actor);
  return { found: true, erased };
}

/** Name, phone and the provider transaction context of one identity verification. */
export function eraseVerificationPii(tx: SqlExecutor, verificationId: string, reason: string, actor: ErasureActor) {
  return eraseColumns(
    tx,
    {
      table: "identity_verifications",
      target: "IDENTITY_VERIFICATION",
      id: verificationId,
      columns: ["verified_name", "verified_phone", "provider_context_encrypted"],
      marker: "pii_erased_at",
    },
    reason,
    actor,
  );
}

/**
 * The DI HMAC of one subject. Afterwards the person can no longer be recognised: a later verification creates a NEW
 * subject (so per-person purchase limits no longer link to past orders). Erase only when the retention policy says so.
 */
export function eraseSubjectKey(tx: SqlExecutor, subjectId: string, reason: string, actor: ErasureActor) {
  return eraseColumns(
    tx,
    { table: "identity_subjects", target: "IDENTITY_SUBJECT", id: subjectId, columns: ["subject_key_hash"], marker: "erased_at" },
    reason,
    actor,
  );
}

export const ORDER_CUSTOMER_FIELDS = ["customer_name", "customer_phone", "customer_email"] as const;

/** Chosen customer contact fields of one order; the order, its items and payments are untouched. */
export function eraseOrderCustomerPii(
  tx: SqlExecutor,
  orderId: string,
  fields: readonly (typeof ORDER_CUSTOMER_FIELDS)[number][],
  reason: string,
  actor: ErasureActor,
) {
  if (fields.length === 0 || fields.some((f) => !(ORDER_CUSTOMER_FIELDS as readonly string[]).includes(f)))
    throw new ErasureInputError("unknown order customer field");
  return eraseColumns(
    tx,
    { table: "orders", target: "ORDER", id: orderId, columns: [...new Set(fields)], marker: "customer_pii_erased_at" },
    reason,
    actor,
  );
}
