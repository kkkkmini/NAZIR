import "server-only";
import { getRuntimeConfig } from "@/server/config/server-config";

/**
 * 관객 예매 화면(A3-1·A3-3)의 공연·회차·좌석 데이터 출처. DB 연결 여부만으로 정하지 않는다.
 *
 * | NAZIR_RUNTIME_ENV | 출처 |
 * |---|---|
 * | staging / production | DATABASE_URL이 있으면 "db"(공개 카탈로그: PUBLISHED 공연만), 없으면 "none". [DEV] fixture는 절대 쓰지 않는다. |
 * | local / test | NAZIR_CATALOG_SOURCE=db 이고 DATABASE_URL이 있으면 "db"(테스트 DB 데이터로 표시), 그 밖에는 "dev-fixture"(기본값). |
 *
 * - seed는 local/test에서만 실행되고(seed-guard), test 환경은 `_test` DB만 쓰므로(database-config) 개발 seed가 운영 화면에 나올 경로가 없다.
 * - NAZIR_CATALOG_SOURCE는 local/test 전용 선택값이다. 운영에서는 읽지 않는다. 값이 "db"가 아니면 기본값(dev-fixture).
 * - 반드시 요청 시점(connection() 이후)에 호출한다.
 */
export type CatalogSource = { kind: "db"; testData: boolean } | { kind: "dev-fixture" } | { kind: "none" };

export function catalogSource(): CatalogSource {
  const env = getRuntimeConfig().runtimeEnv;
  const hasDb = Boolean(process.env.DATABASE_URL?.trim());
  if (env === "local" || env === "test") {
    return process.env.NAZIR_CATALOG_SOURCE?.trim() === "db" && hasDb ? { kind: "db", testData: true } : { kind: "dev-fixture" };
  }
  return hasDb ? { kind: "db", testData: false } : { kind: "none" };
}
