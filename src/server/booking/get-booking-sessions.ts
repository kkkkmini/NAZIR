import "server-only";
import { connection } from "next/server";
import { nazir } from "@/content/nazir";
import { devPreviewEnabled } from "@/server/dev/dev-preview";
import type { BookingSessionsResult } from "./session-types";

/**
 * A3-1 회차 목록 조회.
 * - 실제 회차 API가 준비되기 전까지 운영 환경은 "not-connected"를 돌려준다.
 * - local/test에서만 [DEV] 가짜 데이터를 돌려준다. 가짜 데이터 모듈은 이때만 동적으로 불러온다.
 */
export async function getBookingSessions(): Promise<BookingSessionsResult> {
  await connection();
  if (!devPreviewEnabled()) return { kind: "not-connected" };
  const { devSessionFixture } = await import("@/server/dev/dev-session-fixture");
  return { kind: "dev-fixture", showTitle: nazir.title, sessions: devSessionFixture(new Date()) };
}
