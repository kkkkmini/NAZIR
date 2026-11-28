import "server-only";
import { appCatalogDeps } from "./app-deps";
import { getPublicShow, listPublicShows, type PublicShowDetail } from "./public-catalog";

/**
 * 관객 예매 화면(A1·A3-1·A3-3)이 쓰는 "현재 공연" — 백엔드 page-data.ts `loadHome`과 같은 규칙(U1):
 * 공개된 공연이 정확히 1개면 그 공연. 화면은 자기 사이트의 HTTP API를 부르지 않고 같은 서비스를 직접 쓴다.
 *
 * 데이터 출처(DB/fixture/없음)는 catalog-source.ts가 정한다. 이 함수는 출처가 "db"일 때만 부른다.
 * - "none" / "multiple": 공개 공연 0개 / 2개 이상. 단일 공연 화면이라 임의로 하나를 고르지 않는다.
 * - DB 오류는 삼키지 않고 던진다(페이지의 오류 처리로 간다). 빈 결과로 바꾸지 않는다.
 */
export type CurrentShowResult =
  | { kind: "none" }
  | { kind: "multiple" }
  | { kind: "show"; show: PublicShowDetail };

export async function loadCurrentShow(): Promise<CurrentShowResult> {
  const { db, clock } = appCatalogDeps();
  const shows = await listPublicShows(db);
  if (shows.length === 0) return { kind: "none" };
  if (shows.length > 1) return { kind: "multiple" };
  const show = await getPublicShow(db, { id: shows[0].id }, await clock.now());
  return show ? { kind: "show", show } : { kind: "none" };
}
