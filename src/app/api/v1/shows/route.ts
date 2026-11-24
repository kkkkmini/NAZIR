import { connection } from "next/server";
import { appCatalogDeps } from "@/server/catalog/app-deps";
import { handleListShows } from "@/server/catalog/http";

/** Public show list (API_SPEC §4.0). `connection()`: always request time, never prerendered (Cache Components). */
export async function GET() {
  await connection();
  return handleListShows(appCatalogDeps);
}
