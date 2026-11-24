import { connection } from "next/server";
import { appCatalogDeps } from "@/server/catalog/app-deps";
import { handleListSessions } from "@/server/catalog/http";

/** Sessions of a public show with their computed sales status (API_SPEC §4.0). */
export async function GET(_req: Request, ctx: RouteContext<"/api/v1/shows/[showId]/sessions">) {
  await connection();
  return handleListSessions(await ctx.params, appCatalogDeps);
}
