/**
 * HTTP layer of the public catalog API (API_SPEC §4.0, §4.3). Route files under src/app/api/v1 only wire these
 * handlers to the real database and clock, so the handlers can be tested against a real PostgreSQL without the
 * Next.js runtime.
 *
 * - Public, read-only, no cookies, no CSRF (GET only).
 * - `Cache-Control: no-store`: seat and session status change within minutes (7-minute holds, 3-minute payment
 *   protection), and the cache lifetime API_SPEC §4.3 allows ("짧은 캐시") is not decided yet (DECISIONS Q-031).
 * - Errors use the common body (API_SPEC §2): 400 VALIDATION_FAILED for a malformed id, 404 NOT_FOUND for a missing or
 *   non-public resource, 500 INTERNAL_ERROR (generic message) for anything else — never internal error text.
 * - Rate limiting by IP (API_SPEC §4.3, §7) is NOT implemented yet: its shared store and numbers are undecided (Q-013).
 */
import type { Clock } from "../lib/clock";
import { AppError, toErrorResponse } from "../lib/errors";
import { getPublicSeatMap, getPublicShow, listPublicSessions, listPublicShows, type CatalogDb } from "./public-catalog";

export interface CatalogDeps {
  db: CatalogDb;
  clock: Clock;
}

/** Deps are resolved lazily so that a configuration error (e.g. no DATABASE_URL) becomes a generic 500, not a crash. */
export type CatalogDepsProvider = () => CatalogDeps;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEADERS = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: HEADERS });
}

function assertUuid(value: string, name: string): void {
  if (!UUID.test(value)) throw new AppError("VALIDATION_FAILED", "요청 형식이 올바르지 않습니다.", { field: name });
}

const notFound = () => new AppError("NOT_FOUND", "요청한 정보를 찾을 수 없습니다.");

async function run(fn: () => Promise<unknown>): Promise<Response> {
  try {
    return json(await fn());
  } catch (e) {
    if (!(e instanceof AppError)) console.error("[catalog] request failed:", e instanceof Error ? e.name : typeof e);
    const { status, body } = toErrorResponse(e);
    return json(body, status);
  }
}

const list = <T>(items: T[]) => ({ items, pagination: { page: 1, limit: items.length, total: items.length } });

/** GET /api/v1/shows */
export function handleListShows(deps: CatalogDepsProvider): Promise<Response> {
  return run(async () => list(await listPublicShows(deps().db)));
}

/** GET /api/v1/shows/{showId} */
export function handleGetShow(params: { showId: string }, deps: CatalogDepsProvider): Promise<Response> {
  return run(async () => {
    assertUuid(params.showId, "showId");
    const { db, clock } = deps();
    const show = await getPublicShow(db, { id: params.showId }, await clock.now());
    if (!show) throw notFound();
    return show;
  });
}

/** GET /api/v1/shows/{showId}/sessions */
export function handleListSessions(params: { showId: string }, deps: CatalogDepsProvider): Promise<Response> {
  return run(async () => {
    assertUuid(params.showId, "showId");
    const { db, clock } = deps();
    const sessions = await listPublicSessions(db, params.showId, await clock.now());
    if (!sessions) throw notFound();
    return list(sessions);
  });
}

/** GET /api/v1/sessions/{sessionId}/seats */
export function handleGetSeats(params: { sessionId: string }, deps: CatalogDepsProvider): Promise<Response> {
  return run(async () => {
    assertUuid(params.sessionId, "sessionId");
    const { db, clock } = deps();
    const map = await getPublicSeatMap(db, params.sessionId, await clock.now());
    if (!map) throw notFound();
    return map;
  });
}
