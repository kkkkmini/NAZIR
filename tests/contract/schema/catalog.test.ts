/**
 * CAT-API-01..09 (Step 3): the public catalog API against a real PostgreSQL, through the app path
 * (`getPrisma()` + DbClock), with seat states built from REAL orders, items and holds.
 *
 * Expected states are fixed by construction (each seat is created for exactly one state), then compared with
 *   1. the API responses (seat map, session list, show detail),
 *   2. the counts the API reports, and
 *   3. the HTML the seat-map / badge components render from the same response (UI ⇄ DB consistency).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { cloneTestDb, destroyTestDb, resolveTestServer, type TestDb } from "./helpers/pg";
import { insert, mkIdentitySession, mkOrder, mkOrderItem, mkSeat, mkSessionSeat, mkShow, mkSubject, mkVenue } from "./helpers/fixtures";

const server = resolveTestServer();
let db: TestDb;

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const minutes = (m: number) => new Date(Date.now() + m * 60_000);
const DAY = 24 * 60;

let venue: Row;
let pub: Row;
let draft: Row;
let closed: Row;
const sessions: Record<string, Row> = {};
/** session key → (svg seat key → expected display status) */
const expected: Record<string, Record<string, string>> = {};

async function mkSessionRow(showId: string, key: string, o: Row = {}) {
  const s = await insert(db.pool, "show_sessions", { show_id: showId, venue_id: venue.id, starts_at: minutes(30 * DAY), sales_status: "ON_SALE", ...o });
  sessions[key] = s;
  expected[key] = {};
  return s;
}

/** A seat of `session` in the given state. HELD/SOLD/expired/released states are built from a real order + item + hold. */
async function mkSeatIn(sessionKey: string, state: "AVAILABLE" | "BLOCKED" | "SOLD" | "HELD_ACTIVE" | "HELD_CONFIRMING" | "EXPIRED_ACTIVE" | "RELEASED", price = 100000) {
  const session = sessions[sessionKey];
  const n = Object.keys(expected[sessionKey]).length + 1;
  const key = `${sessionKey}-${n}`;
  const seat = await mkSeat(db.pool, venue.id, { svg_seat_id: key, section_name: price >= 150000 ? "VIP" : "R", row_label: sessionKey, seat_number: String(n) });
  const ss = await mkSessionSeat(db.pool, session.id, seat.id, venue.id, { price, status: state === "BLOCKED" ? "BLOCKED" : "AVAILABLE" });
  if (state !== "AVAILABLE" && state !== "BLOCKED") {
    const subject = await mkSubject(db.pool);
    const idSession = await mkIdentitySession(db.pool, subject.id);
    const ref = { sessionId: session.id, subjectId: subject.id, identitySessionId: idSession.id };
    const orderOverrides: Row = { total_amount: price };
    if (state === "EXPIRED_ACTIVE") orderOverrides.hold_expires_at = minutes(-1);
    if (state === "HELD_CONFIRMING") Object.assign(orderOverrides, { status: "PAYMENT_CONFIRMING", hold_expires_at: minutes(-10), confirm_protected_until: minutes(2) });
    if (state === "RELEASED") Object.assign(orderOverrides, { status: "CANCELED", closed_at: new Date() });
    const order = await mkOrder(db.pool, ref, orderOverrides);
    const item = await mkOrderItem(db.pool, { orderId: order.id, sessionId: session.id, sessionSeatId: ss.id }, { price });
    if (state === "SOLD") {
      await db.query(`UPDATE session_seats SET status = 'SOLD', sold_order_item_id = $1, updated_at = now() WHERE id = $2`, [item.id, ss.id]);
    } else {
      const hold: Row = { order_id: order.id, order_item_id: item.id, session_seat_id: ss.id, status: "ACTIVE" };
      if (state === "HELD_CONFIRMING") hold.status = "CONFIRMING";
      if (state === "RELEASED") Object.assign(hold, { status: "RELEASED", released_reason: "USER_CANCELED", ended_at: new Date() });
      await insert(db.pool, "seat_holds", hold);
    }
  }
  expected[sessionKey][key] = { AVAILABLE: "AVAILABLE", BLOCKED: "BLOCKED", SOLD: "SOLD", HELD_ACTIVE: "HELD", HELD_CONFIRMING: "HELD", EXPIRED_ACTIVE: "AVAILABLE", RELEASED: "AVAILABLE" }[state];
}

