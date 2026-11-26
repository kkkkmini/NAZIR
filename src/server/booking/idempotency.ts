/**
 * Owner-scoped idempotency records (DATABASE.md §5.8, API_SPEC §6, A-010, A-053 ⑥).
 *
 * A record is unique per (scope, owner, key hash). The owner is the identity subject + browser binding: the same key
 * sent by another person or another browser is a DIFFERENT request and never sees this one's result.
 *
 * Atomic use inside ONE booking transaction (the resource and the record commit or roll back together):
 *   acquire  INSERT … ON CONFLICT (scope, owner_key_hash, idempotency_key_hash) DO NOTHING
 *            - inserted        → this request owns the key: do the work, then `complete`
 *            - conflict        → lock the existing row (FOR UPDATE) and decide:
 *                expired (expires_at <= now)       → taken over in place: this request owns the key again
 *                other request_hash                → 409 IDEMPOTENCY_KEY_REUSED
 *                COMPLETED, same request_hash      → replay the stored response (no new work, no rate-limit hit)
 *                anything else                     → 409 REQUEST_IN_PROGRESS (defensive: PROCESSING never commits)
 *   complete UPDATE the owned row to COMPLETED with the minimal response snapshot.
 * Concurrency: a second request with the same key WAITS on the unique index entry of the first (uncommitted) insert.
 * When the first commits it sees COMPLETED and replays; when the first rolls back (business rejection, failure) its
 * record disappears and the second proceeds as the owner. A business rejection (409/422) is therefore never stored:
 * retrying the same key re-evaluates it.
 *
 * Nothing secret is stored: the client key is hashed (domain-separated SHA-256), the owner is a hash, the response
 * snapshot carries no token and no personal data.
 */
import { createHash } from "node:crypto";
import type { SqlExecutor } from "../db/sql";
import { AppError } from "../lib/errors";

/** A-053 ⑥: records are kept for 24 hours (DB time). */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** Lease written with PROCESSING. The row is only visible after COMMIT (as COMPLETED), so this is informational. */
export const IDEMPOTENCY_LEASE_MS = 60 * 1000;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** At least 128 bits of base64url (22 chars), at most 128 chars. */
const OPAQUE = /^[A-Za-z0-9_-]{22,128}$/;

const sha = (label: string, value: string) => createHash("sha256").update(`nazir:${label}:`).update(value).digest("hex");

/**
 * `Idempotency-Key` header: a UUID v4 (any case) or an opaque base64url value of at least 128 bits. Anything else,
 * including a missing header, is 400 IDEMPOTENCY_KEY_INVALID. The raw value is only ever hashed.
 */
export function parseIdempotencyKey(header: string | null): string {
  const v = header?.trim() ?? "";
  if (!(UUID_V4.test(v) || OPAQUE.test(v))) {
    throw new AppError("IDEMPOTENCY_KEY_INVALID", "Idempotency-Key 헤더가 없거나 형식이 올바르지 않습니다.");
  }
  return UUID_V4.test(v) ? v.toLowerCase() : v;
}

export function idempotencyKeyHash(key: string): string {
  return sha("idempotency-key", key);
}

/**
 * Owner of a record: identity subject + browser binding (A-010). Both inputs are already stored in the database (the
 * subject id, and the binding as a SHA-256 hash), so a keyed HMAC would add no secrecy; a domain-separated SHA-256
 * also survives key rotation, which would otherwise break replays inside the 24-hour window.
 */
export function idempotencyOwnerHash(identitySubjectId: string, browserBindingHash: string): string {
  return sha("idempotency-owner", `${identitySubjectId}\u0000${browserBindingHash}`);
}

