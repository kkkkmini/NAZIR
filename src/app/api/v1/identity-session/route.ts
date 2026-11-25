import { connection } from "next/server";
import { handleDeleteSession, handleGetSession } from "@/server/identity/session";
import { sessionAppDeps } from "@/server/identity/session-app-deps";

/** Current identity session (API_SPEC §4.0, A-051). */
export async function GET(request: Request) {
  await connection();
  return handleGetSession(request, sessionAppDeps);
}

export async function DELETE(request: Request) {
  await connection();
  return handleDeleteSession(request, sessionAppDeps);
}