beforeAll(async () => {
  db = await cloneTestDb(server, inject("templateDb"));
  venue = await mkVenue(db.pool, { name: "카탈로그 테스트 공연장", address: "테스트 주소" });
  pub = await mkShow(db.pool, venue.id, { title: "공개 공연", slug: "cat-public", status: "PUBLISHED", description: "설명" });
  draft = await mkShow(db.pool, venue.id, { title: "초안 공연", slug: "cat-draft", status: "DRAFT" });
  closed = await mkShow(db.pool, venue.id, { title: "종료 공연", slug: "cat-closed", status: "CLOSED" });

  await mkSessionRow(pub.id, "mixed");
  for (const s of ["AVAILABLE", "BLOCKED", "SOLD", "HELD_ACTIVE", "HELD_CONFIRMING", "EXPIRED_ACTIVE", "RELEASED"] as const) await mkSeatIn("mixed", s);
  await mkSeatIn("mixed", "AVAILABLE", 150000);

  await mkSessionRow(pub.id, "temp", { starts_at: minutes(31 * DAY) });
  await mkSeatIn("temp", "SOLD");
  await mkSeatIn("temp", "HELD_ACTIVE");

  await mkSessionRow(pub.id, "soldout", { starts_at: minutes(32 * DAY) });
  await mkSeatIn("soldout", "SOLD");
  await mkSeatIn("soldout", "SOLD");

  await mkSessionRow(pub.id, "expiredonly", { starts_at: minutes(33 * DAY) });
  await mkSeatIn("expiredonly", "SOLD");
  await mkSeatIn("expiredonly", "EXPIRED_ACTIVE");

  await mkSessionRow(pub.id, "blockedonly", { starts_at: minutes(34 * DAY) });
  await mkSeatIn("blockedonly", "BLOCKED");

  await mkSessionRow(pub.id, "paused", { starts_at: minutes(35 * DAY), sales_status: "PAUSED" });
  await mkSeatIn("paused", "AVAILABLE");

  await mkSessionRow(pub.id, "started", { starts_at: minutes(-60) });
  await mkSeatIn("started", "AVAILABLE");

  await mkSessionRow(pub.id, "canceled", { starts_at: minutes(36 * DAY), sales_status: "CANCELED" });
  await mkSeatIn("canceled", "AVAILABLE");

  await mkSessionRow(draft.id, "draft");
  await mkSeatIn("draft", "AVAILABLE");
  await mkSessionRow(closed.id, "closedshow");
  await mkSeatIn("closedshow", "AVAILABLE");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  delete (globalThis as { __nazirPrisma?: { $disconnect(): Promise<void> } }).__nazirPrisma;
  await destroyTestDb(db);
});

const EXPECTED_SESSION_STATUS: Record<string, string> = {
  mixed: "ON_SALE",
  temp: "TEMPORARILY_UNAVAILABLE",
  soldout: "SOLD_OUT",
  expiredonly: "ON_SALE",
  blockedonly: "SOLD_OUT", // current behaviour; the BLOCKED-only display policy is undecided (TEST_PLAN §2.4)
  paused: "PAUSED",
  started: "CLOSED",
  canceled: "CANCELED",
};

let app: {
  http: typeof import("../../../src/server/catalog/http");
  deps: import("../../../src/server/catalog/http").CatalogDepsProvider;
  SeatMap: typeof import("../../../src/components/seat-map/SeatMap").SeatMap;
  SalesStatusBadge: typeof import("../../../src/components/catalog/ShowOverview").SalesStatusBadge;
  prisma: { $disconnect(): Promise<void> };
};

beforeAll(async () => {
  vi.stubEnv("NAZIR_RUNTIME_ENV", "test");
  vi.stubEnv("DATABASE_URL", db.url);
  vi.stubEnv("DATABASE_URL_UNPOOLED", "");
  vi.stubEnv("PAYMENT_PROVIDER", "mock");
  vi.stubEnv("IDENTITY_PROVIDER", "mock");
  vi.resetModules();
  const { appCatalogDeps } = await import("../../../src/server/catalog/app-deps");
  const deps = appCatalogDeps();
  app = {
    http: await import("../../../src/server/catalog/http"),
    deps: () => deps,
    SeatMap: (await import("../../../src/components/seat-map/SeatMap")).SeatMap,
    SalesStatusBadge: (await import("../../../src/components/catalog/ShowOverview")).SalesStatusBadge,
    prisma: deps.db as unknown as { $disconnect(): Promise<void> },
  };
});
afterAll(() => app?.prisma.$disconnect());

