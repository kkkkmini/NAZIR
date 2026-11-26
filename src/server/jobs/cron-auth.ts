/**
 * Authentication of scheduled job endpoints (internal, never public).
 *
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when the project defines the CRON_SECRET environment variable;
 * any other scheduler must send the same header. The secret must be at least 32 characters. Without a usable secret the
 * endpoint refuses to run (fail-closed, 503) — it never runs unauthenticated. The comparison is constant-time and the
 * secret is never logged or echoed.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const MIN_CRON_SECRET_LENGTH = 32;

export type CronAuthResult = { ok: true } | { ok: false; status: 401 | 503; code: "JOB_UNAUTHORIZED" | "JOB_UNAVAILABLE" };

const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();

export function checkCronAuthorization(headers: Headers, secret: string | undefined): CronAuthResult {
  const s = secret?.trim();
  if (!s || s.length < MIN_CRON_SECRET_LENGTH) return { ok: false, status: 503, code: "JOB_UNAVAILABLE" };
  const got = headers.get("authorization") ?? "";
  // hash both sides: equal-length buffers for timingSafeEqual, no length leak
  return timingSafeEqual(digest(got), digest(`Bearer ${s}`)) ? { ok: true } : { ok: false, status: 401, code: "JOB_UNAUTHORIZED" };
}
