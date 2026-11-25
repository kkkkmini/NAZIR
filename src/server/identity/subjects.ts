/**
 * Find-or-create the identity subject for a DI (A-043), across HMAC key versions.
 *
 * MUST run inside a transaction (the caller's — e.g. the identity callback that also marks the verification VERIFIED):
 * it takes transaction-scoped advisory locks on every candidate hash so that two requests for the same person — even
 * from instances that disagree on the current key version during a rotation, as long as they share at least one
 * version — serialize, and never create two subjects.
 *
 * 1. lock every candidate (version, hash), in a fixed order
 * 2. look the subject up under all candidates (erased subjects have no hash and never match)
 * 3. found under the current version → return it
 *    found under an older version   → move it to the current version (same row, same id), return it
 *    found more than once           → SubjectKeyConflictError (two rows for one DI: data problem, never merged silently)
 *    not found                      → insert under the current version
 *
 * Rotation procedure (required — SUBJ-04/06 show what breaks otherwise):
 *   1. deploy the new version to EVERY instance's keyring with *_KEY_CURRENT still on the old version;
 *   2. only then switch *_KEY_CURRENT to the new version;
 *   3. remove the old version only after no row is left on it (migrated by lookups, or erased).
 * An instance that does not know the new version cannot see rows already moved to it and would create a duplicate.
 */
import type { SqlExecutor } from "../db/sql";
import { SUBJECT_KEY_TYPE, subjectKeyCandidates } from "../lib/crypto/subject-key";
import type { Keyring } from "../lib/secrets";

export class SubjectKeyConflictError extends Error {
  constructor() {
    super("more than one identity subject matches this DI under different key versions");
    this.name = "SubjectKeyConflictError";
  }
}

export interface ResolvedSubject {
  id: string;
  created: boolean;
  /** true when the row was found under an older key version and moved to the current one */
  rekeyed: boolean;
}

export async function resolveSubjectInTx(tx: SqlExecutor, ring: Keyring, di: unknown): Promise<ResolvedSubject> {
  const candidates = subjectKeyCandidates(ring, di); // throws DiUnavailableError, no fallback
  const current = candidates.find((c) => c.current)!;
  const lockOrder = [...candidates].sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  for (const c of lockOrder) {
    await tx(`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtextextended($1, 0))` /* not the void value itself: Prisma cannot decode a void column */, [`identity_subject:${SUBJECT_KEY_TYPE}:${c.hash}`]);
  }
  const rows = await tx<{ id: string; key_version: number }>(
    `SELECT s."id", s."key_version" FROM "identity_subjects" s
       JOIN unnest($2::smallint[], $3::text[]) AS c(v, h) ON s."key_version" = c.v AND s."subject_key_hash" = c.h
      WHERE s."subject_key_type" = $1
      FOR UPDATE OF s`,
    [SUBJECT_KEY_TYPE, candidates.map((c) => c.version), candidates.map((c) => c.hash)],
  );
  if (rows.length > 1) throw new SubjectKeyConflictError();
  if (rows.length === 1) {
    const row = rows[0];
    if (Number(row.key_version) >= current.version) return { id: row.id, created: false, rekeyed: false };
    await tx(
      `UPDATE "identity_subjects" SET "key_version" = $2, "subject_key_hash" = $3, "updated_at" = now() WHERE "id" = $1::uuid`,
      [row.id, current.version, current.hash],
    );
    return { id: row.id, created: false, rekeyed: true };
  }
  const inserted = await tx<{ id: string }>(
    `INSERT INTO "identity_subjects" ("subject_key_type", "key_version", "subject_key_hash") VALUES ($1, $2, $3) RETURNING "id"`,
    [SUBJECT_KEY_TYPE, current.version, current.hash],
  );
  return { id: inserted[0].id, created: true, rekeyed: false };
}
