"use client";

/**
 * IA A6: a failure while loading (e.g. the database is unreachable). Never shows internal error text.
 *
 * "다시 시도" uses `retry` (Next.js ≥ 16.3, stable; installed 16.4.6): it refreshes the route — the server components
 * are fetched again — and then clears the error. `reset` would only re-render the same failed content without
 * re-fetching, so a database outage would never recover from the button (review M1).
 */
export default function Error({ retry }: { error: unknown; retry: () => void }) {
  return (
    <>
      <h1 className="text-2xl font-semibold">정보를 불러오지 못했습니다</h1>
      <p className="text-neutral-600">잠시 후 다시 시도해 주세요.</p>
      <button type="button" onClick={() => retry()} className="self-start underline underline-offset-4">
        다시 시도
      </button>
    </>
  );
}