async function get(res: Promise<Response>) {
  const r = await res;
  expect(r.headers.get("cache-control")).toBe("no-store");
  return { status: r.status, body: await r.json() };
}

const seats = (key: string) => get(app.http.handleGetSeats({ sessionId: sessions[key].id }, app.deps));

describe("CAT-API-01 show list and detail expose PUBLISHED shows only", () => {
  it("lists only the PUBLISHED show", async () => {
    const { status, body } = await get(app.http.handleListShows(app.deps));
    expect(status).toBe(200);
    expect(body.items.map((s: Row) => s.slug)).toEqual(["cat-public"]);
    expect(body.pagination).toEqual({ page: 1, limit: 1, total: 1 });
    expect(body.items[0]).toMatchObject({ title: "공개 공연", venue: { name: "카탈로그 테스트 공연장", timezone: "Asia/Seoul" }, priceRange: { min: 100000, max: 150000 } });
  });

  it.each([
    ["DRAFT", () => draft.id],
    ["CLOSED (provisional default, Q-030)", () => closed.id],
    ["unknown", () => "00000000-0000-4000-8000-000000000000"],
  ])("detail and sessions of a %s show answer 404", async (_label, id) => {
    for (const res of [app.http.handleGetShow({ showId: id() }, app.deps), app.http.handleListSessions({ showId: id() }, app.deps)]) {
      const { status, body } = await get(res);
      expect(status).toBe(404);
      expect(body.error.code).toBe("NOT_FOUND");
    }
  });

  it.each(["not-a-uuid", "1; DROP TABLE shows", ""])("a malformed id (%j) answers 400 VALIDATION_FAILED", async (id) => {
    const { status, body } = await get(app.http.handleGetShow({ showId: id }, app.deps));
    expect(status).toBe(400);
    expect(body.error).toMatchObject({ code: "VALIDATION_FAILED", details: { field: "showId" } });
  });
});

describe("CAT-API-02 seat map: every seat's status matches DATABASE.md §11.1", () => {
  it.each(Object.keys(EXPECTED_SESSION_STATUS))("session %s", async (key) => {
    const { status, body } = await seats(key);
    expect(status).toBe(200);
    const got = Object.fromEntries(body.seats.map((s: Row) => [s.key, s.status]));
    expect(got).toEqual(expected[key]);
  });

  it("expired ACTIVE and RELEASED holds are AVAILABLE, a CONFIRMING hold past its expiry is HELD", async () => {
    const { body } = await seats("mixed");
    const by = Object.fromEntries(body.seats.map((s: Row) => [s.key, s.status]));
    expect([by["mixed-5"], by["mixed-6"], by["mixed-7"]]).toEqual(["HELD", "AVAILABLE", "AVAILABLE"]);
  });

  it("seats of a DRAFT or CLOSED show, an unknown session and a malformed id are not served", async () => {
    for (const key of ["draft", "closedshow"]) expect((await seats(key)).status).toBe(404);
    expect((await get(app.http.handleGetSeats({ sessionId: "00000000-0000-4000-8000-000000000000" }, app.deps))).status).toBe(404);
    expect((await get(app.http.handleGetSeats({ sessionId: "x" }, app.deps))).status).toBe(400);
  });
});

