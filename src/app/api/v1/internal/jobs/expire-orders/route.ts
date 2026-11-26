import { connection } from "next/server";
import { expiryJobAppDeps } from "@/server/booking/expiry-job-app-deps";
import { handleExpireOrdersJob } from "@/server/booking/expiry-job-route";

/** Scheduled hold expiry (internal; Bearer CRON_SECRET). Request time only, never cached. */
export async function GET(request: Request) {
  await connection();
  return handleExpireOrdersJob(request, expiryJobAppDeps);
}
