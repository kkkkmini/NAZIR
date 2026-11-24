/**
 * PAGE-01..04 (Step 3, review M4): page-level behaviour of the public catalog pages against a real PostgreSQL —
 * the data-loading components the pages render (src/app/_catalog/content.tsx) through the app path
 * (page-data → getPrisma() + DbClock).
 *
 * Only `connection()` is replaced (it needs a live Next.js request); `notFound()` is the real Next.js function, whose
 * thrown error is recognised with `isHTTPAccessFallbackError` — exactly what the Next.js not-found boundary checks.
 */
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { cloneTestDb, destroyTestDb, resolveTestServer, type TestDb } from "./helpers/pg";
import { mkSeat, mkSession, mkSessionSeat, mkShow, mkVenue } from "./helpers/fixtures";

vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

const server = resolveTestServer();
let db: TestDb;
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let venue: Row;
let showA: Row;
let sessionA: Row;
let content: typeof import("../../../src/app/_catalog/content");
let isNotFound: (e: unknown) => boolean;

beforeAll(async () => {
  db = await cloneTestDb(server, inject("templateDb"));
  venue = await mkVenue(db.pool, { name: "페이지 테스트 공연장" });
  showA = await mkShow(db.pool, venue.id, { title: "공연 A", slug: "page-a", status: "PUBLISHED" });
  sessionA = await mkSession(db.pool, showA.id, venue.id);
  const seat = await mkSeat(db.pool, venue.id, { svg_seat_id: "PA-1", section_name: "R", row_label: "A", seat_number: "1" });
  await mkSessionSeat(db.pool, sessionA.id, seat.id, venue.id, { price: 50000 });

  vi.stubEnv("NAZIR_RUNTIME_ENV", "test");
  vi.stubEnv("DATABASE_URL", db.url);
  vi.stubEnv("DATABASE_URL_UNPOOLED", "");
  vi.stubEnv("PAYMENT_PROVIDER", "mock");
  vi.stubEnv("IDENTITY_PROVIDER", "mock");
  vi.resetModules();
  content = await import("../../../src/app/_catalog/content");
  isNotFound = (await import("next/dist/client/components/http-access-fallback/http-access-fallback")).isHTTPAccessFallbackError;
});
afterAll(async () => {
  const prisma = (globalThis as { __nazirPrisma?: { $disconnect(): Promise<void> } }).__nazirPrisma;
  await prisma?.$disconnect();
  delete (globalThis as { __nazirPrisma?: unknown }).__nazirPrisma;
  vi.unstubAllEnvs();
  await destroyTestDb(db);
});

const html = (el: ReactElement) => renderToStaticMarkup(el);
const params = <T,>(p: T) => ({ params: Promise.resolve(p) });

async function expectNotFound(render: () => Promise<unknown>) {
  const err = await render().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, "expected the page to call notFound()").not.toBeNull();
  expect(isNotFound(err)).toBe(true);
}

describe("PAGE-01 home: one public show → that show's page, several → a list (U1)", () => {
  it("with exactly one public show the home page is the show's landing page", async () => {
    const out = html(await content.HomeContent());
    expect(out).toContain(`data-show-id="${showA.id}"`);
    expect(out).toContain("공연 A");
    expect(out).not.toContain("data-show-list");
    expect(out).toContain(`href="/shows/page-a/sessions/${sessionA.id}"`);
  });

  it("with several public shows the home page lists them; DRAFT and CLOSED shows are not listed", async () => {
    const showB = await mkShow(db.pool, venue.id, { title: "공연 B", slug: "page-b", status: "PUBLISHED" });
    const draft = await mkShow(db.pool, venue.id, { title: "초안", slug: "page-draft", status: "DRAFT" });
    const closed = await mkShow(db.pool, venue.id, { title: "종료", slug: "page-closed", status: "CLOSED" });
    try {
      const out = html(await content.HomeContent());
      expect(out).toContain("data-show-list");
      expect(out).toContain('href="/shows/page-a"');
      expect(out).toContain('href="/shows/page-b"');
      expect(out).not.toContain("page-draft");
      expect(out).not.toContain("page-closed");
      expect(out).not.toContain("data-show-id"); // not the single-show page
    } finally {
      await db.query(`DELETE FROM shows WHERE id = ANY($1::uuid[])`, [[showB.id, draft.id, closed.id]]);
    }
  });

  it("with no public show the home page says so (no crash)", async () => {
    await db.query(`UPDATE shows SET status = 'DRAFT', updated_at = now() WHERE id = $1`, [showA.id]);
    try {
      const out = html(await content.HomeContent());
      expect(out).toContain("공개된 공연이 아직 없습니다.");
    } finally {
      await db.query(`UPDATE shows SET status = 'PUBLISHED', updated_at = now() WHERE id = $1`, [showA.id]);
    }
  });
});

