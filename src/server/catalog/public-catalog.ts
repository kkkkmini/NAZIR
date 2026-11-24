/**
 * Public catalog read model (Step 3): shows, sessions and seats with their computed display status.
 *
 * - Read-only. Nothing here writes, locks or cleans up holds (expired holds are cleaned up by the order paths, Step 5).
 * - Status logic is NOT re-implemented here: every seat goes through `computeSeatDisplayStatus`/`countSeatDisplay`
 *   (DATABASE.md §11.1) and every session through `computeSalesStatus` (§11.11), with ONE `now` per call so seat
 *   counts and the session status agree.
 * - `now` comes from the caller's Clock (DbClock in the app). Hold expiry is compared with the order's
 *   `hold_expires_at` (A-007), read as epoch milliseconds so no session TimeZone can shift it.
 * - Only allow-listed public fields leave this module: no order, hold, payment or identity data, no internal
 *   `sold_order_item_id`, no venue ids (API_SPEC §4.3).
 * - Which shows are public is `PUBLIC_SHOW_STATUSES` — see the note there.
 */
import type { PrismaClient } from "../../generated/prisma/client";
import { LIVE_HOLD_STATUS } from "../db/constants";
import { computeSalesStatus, isSellableStatus, type SalesDisplayStatus } from "./sales-status";
import { computeSeatDisplayStatus, countSeatDisplay, type SeatDisplayInput, type SeatDisplayStatus } from "./seat-display";

/**
 * Shows visible to the public (list, detail, sessions, seats). PROVISIONAL DEFAULT, not an approved policy:
 * whether a CLOSED show stays publicly visible is undecided (DECISIONS Q-030). Until decided only PUBLISHED shows are
 * public — the conservative choice (a CLOSED show answers 404 exactly like a DRAFT one). Changing this one constant is
 * the whole switch; `computeSalesStatus` already reports a CLOSED show's sessions as CLOSED.
 */
export const PUBLIC_SHOW_STATUSES: readonly string[] = ["PUBLISHED"];

export type CatalogDb = Pick<PrismaClient, "show" | "showSession" | "$queryRaw">;

export interface SeatCounts {
  available: number;
  held: number;
  sold: number;
  blocked: number;
  total: number;
}

export interface PublicVenue {
  name: string;
  address: string | null;
  timezone: string;
}

export interface PublicShowSummary {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  posterUrl: string | null;
  venue: PublicVenue;
  salesOpensAt: string | null;
  salesClosesAt: string | null;
  /** Lowest / highest seat price over all sessions (KRW), null when the show has no seats yet. */
  priceRange: { min: number; max: number } | null;
}

export interface PublicSession {
  id: string;
  startsAt: string;
  endsAt: string | null;
  /** Computed display status (sales-status.ts). Only ON_SALE is sellable. */
  status: SalesDisplayStatus;
  sellable: boolean;
  maxSeatsPerIdentity: number;
  seats: SeatCounts;
}

export interface PublicPriceTier {
  section: string | null;
  price: number;
}

export interface PublicShowDetail extends PublicShowSummary {
  sessions: PublicSession[];
  /** Distinct (section, price) pairs over all sessions, highest price first. */
  priceTable: PublicPriceTier[];
}

export interface PublicSeat {
  /** session_seats.id — the identifier a later order request (Step 5) will refer to. */
  id: string;
  /** seats.svg_seat_id — the key that maps this seat onto a seat-map drawing (temporary grid now, venue SVG later). */
  key: string;
  section: string | null;
  row: string | null;
  number: string;
  label: string | null;
  price: number;
  status: SeatDisplayStatus;
}

export interface PublicSeatMap {
  show: { id: string; slug: string; title: string; venue: PublicVenue };
  session: PublicSession;
  seatMap: { version: string | null; assetUrl: string | null };
  seats: PublicSeat[];
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toPrice(v: bigint): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error("seat price is outside the safe integer range");
  return n;
}

function venueOf(v: { name: string; address: string | null; timezone: string }): PublicVenue {
  return { name: v.name, address: v.address, timezone: v.timezone };
}

interface SeatRow {
  session_id: string;
  id: string;
  status: string;
  price: bigint;
  svg_seat_id: string;
  section_name: string | null;
  row_label: string | null;
  seat_number: string;
  seat_label: string | null;
  holds: { status: string; expiresAtMs: number }[];
}

