import { connection } from "next/server";
import { handleClaim } from "@/server/identity/session";
import { sessionAppDeps } from "@/server/identity/session-app-deps";

/** Exchange a VERIFIED identity verification for an identity session (API_SPEC §4.2, A-051). */
export async function POST(request: Request, ctx: RouteContext<"/api/v1/identity-verifications/[id]/claim">) {
  await connection();
  const { id } = await ctx.params;
  return handleClaim(request, { id }, sessionAppDeps);
}
