/**
 * GET /api/v1/internal/jobs/expire-orders — scheduled hold expiry (Vercel Cron issues GET). Internal only:
 * `Authorization: Bearer <CRON_SECRET>` (../jobs/cron-auth.ts), otherwise 401; without a configured secret 503 and the
 * job does not run. Response: the run summary (counts only), `no-store`.
 */
import { checkCronAuthorization } from "../jobs/cron-auth";
import type { BookingTxDeps } from "./tx";
import { EXPIRY_BATCH_DEFAULT, runExpiryBatch } from "./expiry-job";

export interface ExpiryJobDeps {
  cronSecret: () => string | undefined;
  tx: () => BookingTxDeps;
  batchSize?: number;
}

const NO_STORE = { "Cache-Control": "no-store" };

export async function handleExpireOrdersJob(request: Request, deps: ExpiryJobDeps): Promise<Response> {
  const auth = checkCronAuthorization(request.headers, deps.cronSecret());
  if (!auth.ok) {
    if (auth.status === 503) console.error("[order-expiry-job] CRON_SECRET is not configured (or too short): job not run");
    return Response.json({ error: { code: auth.code, message: auth.status === 401 ? "unauthorized" : "job unavailable", details: {} } }, { status: auth.status, headers: NO_STORE });
  }
  try {
    const summary = await runExpiryBatch(deps.tx(), deps.batchSize ?? EXPIRY_BATCH_DEFAULT);
    return Response.json(summary, { status: 200, headers: NO_STORE });
  } catch (e) {
    console.error("[order-expiry-job] run failed:", e instanceof Error ? e.name : typeof e);
    return Response.json({ error: { code: "INTERNAL_ERROR", message: "job failed", details: {} } }, { status: 500, headers: NO_STORE });
  }
}
