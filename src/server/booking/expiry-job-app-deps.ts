import "server-only";
import { bookingTxDeps } from "./app-deps";
import type { ExpiryJobDeps } from "./expiry-job-route";

/** Application wiring of the expiry job: CRON_SECRET from the environment, the shared booking transaction deps. */
export const expiryJobAppDeps: ExpiryJobDeps = {
  cronSecret: () => process.env.CRON_SECRET,
  tx: bookingTxDeps,
};
