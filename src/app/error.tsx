"use client";

import { PageTitle, SiteShell } from "@/components/site/site-shell";

/**
 * IA A6: a failure while loading (e.g. the database is unreachable). Never shows internal error text.
 *
 * "다시 시도" uses `retry` (Next.js ≥ 16.3, stable; installed 16.4.6): it refreshes the route — the server components
 * are fetched again — and then clears the error. `reset` would only re-render the same failed content without
 * re-fetching, so a database outage would never recover from the button (review M1).
 */
export default function Error({ retry }: { error: unknown; retry: () => void }) {
  return (
    <SiteShell>
      <section className="flex flex-col items-start gap-5 border-t-2 border-char pt-8" data-error-page>
        <PageTitle title="정보를 불러오지 못했습니다" />
        <p className="text-[0.9375rem] text-char-2">잠시 후 다시 시도해 주세요.</p>
        <button
          type="button"
          onClick={() => retry()}
          className="inline-flex min-h-12 items-center justify-center rounded-[0.25rem] bg-btn px-7 text-[0.9375rem] font-semibold text-white transition-colors hover:bg-btn-hover"
        >
          다시 시도
        </button>
      </section>
    </SiteShell>
  );
}
