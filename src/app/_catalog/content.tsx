/**
 * Data-loading content of the public catalog pages (IA A1, A3-3 preview). Kept out of the `page.tsx` files so the
 * page-level behaviour — home single/list (U1), not-found, slug/session ownership — is testable against a real database
 * (tests/contract/schema/pages.test.ts). The pages wrap these in <Suspense> (Cache Components).
 * `_catalog` is a private folder: not a route.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { formatDateTime, formatKrw, HELD_SEAT_NOTICE } from "@/components/catalog/labels";
import { SalesStatusBadge, ShowOverview } from "@/components/catalog/ShowOverview";
import { SeatMap } from "@/components/seat-map/SeatMap";
import { loadHome, loadSeatMap, loadShowBySlug } from "@/server/catalog/page-data";

/** `/`: with one public show the home page is that show's landing page (U1); with several it lists them. */
export async function HomeContent() {
  await connection(); // request time: statuses depend on DB time and live holds
  const home = await loadHome();
  if (home.kind === "single" && home.show) return <ShowOverview show={home.show} />;
  const shows = home.kind === "list" ? home.shows : [];
  if (shows.length === 0) {
    return (
      <>
        <h1 className="text-2xl font-semibold">NAZIR</h1>
        <p className="text-neutral-600">공개된 공연이 아직 없습니다.</p>
      </>
    );
  }
  return (
    <>
      <h1 className="text-2xl font-semibold">공연</h1>
      <ul className="flex flex-col divide-y divide-neutral-200 border-y border-neutral-200" data-show-list>
        {shows.map((s) => (
          <li key={s.id} className="py-3">
            <Link href={`/shows/${s.slug}`} className="font-medium underline-offset-4 hover:underline">
              {s.title}
            </Link>
            <p className="text-sm text-neutral-600">
              {s.venue.name}
              {s.priceRange && ` · ${formatKrw(s.priceRange.min)}~`}
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}

/** `/shows/{slug}`: IA A1 for a given show. Unknown or non-public slug → not found. */
export async function ShowContent({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  await connection();
  const show = await loadShowBySlug(slug);
  if (!show) notFound();
  return <ShowOverview show={show} />;
}

/**
 * `/shows/{slug}/sessions/{sessionId}`: read-only seat status of one session. Not found when the session does not
 * exist, is not a UUID, or does not belong to the show in the URL.
 */
export async function SeatsContent({ params }: { params: Promise<{ slug: string; sessionId: string }> }) {
  const { slug, sessionId } = await params;
  await connection();
  const map = await loadSeatMap(slug, sessionId);
  if (!map) notFound();
  const { show, session } = map;
  return (
    <article className="flex flex-col gap-6" data-session-id={session.id} data-sales-status={session.status}>
      <header className="flex flex-col gap-2">
        <Link href={`/shows/${show.slug}`} className="text-sm text-neutral-600 underline-offset-4 hover:underline">
          ← {show.title}
        </Link>
        <h1 className="text-xl font-semibold">{formatDateTime(session.startsAt, show.venue.timezone)}</h1>
        <p className="flex flex-wrap items-center gap-3 text-sm text-neutral-700">
          <SalesStatusBadge status={session.status} />
          <span>
            잔여 {session.seats.available}석 / 전체 {session.seats.total}석
          </span>
          <span className="text-neutral-500">{show.venue.name}</span>
        </p>
        {session.status === "TEMPORARILY_UNAVAILABLE" && <p className="text-sm text-amber-900">{HELD_SEAT_NOTICE}</p>}
      </header>
      <SeatMap seats={map.seats} />
      <p className="text-sm text-neutral-600">
        좌석 배치는 임시 배치도입니다(실제 공연장 배치도 준비 중). 좌석 선택과 예매는 본인인증 연동 후 열립니다.
      </p>
    </article>
  );
}
