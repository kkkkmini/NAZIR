import "server-only";
import { appCatalogDeps } from "./app-deps";
import { getPublicSeatMap, getPublicShow, listPublicShows } from "./public-catalog";

/**
 * Data for the public pages (server components). Same service and same rules as the API — the pages never call the
 * HTTP API of their own site. Each call reads DB time once (DbClock) and uses it for every status on the page.
 */
export async function loadHome() {
  const { db, clock } = appCatalogDeps();
  const shows = await listPublicShows(db);
  // U1: a single show → the home page IS that show's landing page; several → a list.
  if (shows.length === 1) return { kind: "single" as const, show: await getPublicShow(db, { id: shows[0].id }, await clock.now()) };
  return { kind: "list" as const, shows };
}

export async function loadShowBySlug(slug: string) {
  const { db, clock } = appCatalogDeps();
  return getPublicShow(db, { slug }, await clock.now());
}

export async function loadSeatMap(slug: string, sessionId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return null;
  const { db, clock } = appCatalogDeps();
  return getPublicSeatMap(db, sessionId, await clock.now(), slug);
}