/**
 * Seats of the given sessions with their holds that MAY be valid (ACTIVE / CONFIRMING). Whether a hold is valid at
 * `now` is decided by seat-display.ts, not here; ended holds (RELEASED/EXPIRED/CONVERTED) never make a seat HELD, so
 * leaving them out is only a smaller result.
 */
async function loadSeatRows(db: CatalogDb, sessionIds: string[]): Promise<SeatRow[]> {
  if (sessionIds.length === 0) return [];
  const live = [...LIVE_HOLD_STATUS];
  return db.$queryRaw<SeatRow[]>`
    SELECT ss.show_session_id AS session_id, ss.id, ss.status, ss.price,
           s.svg_seat_id, s.section_name, s.row_label, s.seat_number, s.seat_label,
           COALESCE(
             json_agg(json_build_object('status', h.status,
                                        'expiresAtMs', floor(extract(epoch FROM o.hold_expires_at) * 1000)::bigint))
               FILTER (WHERE h.id IS NOT NULL),
             '[]'::json) AS holds
      FROM session_seats ss
      JOIN seats s ON s.id = ss.seat_id AND s.venue_id = ss.venue_id
      LEFT JOIN seat_holds h ON h.session_seat_id = ss.id AND h.status = ANY(${live}::text[])
      LEFT JOIN orders o ON o.id = h.order_id
     WHERE ss.show_session_id = ANY(${sessionIds}::uuid[])
     GROUP BY ss.id, s.id
     ORDER BY s.section_name NULLS LAST,
              -- rows: all-digit labels in numeric order (9 before 10) — in text order they already came before letters,
              -- so they stay first; every other label keeps its text order; no label last
              s.row_label IS NULL,
              CASE WHEN s.row_label ~ '^[0-9]+$' THEN s.row_label::numeric END NULLS LAST,
              s.row_label,
              -- seats: numeric value of the digits (numeric, not int: no overflow for long seat numbers), then the text
              NULLIF(regexp_replace(s.seat_number, '[^0-9]', '', 'g'), '')::numeric NULLS LAST, s.seat_number`;
}

function toSeatDisplayInput(r: SeatRow): SeatDisplayInput {
  return { status: r.status, holds: r.holds.map((h) => ({ status: h.status, holdExpiresAt: new Date(Number(h.expiresAtMs)) })) };
}

type ShowRow = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  posterUrl: string | null;
  status: string;
  salesOpensAt: Date | null;
  salesClosesAt: Date | null;
  venue: { name: string; address: string | null; timezone: string; seatMapVersion: string | null; seatMapAssetUrl: string | null };
};

type SessionRow = { id: string; startsAt: Date; endsAt: Date | null; salesStatus: string; maxSeatsPerIdentity: number };

function buildSessions(show: ShowRow, sessions: SessionRow[], seatRows: SeatRow[], now: Date): PublicSession[] {
  const bySession = new Map<string, SeatDisplayInput[]>();
  for (const r of seatRows) {
    const list = bySession.get(r.session_id) ?? [];
    list.push(toSeatDisplayInput(r));
    bySession.set(r.session_id, list);
  }
  return sessions.map((s) => {
    const c = countSeatDisplay(bySession.get(s.id) ?? [], now);
    const status = computeSalesStatus({
      show: { status: show.status, salesOpensAt: show.salesOpensAt, salesClosesAt: show.salesClosesAt },
      session: { salesStatus: s.salesStatus, startsAt: s.startsAt },
      seats: c,
      now,
    });
    return {
      id: s.id,
      startsAt: s.startsAt.toISOString(),
      endsAt: iso(s.endsAt),
      status,
      sellable: isSellableStatus(status),
      maxSeatsPerIdentity: s.maxSeatsPerIdentity,
      seats: { ...c, total: c.available + c.held + c.sold + c.blocked },
    };
  });
}

function summarize(show: ShowRow, seatRows: SeatRow[]): PublicShowSummary {
  const prices = seatRows.map((r) => toPrice(r.price));
  return {
    id: show.id,
    slug: show.slug,
    title: show.title,
    description: show.description,
    posterUrl: show.posterUrl,
    venue: venueOf(show.venue),
    salesOpensAt: iso(show.salesOpensAt),
    salesClosesAt: iso(show.salesClosesAt),
    priceRange: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
  };
}

