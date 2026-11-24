import { connection } from "next/server";
import { appCatalogDeps } from "@/server/catalog/app-deps";
import { handleGetSeats } from "@/server/catalog/http";

/** Seats of a session with their computed display status — DATABASE.md §11.1 (API_SPEC §4.3). Read-only. */
export async function GET(_req: Request, ctx: RouteContext<"/api/v1/sessions/[sessionId]/seats">) {
  await connection();
  return handleGetSeats(await ctx.params, appCatalogDeps);
}
