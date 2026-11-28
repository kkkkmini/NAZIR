import "server-only";
import { connection } from "next/server";
import { nazir } from "@/content/nazir";
import { catalogSource } from "@/server/catalog/catalog-source";
import { loadCurrentShow } from "@/server/catalog/current-show";
import { devPreviewEnabled } from "@/server/dev/dev-preview";
import { API_SESSION_STATUSES, type ApiSession } from "@/server/api-contract/catalog";
import { toBookingSessions } from "./catalog-adapter";
import type { BookingSessionsResult } from "./session-types";

/**
 * A3-1 회차 목록 조회. 출처는 catalogSource()가 정한다.
 * - "db": 공개 카탈로그 서비스(getPublicShow, Step 3)의 회차를 toBookingSessions로 변환해 쓴다("live").
 *   공개 공연이 정확히 1개가 아니면 회차를 고르지 않는다("not-connected").
 * - "dev-fixture"(local/test 기본): [DEV] 가짜 데이터. "none": "not-connected".
 * DB 오류는 던진다(호출한 페이지의 오류 표시).
 */
export async function getBookingSessions(): Promise<BookingSessionsResult> {
  await connection();
  const source = catalogSource();
  if (source.kind === "none") return { kind: "not-connected" };
  if (source.kind === "dev-fixture") {
    if (!devPreviewEnabled()) return { kind: "not-connected" };
    const { devSessionFixture } = await import("@/server/dev/dev-session-fixture");
    return { kind: "dev-fixture", showTitle: nazir.title, sessions: devSessionFixture(new Date()) };
  }
  const current = await loadCurrentShow();
  if (current.kind === "show") {
    const { show } = current;
    // 서비스 타입(SalesDisplayStatus)에는 NOT_PUBLIC이 있지만 API 계약(API_SPEC §4.3)상 공개 응답에는 오지 않는다.
    // 다른 상태로 바꾸지 않고, 만약 오면 그 회차는 공개 대상이 아니므로 목록에서 뺀다.
    const sessions = show.sessions.flatMap((x) => (isApiSession(x) ? [x] : []));
    return { kind: "live", showId: show.id, showSlug: show.slug, showTitle: show.title, sessions: toBookingSessions({ ...show, sessions }), testData: source.testData };
  }
  return { kind: "not-connected" };
}

function isApiSession<T extends { status: string }>(s: T): s is T & ApiSession {
  return (API_SESSION_STATUSES as readonly string[]).includes(s.status);
}
