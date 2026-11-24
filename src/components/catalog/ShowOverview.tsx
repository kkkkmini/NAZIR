/**
 * Show detail blocks (IA A1): product information, price table, sessions with their server-computed status.
 * Pure presentation of PublicShowDetail — no status is computed here.
 */
import Link from "next/link";
import type { PublicPriceTier, PublicSession, PublicShowDetail } from "@/server/catalog/public-catalog";
import type { SalesDisplayStatus } from "@/server/catalog/sales-status";
import { formatDateTime, formatKrw, HELD_SEAT_NOTICE, SALES_STATUS_LABEL } from "./labels";

const BADGE_CLASS: Record<Exclude<SalesDisplayStatus, "NOT_PUBLIC">, string> = {
  ON_SALE: "border-neutral-900 bg-neutral-900 text-white",
  TEMPORARILY_UNAVAILABLE: "border-amber-600 text-amber-900",
  SOLD_OUT: "border-neutral-400 text-neutral-600",
  UPCOMING: "border-neutral-400 text-neutral-700",
  PAUSED: "border-neutral-400 text-neutral-600",
  CLOSED: "border-neutral-300 text-neutral-500",
  CANCELED: "border-neutral-300 text-neutral-500 line-through",
};

export function SalesStatusBadge({ status }: { status: SalesDisplayStatus }) {
  if (status === "NOT_PUBLIC") return null; // never rendered: such a show is not public
  return (
    <span data-sales-status={status} className={`inline-block rounded-full border px-2 py-0.5 text-xs ${BADGE_CLASS[status]}`}>
      {SALES_STATUS_LABEL[status]}
    </span>
  );
}

export function PriceTable({ tiers }: { tiers: readonly PublicPriceTier[] }) {
  if (tiers.length === 0) return <p className="text-neutral-600">가격 정보가 아직 없습니다.</p>;
  return (
    <table className="w-full max-w-sm text-sm">
      <caption className="sr-only">좌석 등급별 가격</caption>
      <thead>
        <tr className="border-b border-neutral-200 text-left text-neutral-600">
          <th className="py-1 font-normal">좌석</th>
          <th className="py-1 text-right font-normal">가격</th>
        </tr>
      </thead>
      <tbody>
        {tiers.map((t) => (
          <tr key={`${t.section}-${t.price}`} className="border-b border-neutral-100">
            <td className="py-1">{t.section ?? "일반"}</td>
            <td className="py-1 text-right">{formatKrw(t.price)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SessionList({ showSlug, sessions, timeZone }: { showSlug: string; sessions: readonly PublicSession[]; timeZone: string }) {
  if (sessions.length === 0) return <p className="text-neutral-600">예정된 회차가 없습니다.</p>;
  return (
    <ul className="flex flex-col divide-y divide-neutral-200 border-y border-neutral-200">
      {sessions.map((s) => (
        <li key={s.id} data-session-id={s.id} data-sales-status={s.status} className="flex flex-wrap items-center justify-between gap-2 py-3">
          <div className="flex flex-col">
            <span>{formatDateTime(s.startsAt, timeZone)}</span>
            <span className="text-xs text-neutral-500">
              잔여 {s.seats.available}석 / 전체 {s.seats.total}석
            </span>
            {s.status === "TEMPORARILY_UNAVAILABLE" && <span className="text-xs text-amber-900">{HELD_SEAT_NOTICE}</span>}
          </div>
          <div className="flex items-center gap-3">
            <SalesStatusBadge status={s.status} />
            <Link href={`/shows/${showSlug}/sessions/${s.id}`} className="text-sm underline underline-offset-4">
              좌석 보기
            </Link>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ShowOverview({ show }: { show: PublicShowDetail }) {
  const tz = show.venue.timezone;
  return (
    <article className="flex flex-col gap-8" data-show-id={show.id}>
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{show.title}</h1>
        <p className="text-neutral-700">
          {show.venue.name}
          {show.venue.address && <span className="text-neutral-500"> · {show.venue.address}</span>}
        </p>
        {show.priceRange && (
          <p className="text-sm text-neutral-600">
            {show.priceRange.min === show.priceRange.max
              ? formatKrw(show.priceRange.min)
              : `${formatKrw(show.priceRange.min)} ~ ${formatKrw(show.priceRange.max)}`}
          </p>
        )}
        {(show.salesOpensAt || show.salesClosesAt) && (
          <p className="text-sm text-neutral-600">
            판매 기간: {show.salesOpensAt ? formatDateTime(show.salesOpensAt, tz) : "제한 없음"} ~{" "}
            {show.salesClosesAt ? formatDateTime(show.salesClosesAt, tz) : "각 회차 시작 전"}
          </p>
        )}
      </header>
      {show.description && <p className="whitespace-pre-line leading-7 text-neutral-800">{show.description}</p>}
      <section className="flex flex-col gap-3" aria-labelledby="price-heading">
        <h2 id="price-heading" className="text-lg font-semibold">
          가격
        </h2>
        <PriceTable tiers={show.priceTable} />
      </section>
      <section className="flex flex-col gap-3" aria-labelledby="sessions-heading">
        <h2 id="sessions-heading" className="text-lg font-semibold">
          회차
        </h2>
        <SessionList showSlug={show.slug} sessions={show.sessions} timeZone={tz} />
        <p className="text-sm text-neutral-600">
          예매(본인인증·좌석 선택·결제)는 준비 중입니다. 지금은 회차와 좌석 현황만 확인할 수 있습니다.
        </p>
      </section>
    </article>
  );
}