describe("PAGE-02 show page", () => {
  it("renders a public show by slug", async () => {
    const out = html(await content.ShowContent(params({ slug: "page-a" })));
    expect(out).toContain(`data-show-id="${showA.id}"`);
  });

  it.each([
    ["an unknown slug", "no-such-show"],
    ["a DRAFT show", "page-draft-2"],
  ])("calls notFound() for %s", async (_label, slug) => {
    if (slug === "page-draft-2") await mkShow(db.pool, venue.id, { title: "초안2", slug, status: "DRAFT" });
    await expectNotFound(() => content.ShowContent(params({ slug })));
  });
});

describe("PAGE-03 seat page: the session must exist AND belong to the show in the URL", () => {
  it("renders the seat map for the session of that show", async () => {
    const out = html(await content.SeatsContent(params({ slug: "page-a", sessionId: sessionA.id })));
    expect(out).toContain(`data-session-id="${sessionA.id}"`);
    expect(out).toMatch(/data-seat-key="PA-1" data-status="AVAILABLE"/);
  });

  it("calls notFound() when the session belongs to ANOTHER public show (slug/session mismatch)", async () => {
    const other = await mkShow(db.pool, venue.id, { title: "다른 공연", slug: "page-other", status: "PUBLISHED" });
    const otherSession = await mkSession(db.pool, other.id, venue.id);
    try {
      await expectNotFound(() => content.SeatsContent(params({ slug: "page-a", sessionId: otherSession.id })));
      await expectNotFound(() => content.SeatsContent(params({ slug: "page-other", sessionId: sessionA.id })));
      // control: the right pair renders
      const out = html(await content.SeatsContent(params({ slug: "page-other", sessionId: otherSession.id })));
      expect(out).toContain(`data-session-id="${otherSession.id}"`);
    } finally {
      await db.query(`DELETE FROM show_sessions WHERE id = $1`, [otherSession.id]);
      await db.query(`DELETE FROM shows WHERE id = $1`, [other.id]);
    }
  });

  it.each([
    ["an unknown session", () => ({ slug: "page-a", sessionId: "00000000-0000-4000-8000-000000000000" })],
    ["a malformed session id", () => ({ slug: "page-a", sessionId: "not-a-uuid" })],
    ["an unknown show slug", () => ({ slug: "no-such-show", sessionId: sessionA.id })],
  ])("calls notFound() for %s", async (_label, p) => {
    await expectNotFound(() => content.SeatsContent(params(p())));
  });
});

describe("PAGE-04 without a database the pages fail (into the error boundary), they do not render empty content", () => {
  it("DATABASE_URL missing: the page content rejects with the configuration error", async () => {
    const saved = (globalThis as { __nazirPrisma?: unknown }).__nazirPrisma;
    delete (globalThis as { __nazirPrisma?: unknown }).__nazirPrisma;
    vi.stubEnv("DATABASE_URL", "");
    try {
      await expect(content.HomeContent()).rejects.toThrow(/DATABASE_URL is not set/);
      await expect(content.SeatsContent(params({ slug: "page-a", sessionId: sessionA.id }))).rejects.toThrow(/DATABASE_URL is not set/);
    } finally {
      vi.stubEnv("DATABASE_URL", db.url);
      (globalThis as { __nazirPrisma?: unknown }).__nazirPrisma = saved;
    }
  });
});