const SHOW_SELECT = {
  id: true,
  slug: true,
  title: true,
  description: true,
  posterUrl: true,
  status: true,
  salesOpensAt: true,
  salesClosesAt: true,
  venue: { select: { name: true, address: true, timezone: true, seatMapVersion: true, seatMapAssetUrl: true } },
} as const;

const SESSION_SELECT = { id: true, startsAt: true, endsAt: true, salesStatus: true, maxSeatsPerIdentity: true } as const;

async function loadShow(db: CatalogDb, where: { id: string } | { slug: string }): Promise<ShowRow | null> {
  const show = await db.show.findFirst({ where: { ...where, status: { in: [...PUBLIC_SHOW_STATUSES] } }, select: SHOW_SELECT });
  return show;
}

async function loadSessionsWithSeats(db: CatalogDb, showId: string) {
  const sessions = await db.showSession.findMany({ where: { showId }, select: SESSION_SELECT, orderBy: [{ startsAt: "asc" }, { id: "asc" }] });
  const seatRows = await loadSeatRows(db, sessions.map((s) => s.id));
  return { sessions, seatRows };
}

/** Public shows ordered by title, then id (a stable order; there is one show in Phase 1). */
export async function listPublicShows(db: CatalogDb): Promise<PublicShowSummary[]> {
  const shows = await db.show.findMany({
    where: { status: { in: [...PUBLIC_SHOW_STATUSES] } },
    select: SHOW_SELECT,
    orderBy: [{ title: "asc" }, { id: "asc" }],
  });
  const out: PublicShowSummary[] = [];
  for (const show of shows) {
    const { seatRows } = await loadSessionsWithSeats(db, show.id);
    out.push(summarize(show, seatRows));
  }
  return out;
}

export async function getPublicShow(db: CatalogDb, where: { id: string } | { slug: string }, now: Date): Promise<PublicShowDetail | null> {
  const show = await loadShow(db, where);
  if (!show) return null;
  const { sessions, seatRows } = await loadSessionsWithSeats(db, show.id);
  const tiers = new Map<string, PublicPriceTier>();
  for (const r of seatRows) {
    const tier = { section: r.section_name, price: toPrice(r.price) };
    tiers.set(`${tier.section ?? ""}\u0000${tier.price}`, tier);
  }
  return {
    ...summarize(show, seatRows),
    sessions: buildSessions(show, sessions, seatRows, now),
    priceTable: [...tiers.values()].sort((a, b) => b.price - a.price || String(a.section).localeCompare(String(b.section))),
  };
}

export async function listPublicSessions(db: CatalogDb, showId: string, now: Date): Promise<PublicSession[] | null> {
  const show = await loadShow(db, { id: showId });
  if (!show) return null;
  const { sessions, seatRows } = await loadSessionsWithSeats(db, show.id);
  return buildSessions(show, sessions, seatRows, now);
}

/** `showSlug`, when given, must match the session's show (page URLs carry both). */
export async function getPublicSeatMap(db: CatalogDb, sessionId: string, now: Date, showSlug?: string): Promise<PublicSeatMap | null> {
  const session = await db.showSession.findUnique({ where: { id: sessionId }, select: { ...SESSION_SELECT, showId: true } });
  if (!session) return null;
  const show = await loadShow(db, showSlug === undefined ? { id: session.showId } : { slug: showSlug });
  if (!show || show.id !== session.showId) return null;
  const seatRows = await loadSeatRows(db, [session.id]);
  const [publicSession] = buildSessions(show, [session], seatRows, now);
  return {
    show: { id: show.id, slug: show.slug, title: show.title, venue: venueOf(show.venue) },
    session: publicSession,
    seatMap: { version: show.venue.seatMapVersion, assetUrl: show.venue.seatMapAssetUrl },
    seats: seatRows.map((r) => ({
      id: r.id,
      key: r.svg_seat_id,
      section: r.section_name,
      row: r.row_label,
      number: r.seat_number,
      label: r.seat_label,
      price: toPrice(r.price),
      status: computeSeatDisplayStatus(toSeatDisplayInput(r), now),
    })),
  };
}