describe("CAT-API-03 session status = sales-status.ts over the §11.1 counts (SOLD_OUT vs TEMPORARILY_UNAVAILABLE)", () => {
  it("each session's status in the seat-map response", async () => {
    for (const [key, want] of Object.entries(EXPECTED_SESSION_STATUS)) {
      const { body } = await seats(key);
      expect(body.session.status, key).toBe(want);
      expect(body.session.sellable, key).toBe(want === "ON_SALE");
    }
  });

  it("counts agree with the seats returned, and with the session list and show detail", async () => {
    const list = (await get(app.http.handleListSessions({ showId: pub.id }, app.deps))).body.items as Row[];
    const detail = (await get(app.http.handleGetShow({ showId: pub.id }, app.deps))).body;
    expect(list.map((s) => s.id)).toEqual(detail.sessions.map((s: Row) => s.id));
    for (const [key, session] of Object.entries(sessions)) {
      if (!(key in EXPECTED_SESSION_STATUS)) continue;
      const { body } = await seats(key);
      const tally = { available: 0, held: 0, sold: 0, blocked: 0 } as Record<string, number>;
      for (const s of body.seats) tally[(s.status as string).toLowerCase()]++;
      expect(body.session.seats).toEqual({ ...tally, total: body.seats.length });
      const fromList = list.find((s) => s.id === session.id)!;
      expect(fromList.status).toBe(body.session.status);
      expect(fromList.seats).toEqual(body.session.seats);
    }
    // sessions in start order
    expect(list.map((s) => s.startsAt)).toEqual([...list.map((s) => s.startsAt)].sort());
  });

  it("show detail: price table and range from the seats (bigint → number)", async () => {
    const { body } = await get(app.http.handleGetShow({ showId: pub.id }, app.deps));
    expect(body.priceTable).toEqual([
      { section: "VIP", price: 150000 },
      { section: "R", price: 100000 },
    ]);
    expect(typeof body.priceRange.min).toBe("number");
  });
});

describe("CAT-API-04 status follows the DATABASE clock, not a cached snapshot", () => {
  it("a valid hold that expires turns TEMPORARILY_UNAVAILABLE into ON_SALE on the next request", async () => {
    expect((await seats("temp")).body.session.status).toBe("TEMPORARILY_UNAVAILABLE");
    await db.query(
      `UPDATE orders SET hold_expires_at = now() - interval '1 second', updated_at = now()
        WHERE id IN (SELECT h.order_id FROM seat_holds h JOIN session_seats ss ON ss.id = h.session_seat_id
                      WHERE ss.show_session_id = $1 AND h.status = 'ACTIVE')`,
      [sessions.temp.id],
    );
    const after = (await seats("temp")).body;
    expect(after.session.status).toBe("ON_SALE");
    expect(after.seats.map((s: Row) => s.status).sort()).toEqual(["AVAILABLE", "SOLD"]);
    // restore for other tests
    await db.query(
      `UPDATE orders SET hold_expires_at = now() + interval '5 minutes', updated_at = now()
        WHERE id IN (SELECT h.order_id FROM seat_holds h JOIN session_seats ss ON ss.id = h.session_seat_id
                      WHERE ss.show_session_id = $1 AND h.status = 'ACTIVE')`,
      [sessions.temp.id],
    );
    expect((await seats("temp")).body.session.status).toBe("TEMPORARILY_UNAVAILABLE");
  });

  it("reading never writes: the catalog leaves orders, holds and seats untouched", async () => {
    const fingerprint = async () =>
      (await db.query<{ h: string }>(`
        SELECT md5(string_agg(x, ',' ORDER BY x)) AS h FROM (
          SELECT id::text || status || updated_at::text AS x FROM orders
          UNION ALL SELECT id::text || status || updated_at::text FROM seat_holds
          UNION ALL SELECT id::text || status || updated_at::text FROM session_seats) t`)).rows[0].h;
    const before = await fingerprint();
    for (const key of Object.keys(EXPECTED_SESSION_STATUS)) await seats(key);
    await get(app.http.handleGetShow({ showId: pub.id }, app.deps));
    expect(await fingerprint()).toBe(before);
  });
});

describe("CAT-API-05 only allow-listed public fields leave the API", () => {
  const ALLOWED = new Set([
    // list / detail
    "items", "pagination", "page", "limit", "total", "id", "slug", "title", "description", "posterUrl", "venue", "name",
    "address", "timezone", "salesOpensAt", "salesClosesAt", "priceRange", "min", "max", "sessions", "priceTable",
    "section", "price",
    // sessions
    "startsAt", "endsAt", "status", "sellable", "maxSeatsPerIdentity", "seats", "available", "held", "sold", "blocked",
    // seat map
    "show", "session", "seatMap", "version", "assetUrl", "key", "row", "number", "label",
  ]);
  const keysOf = (v: unknown, out = new Set<string>()): Set<string> => {
    if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.add(k), keysOf(x, out));
    return out;
  };

  it("no key outside the allow-list, and no order / item / subject id anywhere in the payloads", async () => {
    const payloads = [
      (await get(app.http.handleListShows(app.deps))).body,
      (await get(app.http.handleGetShow({ showId: pub.id }, app.deps))).body,
      (await get(app.http.handleListSessions({ showId: pub.id }, app.deps))).body,
      ...(await Promise.all(Object.keys(EXPECTED_SESSION_STATUS).map(async (k) => (await seats(k)).body))),
    ];
    const keys = new Set<string>();
    for (const p of payloads) keysOf(p, keys);
    expect([...keys].filter((k) => !ALLOWED.has(k))).toEqual([]);
    const secrets = (await db.query<{ id: string }>(`SELECT id::text FROM orders UNION ALL SELECT id::text FROM order_items UNION ALL SELECT id::text FROM identity_subjects UNION ALL SELECT id::text FROM venues`)).rows.map((r) => r.id);
    const text = JSON.stringify(payloads);
    for (const id of secrets) expect(text).not.toContain(id);
  });
});

