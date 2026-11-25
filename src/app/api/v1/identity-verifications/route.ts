import { connection } from "next/server";
import { handleStartVerification } from "@/server/identity/start";
import { startAppDeps } from "@/server/identity/start-app-deps";

/** Start identity verification (API_SPEC §4.2). Request time only, never cached. */
export async function POST(request: Request) {
  await connection();
  return handleStartVerification(request, startAppDeps);
}
