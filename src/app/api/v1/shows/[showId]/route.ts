import { connection } from "next/server";
import { appCatalogDeps } from "@/server/catalog/app-deps";
import { handleGetShow } from "@/server/catalog/http";

/** Public show detail with its sessions and price table (API_SPEC §4.0). */
export async function GET(_req: Request, ctx: RouteContext<"/api/v1/shows/[showId]">) {
  await connection();
  return handleGetShow(await ctx.params, appCatalogDeps);
}
