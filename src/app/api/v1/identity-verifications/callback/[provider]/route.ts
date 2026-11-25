import { connection } from "next/server";
import { handleIdentityCallback } from "@/server/identity/callback";
import { callbackAppDeps } from "@/server/identity/callback-app-deps";

/**
 * Identity provider return (API_SPEC §3.4, A-050). GET only for now: the Mock contract is GET; NICE's return method
 * (GET or POST, `method_type`) is unconfirmed, so POST is deliberately not exported yet (Next.js answers 405).
 */
export async function GET(request: Request, ctx: RouteContext<"/api/v1/identity-verifications/callback/[provider]">) {
  await connection();
  const { provider } = await ctx.params;
  return (await handleIdentityCallback(request, { provider }, callbackAppDeps)).response;
}