/** Stable JSON: object keys sorted recursively; arrays keep their order (callers canonicalise order-free lists). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  if (value === undefined) throw new Error("canonicalJson: undefined is not representable");
  return JSON.stringify(value);
}

export function requestHash(canonicalRequest: unknown): string {
  return sha("idempotency-request", canonicalJson(canonicalRequest));
}

export interface IdempotencyRef {
  scope: string;
  ownerKeyHash: string;
  keyHash: string;
  requestHash: string;
}

export type IdempotencyAcquisition =
  | { kind: "owner"; recordId: string; takenOver: boolean }
  | { kind: "replay"; recordId: string; resourceType: string | null; resourceId: string | null; responseStatus: number; responseBody: unknown };

interface ExistingRow {
  id: string;
  request_hash: string;
  status: string;
  resource_type: string | null;
  resource_id: string | null;
  response_status: number | null;
  response_body: unknown;
  expired: boolean;
}

export const keyReused = () => new AppError("IDEMPOTENCY_KEY_REUSED", "같은 Idempotency-Key로 다른 요청을 보낼 수 없습니다.");
export const requestInProgress = () => new AppError("REQUEST_IN_PROGRESS", "같은 요청을 처리하고 있습니다. 잠시 후 다시 확인해 주세요.");

/** Step 1 of an idempotent write. Run it inside the booking transaction, before any rate-limit hit or resource write. */
export async function acquireIdempotency(tx: SqlExecutor, ref: IdempotencyRef): Promise<IdempotencyAcquisition> {
  const inserted = await tx<{ id: string }>(
    `INSERT INTO "idempotency_records" ("scope", "owner_key_hash", "idempotency_key_hash", "request_hash", "status", "locked_until", "expires_at")
     VALUES ($1, $2, $3, $4, 'PROCESSING', now() + $5::int * interval '1 millisecond', now() + $6::int * interval '1 millisecond')
     ON CONFLICT ("scope", "owner_key_hash", "idempotency_key_hash") DO NOTHING
     RETURNING "id"`,
    [ref.scope, ref.ownerKeyHash, ref.keyHash, ref.requestHash, IDEMPOTENCY_LEASE_MS, IDEMPOTENCY_TTL_MS],
  );
  if (inserted.length === 1) return { kind: "owner", recordId: inserted[0].id, takenOver: false };

  const rows = await tx<ExistingRow>(
    `SELECT "id", "request_hash", "status", "resource_type", "resource_id", "response_status", "response_body",
            ("expires_at" <= now()) AS "expired"
       FROM "idempotency_records"
      WHERE "scope" = $1 AND "owner_key_hash" = $2 AND "idempotency_key_hash" = $3
      FOR UPDATE`,
    [ref.scope, ref.ownerKeyHash, ref.keyHash],
  );
  const r = rows[0];
  if (!r) throw requestInProgress(); // vanished between the two statements (purged): let the client retry
  if (r.expired) {
    // past the retention window the key is free again: reuse the row for this new request
    await tx(
      `UPDATE "idempotency_records"
          SET "request_hash" = $2, "status" = 'PROCESSING', "resource_type" = NULL, "resource_id" = NULL,
              "response_status" = NULL, "response_body" = NULL,
              "locked_until" = now() + $3::int * interval '1 millisecond', "expires_at" = now() + $4::int * interval '1 millisecond',
              "updated_at" = now()
        WHERE "id" = $1::uuid`,
      [r.id, ref.requestHash, IDEMPOTENCY_LEASE_MS, IDEMPOTENCY_TTL_MS],
    );
    return { kind: "owner", recordId: r.id, takenOver: true };
  }
  if (r.request_hash !== ref.requestHash) throw keyReused();
  if (r.status === "COMPLETED" && r.response_status !== null) {
    return { kind: "replay", recordId: r.id, resourceType: r.resource_type, resourceId: r.resource_id, responseStatus: r.response_status, responseBody: r.response_body };
  }
  throw requestInProgress();
}

/** Last step of an idempotent write, in the same transaction: store the minimal success snapshot. */
export async function completeIdempotency(
  tx: SqlExecutor,
  recordId: string,
  result: { resourceType: "ORDER" | "PAYMENT"; resourceId: string; responseStatus: number; responseBody: unknown },
): Promise<void> {
  const rows = await tx<{ id: string }>(
    `UPDATE "idempotency_records"
        SET "status" = 'COMPLETED', "resource_type" = $2, "resource_id" = $3::uuid, "response_status" = $4,
            "response_body" = $5::jsonb, "locked_until" = NULL, "updated_at" = now()
      WHERE "id" = $1::uuid AND "status" = 'PROCESSING'
      RETURNING "id"`,
    [recordId, result.resourceType, result.resourceId, result.responseStatus, JSON.stringify(result.responseBody)],
  );
  if (rows.length !== 1) throw new Error("completeIdempotency: the record is not owned by this transaction");
}
