import { connection } from "next/server";
import { mockControlAppDeps } from "@/server/identity/callback-app-deps";
import { handleMockComplete } from "@/server/identity/mock-control";

/** Mock provider control route — 404 outside local/test (PRV-05, A-050). */
export async function POST(request: Request) {
  await connection();
  return handleMockComplete(request, mockControlAppDeps);
}