describe("CAT-API-06 failures answer with the common error body and no internal detail", () => {
  it("a dependency failure is a generic 500", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom: import("../../../src/server/catalog/http").CatalogDepsProvider = () => {
      throw new Error("DATABASE_URL secret-detail");
    };
    const { status, body } = await get(app.http.handleListShows(boom));
    expect(status).toBe(500);
    expect(body).toEqual({ error: { code: "INTERNAL_ERROR", message: "일시적인 오류가 발생했습니다.", details: {} } });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret-detail");
    spy.mockRestore();
  });
});

describe("CAT-UI-01 the rendered seat map and status badges show exactly the database state", () => {
  it.each(Object.keys(EXPECTED_SESSION_STATUS))("session %s", async (key) => {
    const { body } = await seats(key);
    const html = renderToStaticMarkup(createElement(app.SeatMap, { seats: body.seats }));
    const rendered = Object.fromEntries([...html.matchAll(/data-seat-key="([^"]+)" data-status="([A-Z]+)"/g)].map((m) => [m[1], m[2]]));
    expect(rendered).toEqual(expected[key]);
    expect(html.includes("data-held-notice")).toBe(Object.values(expected[key]).includes("HELD"));
    const badge = renderToStaticMarkup(createElement(app.SalesStatusBadge, { status: body.session.status }));
    expect(badge).toContain(`data-sales-status="${EXPECTED_SESSION_STATUS[key]}"`);
  });

  it("badge text uses the decided wording for the three seat-availability states", () => {
    const text = (status: string) => renderToStaticMarkup(createElement(app.SalesStatusBadge, { status: status as never })).replace(/<[^>]+>/g, "");
    expect([text("ON_SALE"), text("TEMPORARILY_UNAVAILABLE"), text("SOLD_OUT")]).toEqual(["예매 가능", "일시 품절", "매진"]);
  });
});

describe("CAT-API-07 seat order: long seat numbers never fail, numeric row labels sort naturally (review M2)", () => {
  it("rows 9 → 10 → A → B → (no label); seats 2 → 10 → 12345678901; the rendered map keeps that order", async () => {
    const s = await insert(db.pool, "show_sessions", { show_id: pub.id, venue_id: venue.id, starts_at: minutes(40 * DAY), sales_status: "ON_SALE" });
    const layout: [string | null, string][] = [
      ["10", "1"],
      ["9", "12345678901"],
      ["B", "1"],
      [null, "1"],
      ["9", "10"],
      ["A", "1"],
      ["9", "2"],
    ];
    for (const [row, number] of layout) {
      const key = `ORD-${row ?? "none"}-${number}`;
      const seat = await mkSeat(db.pool, venue.id, { svg_seat_id: key, section_name: "ORD", row_label: row, seat_number: number });
      await mkSessionSeat(db.pool, s.id, seat.id, venue.id, { price: 100000 });
    }
    const res = await get(app.http.handleGetSeats({ sessionId: s.id }, app.deps));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.seats.map((x: Row) => x.key)).toEqual([
      "ORD-9-2",
      "ORD-9-10",
      "ORD-9-12345678901",
      "ORD-10-1",
      "ORD-A-1",
      "ORD-B-1",
      "ORD-none-1",
    ]);
    const htmlOut = renderToStaticMarkup(createElement(app.SeatMap, { seats: res.body.seats }));
    const rowLabels = [...htmlOut.matchAll(/<span class="[^"]*text-neutral-500[^"]*">([^<]+)<\/span><ul/g)].map((m) => m[1]);
    expect(rowLabels).toEqual(["9", "10", "A", "B", "-"]);
  });
});
