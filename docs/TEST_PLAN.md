# NAZIR — TEST PLAN

> 문서 버전: 1.2 · 기준일: 2026-11-15 · 목적: 좌석·금전·구매 한도·개인정보 무결성 검증 및 공개 Go/No-Go
> 관련 문서: `DATABASE.md`, `API_SPEC.md`, `ARCHITECTURE.md`, `IMPLEMENTATION_PLAN.md`, `DECISIONS.md`, `PROVIDERS.md`
> 이전 버전 원문: `docs/archive/v1.0/TEST_PLAN`, `docs/archive/v1.1/TEST_PLAN.md`

## 1. 전략 및 환경

등급: P0는 실제 판매 전 필수, P1은 공개 운영 필수(수동 대체 시 사용자 승인으로 예외 가능), P2는 후속(`IMPLEMENTATION_PLAN.md` §2).

종류: Unit, Integration, Concurrency, Schema Contract, E2E, Security, Resilience, Load.

- PostgreSQL 동시성·partial index·CHECK·복합 FK는 **실제 PostgreSQL**에서 검증. SQLite 대체 금지.
- PG/인증은 mock adapter(장애 주입 포함, ARCHITECTURE §6.3) 후 실제 sandbox.
- 개발/테스트/운영 DB 분리, 전용 fixture.
- 시간은 Clock 인터페이스로 주입(7분·3분·재조회 백오프·세션 TTL 검증).
- 동시성 테스트는 실제 병렬 커넥션으로 수행하고, 경합 지점에 barrier/지연 주입을 사용한다.
- 실제 개인정보·카드정보를 로그에 남기지 않는다.
- 각 테스트는 기대 결과와 함께 **DB 불변식**(아래 §1.1)을 사후 검사한다.

### 1.1 공통 사후 불변식

| ID | 불변식 |
|---|---|
| INV-1 | 좌석당 `ACTIVE`/`CONFIRMING` hold ≤ 1 |
| INV-2 | 좌석당 유효 티켓(`ISSUED`/`USED`) ≤ 1, `SOLD` ⇔ `sold_order_item_id` 존재 |
| INV-3 | `purchase_quotas.counted_seats` = 규칙상 파생 값, ≤ `seat_limit`(≤ 4) |
| INV-4 | (주체, 회차)당 활성 주문 ≤ 1 |
| INV-5 | 주문당 진행 중 결제 ≤ 1, `PAID` 주문은 `confirmed_payment_id` 보유 |
| INV-6 | 결제별 `refunded_amount` ≤ `approved_amount` |
| INV-7 | hold·항목·티켓·환불 항목의 주문·좌석·회차 소속 일치 |
| INV-8 | `order_items` 생성 후 변경·삭제 없음 |
| INV-9 | `SOLD` 좌석에 live(`ACTIVE`/`CONFIRMING`) hold가 없다 *(DB 보장 2026-11-25 — guard A/B 트리거, §3.2 S2-*, DATABASE §19.14)* |
| INV-10 | 종료 주문(`CANCELED`/`EXPIRED`/`UNFULFILLED`/`REFUNDED`)에 live hold가 없고, 유효 티켓은 `SOLD` 좌석·소유 항목과 일치한다 *(DB 미보장 — Step 9 정합성 검사, S5)* |
| INV-11 | `PRIMARY` 결제 ⇔ 주문의 확정 결제, 주문당 `PRIMARY` ≤ 1, `PRIMARY` 승인 금액 = 요청 금액 = 주문 총액 *(DB 보장 — 사후 확인용)* |
| INV-12 | 주문 `total_amount` = 항목 가격 합계, 항목 수 1~`max_seats_per_identity` *(DB 미보장 — 주문 생성 트랜잭션·정합성 검사)* |

## 2. P0 스키마 계약 / Migration

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| MIG-01 | 빈 PostgreSQL에 `migrate deploy` | 성공 |
| MIG-02 | 필수 partial unique 존재 검사(`seat_holds`, `orders` 활성, `payments` 진행 중, `tickets` 유효, `review_cases` open) | 모두 존재, predicate 일치 |
| MIG-03 | 필수 CHECK 존재 검사(quota, 결제 금액·환불, SOLD 소유, 수단, 상태값) | 모두 존재 |
| MIG-04 | 필수 복합 FK 존재 검사(DATABASE §14) | 모두 존재 |
| MIG-05 | `seats` NULLS NOT DISTINCT unique | 구역/열 NULL 좌석 중복 삽입 거부 |
| MIG-06 | 이후 migration 생성 시 raw SQL 객체 DROP 여부 | DROP 문 없음(CI 검사) |
| MIG-07 | 타입 검사: 시각 컬럼 `timestamptz`, 금액 `bigint` | 일치 |
| MIG-08 | 소속 불일치 직접 삽입(다른 회차 좌석 항목, 다른 공연장 좌석의 회차 좌석, 다른 주문 hold) | FK 위반으로 거부 |
| MIG-09 | 모든 migration이 `BEGIN; … COMMIT;`으로 감싸짐(정적 검사, 트랜잭션 불가 문장은 `-- no-transaction:` 표지) | 위반 없음, 검사기가 래퍼 누락·중간 COMMIT·`CONCURRENTLY`를 검출 |
| MIG-10 | **실제 migration 파일에 마지막 문장 실패를 주입**해 실제 Prisma CLI로 적용 | 실패한 migration의 테이블·인덱스·제약·트리거·함수가 하나도 남지 않고 앞선 migration은 유지, `migrate deploy`는 `P3009`로 차단, 수정 후 `migrate resolve --rolled-back` + 재배포 성공, 전체 계약 통과. 음성 대조군: 래퍼 없이 같은 실패 시 27개 테이블이 남음 |
| MIG-11 | 결제·주문 정합성(S3): 정상 `PRIMARY`+`PAID`(문장 순서 무관), `FAILED`/`CANCELED`/`READY`/`CONFIRMING`/`UNKNOWN`/`EXCESS` 결제를 확정 결제로 지정, 승인 금액 ≠ 주문 총액인 `PRIMARY`, 한 주문에 `PRIMARY` 2건, `EXCESS` 여러 건, 다른 주문 결제 지정, 요청 금액 ≠ 주문 총액, **UPDATE 우회**(강등·재지정·분리·승격) | 정상·`EXCESS` 다건은 허용, 나머지는 즉시 또는 **COMMIT에서** 거부(제약 이름 확인). 실제 COMMIT 시험 포함 |
| MIG-12 | 주문↔쿼터 FK(S4): 쿼터 행 없음, 다른 주체, 다른 회차, 정상, 쿼터 행 삭제·키 변경, 쿼터 행 없는 상태의 2커넥션 동시 예약(QTA-07·QTA-20의 DB 수준) | 정상만 허용, 동시 요청은 쿼터 행에서 직렬화, 한도는 CHECK가 최종 방어 |
| MIG-13 | 인증 세션 ↔ 원 인증(Q-024, A-040): 다른 주체, 다른 purpose, **다른 브라우저 바인딩**, 미검증(주체 NULL) 인증, 정상, 세션 후 원 인증의 주체·용도·바인딩 변경, 세션 재지정 | 정상만 허용, 인증 1건당 세션 1개 유지 (구현: `consistency` Q-024 + `ledger-claims` A-040) |
| MIG-14 | `method_type = OTHER`(Q-022): `SUCCEEDED`+`EXCESS`만 허용, `READY`/`CONFIRMING`/`UNKNOWN`/`FAILED`/`CANCELED`/`PRIMARY` 거부, 허용 외 카드사·간편결제사 문자열 기록, `PRIMARY` 승격 UPDATE 거부 | 위 규칙대로 |
| MIG-15 | `order_items` UPDATE·DELETE 차단(Q-023), 주문 생성 트랜잭션 롤백 시 항목이 남지 않음 | UPDATE·DELETE 모두 SQLSTATE `23001`, 롤백은 정상 |
| MIG-16 | 타임스탬프 출처(D3): DB 기본값 `CURRENT_TIMESTAMP`, raw SQL의 DB 시각(트랜잭션 시작), raw UPDATE는 `updated_at` 불변, Prisma Client는 앱 시각을 명시 전송 | 실측과 일치(Prisma 업그레이드 시 변하면 실패) |
| MIG-17 | 결제 원장 보존(A-038): 참조 없는 `READY`/`CONFIRMING`/`UNKNOWN`/`FAILED`/`CANCELED`/`SUCCEEDED`+`EXCESS` 결제와 확정 `PRIMARY`·로그가 있는 결제의 DELETE(개별·벌크·실제 커밋), 상태 전이·INSERT·UPDATE는 계속 허용, 롤백된 생성은 행을 남기지 않음 | DELETE는 모두 SQLSTATE `23001`, 정상 전이는 허용 |
| MIG-18 | `SUCCEEDED`의 양수 `approved_amount`와 **`approved_at`**(A-038): INSERT·UPDATE·NULL·0·전이 우회. `SUCCEEDED`+`approved_at` NULL 거부, 값이 있으면 허용, 정상 전이(`READY`→`CONFIRMING`→`SUCCEEDED`) 허용, `SUCCEEDED`→`approved_at` NULL UPDATE 거부 | `SUCCEEDED`는 승인 금액·승인 시각 필수, 다른 상태는 NULL 허용, 승인된 결제는 환불 기록 가능 |
| MIG-19 | 결제수단 요청값·원문(Q-027, A-039): 생성 시 `requested_method_type` 기록, 요청값 변경(`CARD`↔`EASY_PAY`, `OTHER`로 변경, `NULL`) 거부, `CARD→CARD`·`EASY_PAY→EASY_PAY` 승인, `CARD→OTHER`·`EASY_PAY→OTHER`(`method_type`만 변경, 요청값 유지) 허용, `OTHER`+원문 NULL 거부, 원문 위험 값(공백·9자리 이상 숫자·`@`·제어문자) 거부, 원문은 정규화 없이 그대로 저장, 요청값을 건드리지 않는 일반 UPDATE 허용, 승인 UPDATE 후에도 요청값 유지(서비스 순수 함수 `paymentApprovalMethodColumns`와 DB가 함께) **(보강 2026-11-18)** 미승인 결제(`READY`/`CONFIRMING`/`UNKNOWN`/`FAILED`/`CANCELED`)의 `method_type` ≠ 요청값은 INSERT·UPDATE(단독·벌크·상태 전이 동시) 모두 거부, 일치하는 생성·전이는 허용, `SUCCEEDED`는 `CARD→CARD`/`CARD→EASY_PAY`/`CARD→OTHER`/`EASY_PAY→OTHER` 등 PG 결과대로 허용(EXCESS·PRIMARY 모두), 불일치 승인 결제를 미승인 상태로 되돌리는 UPDATE 거부 | 요청값은 생성 후 불변, `OTHER`는 원문 필수, **미승인 결제의 `method_type`은 요청값과 같다(`SUCCEEDED`에서만 다를 수 있음)**, 나머지 전이는 기존 규칙대로 허용 |
| MIG-20 | 인증 세션 무결성(Q-028, A-040): `PENDING`·`FAILED`·`EXPIRED` 인증의 세션 거부(COMMIT), `VERIFIED`로 남은 인증의 세션 거부, 세션 없는 `CONSUMED` 거부, 다른 바인딩 세션 거부(FK), 세션 있는 `CONSUMED`를 `VERIFIED`/`PENDING`/`FAILED`로 되돌리기 거부, **claim 두 가지 문장 순서(세션 먼저·상태 먼저) 모두 허용**, `REVOKED`/`EXPIRED` 세션 허용, `PENDING`→`FAILED`→`EXPIRED` 정상 전이 허용, 보존·삭제 시나리오(세션→인증 순서 동시 삭제 허용, 세션만 삭제 거부, 인증만 삭제 FK 거부, 주문이 참조하는 세션 삭제 RESTRICT, 개인정보 컬럼 UPDATE 허용, `PENDING`/`FAILED`/`EXPIRED` 인증 삭제 허용) | 지연 trigger가 COMMIT에서 판정, 정상 claim은 막지 않음 |
| MIG-21 | 원장성 테이블 보호(Q-029, A-041): `admin_audit_logs`·`payment_status_logs`·`refund_items`의 UPDATE·DELETE(개별·벌크·**실제 COMMIT**) 거부, `refunds` DELETE 거부·UPDATE(상태 전이) 허용, **범위 밖**(`tickets`·`orders`·`seat_holds`·`order_status_logs`·`seat_status_logs`·`payment_webhook_events`)은 차단되지 않음을 명시적으로 확인 | 차단 대상은 SQLSTATE `23001`, 범위 밖 테이블은 기존 동작 유지 |
| MIG-22 | 승인 증거 불변(PR #2 P1, A-042): `SUCCEEDED` 결제(`PRIMARY`·`EXCESS`)의 `approved_amount`·`approved_at`·`method_type`·`provider_method_raw`(값→다른 값·값→NULL)·`easy_pay_provider`·`card_company`·`merchant_payment_ref`·`provider_payment_id`·`pg_transaction_id`·`provider`·`currency`·`order_id`·`status`(`FAILED`/`CANCELED`/`READY`/`CONFIRMING`/`UNKNOWN` 강등, 승인 값 지우기 동반 포함) UPDATE 거부(단건·벌크·실제 COMMIT), 거부 후 행 불변. 허용: `refunded_amount`(전액 환불까지)·`last_verified_at`·`requery_count`·`next_requery_at`·`unknown_since`·`confirm_started_at`·`failure_*`·`updated_at`·값이 같은 쓰기, `READY`/`CONFIRMING`/`UNKNOWN` → `SUCCEEDED` 전이(모든 증거를 한 UPDATE로 기록), `SUCCEEDED` 이전 결제의 모든 컬럼 UPDATE, `PRIMARY` ⇔ 주문 일관성(`checkAtCommit`) | 증거는 SQLSTATE `23001`(`payments_approved_evidence_immutable`)로 거부, 운영 컬럼 UPDATE는 허용 |
| MIG-23 | 환불 핵심 불변과 `SEAT` 합계(PR #2 P1, A-042): `total_amount`·`refund_type`·`provider`·`payment_id`·`order_id`(+`payment_id`)·`requested_by_admin_id`(NULL→값·값→값·값→NULL)·`created_at`·`id` UPDATE 거부(단건·벌크·실제 COMMIT), `order_id` 단독 변경은 복합 FK가 먼저 판정. 허용: 상태 전이 전체(`REQUESTED`→`VERIFYING`→`FAILED`→`VERIFYING`→`COMPLETED`, `WITHDRAWN`)와 `provider_refund_id`·`pg_executed_by_admin_id`·`verified_at`·`completed_at`·`failure_reason`·`reason`·`updated_at`·값이 같은 쓰기, 완료 후에도 핵심 불변. `SEAT` 환불: 항목 합계 = 총액(항목 1개·여러 개·환불 후 항목 INSERT) 허용, 항목 없음·합계 부족·합계 초과·커밋된 환불에 항목 추가는 **COMMIT에서** 거부(`refunds_seat_items_total_ck`), `PAYMENT_EXCESS`는 항목 없을 때만 허용(`refunds_excess_no_items_ck`), 실제 COMMIT 실패 시 환불·항목이 남지 않음 | 핵심 변경은 `23001`(`refunds_core_immutable`), 합계 위반은 COMMIT에서 `23514` |
| MIG-24 | Prisma CLI 환경 가드(PR #2 P2, A-042): 실제 `prisma validate`로 환경×DB 10가지(local+dev 허용, test+test 허용, test+dev 거부, local/staging/production+test 거부, 누락·미지 값은 production 취급, production+dev 허용), `DATABASE_URL` 없이 `validate` 동작, 거부된 `migrate deploy`·`migrate reset`이 **시작 전에** 종료되고 DB에 테이블이 생기지 않으며 기존 데이터가 남음, 허용 조합의 `migrate deploy` 정상. **Shadow DB(2026-11-18 보강)**: local/staging/production/누락/미지 환경 + 개발 DB + `_test` Shadow DB 거부, test + `_test` DB + 비test Shadow DB 거부, 모든 명령(`migrate deploy` 포함)에서 거부, 주 DB와 같은 DB(동일 URL·loopback 다른 표기) 거부 후 데이터 보존, local + 비test Shadow·test + `_test` Shadow 허용(양성 대조: 허용된 명령은 Shadow 안의 sentinel 테이블을 실제로 지움 → 거부된 명령이 지우지 않았음이 의미 있음), Shadow 미설정 시 `validate`·`migrate status` 정상·`migrate diff --from-migrations`는 Prisma 자체 오류. 단위 테스트(DB 불필요)가 같은 규칙, 빈 문자열·공백·형식 오류 Shadow, Shadow만 설정, 비밀번호 비노출을 확인 | 거부는 명령 실행 전, DB·Shadow DB 불변 |

**Step 2 구현 상태 (2026-11-16):** MIG-01~16 구현·통과. 실행: `TEST_DATABASE_URL=postgresql://… npm run test:db` (실제 PostgreSQL 15+ 필수, 미설정 시 건너뛰지 않고 실패). CI는 `.github/workflows/ci.yml`의 `db` job(`postgres:16` 서비스 컨테이너). 파일과 범위:

| 파일 | 내용 |
|---|---|
| `tests/contract/schema/migrations.test.ts` | MIG-01(빈 DB에 `migrate deploy`, 재실행 멱등), MIG-02, MIG-03·**MIG-03b**(DB CHECK 어휘 = `src/server/db/constants.ts`), MIG-04(모든 FK RESTRICT 포함), MIG-05(카탈로그), MIG-06(정적 DROP 검사 + 합성 SQL로 검사기 검증), MIG-07, **DRIFT-01**, `DB_CONSTRAINT` 이름이 실제 DB 객체인지 검증, 음성 대조군(일부러 망가뜨린 DB에서 검사기가 위반을 검출) |
| `tests/contract/schema/migration-safety.test.ts` | **MIG-09**(모든 migration 트랜잭션 래핑 + 검사기 검증), **MIG-10**(실제 Prisma CLI, 실제 migration에 실패 주입, 롤백·`P3009`·`resolve --rolled-back`·재시도, 래퍼 없는 음성 대조군) |
| `tests/contract/schema/integrity.test.ts` | MIG-05(동작), MIG-08, 규칙 1~14의 동작 증명(SQLSTATE·제약 이름 단언), 실제 2커넥션 동시 INSERT, QTA-18·QTA-19·ORD-17 중 DB 수준 부분 |
| `tests/contract/schema/consistency.test.ts` | **MIG-11~15**: S3 주문↔결제 정합성(지연 constraint trigger는 `expectCommitError`와 실제 COMMIT으로 검증), S4 쿼터 FK와 DB 수준 동시성, Q-022 `OTHER`, Q-023 DELETE 차단, Q-024 인증 세션 FK, A-038 결제 원장(DELETE)·승인 금액 |
| `tests/contract/schema/ledger-claims.test.ts` | **MIG-17~21 후속(74개)**: A-038 승인 시각, A-039 요청 수단·원문·미승인 결제의 수단 일치(+39), A-040 인증 세션 무결성(두 claim 순서, 보존·삭제 시나리오 포함), A-041 원장성 테이블 보호(벌크·실제 COMMIT 포함) |
| `tests/contract/schema/ledger-evidence.test.ts` | **MIG-22·23 (63개)**: 승인 증거 불변(컬럼×역할 표 기반 테스트, 벌크, 강등, 허용 운영 UPDATE, 전이, 실제 COMMIT), 환불 핵심 불변(컬럼별·벌크·상태 전이·실제 COMMIT), `SEAT` 합계(COMMIT 시점, 실제 COMMIT 성공·실패) |
| `tests/contract/schema/cli-guard.test.ts` | **MIG-24 (32개)**: 실제 Prisma CLI와 PostgreSQL로 `prisma.config.ts` 환경 가드 확인(`DATABASE_URL` 조합 + Shadow DB 조합, 거부 시 DB·Shadow DB 불변) **DB-05**(Step 3): `DATABASE_URL_UNPOOLED`가 있으면 CLI가 그 주소로 연결(Pooled 주소에 틀린 비밀번호를 두어 실측), 없으면 `DATABASE_URL`, 다른 DB를 가리키는 쌍·다른 환경의 Direct 주소는 실행 전 거부, 비밀번호 비출력 |
| `tests/unit/prisma-cli-guard.test.ts` | MIG-24의 순수 함수 규칙(38개, DB 불필요, `npm test`). `isSameDatabase`(loopback 표기·포트·서버 비교)도 여기서 검증 **DB-04**: Pooled/Direct 쌍 선택·같은 DB 검증·Shadow와 두 메인 주소 비교 |
| `tests/unit/payment-method.test.ts` | A-039 서비스 규칙의 순수 함수 시험(DB 불필요, `npm test`): 생성 시 요청값 기록, 승인 시 요청값 불변, `DISALLOWED`→`OTHER`+원문, 원문 안전 검사 |
| `tests/contract/schema/client.test.ts` | DB-01: 앱의 Prisma Client(`getPrisma()`)가 실제 DB에 연결, uuid·bigint(>2^53)·timestamptz 왕복, 명시적 READ COMMITTED, DB↔환경 불일치 거부. **MIG-16(DB-02)**: 타임스탬프 출처 실측 |
| `tests/contract/schema/db-clock.test.ts` | **DB-03**(Step 3): `DbClock`(`getAppClock()`)이 실제 DB의 `now()`를 반환, 세션 `TimeZone=Asia/Seoul`(`SET LOCAL`)에서도 같은 순간 — 시계 자체의 시간대 독립성(§2.3 S11), 트랜잭션 클라이언트에 묶으면 트랜잭션 시작 시각 하나, 트랜잭션 밖에서는 증가, 연결 실패는 그대로 전파(시스템 시각 대체 없음) |
| `tests/contract/schema/catalog.test.ts` | **CAT-API-01~07·CAT-UI-01**(Step 3, §2.5) |
| `tests/contract/schema/pages.test.ts` | **PAGE-01~04**(Step 3, §2.5): 페이지 데이터 컴포넌트(`src/app/_catalog/content.tsx`)를 실제 DB로 실행, `connection()`만 대체, `notFound()`는 실제 함수 |
| `tests/contract/schema/connection-roles.test.ts` | **DB-06**(Step 3): 앱 런타임은 `DATABASE_URL`(Pooled)로만 연결하고 `DATABASE_URL_UNPOOLED`는 쓰지 않음, 세션 UTC, `DATABASE_URL` 단독 동작 |
| `tests/contract/schema/timezone.test.ts` | **TZ-01~05**(Step 3, §2.3 S11): 서울 기본 시간대 DB에서 앱 연결의 UTC 고정·연결별 적용·DateTime 왕복·`DbClock` 일치·판매 상태 |
| `tests/contract/schema/seed.test.ts` | SEED-01~04: 생성·멱등·production/미설정/staging 거부·DB↔환경 교차 검사. **SEED-05**(Step 3, S11): DB 기본 시간대 `Asia/Seoul`에서 실제 `prisma db seed`로 넣은 회차 시각이 실행 시각+30일 범위 안(epoch 기준), 일정 간격·인원 불변. **SEED-06**(Step 3): `DATABASE_URL_UNPOOLED`가 있으면 seed가 그 주소로 연결(Pooled 주소 비밀번호가 틀려도 성공, 출력에 비밀번호 없음), 없으면 `DATABASE_URL`, 다른 DB를 가리키는 쌍은 거부 | SEED-03은 `_test`가 아닌 throwaway DB로 seed 가드의 환경 규칙을 직접 확인하고, SEED-03b는 `_test` DB + 비test 환경이 CLI 가드에서 먼저 거부됨을 확인한다
| `tests/unit/db-clock.test.ts` | **CLK-01**(Step 3): `DbClock` 계약(가짜 executor, DB 불필요): epoch ms 해석, 매 호출 새 `Date`, DB 오류 그대로 전파, 행 수·형식·범위 이상 시 `DbClockError`, `FixedClock`과 교체 가능 |
| `tests/unit/error-boundary.test.ts` | **PAGE-05**(Step 3): 오류 경계 재시도 |
| `tests/unit/startup-guard.test.ts` | **PAGE-06**(Step 3): 서버 기동 시 DB 주소 조합(실제 `instrumentation-node` 모듈, `process.exit` 대체) |
| `tests/unit/seat-map-layout.test.ts` | **CAT-08b**(Step 3): 임시 격자 배치(좌석 1회씩, 구역 가격순, 상태 불변) |
| `tests/unit/sales-status.test.ts` | **CAT-01~06·08**(Step 3, §2.4) |
| `tests/unit/seat-display.test.ts` | **CAT-07**(Step 3, §2.4): §11.1 좌석 표시 상태 |
| `tests/unit/pg-adapter.test.ts` | **TZ-06**(Step 3): `buildPgPoolConfig()` (DB 불필요) |
| `tests/unit/check-config.test.ts` | **DB-07**(Step 3): `npm run check:config`을 실제 실행(DB 연결 없음): Pooled/Direct 쌍 요약(URL·비밀번호 비출력), `DATABASE_URL` 단독 통과, 다른 DB·다른 Neon 엔드포인트·다른 환경·`DATABASE_URL_UNPOOLED` 단독은 실패 |
| `tests/unit/database-config.test.ts` | DB URL 파싱·개발/테스트 DB 분리·seed 가드(DB 불필요, `npm test`) **DB-04**(Step 3): Neon `-pooler` 호스트 정규화(`*.neon.tech`의 엔드포인트 라벨만), `selectDirectDatabaseUrl`(Direct 우선·공백은 미설정·같은 DB·양쪽 환경 규칙·비밀번호/호스트 비노출), seed의 Direct 선택, 앱 런타임 검사 `assertRuntimeDatabaseConfig`(`DATABASE_URL_UNPOOLED`만 있으면 기동 거부, CLI·seed는 단독 허용 유지) |

필수 제약 목록(단일 정본)은 `tests/contract/schema/manifest.ts`다. 새 제약·테이블을 추가하면 여기에도 추가한다. MIG-06은 이후 migration이 manifest의 객체를 DROP하거나(`DROP INDEX/CONSTRAINT/TRIGGER/FUNCTION`), 그 객체가 의존하는 컬럼·테이블을 DROP하면 실패한다(정당한 CHECK 어휘 확장의 `DROP`+`ADD`도 현재는 위반으로 판정한다 — S8로 개선 예정). 롤백 트랜잭션 헬퍼 `rolledBack`은 롤백 직전에 `SET CONSTRAINTS ALL IMMEDIATE`로 커밋 시점 검사를 강제하므로, 커밋될 수 없는 상태를 남기는 테스트는 실패한다.

### 2.1 보완 구현의 공허성 검증

새 제약이 실제로 잘못된 상태를 막는지 확인하기 위해 보호 장치를 하나씩 제거(뮤테이션)해 실행했다: `payments_primary_order_uq`, 지연 trigger 2개 각각, 지연 속성(`DEFERRABLE INITIALLY DEFERRED`) 제거, `payments_primary_amount_ck`, `payments_method_type_other_ck`, `order_items_no_delete`, `orders_quota_fk`, `payments_order_total_fk`(복합 → 단일 FK), `identity_sessions` 복합 FK(→ 단일 FK), migration 트랜잭션 래퍼 — **11개 모두** 해당 영역 테스트가 실패했다. A-038의 `payments_no_delete` 트리거와 `payments_succeeded_amount_ck`도 같은 방식으로 제거해 각각 12개·8개 테스트가 실패함을 확인했다. 후속 작업(A-038 보강·A-039~A-041)의 새 제약·트리거 17개는 아래 §2.1.1에서 같은 방식으로 시험했다. 새 제약을 추가·변경할 때는 같은 방식으로 제거 시험을 한다.

#### 2.1.1 후속 작업 뮤테이션 결과 (2026-11-17)

뮤테이션 시험: migration의 보호 장치를 하나씩 제거·약화한 뒤 `ledger-claims.test.ts`와 `consistency.test.ts`를 실행했다(매번 원본을 복원). **17개 모두 해당 테스트가 실패해 검출**했고, 복원 후 두 파일은 원본과 바이트 단위로 같다. 같은 장치가 존재하는지는 manifest 테스트(MIG-05)도 별도로 검사한다.

| # | 변경 | 결과 |
|---|---|---|
| N1 | payments_succeeded_approved_at_ck → TRUE | 2개 실패 |
| N2 | payments_requested_method_type_ck → TRUE | 1개 실패 |
| N3 | payments_requested_method_no_change removed | 1개 실패 |
| N4 | payments_other_requires_raw_ck → TRUE | 1개 실패 |
| N5 | provider_method_raw_ck: 9+ digit clause removed | 1개 실패 |
| N6 | provider_method_raw_ck: blank clause removed | 1개 실패 |
| N7 | identity 4-col FK → single-column FK | 5개 실패 |
| N8 | identity_sessions_claim_guard removed | 2개 실패 |
| N9 | identity_verifications_claim_guard removed | 2개 실패 |
| N10 | identity_sessions_claim_guard not deferred | 11개 실패 |
| N11 | admin_audit_logs_no_update removed | 2개 실패 |
| N12 | admin_audit_logs_no_delete removed | 1개 실패 |
| N13 | payment_status_logs_no_update removed | 1개 실패 |
| N14 | payment_status_logs_no_delete removed | 2개 실패 |
| N15 | refund_items_no_update removed | 2개 실패 |
| N16 | refund_items_no_delete removed | 1개 실패 |
| N17 | refunds_no_delete removed | 2개 실패 |

**미승인 결제의 수단 일치 CHECK(`payments_unapproved_method_matches_request_ck`, 2026-11-18)**도 같은 방식으로 시험했다(`ledger-claims.test.ts`·`consistency.test.ts`, 매번 원본 복원, 복원 후 바이트 동일). **6개 변형 모두 검출**:

| # | 변경 | 결과 |
|---|---|---|
| M1 | CHECK → `TRUE` | 28개 실패 |
| M2 | CHECK 제거 | 28개 실패 |
| M3 | `FAILED`/`CANCELED`는 달라도 허용하도록 완화 | 13개 실패 |
| M4 | `READY`는 달라도 허용하도록 완화 | 5개 실패 |
| M5 | `CONFIRMING`/`UNKNOWN`은 달라도 허용하도록 완화 | 10개 실패 |
| M6 | `SUCCEEDED`도 일치해야 하도록 과도하게 강화(승인 흐름이 깨짐) | 17개 실패 |

#### 2.1.2 PR #2 후속 뮤테이션 결과 (2026-11-18)

승인 증거 불변 트리거·환불 핵심 불변 트리거·`SEAT` 합계 지연 trigger·Prisma CLI 환경 가드를 하나씩 제거·약화·과도하게 강화하고(컬럼별 포함) `ledger-evidence`·`ledger-claims`·`consistency`·`integrity`(DB 계약)와 `cli-guard`·`seed`(CLI 가드) 테스트를 실행했다. 매번 원본을 복원했고 복원 후 두 파일은 원본과 바이트 단위로 같다. **43개 변형 중 40개가 검출**되었고 3개는 **동등 변이**(아래)라 동작이 같아 어떤 테스트로도 검출될 수 없다. 과도한 강화 변이(운영 컬럼을 불변으로 만들기)도 실패하므로 정상 운영 UPDATE를 막지 않는다는 점도 시험된다.

| 변경 | 결과 |
|---|---|
| E0 payments_approved_evidence_no_change removed | 36개 실패 |
| E evidence trigger no longer guards status | 4개 실패 |
| E evidence trigger no longer guards order_id | 1개 실패 |
| E evidence trigger no longer guards provider | 2개 실패 |
| E evidence trigger no longer guards currency | 2개 실패 |
| E evidence trigger no longer guards merchant_payment_ref | 2개 실패 |
| E evidence trigger no longer guards provider_payment_id | 4개 실패 |
| E evidence trigger no longer guards pg_transaction_id | 6개 실패 |
| E evidence trigger no longer guards requested_amount | **미검출(동등 변이)** |
| E evidence trigger no longer guards approved_amount | 1개 실패 |
| E evidence trigger no longer guards approved_at | 4개 실패 |
| E evidence trigger no longer guards method_type | 2개 실패 |
| E evidence trigger no longer guards provider_method_raw | 4개 실패 |
| E evidence trigger no longer guards easy_pay_provider | 2개 실패 |
| E evidence trigger no longer guards card_company | 4개 실패 |
| E guard only PRIMARY payments (WHEN role = PRIMARY) | 18개 실패 |
| E guard only EXCESS payments (WHEN role = EXCESS) | 17개 실패 |
| E guard fires for every payment, not only SUCCEEDED (over-strict) | 24개 실패 |
| E over-strict: refunded_amount frozen | 5개 실패 |
| E over-strict: last_verified_at frozen | 3개 실패 |
| E over-strict: requery_count frozen | 3개 실패 |
| R0 refunds_core_no_change removed | 15개 실패 |
| R refund core trigger no longer guards id | 1개 실패 |
| R refund core trigger no longer guards order_id | **미검출(동등 변이)** |
| R refund core trigger no longer guards payment_id | 2개 실패 |
| R refund core trigger no longer guards refund_type | 3개 실패 |
| R refund core trigger no longer guards provider | 2개 실패 |
| R refund core trigger no longer guards total_amount | 5개 실패 |
| R refund core trigger no longer guards requested_by_admin_id | 3개 실패 |
| R refund core trigger no longer guards created_at | 1개 실패 |
| R over-strict: refund status frozen | 3개 실패 |
| R over-strict: provider_refund_id frozen | 3개 실패 |
| R over-strict: completed_at frozen | 3개 실패 |
| S1 refunds_items_guard removed | 1개 실패 |
| S2 refund_items_refund_guard removed | 2개 실패 |
| S3 refunds_items_guard not deferred | 30개 실패 |
| S4 refund_items_refund_guard not deferred | 7개 실패 |
| S5 sum rule weakened to item_sum > total | 2개 실패 |
| S6 sum rule weakened to item_sum < total | 4개 실패 |
| S7 SEAT refund may have no items | **미검출(동등 변이)** |
| S8 PAYMENT_EXCESS refund may have items | 1개 실패 |
| P2 prisma.config.ts: guard call removed | 17개 실패 |
| P2 prisma.config.ts: guard only when NAZIR_RUNTIME_ENV=test | 14개 실패 |

동등 변이 3개의 이유: ① `requested_amount` 보호 제거 — 복합 FK `payments_order_total_fk`가 이미 어떤 변경도 거부한다(`requested_amount = orders.total_amount`이고 결제가 있으면 주문 총액도 RESTRICT). 테스트 "requested_amount is already fixed by the composite FK"가 FK로 거부됨을 확인한다. ② `refunds.order_id` 보호 제거 — `(payment_id, order_id)` 복합 FK 때문에 `order_id`는 결제가 바뀌어야만 바뀔 수 있고 `payment_id`가 불변이다. ③ `SEAT` 환불 "항목 없음" 분기 제거 — `total_amount > 0` CHECK 덕분에 항목 합계 0은 항상 총액과 달라 다음 분기가 같은 제약 이름으로 거부한다(분기는 오류 메시지를 명확하게 하려는 것). 세 곳 모두 중복 방어(defense in depth)로 남겼다.




**Shadow DB 가드(2026-11-18 PR #2 추가 리뷰)** 변이 12개를 같은 방식으로 시험했다(단위 `prisma-cli-guard`·`database-config` / 실제 CLI `cli-guard`, 매번 원본 복원·복원 후 바이트 동일). **12개 모두 검출**(실패한 테스트 수):

| # | 변경 | 단위 | CLI 계약 |
|---|---|---|---|
| SH1 | Shadow DB를 전혀 검사하지 않음 | 15개 | 12개 |
| SH2 | `DATABASE_URL`이 있을 때만 Shadow 검사 | 1개 | 0개 |
| SH3 | test 환경에서 Shadow 검사 생략 | 3개 | 3개 |
| SH4 | test 외 환경에서 Shadow 검사 생략 | 13개 | 9개 |
| SH5 | Shadow는 환경 규칙 없이 항상 허용 | 15개 | 12개 |
| SH6 | 주 DB와 같은 DB 검사 제거 | 7개 | 4개 |
| SH7 | 같은 DB 비교에서 DB 이름 무시 | 5개 | 2개 |
| SH8 | 같은 DB 비교에서 loopback 표기 정규화 제거 | 1개 | 2개 |
| SH9 | 같은 DB 비교에서 포트 무시 | 1개 | 0개 |
| SH10 | 같은 DB 비교에서 호스트 무시(과도한 강화) | 1개 | 0개 |
| SH11 | 빈 문자열 Shadow를 설정된 것으로 취급(과도한 강화) | 1개 | 0개 |
| SH12 | 오류 메시지에 Shadow URL을 그대로 출력 | 2개 | 0개 |

SH2·SH9·SH10·SH11·SH12는 입력 해석 규칙이라 단위 테스트가 검출하고, 환경·DB 조합의 실제 효과(Shadow가 지워지는지)는 CLI 계약 테스트가 SH1·SH3~SH8로 확인한다.

### 2.2 후속 Step으로 이월한 DB 점검 (Step 2 기술 검토 S2·S5·S7·S8·S9·S10)

| 항목 | 내용 | 반영 Step | 테스트 |
|---|---|---|---|
| S2 | `SOLD` 좌석에 `ACTIVE`/`CONFIRMING` hold를 넣을 수 있다(DB 미보장). 주문 생성의 AVAILABLE 검사(§11.2 4단계)를 우회하는 경로가 없어야 한다. DB 방어(constraint trigger)의 가능성도 Step 5 시작 전 재검토. **→ DB 방어 구현(2026-11-25, A-053 ③, §3.2)** | Step 5 | SEAT-04·05의 `SOLD` 변형 신설, INV-9, 동시 요청 시험 |
| S5 | 종료 주문의 live hold, 미판매 좌석의 `ISSUED` 티켓 | Step 9 | INV-10 정합성 검사 + review case |
| S7 | Prisma가 트리거 오류(`23001`)를 `P2003`으로 위장하고 제약 이름은 `meta.driverAdapterError.cause`에 있음 | Step 5 시작 전 | 오류 매핑 단위 테스트: 모든 `DB_CONSTRAINT`가 의도한 도메인 오류로 변환 |
| S8 | MIG-06 검사기 개선: 같은 migration에서 같은 이름으로 다시 만드는 `DROP`+`ADD`(CHECK 어휘 확장)는 허용하되 진짜 제거는 계속 검출 | 별도 테스트 개선 | `findProtectedDrops` 합성 케이스 확장 |
| S9 | `lock_timeout`·`statement_timeout`·`idle_in_transaction_session_timeout`(현재 0), TLS 강제, 앱 DB 역할 분리(원장 UPDATE/DELETE/TRUNCATE 권한 제거) | Step 10 | 인프라 검증·리허설 |
| S10 | partial unique를 대상으로 한 `INSERT … ON CONFLICT`는 인덱스 predicate를 그대로 명시해야 한다 | Step 5 | 해당 쿼리의 통합 테스트 |

### 2.3 Step 3 착수 중 발견한 DB 점검 (S11)

`tests/contract/schema/timezone.test.ts`는 자기 DB에 `ALTER DATABASE … SET timezone = 'Asia/Seoul'`을 걸어 **모든 새 연결이 서울 시간대로 시작**하게 한 뒤, 테스트 쪽 세션 설정 없이 앱 경로(`getPrisma()`·`getAppClock()`)로 검증한다. 기준값은 세션과 무관한 epoch 밀리초다.

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| TZ-01 | 환경·음성 대조: 일반 새 연결의 `TimeZone`, 수정 전 어댑터의 쓰기·읽기, 연결 문자열 `options`의 덮어쓰기 | `Asia/Seoul`; 수정 전 어댑터는 쓰기 −9h·읽기 +9h(자기 왕복은 같음); URL `options`가 설정 객체를 이김 |
| TZ-02 | 앱 연결의 세션 시간대: 단일 연결, 동시에 연 연결 5개(서로 다른 backend pid), pool을 닫고 다시 만든 뒤의 새 연결, `options=`가 있는 `DATABASE_URL` | 모두 `UTC`; URL은 거부 |
| TZ-03 | DateTime 쓰기·읽기 왕복: 모델 쓰기 → 모델·raw·트랜잭션 읽기·저장 epoch, 날짜 경계(KST 자정), DateTime 필터, SQL로 쓴 마이크로초·`+09` 리터럴 | 모두 같은 순간(밀리초로 절삭) |
| TZ-04 | 같은 트랜잭션에서 SQL `now()`로 쓴 값의 모델 읽기 = `DbClock(tx).now()`, 앱 시계 = 서버 epoch | 일치 |
| TZ-05 | SQL `now()` 기준으로 만든 시작된 회차·시작 전 회차·마감 지난 공연을 앱으로 읽어 판매 상태 계산(음성 대조: 수정 전 어댑터) | `CLOSED`·`ON_SALE`·`CLOSED`(수정 전: `UPCOMING`·`ON_SALE`로 틀림) |
| TZ-06 | `buildPgPoolConfig()` 단위: UTC `options`, 앞뒤 공백·개행은 잘라 내고 **검사한 문자열 그대로** `pg`에 전달(그 밖은 불변), `options` 키(대소문자·빈 값·공백 뒤) 거부, 비밀번호 비노출 | — |

**뮤테이션(2026-11-21, Pooled/Direct):** `prisma.config.ts`가 `DATABASE_URL`을 쓰도록 되돌리면 DB-05가, seed가 `DATABASE_URL`을 쓰도록 되돌리면 SEED-06이 실패한다.

**뮤테이션(2026-11-20):** seed를 공통 설정 없이 되돌리면 SEED-05가 실패한다(저장 시각 약 9시간 이름). `options`를 제거하면 TZ-02(3개)·TZ-03(2개)·TZ-04(1개)·TZ-05(1개) 7개가 실패하고, 수정과 무관한 대조·epoch·URL 거부 5개만 통과한다.


| 항목 | 내용 | 반영 | 테스트 |
|---|---|---|---|
| S11 | Prisma 7 + `@prisma/adapter-pg` 7.10.1은 세션 `TimeZone`을 UTC로 가정한다. 읽기는 받은 오프셋을 `+00:00`으로 바꾸고, 쓰기는 오프셋 없는 UTC 문자열을 보낸다. 세션이 `Asia/Seoul`이면 **쓰기 9시간 이르게, 읽기 9시간 늦게**(모델·raw 모두) — 앱끼리 왕복은 같아 보여 드러나지 않는다(2026-11-20 실측). **해결(2026-11-20):** 앱의 모든 pool 연결을 `pg` `options`(`-c TimeZone=UTC`) 시작 파라미터로 시작, `options=`가 있는 `DATABASE_URL`은 거부(DATABASE §19.12). seed 연결도 같은 설정 사용(2026-11-20). 남은 확인: 트랜잭션 모드 풀러의 `options` 처리(E-007) | Step 3 | TZ-01~06, DB-03, SEED-05 |

### 2.4 Step 3 카탈로그 — 표시용 판매 상태 (CAT)

`src/server/catalog/sales-status.ts`·`seat-display.ts`의 순수 함수. 판단 근거는 DATABASE §11.11(반열린 판매 기간, `starts_at > now`)과 §11.1(좌석 표시 상태). 표시용이며 주문 생성(Step 5)이 잠금 아래 다시 판단한다.

- **승인 대기:** 비판매 사유 간 우선순위(`NOT_PUBLIC` > `CANCELED` > `CLOSED` > `PAUSED` > `UPCOMING` > 좌석 상태)와 `CLOSED` 공연의 공개 목록 노출 여부는 Step 3 조사 보고의 제안이며 **사용자 승인 대기**다.
- **확정(사용자 결정 2026-11-21) — 좌석 유무 표시:**

  | 내부 상태 | 화면 문구 | 판정 (§11.11 충족 시) |
  |---|---|---|
  | `ON_SALE` | 예매 가능 | §11.1 `AVAILABLE` 좌석 1석 이상 |
  | `TEMPORARILY_UNAVAILABLE` | 일시 품절 | `AVAILABLE` 0석, **유효한** 임시 점유(`HELD`: `CONFIRMING`, 또는 `ACTIVE` + 주문 `hold_expires_at > now`) 1석 이상. 만료된 `ACTIVE` hold는 `AVAILABLE`로 센다 |
  | `SOLD_OUT` | 매진 | `AVAILABLE` 0석, `HELD` 0석 |

  상세 화면 안내 문구(UI 구현 시 사용, 일시 품절·임시 점유 좌석): **"다른 고객의 결제가 진행 중인 좌석입니다. 잠시 후 다시 확인해 주세요."**
- **미결정 — `BLOCKED`만 남은 회차:** `BLOCKED`는 관리자가 차단·해제할 수 있는 상태이며(§5.5), 환불 좌석도 재판매 전 `BLOCKED`로 두는 안이 권장안이다(Q-012, 미확정). 따라서 "남은 좌석이 모두 `BLOCKED`"는 영구 매진이 아닐 수 있다. 현재 구현은 `AVAILABLE`·`HELD`가 0이면 `BLOCKED` 수와 무관하게 `SOLD_OUT`(좌석이 하나도 없는 회차 포함)이며, CAT-08이 **현재 동작만** 고정한다. `매진` 유지 / 별도 상태(예: 판매 준비 중) / 좌석 0석 회차 처리를 사용자가 결정한다.

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| CAT-01 | 판매 오픈 1ms 전·정각·1ms 후, 마감 1ms 전·정각·1ms 후, 시작 1ms 전·정각, 시작이 마감보다 이른 회차, 마감 = 시작 | 오픈 전 `UPCOMING`, 오픈 정각부터 `ON_SALE`, 마감 정각·시작 정각부터 `CLOSED` |
| CAT-02 | 판매 기간 NULL(양쪽·한쪽) | NULL은 제한 없음, 시작 시각이 마감 |
| CAT-03 | `DRAFT` 공연, `CLOSED` 공연, `CLOSED`·`PAUSED`·`CANCELED` 회차와 그 조합 | `NOT_PUBLIC`(공개 API 404), `CLOSED`, `PAUSED`, `CANCELED` — 우선순위대로 |
| CAT-04 | 예매 가능 좌석 0/1, 유효 점유 0/1/다수, 판매 전·중지·마감·시작 후의 점유 좌석 | `ON_SALE` / `TEMPORARILY_UNAVAILABLE` / `SOLD_OUT`, 판매 기간 밖은 기존 사유 우선, `ON_SALE`만 판매 가능 |
| CAT-05 | 공연 상태 × 회차 상태 × 판매 기간(역전 포함) × 시각 × 예매 가능 0/1 × 점유 0/1 전체 조합 | `ON_SALE` ⇔ §11.11 ∧ 예매 가능 ≥ 1, `TEMPORARILY_UNAVAILABLE` ⇔ §11.11 ∧ 예매 가능 0 ∧ 점유 ≥ 1, `SOLD_OUT` ⇔ §11.11 ∧ 둘 다 0 |
| CAT-06 | 미지 상태값, 잘못된 날짜, 음수·소수·NaN·누락 좌석 수 | `SalesStatusInputError`(추정하지 않음), 입력 불변 |
| CAT-07 | §11.1 좌석 표시: `SOLD`·`BLOCKED`·`CONFIRMING`(만료 시각과 무관)·`ACTIVE` 만료 1ms 전/정각/1ms 후·종료된 hold·여러 hold·미지 상태값 | 정각부터 `AVAILABLE`, 종료 hold는 무시, `SOLD`·`BLOCKED`가 hold보다 우선, 미지 값은 `SeatDisplayInputError` |
| CAT-08 | 좌석 행 → `countSeatDisplay` → 판매 상태: 유효 점유·`CONFIRMING`·만료(1ms 전, 정각) 점유, `SOLD` + 남은 좌석 `BLOCKED`, 좌석 0석 | 만료 점유만 남으면 `ON_SALE`(일시 품절 아님). `BLOCKED`만 남거나 0석이면 **현재** `SOLD_OUT`(정책 미결정) |

### 2.5 Step 3 공개 조회 API·화면 (CAT-API, CAT-UI)

`tests/contract/schema/catalog.test.ts` — 실제 PostgreSQL, 앱 경로(`getPrisma()` + DbClock). 좌석 상태는 실제 주문·항목·hold로 만든다(유효 `ACTIVE`, 만료 시각이 지난 `CONFIRMING`, 만료된 `ACTIVE`, `RELEASED`, `SOLD`, `BLOCKED`).

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| CAT-API-01 | 공연 목록·상세·회차 목록: `PUBLISHED`·`DRAFT`·`CLOSED`·없는 공연, 형식이 틀린 id | `PUBLISHED`만 노출, 나머지 404 `NOT_FOUND`(`CLOSED`는 임시 기본값 Q-030), 형식 오류 400 `VALIDATION_FAILED` |
| CAT-API-02 | 회차별 좌석 상태 | 모든 좌석이 §11.1과 일치(만료 `ACTIVE`·`RELEASED`는 `AVAILABLE`, 만료 시각이 지난 `CONFIRMING`은 `HELD`), 비공개 공연의 회차·없는 회차 404 |
| CAT-API-03 | 회차 판매 상태와 집계 | `ON_SALE`/`TEMPORARILY_UNAVAILABLE`/`SOLD_OUT`/`PAUSED`/`CLOSED`(시작 후)/`CANCELED`, `BLOCKED`만 남은 회차는 **현재** `SOLD_OUT`(Q-032). 좌석 응답·회차 목록·공연 상세의 상태와 집계가 서로 일치, 가격표·가격 범위(number) |
| CAT-API-04 | DB 시각 기준·읽기 전용 | 유효 hold의 만료 시각을 지나게 하면 다음 요청에서 `TEMPORARILY_UNAVAILABLE` → `ON_SALE`, 조회 전후 주문·hold·좌석 지문 불변 |
| CAT-API-05 | 공개 필드 허용 목록 | 허용 목록 밖의 키 없음, 주문·주문 항목·동일인 주체·공연장 id가 응답 어디에도 없음 |
| CAT-API-06 | 의존성 실패 | 500 `INTERNAL_ERROR` 공통 본문, 내부 오류 문구 비노출 |
| CAT-UI-01 | 좌석 배치도·상태 배지 렌더링 | 렌더된 HTML의 좌석별 `data-status`가 DB 기대값과 일치, 임시 점유 안내 문구는 `HELD` 좌석이 있을 때만, 배지 문구는 확정 문구(예매 가능·일시 품절·매진) |
| CAT-API-07 | 좌석 정렬(리뷰 M2): 열 `10`·`9`·`B`·`A`·라벨 없음, 좌석 번호 `12345678901`·`10`·`2` | 200 응답(10자리 이상 좌석 번호에서 오류 없음), 열 9 → 10 → A → B → 라벨 없음, 좌석 2 → 10 → 12345678901, 렌더된 배치도의 열 순서도 같음. 개발 seed 156석의 정렬은 수정 전과 동일(2026-11-22 확인) |
| PAGE-01 | 홈(U1): 공개 공연 1개 / 여러 개(초안·종료 공연 포함) / 0개 | 1개면 그 공연 소개, 여러 개면 공개 공연만 목록, 0개면 안내 문구 |
| PAGE-02 | 공연 페이지: 공개 slug, 없는 slug, `DRAFT` 공연 | 렌더링 / `notFound()` / `notFound()` |
| PAGE-03 | 좌석 페이지: 같은 공연의 회차, **다른 공개 공연의 회차(slug·회차 소속 불일치, 양방향)**, 없는 회차, UUID 아님, 없는 slug | 렌더링, 나머지는 모두 `notFound()` |
| PAGE-04 | `DATABASE_URL` 없음 | 페이지 내용이 설정 오류로 실패한다(오류 경계로 전달, 빈 화면이나 가짜 내용 없음) |
| PAGE-05 | 오류 경계 "다시 시도"(리뷰 M1) | `retry`를 호출하고 `reset`은 호출하지 않음, 오류 문구 비노출 |
| PAGE-06 | 서버 기동: DB 주소 없음 / `DATABASE_URL_UNPOOLED` 단독 / 정상 쌍 / 다른 DB 쌍 / 다른 환경 DB | 없음은 **현재** 기동(필수화는 미결정, 리뷰 M3), 단독·다른 DB·다른 환경은 `process.exit(1)`, 정상 쌍은 Pooled DB를 비밀번호 없이 기록 |

**뮤테이션(2026-11-22):** hold 만료 무시 → 7개 실패, `CLOSED` 공연 공개 → 3개 실패, 임시 점유 수 제거 → 3개 실패. 리뷰 반영분: 예전 정렬 SQL(`::int`) 복원 → CAT-API-07 실패(500), 공연·회차 소속 검사 제거 → PAGE-03 실패, 홈 단일 공연 분기 깨뜨림 → PAGE-01 실패, `error.tsx`를 `reset`으로 되돌림 → PAGE-05 실패.

**오류 경계 재시도 실측(2026-11-22, 리뷰 M1):** 실제 빌드(`next start`)를 아직 없는 DB로 띄워 오류 화면 → DB 생성·migration·seed → 브라우저에서 "다시 시도" 버튼 클릭 → 문서 재요청 없이 RSC 재요청(`GET /?_rsc=… 200`)만으로 공연 화면 복구. Next.js 16.4.6의 `retry`는 `router.refresh()` 후 오류 상태를 지운다(설치본 `error-boundary.js` 확인).

**수동 확인(2026-11-22, 로컬 `next start` + 개발 seed + SQL로 만든 판매·점유·차단 좌석):** API·페이지 응답, 브라우저(Playwright)에서 좌석 `data-status` = DB, 390px 폭에서 가로 넘침 없음. 페이지의 없는 공연·회차는 PPR 특성상 HTTP 200 + not-found 화면 + `noindex`로 응답한다(API는 404).

**DB 세션 검증 스크립트:** `npm run verify:db-session`(비파괴: 임시 테이블·트랜잭션 단위 잠금만) — `DATABASE_URL`로 세션 TimeZone=UTC, 트랜잭션 연결 고정·`FOR UPDATE`, 동시 트랜잭션 잠금 경합, COMMIT 시점 지연 제약 오류. 2026-11-22 로컬 PostgreSQL 직접 연결과 **PgBouncer 1.22 트랜잭션 모드**(서울 기본 시간대 DB)에서 4개 모두 통과. **실제 Neon에서는 미실행.**

## 3. P0 좌석/점유

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| SEAT-01 | 서로 다른 주체가 동일 좌석 동시 점유 | 한 요청만 성공, 나머지 409 `SEAT_UNAVAILABLE` |
| SEAT-02 | 다중 좌석 중 하나 확보 불가 | 전체 rollback, 부분 점유 없음, 한도 카운터 불변 |
| SEAT-03 | 만료 hold 좌석에 새 점유 | 사전 정리 `expireOrder` 후 성공, 이전 주문 `EXPIRED`·한도 복구 |
| SEAT-04 | 유효 `ACTIVE` hold 좌석 재점유 | 거부 |
| SEAT-05 | `CONFIRMING` hold 좌석(7분 경과)에 새 점유 | 거부(펜싱), 기존 주문 불변 |
| SEAT-06 | `UNKNOWN` 결제 주문의 좌석에 새 점유 | 거부(재판매 금지) |
| SEAT-07 | 차단과 점유 동시 실행 | 한 작업만 성공, 일관성 유지 |
| SEAT-08 | SOLD 좌석 차단 | 거부 |
| SEAT-09 | 만료됐으나 미정리된 `ACTIVE` hold 좌석 차단 | 409 후 정리 뒤 재시도 성공, 차단 트랜잭션이 다른 주문 hold를 바꾸지 않음 |
| SEAT-10 | 브라우저 timer 조작 | 서버 만료시각 불변 |
| SEAT-11 | 다중 좌석 역순 요청 동시 실행 | 정렬 잠금으로 deadlock 없음, 발생 시 안전 재시도 |
| SEAT-12 | 만료 작업 지연 | 주문 생성 경로가 직접 정리 |
| SEAT-13 | 다른 회차의 좌석 ID를 섞어 요청 | 400/409, 점유 없음 |
| SEAT-14 | 결제 실패·재시도로 7분 연장 시도 | `hold_expires_at` 불변 |

v1.0의 SEAT-05(A→B 변경), SEAT-06(A→B 실패), SEAT-07(A→B→A)은 좌석 변경 제거 [확정 D-001]에 따라 삭제하고 ORD-11~14(취소 후 재예매)로 대체했다.

### 3.1 Step 5 단위 1: 예약 트랜잭션 기반 (TX-*, A-053)

실제 PostgreSQL + Prisma adapter: `tests/contract/schema/booking-tx.test.ts`. 단위: `tests/unit/booking-tx.test.ts`, `tests/unit/startup-guard.test.ts`(TX-U09).

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| TX-01 | DB 기본 격리수준을 SERIALIZABLE로 바꾼 뒤 러너 실행 / 같은 pooled 연결에서 트랜잭션 후 설정 확인 | 트랜잭션 안은 `read committed`; `lock_timeout`·`statement_timeout`은 안에서만 설정값, 끝난 뒤 `0` |
| TX-02 | 다른 연결이 좌석을 잠근 상태 / 재시도 사이에 잠금 해제 | 55P03 2회 후 503 `DATABASE_BUSY`(쓰기 롤백) / 재시도에서 성공 |
| TX-03 | `pg_sleep(3)`, statement_timeout 300ms | 503, 재시도 없음, 2초 안에 종료 |
| TX-04 | Pool max=1을 다른 트랜잭션이 점유 / 트랜잭션 `timeout` 초과 | P2028 → 503 + `retryAfterSeconds`, 이후 같은 Pool에서 새 트랜잭션 성공(연결 누수 없음) / 503, 쓰기 롤백 |
| TX-05 | 지연 constraint trigger가 COMMIT에서 거부 | 모든 문장 수락 후 COMMIT 23514(이름 없음) → 문맥 규칙으로 매핑, 규칙 없으면 500, 주문·결제 원상태 |
| TX-06 | 문장 시점 23505: 활성 주문 중복 / 좌석 live hold 중복 | `ACTIVE_ORDER_EXISTS` / `SEAT_UNAVAILABLE`, 같은 트랜잭션의 쿼터 행·주문 롤백 |
| TX-07 | 두 트랜잭션이 좌석을 역순으로 잠금 | deadlock 재현, 재시도로 둘 다 성공 / 재시도 없으면 한쪽 503 |
| TX-08 | `lockSeatsSorted` 12개 동시 실행(순서 섞음) / 반환값 | 전부 커밋, 재시도 0회 / 정렬 순서, 회차·상태 포함, 없는 id 제외 |
| TX-09 | `ensureAndLockQuota`: 생성·snapshot 유지 / 회차 없음 / 행 없을 때 동시 2건(커밋·롤백) | `seat_limit` = 생성 당시 회차 한도, 이후 불변 / `null`·행 없음 / 두 번째가 첫 번째 종료까지 대기 후 커밋된 카운터를 읽음, 롤백이면 직접 생성 |
| TX-10 | fn의 AppError / fn이 DB 오류를 잡고 계속 진행 | 그대로 재전파·쓰기 롤백 / 25P02 → 500, 쓰기 롤백 |
| TX-11 | 고객 이름·전화번호가 메시지에 들어가는 CHECK 위반 | 원문 오류에는 값이 있음(전제 확인), 러너 로그·응답에는 없음, 로그 1줄(분류·SQLSTATE·제약·시도) |
| TX-12 | 앱 연결(`getPrisma` + `bookingTxDeps`) | 환경 설정 값 적용(`lock_timeout` 반영), READ COMMITTED, 잘못된 Pool 설정은 요청 시점 fail-closed |
| TX-U01~U08 | Pool 설정 규칙(기본값·필수·범위·순서), 측정 형태별 분류, backoff 상한, 러너 판단(재시도·503·문맥 매핑·25P02·로그), 좌석 id 정렬, `Retry-After` | |
| TX-U09 | 서버 기동: Pool 기본값 기록 / 잘못된 값·순서 | 기동·로그(비밀값 없음) / `process.exit(1)` |

**결과(2026-11-25):** unit 449 passed(396 → +53), DB 537 passed(514 → +23). TX DB 테스트는 4회 반복 실행에서 모두 통과.

### 3.2 Step 5 단위 2: 좌석·hold 불변조건(S2)과 이력 보호(A-041 확장) (A-053 ③ ⑦)

실제 PostgreSQL 16 + Prisma adapter(예약 트랜잭션 러너): `tests/contract/schema/seat-hold-invariants.test.ts`. 계약 매니페스트에 트리거 7개 추가(`manifest.ts`).

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| S2-01 | `AVAILABLE` 좌석에 `ACTIVE`·`CONFIRMING` hold 생성 | 성공 |
| S2-02/03 | `SOLD`·`BLOCKED` 좌석에 live hold 생성 / 이미 종료된 hold(`RELEASED`) 생성 | 23514 → 문맥 `SEAT_UNAVAILABLE`(규칙 없으면 500), hold 없음 / 허용(live 아님) |
| S2-04 | 종료된 hold를 `SOLD` 좌석에서 다시 `ACTIVE`로 | 거부, 원상태 |
| S2-05 | hold의 좌석 변경 UPDATE | 복합 FK가 거부(좌석 변경은 DB 경로 아님) |
| S2-06 | 다른 연결이 좌석을 잠근 상태에서 hold 생성 / `ACTIVE→CONFIRMING` | 트리거가 좌석 잠금을 기다림(lock timeout → 503) / 좌석 잠금과 무관하게 즉시 성공 |
| S2-07 | hold 없는 좌석·종료 hold만 있는 좌석 `SOLD` | 성공 |
| S2-08 | live `ACTIVE`·`CONFIRMING` hold가 있는 좌석 `SOLD` | UPDATE는 수락, COMMIT 거부(23514), 좌석·로그 롤백 |
| S2-09 | 주문 만료 시각이 지난 `ACTIVE` hold | 여전히 live라 `SOLD` 거부, 같은 트랜잭션에서 `EXPIRED`로 바꾸면 `SOLD` 성공 |
| S2-10 | 판매 경로: `CONFIRMING→CONVERTED` + `SOLD`(두 순서) | 성공 |
| S2-11 | REPEATABLE READ·SERIALIZABLE에서 `SOLD` | COMMIT 거부(hold 없어도) |
| S2-12 | REPEATABLE READ 판매자 스냅샷 이후 hold 커밋 | 판매자 거부, hold 유지 |
| S2-13a | hold가 먼저 좌석을 잠금 | 판매자가 **대기**(pg_stat_activity로 확인) 후 COMMIT 거부, hold 유지 |
| S2-13b | 판매자가 먼저 좌석을 잠금 | hold가 **대기** 후 거부, 주문 트랜잭션 전체 롤백 |
| S2-13c | 먼저 잠근 쪽이 롤백(양방향) | 기다리던 쪽 성공 |
| S2-14 | 동시 시작 30회(선행 측을 번갈아 둠) | 매회 정확히 하나만 성공, 양방향 승리가 모두 발생, 불변조건 위반 0 |
| S2-15 | 겹치는 2석 주문 8건 동시(`lockSeatsSorted`) | deadlock·lock timeout 0, 성공 주문은 2석 모두, 좌석당 live hold ≤ 1, 항목 없는 주문 없음 |
| A41-01~04 | `order_status_logs`·`seat_status_logs` UPDATE·DELETE | 23001(러너 문맥 매핑·원시 연결 모두), 행 불변 |
| A41-05 | `seat_holds` DELETE | 23001, hold 유지 |
| A41-06 | 이력 INSERT, hold 상태 UPDATE(`RELEASED`) | 성공 |
| A41-07 | 이력이 있는 주문 DELETE | FK RESTRICT(기존) |
| S2-M1~M4, A41-M1 | 변이: guard A 무력화 / guard A의 `FOR SHARE` 제거 / guard B 삭제 / guard B의 READ COMMITTED 검사 제거 / 이력·hold 트리거 삭제 | 각각 위 시나리오가 **위반을 재현**(테스트가 결함을 잡음을 확인) |

**결과(2026-11-25):** 파일 단독 28 passed × 10회(S2-14는 회당 30라운드). 전체 DB 565 passed(537 → +28), unit 449 passed. 전체 실행에서 간헐적인 `Unhandled Errors`(57P01, 기존 Step 4 테스트 파일의 정리 순서 문제 — 이번 변경과 무관)는 별도 과제로 남김.

### 3.3 Step 5 단위 3: 주문번호 sequence (ON-*, Q-025)

실제 PostgreSQL 16 + Prisma adapter(예약 트랜잭션 러너): `tests/contract/schema/order-number.test.ts`. 단위: `tests/unit/order-number.test.ts`.

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| ON-01 | 새 DB에서 연속 발급 | `NZ-<KST 월>-000001`, `…-000002` |
| ON-02 | 명시 시각 5개(11/30 14:59:59.999999Z, 15:00Z, 12/31 14:59:59Z, 15:00Z, 2/28 15:00Z) × 세션 TimeZone 4개 | 각각 202611·202612·202612·202701·202603, TimeZone 무관 |
| ON-03 | 기본 인자: 한 트랜잭션 안 두 번 발급(사이 50ms), `next_order_number(now())`, 주문 INSERT | 월 모두 같음(트랜잭션 시작 시각), 번호 +1, 주문 `created_at`의 KST 월 = 번호의 월 |
| ON-04 | `next_order_number(NULL)` | 22004 |
| ON-05 | 동시 발급 200건(각자 booking 트랜잭션) / 동시 주문 INSERT 30건 | 모두 다름·형식 일치·연속 구간 1개 / 저장된 번호 = 발급된 번호 |
| ON-06 | 번호를 써서 주문을 넣은 뒤 롤백 | 그 번호는 저장되지 않고 다시 발급되지 않음(결번), 다음 번호는 +1 |
| ON-07 | `setval` 999998 → 999999·1000000, bigint 최대값 | 6자리 → 7자리(잘림 없음), 19자리까지, 모두 CHECK 통과·INSERT 성공 |
| ON-08 | NO CYCLE: 최대값 이후 발급 | `pg_sequences` 속성 확인, 2200H(1로 돌아가지 않음), 러너는 일반 500 |
| ON-09 | 형식 위반 11종(접두·자릿수·소문자·공백·끝 줄바꿈 등) / 정상 형식 | 23514(문맥 매핑), 앱 패턴도 거부 / 허용 |
| ON-10 | 권한 | EXECUTE는 PUBLIC, sequence USAGE 없는 역할은 42501, 부여하면 발급 |
| ON-11 | 계약 검사 / 검사기 비공허성(CYCLE·증분·volatility 변경, 삭제) / 변이: 잘라내는 `lpad`, CHECK 제거 | 위반 0 / 각각 보고 / 7자리 시나리오가 잘림을 잡음, 잘못된 번호 저장됨 |
| ON-12 | MIG-06: 이후 migration의 `DROP FUNCTION`·`DROP SEQUENCE`·`DROP CONSTRAINT` | 3건 모두 검출 |
| ON-U01~U02 | 앱 패턴(정상 4·거부 10), `nextOrderNumber`가 주어진 executor로 한 문장만 실행, 이상한 DB 결과 거부(값 미노출) | |

**결과(2026-11-26):** 파일 단독 31 passed, unit 467 passed(449 → +18), 전체 DB 596 passed(565 → +31).

### 3.4 Step 5 단위 4: 주문 생성 API·멱등성 (IDM-*, CO-*, OR-*)

실제 PostgreSQL 16 + Prisma adapter: `idempotency.test.ts`(IDM-01~10), `create-order.test.ts`(CO-01~22), `orders-route.test.ts`(OR-01~09). 단위: `tests/unit/idempotency.test.ts`(IDM-U01~U03).

| ID | 시나리오 | 기대 결과 | 대응 |
|---|---|---|---|
| IDM-01~04 | 재반환 / 다른 본문 / 다른 소유 주체 / 업무 거절 후 재요청 | 같은 응답·카운터 불변 / 409 / 별개 요청 / 기록·자원·카운터 롤백, 재평가 | ORD-02·03·05 |
| IDM-05·06 | 같은 키 동시 10건 / 첫 요청 롤백 | 자원 1·재반환 9·**카운터 +1** / 다음 요청이 소유자, 카운터 +1 | ORD-06 |
| IDM-07·08 | 보존 경계(`expires_at = now`는 만료) / 만료 기록 동시 인수 5건 | 같은 행 재사용, 새 24시간 / 1건만 인수 | ORD-07 |
| IDM-09·10 | 커밋된 PROCESSING(방어) / 저장 내용 | 409 `REQUEST_IN_PROGRESS` / 키 원문·주체 ID 없음, hash만 | |
| CO-01·02 | 단일·다중 좌석 | 모든 행(주문·항목·hold·쿼터·로그·접근 세션·outbox·멱등성), DB 가격 합계, 7분, 이름·전화 재암호화, outbox·로그에 개인정보·토큰 없음 | ORD-01, QTA-01 |
| CO-03 | 접근 세션 만료 | 회차 종료 + 24h / 30일 상한 / `ends_at` NULL → 시작 + 24h(Q-034) | |
| CO-04·05 | 누적 한도(3석 후 2석 → 422 remaining 1, 1석 → 성공) / 5석 / 활성 주문 | 422 / 422 remaining 4 / 409 `activeOrderId` | QTA-02~05 |
| CO-06 | DRAFT·CLOSED 공연, PAUSED·CLOSED·CANCELED 회차, 시작 후, 판매 기간 전·후, 없는 회차 | 404 / 422 `SALES_NOT_OPEN` / 404, 쓰기 없음 | ORD-18 |
| CO-07·08 | 잔여 10분 이상·미만 / 세션 없음·LOOKUP·다른 브라우저·만료·폐기 | 성공·422 / 401·403·401 MISMATCH·401·401 | IDV-18~22, ORD-08 |
| CO-09 | SOLD·BLOCKED·유효 점유·**만료됐으나 미처리 점유**·다른 회차·없는 좌석 | 409 + `unavailableSeatIds`, 쓰기 없음 | SEAT-01·04·13 |
| CO-10~13 | 재반환(접근 토큰 회전·카운터 불변) / 접근 세션 폐기 후 재반환 / 재인증 후 같은 브라우저 재반환·다른 브라우저는 새 요청 / 다른 본문 / 거절 후 재요청 | | ORD-02~05 |
| CO-12 | 같은 키 동시 8건 | 주문 1, 재반환 7, 정책별 카운터 +1 | ORD-06 |
| CO-14·15 | 세션 3회 초과 → 429(재반환은 한도에서도 응답) / 주체·회차 한도는 브라우저를 넘어 합산·회차별 독립 | | D-015 |
| CO-16~19 | 다른 주체 8명 같은 좌석 / 한 주체 5건 / 겹치는 2석 10건 / 쿼터 행 없는 상태의 두 브라우저 | 1건 / 1건 / deadlock 0·전부 아니면 전무 / 1건 | SEAT-01·02·11, QTA-06·07·20 |
| CO-20~22 | 주문·항목·hold·로그·접근 세션·outbox INSERT, 멱등성 완료 UPDATE, COMMIT 시점 실패 / 실패 후 같은 키 | 500, 흔적 0(쿼터 행·카운터·PROCESSING 포함) / 정상 처리 | 원자성 |
| OR-01~03 | 201 계약·쿠키 속성·토큰 hash 저장 / 재반환 쿠키 갱신 / 다른 본문 | | |
| OR-04 | 바인딩·Origin·CSRF·세션 쿠키·키·JSON·content-type·4KB·가격 필드·중복 좌석 | 401/403/400, 쓰기·카운터 0 | |
| OR-05~07 | 429 + `Retry-After` / 좌석 잠금 대기 초과 503 `DATABASE_BUSY` + `Retry-After` / rate limit 설정 불가 503 | | |
| OR-08·09 | 내부 실패 | 일반 500, 응답·로그에 SQL·토큰·이름·전화 없음 / 앱 배선(`orderAppDeps`)으로 실제 키·설정 사용 | |

**다음 단위에서 다룸(2026-11-26, §3.5):** 사전 정리·`expireOrder`와 신규 주문의 경쟁(SEAT-03·12, ORD-15), 취소·재예매(ORD-12~14).

**결과(2026-11-26):** IDM 10, CO 39, OR 21 passed(반복 실행 3회), unit 484 passed, 전체 DB 666 passed.

### 3.5 Step 5 단위 5: 만료·사전 정리·정기 작업·취소 (EX-*, PC-*, JOB-*, CN-*)

실제 PostgreSQL 16 + Prisma adapter: `order-expiry.test.ts`(EX), `order-precleanup.test.ts`(PC), `expiry-job.test.ts`(JOB), `order-cancel.test.ts`(CN). 단위: `tests/unit/cron-auth.test.ts`(JOB-U01).

| ID | 시나리오 | 기대 결과 | 대응 |
|---|---|---|---|
| EX-01~03 | 정상 만료·재예매 / 만료 전 / 재실행·없는 주문 | 전이·카운터·로그·outbox v2 / 변화 없음 / 두 번째 감소 없음 | ORD-15, QTA-09 |
| EX-04·05 | `PAYMENT_CONFIRMING`·`PAYMENT_UNKNOWN`(모든 기한 경과) / 모순된 `PENDING` | 손대지 않음 / `needs_review`, 손대지 않음 | SEAT-05·06, D-003 |
| EX-06~09 | `READY` 결제 / 동시 10건 / 다른 계산 좌석 유지 / 4석 | `CANCELED`+로그 / 만료 1회 / 이 주문 좌석만 감소 / 4개 `EXPIRED` | |
| EX-10~12 | COMMIT 실패 / 쓰기 4곳 실패 / 쿼터 잠금 대기 | 전부 롤백 후 재실행 성공 / 전부 롤백 / 주문 행을 먼저 잠그지 않음 | 원자성, A-020 |
| PC-01~04 | 본인 만료 주문 / 다른 주체 만료 점유 / 미만료 점유 / `PAYMENT_CONFIRMING` 점유 | 정리 후 생성 / 정리 후 좌석 확보 / 409 / 409, 손대지 않음 | SEAT-03·12 |
| PC-05 | 정리 실패 | 추측으로 진행하지 않음(409·`ACTIVE_ORDER_EXISTS`), 이후 회복 | |
| PC-06·07 | 만료 점유 좌석 5명 경쟁 / 사전 정리와 정기 작업 동시 | 만료 1회·신규 1건 / 만료 1회·신규 성공 | |
| PC-08·09 | 두 점유 주문 정리 / 세션 없는 요청 | 둘 다 정리 / 정리하지 않음 | |
| JOB-01~03 | 대상만 만료(미만료·CONFIRMING 제외) / 배치 경계·이어서 처리 / 동시 실행 4개 | | |
| JOB-04·05 | 주문 1건 실패 / 로그 | 나머지 처리·실패 집계·다음 실행에서 처리 / 개인정보·토큰 없음 | |
| JOB-06·07 | 라우트 인증(정답 200, 불일치·없음 401, 비밀값 없음 503 — 실행 안 함) / 쿼터 잠금 직렬화 | | |
| CN-01·02 | 취소 효과(hold `RELEASED`·카운터·로그·outbox·`READY` 결제) / 반복 | 멱등, 두 번째 쓰기 없음 | ORD-12 |
| CN-03 | 다른 사람·세션 없음·복사된 세션·CSRF·잘못된 id·본문·없는 주문 / LOOKUP | 404·401·401·403·400·400·404 / 403 | ORD-09·10 |
| CN-04·05 | 점유 시간이 지난 `PENDING` / 이미 만료 | `EXPIRED` / 200 `EXPIRED`, 쓰기 없음 | |
| CN-06·07 | `PAYMENT_CONFIRMING`·`PAYMENT_UNKNOWN`·`REVIEW_REQUIRED` / `PAID` / 모순 상태 | 409 `PAYMENT_IN_PROGRESS` / 409 `INVALID_STATE_TRANSITION` / 409, 모두 불변 | ORD-14 |
| CN-08·09 | 동시 취소 5건 / 취소 vs 만료 20회 | 전이 1회 / 주문마다 종료 1회·카운터 정확 | |
| CN-10~12 | 재예매(새 키) / 재예매 실패 / 원래 키 재요청 | 새 주문, 이전 주문 `CANCELED` 유지 / 이전 주문 복구 없음 / 원래 응답 재반환 | ORD-13 |
| CN-13·14 | 취소 중 실패 / 취소와 같은 주체의 신규 주문 10회 | 전부 롤백 / 카운터 = live hold | |

**결과(2026-11-26):** EX 16, PC 9, JOB 7, CN 18 passed(각 3~5회 반복), unit 497 passed, 전체 DB 716 passed, Unhandled Errors 0.

## 4. P0 주문/세션/Idempotency

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| ORD-01 | 정상 주문 | 주문·항목·hold·접근 세션 생성, 한도 +n, `hold_expires_at = now + 7분` |
| ORD-02 | 같은 주체·같은 key·같은 본문 재요청 | 주문 중복 없음, 같은 응답 |
| ORD-03 | 같은 주체·같은 key·다른 본문 | 409 `IDEMPOTENCY_KEY_REUSED` |
| ORD-04 | 응답 유실 후 같은 브라우저 재요청 | 기존 주문, 접근 쿠키 재설정 |
| ORD-05 | **다른 브라우저/다른 주체가 같은 key·같은 본문 재요청** | 피해자 주문·쿠키 반환 없음(별개 요청 처리) |
| ORD-06 | 같은 key 동시 2요청 | 한 요청만 처리, 나머지 결과 재반환 또는 409 `REQUEST_IN_PROGRESS` |
| ORD-07 | PROCESSING lease 만료 후 재요청 | 재처리, 중복 주문 없음 |
| ORD-08 | 인증 세션 없이 주문 생성·상세 접근 | 401 |
| ORD-09 | 다른 주체의 주문 접근 | 403/404 |
| ORD-10 | 폐기·만료된 세션/접근 세션 사용 | 거부 |
| ORD-11 | 주문번호만 알고 조회 | 거부 |
| ORD-12 | `PENDING` 주문 취소 | `CANCELED`, hold `RELEASED`, READY 결제 `CANCELED`, 한도 −n |
| ORD-13 | 취소 후 다른 좌석으로 재예매 | 새 주문 생성, 이전 주문·결제·hold 이력 보존·비참조 |
| ORD-14 | `PAYMENT_CONFIRMING`/`PAYMENT_UNKNOWN` 주문 취소 | 409 `PAYMENT_IN_PROGRESS` |
| ORD-15 | 결제 전 hold 만료 | 주문 `EXPIRED`, 한도 복구 |
| ORD-16 | 좌석 변경 API 호출 시도(`PATCH /orders/{id}/seats`) | 404(미제공) |
| ORD-17 | `order_items` UPDATE 시도(DB 직접) | 차단 또는 계약 테스트에서 탐지 |
| ORD-18 | 판매 기간 외·회차 PAUSED/CLOSED/CANCELED·시작 후 주문 | 422 `SALES_NOT_OPEN` |
| ORD-19 | 결제 진행 중 이메일 변경 | 409 |
| ORD-20 | 이름·전화번호 변경 요청 | 불가(필드 미제공) |

## 5. P0 구매 한도/활성 주문 [확정 D-006, D-008]

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| QTA-01 | 한 주문 4석 | 성공 |
| QTA-02 | 한 주문 5석 | 422 `PURCHASE_LIMIT_EXCEEDED` |
| QTA-03 | 2석 결제 완료 후 같은 회차 2석 추가 주문 | 성공(`PAID`는 비활성 주문, 한도 4 도달) |
| QTA-04 | 위 상태에서 1석 추가 | 422 |
| QTA-05 | 같은 주체가 같은 회차에 활성 주문 보유 중 새 주문 | 409 `ACTIVE_ORDER_EXISTS` |
| QTA-06 | 같은 주체가 **다른 브라우저 두 곳에서 동시에** 같은 회차 주문 | 한 요청만 성공, 한도·활성 주문 불변식 유지 |
| QTA-07 | 같은 주체 동시 요청 3석 + 2석 | 한 요청만 성공 |
| QTA-08 | 같은 주체, 다른 회차 동시 주문 | 각각 성공(회차별 독립) |
| QTA-09 | 만료된 점유는 한도에서 제외 | 만료 후 새 주문 4석 가능 |
| QTA-10 | 취소·결제 실패로 해제된 좌석은 제외 | 즉시 새 주문 가능 |
| QTA-11 | `CONFIRMING`·`UNKNOWN` 좌석은 포함 | 추가 주문 시 한도 계산에 포함, 활성 주문으로 409 |
| QTA-12 | 환불 `REQUESTED`/`VERIFYING` 좌석은 포함 | 한도 미복구 |
| QTA-13 | 환불 `COMPLETED`(좌석 해제) | 해당 좌석 수만큼 한도 복구 |
| QTA-14 | 4석 중 1석 부분 환불 완료 | 1석만 복구, 주문 `PAID` 유지 |
| QTA-15 | 환불 `FAILED` | 한도 미복구 |
| QTA-16 | 서로 다른 전화번호로 인증했지만 같은 동일인 식별값(DI 등) | 같은 subject로 합산 |
| QTA-17 | quota 카운터 강제 불일치(fixture) | 정합성 검사가 `QUOTA_MISMATCH` review case 생성, 자동 덮어쓰기 없음 |
| QTA-18 | `counted_seats`가 `seat_limit`를 넘는 UPDATE 직접 시도 | CHECK 위반 |
| QTA-19 | 활성 주문 partial unique 직접 위반 시도 | unique 위반 |
| QTA-20 | **`purchase_quotas` 행이 없는 상태**에서 같은 주체가 두 브라우저로 동시 주문(barrier로 동시 INSERT 유도) | T2가 T1 종료까지 대기 후 커밋된 카운터 기준 판정, 한도·활성 주문 불변식 유지 |
| QTA-21 | QTA-20에서 T1을 강제 롤백 | T2의 행 삽입이 진행되어 정상 처리, 카운터 = T2 좌석 수 |
| QTA-22 | `REVIEW_REQUIRED`(좌석 CONFIRMING 보호 중) 주문 보유 주체가 같은 회차 새 주문 | 409 `ACTIVE_ORDER_EXISTS` |
| QTA-23 | `RELEASE_SEATS` 실행(결제 종료·승인 결제 EXCESS) | 한 트랜잭션에서 hold RELEASED·쿼터 −n·주문 `UNFULFILLED`, 이후 같은 회차 새 주문 성공. 트랜잭션 중간 실패 주입 시 전부 롤백 |
| QTA-24 | `RELEASE_SEATS`를 `CONFIRMING`/`UNKNOWN` 결제가 남은 주문에 실행 | 409 `PAYMENT_IN_PROGRESS`, 상태 불변 |
| QTA-25 | 정상 `PAID` 주문에 초과 승인 발생 | 주문 `PAID` 유지, 결제 EXCESS + review case, 한도 내 추가 주문 가능 |
| QTA-26 | 같은 주체의 `PAYMENT_UNKNOWN` 주문 존재 시 새 주문 | 409 `ACTIVE_ORDER_EXISTS` |
| QTA-27 | quota 관련 트랜잭션 격리 수준 검사(계측) | 모두 READ COMMITTED, 판정 쿼리가 잠금 이후 실행 |
| QTA-28 | 회차 `max_seats_per_identity` 변경 후 기존 쿼터 행 | `seat_limit` 불변(snapshot) |

## 6. P0 본인인증/개인정보 [확정 D-004]

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| IDV-01 | 정상 인증 → claim | BOOKING 세션 발급, 인증 `CONSUMED`, 만료 30분(설정값) |
| IDV-02 | 인증 실패·취소 | 세션 미발급 |
| IDV-03 | 인증 없이 좌석 점유·주문 시도 | 401 `IDENTITY_SESSION_REQUIRED` |
| IDV-04 | **다른 브라우저에서 claim** | 거부(바인딩 불일치) |
| IDV-05 | **세션 쿠키를 다른 브라우저로 복사해 사용** | 401 `BROWSER_BINDING_MISMATCH` |
| IDV-06 | claim 재사용(같은 인증 2회) | 거부 |
| IDV-07 | 같은 `provider_transaction_id`로 다른 인증 레코드 검증 | 거부(unique) |
| IDV-08 | 클라이언트 성공 위조·콜백 위조(nonce 불일치) | 서버 검증 실패, 상태 불변 |
| IDV-09 | claim 기한 경과 | 거부 |
| IDV-10 | 세션 만료 후 진행 중 주문 접근 → 재인증 | 같은 subject로 기존 주문 이어서 진행 |
| IDV-11 | LOOKUP 세션으로 주문 생성·결제 | 403 `SESSION_PURPOSE_MISMATCH` |
| IDV-12 | LOOKUP 세션으로 주문 목록 | 인증 주체의 주문만 반환 |
| IDV-13 | 세션 없이 주문 목록 | 401 |
| IDV-14 | 인증 시작·claim 반복 | rate limit |
| IDV-15 | 같은 브라우저에서 재인증 | 기존 같은 purpose 세션 `REVOKED`, 새 토큰 |
| IDV-16 | 로그·DB 검사 | 동일인 식별값 원문 없음(HMAC만), 전화번호·토큰 마스킹 |
| IDV-17 | 인증 콜백이 cross-site POST로 도착 | 쿠키 없이 처리 후 303, 결과 페이지에서 claim 성공 |
| IDV-18 | BOOKING 세션으로 29분간 계속 요청 | `expires_at` 불변(sliding 없음), 30분에 만료 |
| IDV-19 | 같은 브라우저에서 주문 취소 후 재예매(세션 유효) | 재인증 없이 성공, 세션 유지 |
| IDV-20 | 세션 잔여 9분에 주문 생성 | 422 `IDENTITY_SESSION_TIME_INSUFFICIENT` |
| IDV-21 | 세션당 주문 생성 상한(설정값) 초과, 주체·회차 시간당 상한 초과 | 429 `ORDER_CREATION_LIMITED` |
| IDV-22 | 다른 브라우저에서 새 인증 후 같은 회차 주문(첫 브라우저에 활성 주문 존재) | 같은 subject로 409 `ACTIVE_ORDER_EXISTS` |

### 6.1 Bootstrap·CSRF (BOOT, Step 4, A-044) — `tests/unit/bootstrap-csrf.test.ts`

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| BOOT-01 | 최초 방문 | `__Host-nz_bind` 발급(Secure·HttpOnly·Path=/·SameSite=Lax·Max-Age 30일·Domain 없음), `no-store`, 토큰 검증 통과 |
| BOOT-02 | 유효한 쿠키로 재방문 | 재사용, `Set-Cookie` 없음, 같은 토큰 |
| BOOT-03 | 형식 오류·중복 쿠키 | 새 바인딩 발급 |
| BOOT-04 | 보안 설정 누락 | 500, 쿠키·토큰 없음, 키 미노출 |
| BOOT-05 | 다른 바인딩·변조·형식 오류 토큰 | 검증 실패 (2026-11-28: 변조 위치를 MAC 첫 문자로 변경 — 아래 결과 참고) |
| BOOT-05b | 유효 토큰의 비정규 표기(마지막 문자만 다르고 디코딩 바이트는 같은 3가지) | 검증 실패. 원래 토큰은 통과 |
| BOOT-05c | 무작위 키·바인딩 500쌍 반복: 정규 토큰, 비정규 표기 3종, 첫 문자 변조 | 정규 토큰만 통과 |
| BOOT-06 | 용도가 다른 HMAC | 검증 실패(용도 분리) |
| BOOT-07 | 키 교체 | 새 토큰은 현재 버전, 이전 버전 검증 허용, 제거된 버전 거부 |
| BOOT-08 | 정확한 Origin + 유효 토큰 | 통과 |
| BOOT-09 | Origin 누락·`null`·타 사이트·슬래시·http·하위 도메인, `Sec-Fetch-Site` cross/same-site | 403 `CSRF_REJECTED` |
| BOOT-10 | 토큰 누락·다른 바인딩 토큰·바인딩 없음 | 403 `CSRF_REJECTED` |
| BOOT-11 | 키링 형식 오류(짝 누락·짧은 키·버전 없음·현재 버전 없음·중복 버전·같은 키·base64url 아님), 키링 간 키 공유 | 거부, 오류에 키 미노출 |
| BOOT-12 | 환경별: production·staging 누락 시 기동 거부, local·test는 기동 후 사용 시 실패, Origin 규칙(https·loopback http) | 표대로 |

**결과(2026-11-24):** unit 332 passed(BOOT 포함 37건 신규), DB 390 passed. 실제 Chromium(Playwright, `next start`, http://localhost)에서 쿠키 저장·속성·JS 비노출·재방문 시 재설정 없음·같은 토큰 확인.

**BOOT-05 간헐 실패 원인과 수정(2026-11-28, 브랜치 `claude/elegant-pasteur-i0mjlt`, Step 5 `8b27bb3` 기준):**
- 증상: BOOT-05가 가끔 실패(실측 30회 중 3회). 실패 단언은 "마지막 문자를 바꾼 토큰은 거부"였다.
- 원인: CSRF 토큰은 `v<N>.` + 32바이트 HMAC의 base64url(43자)이다. 마지막 문자에는 사용되지 않는 2비트가 있어 한 MAC에 4가지 표기가 있고, `verifyVersioned`가 `Buffer.from(…, "base64url")`로 디코딩하면서 그 비트를 무시했다. 토큰이 `A`/`B` 등으로 끝나면 테스트의 "변조"가 같은 바이트가 되어 검증을 통과했다(키가 실행마다 무작위라 간헐적). MAC 바이트가 같으므로 위조는 아니고 **토큰 가변성(malleability)** 문제다.
- 수정: `src/server/lib/crypto/hmac.ts` `verifyVersioned`가 디코딩한 바이트를 다시 인코딩해 입력과 같을 때만(정규 표기) 비교한다. `mac()`·`signVersioned`는 변경 없음(항상 정규 표기를 만든다). 호출자는 `verifyCsrfToken`(`src/server/lib/csrf.ts`) 하나뿐이며, rate limit은 `signVersioned`만 쓰고 검증하지 않는다. 다른 HMAC 기능은 영향 없음.
- 테스트: BOOT-05의 변조 위치를 모든 비트가 유효한 MAC 첫 문자로 바꿔 결정적으로 만들고 BOOT-05b·05c를 추가했다.
- **수정 전후 비교:** 검사 한 줄을 제거하면 BOOT-05b·05c가 실패(39건 중 2건), 복원하면 39건 통과 — 새 테스트가 수정에 의존함을 확인.
- **실행 결과(2026-11-28 11:31 UTC, 로컬):** BOOT 파일 39 passed, BOOT-05* 30회 반복 30/30 통과, 전체 Unit 21개 파일 **499 passed**(기존 497 + 2) 6회 연속, typecheck·lint·`git diff --check` 통과. DB 테스트는 이 변경과 무관해 실행하지 않음.

### 6.2 Rate limit (RL, Step 4, A-045)

Unit `tests/unit/rate-limit.test.ts`(RL-U01~U05), DB `tests/contract/schema/rate-limit.test.ts`(RL-01~12, 실제 PostgreSQL).

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| RL-U01 | 신뢰 IP | `x-vercel-forwarded-for`만 사용, `x-forwarded-for`·`x-real-ip` 무시, 누락·목록·형식 오류 거부, IPv6 /64, `fixed`는 local·test만 |
| RL-U02 | 정책값 | 초안 기본값, `identity.start.binding` 설정 필수, 잘못된 override 거부 |
| RL-U03 | 설정 | staging·production 키링·`vercel` 필수, CSRF 키 공유 거부, local·test 누락 시 사용 단계에서 실패 |
| RL-U04 | 키 | 버전 포함 HMAC, 정책·차원·값 분리, 원문 미포함 |
| RL-U05 | 결과 | 허용·남은 횟수, 거절·retryAt(DB 시각), 429 vs 503 구분, 미설정 정책 503 |
| RL-01~03 | 최초·도달·초과 | 1회 허용, limit번째 남은 0, 초과 거절, 거절이 창을 연장하지 않음, count 상한 limit+1 |
| RL-04 | 창 경과 | count 1로 재시작 |
| RL-05·06 | 분리 | 정책별, IP별, 바인딩별 |
| RL-07 | 원문 미저장 | 행에 IP·바인딩 원문 없음, CHECK가 원문 키·임의 정책명 거부 |
| RL-08 | DB 시각 | 프로세스 시계가 2001년이어도 창은 DB now() |
| RL-09 | 동시성 | advisory lock barrier로 50개 트랜잭션 동시 진행: limit 10 → 정확히 10 허용, 남은 값 9..0 각 1회, 행 1개; 최초 INSERT 경합 50/50 정확; 25개 키 독립; 앱 Prisma 풀로 30건 → 7 허용 |
| RL-10 | 저장소 장애 | 연결 실패·테이블 없음 → 503 `RATE_LIMIT_UNAVAILABLE`, 로그에 IP 없음 |
| RL-11 | 정리 | 만료 행만 배치 삭제 |
| RL-13 | A-047 /64 | 같은 /64의 60개 다른 주소가 한 bucket, 다른 /64 독립, mapped IPv4 = IPv4 |
| RL-14 | 공용 IP 여러 브라우저 | 브라우저마다 5회, 네트워크 전체 60회 |
| RL-12 | 경계 시각 | `expires_at = now()`는 만료(재시작·삭제), `+1µs`는 유지 |

**결과(2026-11-24):** unit 352 passed, DB 407 passed. 2026-11-25 A-047 반영 후 RL unit 21, RL DB 19 통과.

**미검증(완료로 표시하지 않음):** 실제 Vercel Preview에서 `x-vercel-forwarded-for` 전달, 만료 행 정리 스케줄(미구현).

### 6.3 개인정보 암호화·DI HMAC·파기 (Step 4, A-043, A-048)

Unit `tests/unit/pii-crypto.test.ts`, DB `tests/contract/schema/pii-subjects.test.ts`. 값은 모두 합성 표지(MARKER)이며 행·로그·오류에 나타나지 않는지 검사한다.

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| PII-U01 | 암복호화 왕복 | 형식 `v<N>.nonce(12B).ct.tag(16B)`, 호출마다 다른 nonce |
| PII-U02 | 변조(nonce·ct·tag·길이)·다른 필드로 이동 | 거부, 오류에 원문·암호문 없음 |
| PII-U03 | 잘못된 형식 | 거부 |
| PII-U04 | 키 교체 | 구버전 복호화, 신규는 current, 없는 버전 거부 |
| PII-U05 | 빈 값·과대 값·미지 필드 | 거부, 값 미노출 |
| PII-U06 | DI HMAC | 버전별 결정적, current 우선, DI 없음 → `DiUnavailableError`(대체 없음) |
| PII-U07 | 키 분리 | 4개 키링 중 어느 둘이 같은 키여도 거부 |
| PII-U08 | 누락 | staging·production 기동 거부, local은 사용 시 실패, AES 키 32바이트 강제 |
| SUBJ-01·02 | 생성·재조회 | DI subject 1개, 원문 미저장 |
| SUBJ-03 | 키 교체 | v1 행을 {v1,v2}에서 찾아 같은 id로 v2 갱신, {v2}만으로 조회 |
| SUBJ-04·06b | 절차 위반 | 구버전을 먼저 빼거나 {v1} 인스턴스가 남으면 중복 → 다음 조회에서 `SubjectKeyConflictError`(병합 안 함) |
| SUBJ-05 | 동시 첫 인증 20건 | subject 1개 |
| SUBJ-06 | 교체 중 current v1·v2 인스턴스 동시 | subject 1개, 하향 갱신 없음 |
| SUBJ-07 | DI 없음 | 오류, 기록 없음 |
| SUBJ-08 | 파기된 subject | 매칭 안 됨, 새 subject |
| ERASE-01 | 저장값 | 암호문, 복호화 일치 |
| ERASE-02 | 인증 개인정보 파기 | 세션·주문 FK가 있어도 가능, 재기록 CHECK 거부, 재파기는 로그 없음 |
| ERASE-03·04 | 주문 고객 필드 | 필드별 파기, 주문·금액·상태 유지, 표시 없이 제거 불가 |
| ERASE-05 | DI HMAC 파기 | subject 행 유지, 주문 연결 유지 |
| ERASE-06 | 파기 로그 | 컬럼 이름만, 값·암호문 없음, UPDATE·DELETE 거부 |
| ERASE-07 | 로그 입력 | 자유 텍스트 사유·미지 필드·행위자 불일치 거부 |
| ERASE-08 | 없는 id | not found, 로그 없음 |

**결과(2026-11-25):** unit 375 passed(PII 22 포함), DB 426 passed(SUBJ·ERASE 17 포함, DRIFT-01 포함).

### 6.4 IdentityProvider·인증 시작 (Step 4, A-049)

Unit `tests/unit/identity-provider.test.ts`(IDP-U01~05), DB·API `tests/contract/schema/identity-start.test.ts`(START-01~20, 실제 PostgreSQL·실제 rate limiter·CSRF·Mock).

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| IDP-U01 | Mock local·test | 시작 성공, 같은 출처 launch, 신원 입력 없음, 주입 난수로 결정적 |
| IDP-U02·03 | Mock staging·production·잘못된 값 | factory와 클래스 모두 거부, 시작 검사도 거부(PRV-01/02) |
| IDP-U04 | 잘못된 provider 설정 | 거부 |
| IDP-U05 | NICE adapter | 항상 `ProviderUnavailableError` |
| START-01·02 | 정상(BOOKING·LOOKUP) | 200, PENDING, 바인딩 hash, state hash만 저장, context 암호화, TTL 10분(DB 시각), no-store |
| START-03 | 요청 형식(필드 누락·미지 purpose·returnUrl 포함·배열·비JSON·content-type·과대) | 400, 기록·카운터 없음 |
| START-04 | 바인딩 누락·변조 | 401 `BROWSER_BINDING_REQUIRED`, 카운터 없음 |
| START-05 | CSRF 토큰 누락·다른 브라우저·변조, Origin 누락·타 사이트·null | 403, 카운터 없음 |
| START-06 | 같은 브라우저 6번째 | 429 + Retry-After, 이전 시작은 SUPERSEDED |
| START-07 | IP 60회 초과 | 429, 새 브라우저 카운터 미생성(IP 먼저) |
| START-08·09 | rate limit 저장소 장애, 신뢰 IP 헤더 없음 | 503 `RATE_LIMIT_UNAVAILABLE`, 행 없음 |
| START-10·11·12 | provider 장애·거부·잘못된 응답(외부 URL·javascript:·잘못된 id)·예상 밖 예외 | 503 / 502, 행 FAILED, 로그·응답 비노출 |
| START-13 | Mock을 production으로 생성 | 503, 행 없음 |
| START-14·15 | 중복·동시 요청 | 409 `REQUEST_IN_PROGRESS`, provider 1회, PENDING 1건 |
| START-16 | DB 방어 | 두 번째 PENDING·같은 state hash 거부 |
| START-17 | state | 매번 새 값, 고정 난수면 두 번째 실패(재사용 없음) |
| START-18 | 만료 후 provider 응답 | 저장 안 함, 409 |
| START-19 | 응답 없는 오래된 PENDING | 새 시작이 대체 |
| START-20 | 로그 | 바인딩·키·IP 없음 |

**결과(2026-11-26):** unit 390 passed, DB 459 passed.

### 6.5 Mock 인증·Callback (Step 4, A-050) — `tests/contract/schema/identity-callback.test.ts`

실제 PostgreSQL, 실제 시작·Mock 제어·Callback 핸들러를 순서대로 실행한다.

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| CB-01 | Mock 페이지 거래 조회 | PENDING MOCK만, 미지·형식 오류·비활성 환경은 없음 |
| CB-02 | 비활성(staging·production) | 제어 라우트 404, Mock 생성 거부 |
| CB-03 | 제어 라우트 | 타 Origin·Origin 없음 403, 미지 결과·임의 DI 400, 두 번째 완료 410, 저장된 callback으로만 이동 |
| CB-04 | 성공 | VERIFIED, DI HMAC subject, 이름·전화 암호화, claim 5분, context 삭제, 바인딩 보존, state 없는 303 |
| CB-05·06 | 취소·실패 | FAILED(코드), subject·개인정보 없음 |
| CB-07 | 같은 인물 재인증 | 같은 subject |
| CB-08·09 | state 누락·형식·중복·미지 | 상태 불변 |
| CB-10 | 다른 provider | 상태 불변 |
| CB-11 | 위조(결과 토큰 없음·불일치) | FAILED `INTEGRITY_FAILED` |
| CB-12 | 만료 | EXPIRED |
| CB-13 | 재전송 | `ALREADY_PROCESSED`, 행 불변 |
| CB-14 | 같은 state 동시 20회 | VERIFIED 1회, subject 최대 1개 |
| CB-15 | 같은 신규 인물의 서로 다른 거래 동시 완료 | subject 1개 |
| CB-16 | 전이 트랜잭션 중 오류 | 롤백(PENDING, subject 없음), 재시도 성공 |
| CB-17 | provider 장애 | PENDING 유지 |
| CB-18 | DI 없음 | FAILED `DI_UNAVAILABLE`, 대체 없음 |
| CB-19 | 이상 값 | `INTEGRITY_FAILED` |
| CB-20 | 다른 브라우저 바인딩 세션 | DB가 거부(4열 FK) |
| CB-21 | 쿠키 | 읽지도 설정하지도 않음 |
| CB-22 | 로그 | state·결과 토큰·DI·이름·전화 없음 |
| CB-23 | 앱 Prisma 트랜잭션 경유 전체 흐름 | 성공(void 컬럼 회귀 방지) |

**결과(2026-11-26):** unit 390 passed, DB 483 passed. 실제 Chromium(`next start`, test 환경, 새 DB): bootstrap → 시작 200 → Mock 화면 → 인물 A → 303 연쇄 → `/identity/complete?vid=`(state·토큰 없음), DB `VERIFIED`·암호화·context 삭제, 사용한 거래의 Mock 화면은 not-found, 타 Origin 제어 403, 서버 로그에 state·토큰·이름 없음.

### 6.6 Claim·인증 세션 (Step 4, A-051)

DB `tests/contract/schema/identity-claim.test.ts`(**앱 Prisma 클라이언트의 실제 interactive 트랜잭션**, 인증은 실제 시작→Mock→callback으로 생성), Unit `tests/unit/db-errors.test.ts`.

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| CLM-01 | 같은 브라우저 claim | 200, CONSUMED, ACTIVE 세션 1개, 30분 고정, 쿠키 속성, 토큰은 쿠키에만(DB는 hash) |
| CLM-02 | 다른 브라우저 | 401 `BROWSER_BINDING_MISMATCH`, 변경 없음 |
| CLM-03 | VERIFIED 아님(취소·실패·EXPIRED) | 422 |
| CLM-04 | 미지 id 404, 형식·본문 필드 400 | |
| CLM-05 | 창: 5분 확인, 경계(`= now()`) 거부, 경과 거부, 직전 성공 | |
| CLM-06 | CSRF·Origin·바인딩 누락 | 거부, 변경 없음 |
| CLM-07 | 사용된 세션의 재 claim 422, 재인증 시 이전 세션 REVOKED(IDV-15) | |
| CLM-08 | 응답 유실 후 재 claim | 같은 세션 행, 새 토큰, 이전 토큰 무효, 만료 불변; 다른 브라우저·창 경과 거부 |
| CLM-09 | 사용·폐기·만료된 세션은 복구 불가 | 422 |
| CLM-10 | 같은 claim 15회 동시 | 세션 1개, 유효 토큰 1개, 스스로 폐기 없음 |
| CLM-11 | 같은 브라우저의 다른 인증 2건 동시 claim | ACTIVE 1개, 제약 오류 비노출 |
| CLM-12 | BOOKING·LOOKUP 분리 | |
| REC-01 | 복구 창 경계(세션 생성 + 4분59초 성공, 정확히 5분·5분1초 거부) | |
| REC-02 | `claim_expires_at`과 독립(지나도 5분 안이면 복구, 반대로 claim 창이 열려도 5분 지나면 거부) | |
| REC-03 | 복구 결과 | 같은 행·만료 불변·CONSUMED 유지·새 hash·이전 토큰 무효 |
| REC-04 | 동시 복구 10회 | 유효 토큰 1개, 세션 1행 |
| REC-05 | 사용된 세션 | 복구 거부, 사용 중 토큰 유지 |
| REC-06·07 | 다른 verificationId(같은 브라우저의 이전 인증, 다른 브라우저의 인증, 세션 없는 id) | 거부, 다른 세션 토큰 불변 |
| LKP-01 | LOOKUP 10분 고정, 사용해도 불변, `expires_at = now()`면 만료 | |
| M7-01 | COMMIT 시점 23514 | `DriverAdapterError`, SQLSTATE만(이름 없음) 실측, 매핑; 문장 시점 23505 이름 포함 |
| M7-02 | claim 트랜잭션이 COMMIT에서 실패 | 422, 인증 VERIFIED 유지, 새 세션 없음, 기존 세션 폐기 안 됨 |
| M7-03 | 무관한 오류 | 500, 내부 메시지 비노출 |
| SES-01 | 조회 | 3개 필드만, 마스킹, no-store, `expires_at` 불변 |
| SES-02 | 만료·폐기·형식 오류·쿠키 없음 | 401 |
| SES-03 | 다른 브라우저로 복사된 토큰 | 401 `BROWSER_BINDING_MISMATCH` |
| SES-04 | 로그아웃·이후 토큰 거부·반복 로그아웃 | 204, 같은 속성으로 쿠키 삭제 |
| SES-05 | 다른 사용자 세션 영향 없음 | |
| SES-06 | CSRF 없는 로그아웃 | 403, 폐기·쿠키 삭제 없음 |
| SES-07 | DB: 바인딩·purpose당 ACTIVE 1개 | 23505 |
| SES-08 | 로그 | 토큰·바인딩·이름·전화 없음 |
| M7-U01 | 오류 형태 3종, 메시지 미사용, 이름 마스킹 | |

**결과(2026-11-27):** unit 396 passed, DB 506 passed → A-052 반영 후 DB 514 passed(REC·LKP 8건 추가). 실제 Chromium(`next start`, test 환경): bootstrap → 시작 → Mock(인물 B) → callback → claim 200(`__Host-nz_idv` HttpOnly·Secure·Lax·30분, JS 비노출) → 세션 조회 200 → 사용 후 재 claim 422 → 로그아웃 204(쿠키 삭제) → 조회 401.

## 7. P0 결제/티켓 [확정 D-003, D-005]

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| PAY-01 | 정상 결제 | Tx1 → confirm → Tx2, `PAID`/`SOLD`/티켓, `role = PRIMARY` |
| PAY-02 | 브라우저 redirect 파라미터만 성공 | 확정되지 않음 |
| PAY-03 | 복귀 시 hold 이미 만료 | confirm 미호출, 결제 `CANCELED`, 주문 `EXPIRED` |
| PAY-04 | 복귀 금액 위조 | confirm 미호출, 결제 `FAILED` |
| PAY-05 | **Tx1 커밋 직후 7분 경과 + 다른 사용자 점유 시도** | 거부(펜싱), 승인 시 정상 확정 |
| PAY-06 | confirm 2분 후 승인 응답 | 3분 내 → `PAID` |
| PAY-07 | confirm timeout, 3분 경과 | 결제 `UNKNOWN`, 주문 `PAYMENT_UNKNOWN`, **hold `CONFIRMING` 유지, 좌석 해제 없음, 실패 처리 없음** |
| PAY-08 | UNKNOWN 후 재조회에서 승인 확인 | `PAID`, 티켓 1회 |
| PAY-09 | UNKNOWN 후 재조회에서 승인 없음 확정(7분 경과) | 결제 `FAILED`, 주문 `EXPIRED`, 한도 복구 |
| PAY-10 | 실패 확정, 7분 남음 | 주문 `PENDING`, hold `ACTIVE`, 만료시각 불변, 새 결제 시도 가능 |
| PAY-11 | UNKNOWN 중 새 결제 시작 | 409 `PAYMENT_IN_PROGRESS` |
| PAY-12 | 같은 결제 key 재요청 | 결제 중복 생성 없음 |
| PAY-13 | 두 탭에서 동시 결제 시작 | 진행 중 결제 1건(기존 READY는 CANCELED) |
| PAY-14 | CANCELED된 READY 결제로 PG 복귀 | confirm 미호출 |
| PAY-15 | 승인 금액 불일치 | 발권 금지, 결제 `EXCESS`, 주문 `REVIEW_REQUIRED`, hold 보호 유지, review case |
| PAY-16 | 이미 PAID 주문에 다른 결제 승인 발견 | 이력 보존, `role = EXCESS`, 주문 `PAID` 유지, review case |
| PAY-17 | 허용 외 결제수단(가상계좌) 요청·보고 | 시작 시 422, PG 보고 시 확정 금지·review case |
| PAY-18 | 복귀·webhook·재조회 동시 도착 | 판매 확정 1회, 티켓 항목당 1장 |
| PAY-19 | 판매 확정 트랜잭션 재시도 | 항목당 티켓 1장 |
| PAY-20 | confirm 호출 직후 프로세스 종료(crash 주입) | `CONFIRMING` 잔존 → 3분 후 UNKNOWN → 재조회로 해소 |
| PAY-21 | confirm이 DB 트랜잭션 밖에서 호출되는지 | 계측으로 확인(트랜잭션 내 외부 호출 0건) |
| PAY-22 | 남은 점유 60초 미만에서 결제 시작 | 422 `HOLD_TIME_INSUFFICIENT`(설정값) |
| PAY-23 | UNKNOWN 10분·30분 경과 | 경보, 30분에 `PAYMENT_UNKNOWN_PROLONGED` review case |
| PAY-24 | `expireOrder`와 Tx1 동시 실행 | 둘 중 하나만 효과, 결제 미발생 또는 정상 펜싱 |
| PAY-25 | 결제 진행 중 판매 PAUSED 전환 | 진행 중 주문은 확정 완료 |
| PAY-26 | 비활성 결제수단·카드사(심사 미완료 설정) 요청 | 422 `PAYMENT_METHOD_UNAVAILABLE`, `GET /payment-methods`에 미노출 |
| PAY-27 | 승인 응답의 카드사·간편결제사가 허용 목록 밖(Mock 주입) | 자동 확정 금지, 결제 EXCESS + `DISALLOWED_METHOD` |
| PAY-28 | confirm INDETERMINATE → orderId 조회 `IN_PROGRESS` → 같은 멱등 키 재시도 | 중복 승인 없이 1회 승인, 3분 내 확정 |
| PAY-29 | confirm timeout 60초 상황에서 3분 경과 | UNKNOWN 전환, 좌석 보호 유지, 이후 조회 `DONE`이면 PAID |
| PAY-30 | UNKNOWN 중 조회 결과 `EXPIRED`(인증 후 10분 경과, Mock) | 결제 FAILED, 점유 만료 시 주문 EXPIRED·쿼터 복구 |
| PAY-31 | 페이코·카카오페이·가상계좌 요청 | 422 `PAYMENT_METHOD_NOT_ALLOWED` |

## 8. P0 Webhook

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| WH-01 | Webhook 반복 수신 | 중복 확정 없음 |
| WH-02 | 순서 역전 | PG 재조회 기준 반영 |
| WH-03 | 위조 서명(서명 제공 PG) | 상태 변경 없음 |
| WH-04 | event ID 없는 webhook | provider dedupe key 적용 |
| WH-05 | **첫 처리 FAILED 후 같은 이벤트 재전송** | 재처리되어 반영 |
| WH-06 | PROCESSING lease 만료 | 재처리 |
| WH-07 | 결제 미매칭 이벤트 | `UNMATCHED` + review case |
| WH-08 | payload 금액·상태 위조(서명 미제공 PG) | 재조회 결과로만 반영 |
| WH-09 | 취소(환불) 이벤트 | 환불 대사 실행 |
| WH-10 | 서명 헤더 없음 | `signature_verified=false` 기록, 조회 결과로만 반영 |
| WH-11 | 같은 이벤트를 `transmission-id`만 바꿔 재전송 | eventId(또는 조합 키)로 중복 판정, 1회 처리 |
| WH-12 | 수신 엔드포인트 계측 | 외부 호출 0건, 상태 변경 0건, 10초 이내 200 |
| WH-13 | 웹훅 본문의 status가 `DONE`이지만 조회 결과 `IN_PROGRESS` | 확정하지 않음(조회 결과 우선) |

## 9. P0 환불 [확정 D-007]

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| REF-01 | 요청 기록 | `REQUESTED`, 티켓 `ISSUED`, 좌석 `SOLD`, 한도 불변 |
| REF-02 | PG 실행 기록 → 검증 성공(전액) | `COMPLETED`, 티켓 VOID, 좌석 해제, 한도 복구, 주문 `REFUNDED` |
| REF-03 | 부분 환불(4석 중 1석) | 해당 항목만, 주문 `PAID` 유지 |
| REF-04 | `SEAT` 항목 합계 ≠ 총액 | 거부 |
| REF-05 | 같은 항목 중복 환불 요청 | 거부 |
| REF-06 | 결제별 누적(완료+진행 중) > 승인 금액 | 거부, CHECK 최종 방어 |
| REF-07 | 동시 환불 요청 | 잠금으로 초과 방지 |
| REF-08 | PG 재조회 결과 환불 없음 | `FAILED`, 좌석·티켓 유지 |
| REF-09 | PG 환불 성공 후 DB 반영 실패 | `VERIFYING` 잔존 → 재검증으로 멱등 복구, 이중 기록 없음 |
| REF-10 | DB 요청 없이 PG에서 환불됨 | 취소 webhook/대사로 `REFUND_UNRECORDED` |
| REF-11 | **REVIEW_REQUIRED 주문의 초과 결제 환불** | `PAYMENT_EXCESS`, 좌석·타인 티켓 불변 |
| REF-12 | **소유 불일치 좌석 해제 시도**(fixture로 다른 항목이 소유) | 해제 거부, `SEAT_OWNERSHIP_MISMATCH` |
| REF-13 | 중복 승인 결제(EXCESS) 환불 후 정상 결제 좌석 환불 | 서로 독립, 각 결제 한도 내 |
| REF-14 | `SEAT` 유형을 EXCESS 결제에, `PAYMENT_EXCESS`를 PRIMARY에 | 거부 |
| REF-15 | 환불 완료 커밋 시점 좌석 재점유 경합 | 커밋 전 점유 불가, 커밋 후 한도·좌석 동시 반영 |
| REF-16 | 재판매 정책 BLOCKED/AVAILABLE 설정 | 설정대로 해제 상태 |
| REF-17 | 사용자 입력만으로 완료 시도 | 불가(PG 검증 필수) |

## 10. P0 관리자/Review case

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| ADM-01 | 비로그인 관리자 API | 401 |
| ADM-02 | 비활성 관리자 로그인 | 거부 |
| ADM-03 | 반복 로그인 실패 | rate limit |
| ADM-04 | 좌석 차단/해제 | 상태 변경 및 audit log(같은 트랜잭션) |
| ADM-05 | hold/SOLD 좌석 차단 | 거부 |
| ADM-06 | STAFF가 SUPER_ADMIN 전용 action | 403 |
| ADM-07 | review case action 각각 | 정의된 효과 + 감사 로그 |
| ADM-08 | 열거 외 수정 요청 | 제공되지 않음 |
| ADM-09 | DB 직접 수정 없는 복구(UNKNOWN 장기화, 금액 불일치, 미기록 환불) | 관리자 흐름으로 완료 |
| ADM-10 | 로그인 시 세션 토큰 재발급, 로그아웃 시 폐기 | 확인 |
| ADM-11 | 관리자 화면 전화번호 | 기본 마스킹 |

## 11. P1 Outbox/Sheets 및 운영 작업

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| OUT-01 | 핵심 변경과 outbox 생성 | 같은 DB transaction(P0) |
| OUT-02 | Sheets 장애 | 주문·결제 성공 유지 |
| OUT-03 | 이벤트 재전송 | 중복 row 없음 |
| OUT-04 | worker 동시 claim | 한 worker만 lease |
| OUT-05 | worker crash | lease 만료 후 재시도 |
| OUT-06 | 일시 실패 | backoff 재시도 |
| OUT-07 | 최대 재시도 초과 | DEAD + review case |
| OUT-08 | 같은 aggregate의 오래된 이벤트가 늦게 처리 | 최신 행 덮어쓰지 않음(SUPERSEDED) |
| OUT-09 | Sheets payload | 전화번호 마스킹 |
| OPS-01 | 만료 작업 중복 실행 | 안전 |
| OPS-02 | 정합성 검사 | 불일치 시 review case |
| OPS-03 | PG 일일 대사 | 미매칭 승인·미기록 환불 탐지 |

## 12. E2E 필수 흐름

1. 본인인증 → claim → 공연 → 회차 → 좌석 → 주문.
2. 결제(PG sandbox) → 복귀 → 펜싱 → confirm → PAID → SOLD → 티켓 → 확인서.
3. 취소 후 다른 좌석 재예매.
4. 동일 좌석 경합(두 사용자).
5. 동일인 한도: 2석 결제 + 2석 추가 + 1석 거부.
6. 결제 중 브라우저 종료 및 UNKNOWN 복구.
7. 7분 만료 직전 결제 진입 → 7분 경과 후 승인(펜싱으로 정상 확정).
8. 조회용 본인인증 → 주문 목록 → 확인서.
9. 관리자: REVIEW_REQUIRED 처리, 수동 환불 3단계, 한도 복구 확인.

## 13. 보안 체크리스트

- [ ] 주문번호만으로 주문 접근 불가
- [ ] 인증 세션·접근 세션의 브라우저 바인딩, 다른 브라우저 재사용 불가
- [ ] 인증 결과 1회 claim, 거래 ID 재사용 불가
- [ ] Idempotency 소유 주체 분리(타인 키 재사용으로 주문·쿠키 획득 불가)
- [ ] 토큰·키·동일인 식별값 원문 DB/로그 저장 금지
- [ ] 쿠키 기반 API CSRF(Origin + 토큰), `__Host-` 쿠키
- [ ] returnUrl 서버 결정, open redirect 없음
- [ ] 외부 복귀 경로 쿠키 비의존·거래 단일 사용 검증(nonce는 보존 확인 시)
- [ ] XSS/SQL injection 방어(raw query parameterized)
- [ ] 관리자 권한 서버 검증, 권한 매트릭스
- [ ] 인증·로그인·조회·주문·결제 rate limit(공유 저장소)
- [ ] PG webhook 서명 검증(보안 키)·eventId dedupe·조회 기반 비동기 처리
- [ ] 운영 환경 Mock provider·테스트 키 기동 불가(PRV-*)
- [ ] 토스 시크릿·보안 키, NICE client 정보가 클라이언트 번들·DB·로그에 없음
- [ ] `provider_context_encrypted`에 고정 비밀값·토큰 원문 없음
- [ ] secret 미커밋
- [ ] 전화번호·토큰·카드정보 로그·Sheets 마스킹
- [ ] CORS allowlist, HTTPS, Secure cookie
- [ ] 백업/복구 권한 통제
- [ ] 개인정보처리방침 게시

## 14. 부하 테스트

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| LOAD-01 | 예상 최대 동시 접속(값은 사용자 결정)에서 좌석 조회 | 응답 시간 목표 충족 |
| LOAD-02 | 인기 회차 오픈 시 동시 주문 경합 | 불변식 유지, 커넥션 고갈 없음 |
| LOAD-03 | PG mock 지연 상황의 결제 확인 | 트랜잭션 장기 점유 없음 |

## 15. Go / No-Go

**Go:** P0 전부 통과, §1.1 불변식 위반 0건, 좌석 중복 판매·한도 초과 방지 검증, PG server-side verification 및 서버 승인형 동작 확인, 결제 확인 펜싱·UNKNOWN·중복 webhook·중복 승인 복구 검증, 인증 선행·바인딩·조회 보안 검증, **PRV-* 전부 통과(운영 Mock 차단)**, **SBX-* 통과 및 토스 라이브 키로 실결제·취소 검증**, **NICE 운영 환경 실인증 검증(NIC-05~07)**, 수동 환불 3단계 리허설, 운영자 리허설 및 백업/복구 확인, 개인정보처리방침 게시, 중대한 보안 이슈 없음.

**결제수단 조건부 Go [확정 D-012]:** 카드사 심사가 일부만 완료되어도 (1) 승인된 수단만 노출(PAY-26), (2) 미승인 수단 차단(PAY-26, PAY-27), (3) 주요 결제수단 사용 가능 여부와 PG 선택적 활성화 가능 여부 확인, (4) 결제 가능 범위가 Q-018 기준 이상일 때만 Go.

**No-Go:** P0 하나라도 실패, PG/인증 실환경 검증 미완료, PG가 서버 승인형이 아님(설계 재검토 필요), UNKNOWN·좌석 경합·한도 경합 미검증, 개인정보 노출·인증 우회, 운영 복구 체계 미준비, **NICE 운영 승인 미완료(D-013 — Mock 인증으로 대체 판매 금지)**, 결제 가능 범위가 Q-018 기준 미달.

P1 미완료는 수동 대체 수단과 사용자 승인이 있을 때만 Go 가능하다. 목표 공개일보다 안전한 판매가 우선이다.

## 16. P0 Provider 단계·운영 차단 (PRV) [채택 A-024~A-026, 확정 D-013]

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| PRV-01 | 실행 환경 값 없이 기동 + Mock provider 설정 | 기동 실패(fail-closed: production으로 간주) |
| PRV-02 | production + PaymentProvider 또는 IdentityProvider = MOCK | 기동 실패 |
| PRV-03 | production + 토스 `test_` 키, 또는 클라이언트·시크릿 키 세트 불일치 | 기동 실패 |
| PRV-04 | staging + 토스 `live_` 키 | 기동 실패 |
| PRV-05 | production/staging에서 Mock 제어 라우트 호출 | 404(라우트 미등록) |
| PRV-06 | 운영 DB에 `provider = MOCK` 레코드 존재(fixture) | 정합성 검사가 CRITICAL review case 생성 |
| PRV-07 | production + NICE 설정 누락 | 기동 실패 |
| PRV-08 | 클라이언트 번들 검사 | Mock 모듈·시크릿 키 문자열 미포함 |

## 17. Sandbox 계약 테스트 — 토스 (SBX)

토스 `test_ck`/`test_sk`(계약 전 발급 가능 — 원문)로 staging 또는 local에서 실행한다. 원문 미확인 동작을 여기서 확정한다(`PROVIDERS.md` §1).

| ID | 시나리오 | 확인 내용 |
|---|---|---|
| SBX-01 | 카드 결제창(DEFAULT + `cardCompany` 지정) → success → confirm | 지정 카드사만 표시, 승인 응답 필드 정규화 |
| SBX-02 | 토스페이·네이버페이(DIRECT + `easyPay`) | `easyPay` 코드 값 확인, 응답의 간편결제 정보 정규화 |
| SBX-03 | 같은 `Idempotency-Key`로 confirm 재요청 | 첫 응답 반환, 중복 승인 없음 |
| SBX-04 | confirm 동시 2회 | 한쪽 409 처리 중 응답 여부 확인 |
| SBX-05 | `GET /v1/payments/orders/{orderId}`(API 개별 연동 시크릿 키) | 승인 결제 조회 성공 |
| SBX-06 | 인증 후 confirm 전 orderId 조회 | `IN_PROGRESS` 결제의 조회 가능 여부·응답 형식 확인(미확인 항목) |
| SBX-07 | 인증 후 10분 경과 후 조회·confirm | `EXPIRED` 응답 형식, confirm 실패 코드 확인(미확인 항목) |
| SBX-08 | 웹훅 수신 | `tosspayments-webhook-signature` 헤더 실제 존재·검증, `eventId` 존재 여부(미확인 항목) |
| SBX-09 | 전체·부분 취소 후 조회 | `cancels[].transactionKey`·금액 확인, 취소 시 웹훅 발송 여부(미확인 항목) |
| SBX-10 | successUrl에 서버가 붙인 query 보존 여부 | 미확인 항목 확인 |
| SBX-11 | 통합결제창에서 간편결제 노출 범위 | Q-021 확인 |
| SBX-12 | failUrl 파라미터 | 에러 코드·메시지·orderId 전달 형식 확인 |

## 18. NICE adapter (NIC)

NICE는 무료 테스트 건수가 없으므로(원문) NIC-01~04는 Mock, NIC-05~07은 계약·과금 시작 후 지정 인원으로만 실행한다(Q-019).

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| NIC-01 | 결과 무결성 검증 실패(Mock 변조) | `FAILED`, 세션 미발급 |
| NIC-02 | 같은 `web_transaction_id` 재사용 | 거부(`CONSUMED`/unique) |
| NIC-03 | 인증 URL 발급 후 10분 경과 콜백 | `EXPIRED` 또는 `FAILED` |
| NIC-04 | 토큰 캐시 유실 후 콜백 | `FAILED`, 재인증 안내 |
| NIC-05 | 운영 환경 실인증(본인) | VERIFIED, DI 기반 subject 생성, 생년·성별 미저장 확인 |
| NIC-06 | 결과 요청 시 다른 접근토큰 사용 | 동작 확인(토큰 동일성 미확인 항목) |
| NIC-07 | 같은 결과 재요청 | 재조회 가능 여부 확인(미확인 항목) |
| NIC-08 | 로그·DB 검사 | CI/DI 원문, client_secret, 접근토큰 원문 없음 |

## 19. 변경 이력

| 버전 | 일자 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-11-13 | 개발 전달 기준안. 원문: `docs/archive/v1.0/TEST_PLAN` |
| 1.1 | 2026-11-14 | 파일명 `TEST_PLAN.md`로 정정. 공통 사후 불변식, MIG(스키마 계약), QTA(동일인 4석·활성 주문), WH(재처리), LOAD 추가. 좌석 변경 테스트 삭제 → 취소 후 재예매(ORD-12~16). 인증 선행·바인딩·claim(IDV), 결제 확인 펜싱·3분 보호·UNKNOWN(PAY-05~11, 20~25), 소유 주체 Idempotency(ORD-05), 환불 유형·소유권·대사(REF-10~17), review case(ADM-07~09) 추가. 환불·관리자를 P0로 이동 |
| 1.2 | 2026-11-15 | QTA-20~28(쿼터 행 미존재 동시 요청·롤백, REVIEW_REQUIRED 차단, `RELEASE_SEATS`→UNFULFILLED 원자성, PAID 초과 승인, UNKNOWN 차단, 격리 수준, seat_limit snapshot), IDV-18~22(고정 30분, 재사용, 잔여 10분, 주문 생성 제한, 다른 브라우저), PAY-26~31(결제수단 활성화·허용 목록, confirm 멱등 재시도, 60초/3분, EXPIRED, 제외 수단), WH-10~13, §16 PRV(운영 Mock 차단), §17 SBX(토스 sandbox 계약 테스트·미확인 항목 확인), §18 NIC(NICE adapter) 추가. Go/No-Go에 D-012 조건부 개시·D-013 NICE 지연 시 No-Go 반영. 보안 체크리스트 보강. 이전 원문: `docs/archive/v1.1/TEST_PLAN.md` |
| 1.2.1 | 2026-11-16 | Step 2 구현 상태 반영: MIG-01~08 구현, MIG-03b·DRIFT-01·SEED-01~04 추가, 테스트 파일 대응·실행 방법. 시나리오 정의는 변경 없음 |
| 1.2.2 | 2026-11-16 | Step 2 보완 반영: MIG-09~16 신설(migration 트랜잭션·실패 복구, 결제·주문 정합성, 쿼터 FK, 인증 세션 FK, `OTHER`, DELETE 차단, 타임스탬프), INV-9~12, §2.1 공허성 검증, §2.2 후속 Step 이월 항목. 기존 시나리오 정의는 변경 없음 |
| 1.2.3 | 2026-11-17 | MIG-17·MIG-18 신설(A-038 결제 원장 DELETE 차단, `SUCCEEDED` 승인 금액). 기존 시나리오 정의는 변경 없음 |
| 1.2.4 | 2026-11-17 | MIG-17~18 보강, MIG-13 확장(바인딩), MIG-19(결제수단 요청값·원문, Q-027)·MIG-20(인증 세션 무결성, Q-028)·MIG-21(원장성 테이블 보호, Q-029) 신설, 테스트 파일 `ledger-claims.test.ts`·`payment-method.test.ts` 대응, 뮤테이션 시험 결과(§2.1.1) 추가. 기존 시나리오 정의는 변경 없음 |
| 1.2.5 | 2026-11-18 | MIG-19 보강: 미승인 결제의 `method_type` = 요청값(CHECK `payments_unapproved_method_matches_request_ck`), `ledger-claims.test.ts` 35→74개, 뮤테이션 M1~M6 결과(§2.1.1). 기존 시나리오 정의는 변경 없음 |
| 1.2.6 | 2026-11-18 | MIG-22(승인 증거 불변)·MIG-23(환불 핵심 불변·`SEAT` 합계)·MIG-24(Prisma CLI 환경 가드) 신설, 테스트 파일 `ledger-evidence.test.ts`·`cli-guard.test.ts`·`prisma-cli-guard.test.ts` 대응, 뮤테이션 시험(§2.1.2), SEED-03 대상 DB 조정·SEED-03b 추가, 기존 시나리오 정의 변경 1건(S3 `SUCCEEDED` 강등은 이제 문장 시점에 거부). |
| 1.2.7 | 2026-11-18 | MIG-24 보강: `SHADOW_DATABASE_URL` 환경 규칙·주 DB와 같은 DB 거부·미설정 시 기존 동작·거부 시 Shadow DB 불변(sentinel), `cli-guard.test.ts` 20→32개·`prisma-cli-guard.test.ts` 16→38개, 뮤테이션 SH1~SH12(§2.1.2). 기존 단언 변경 1건: "Shadow는 검사하지 않고 그대로 전달"을 새 요구에 맞게 교체. |
| 1.2.8 | 2026-11-20 | Step 3 1차 작업: CAT-01~06(§2.4, 표시용 판매 상태), CLK-01·DB-03(`DbClock`), S11(§2.3, `timestamptz`의 세션 TimeZone 해석 문제, 결정 대기) 추가, 테스트 파일 대응 추가. 기존 시나리오 정의는 변경 없음 |
| 1.2.9 | 2026-11-20 | S11 해결 반영: TZ-01~06·SEED-05 신설(§2.3), 테스트 파일 대응·뮤테이션 결과 추가. 기존 시나리오 정의는 변경 없음 |
| 1.2.10 | 2026-11-21 | 1차 리뷰 반영: `TEMPORARILY_UNAVAILABLE`(일시 품절) 확정 표시와 안내 문구, CAT-04~06 갱신·CAT-07·08 신설, `BLOCKED`만 남은 회차 정책 미결정 기록, TZ-06 공백 처리. 우선순위·`CLOSED` 공연 노출은 승인 대기 유지 |
| 1.2.11 | 2026-11-21 | Neon Pooled/Direct 연결 분리: DB-04(단위)·DB-05(CLI)·DB-06(앱 런타임)·DB-07(`check:config`)·SEED-06 신설, 뮤테이션 결과(§2.3). 기존 시나리오 정의는 변경 없음 |
| 1.2.12 | 2026-11-22 | Step 3 공개 조회 API·화면: §2.5 CAT-API-01~06·CAT-UI-01·CAT-08b, 뮤테이션·수동 확인 결과, `verify:db-session` 스크립트와 PgBouncer 결과. 기존 시나리오 정의는 변경 없음 |
| 1.2.13 | 2026-11-22 | 통합 리뷰 즉시 수정 반영: CAT-API-07(좌석 정렬), PAGE-01~06(페이지 계층·오류 경계·서버 기동) 신설, 뮤테이션·오류 경계 재시도 실측 결과. 기존 시나리오 정의는 변경 없음 |
| 1.2.14 | 2026-11-25 | §3.1 Step 5 단위 1 TX-01~12·TX-U01~U09 신설(예약 트랜잭션 러너·잠금 헬퍼·오류 분류·Pool 설정). 기존 시나리오 정의는 변경 없음 |
| 1.2.15 | 2026-11-25 | §3.2 S2-01~15·A41-01~07·변이 S2-M1~M4·A41-M1 신설, INV-9를 DB 보장으로 갱신, §2.2 S2 행 갱신. 기존 시나리오 정의는 변경 없음 |
| 1.2.16 | 2026-11-26 | §3.3 ON-01~12·ON-U01~U02 신설(Q-025). 1.2.15의 날짜 표기 정정(11-28 → 11-25). 기존 시나리오 정의는 변경 없음 |
| 1.2.17 | 2026-11-26 | §3.4 IDM·CO·OR 신설(주문 생성 API·멱등성). 기존 시나리오 정의는 변경 없음 |
| 1.2.18 | 2026-11-26 | §3.5 EX·PC·JOB·CN 신설(만료·사전 정리·정기 작업·취소). CO-09를 사전 정리 동작에 맞게 갱신. 기존 시나리오 정의는 변경 없음 |
| 1.2.23 | 2026-11-28 | §6.1 BOOT-05 간헐 실패 원인(base64url 마지막 문자의 미사용 비트)과 수정(비정규 MAC 표기 거부), BOOT-05b·05c 신설, 실행 결과. 기존 시나리오는 BOOT-05의 변조 위치만 변경. (번호는 Step 6 브랜치의 1.2.19~1.2.22와 겹치지 않도록 1.2.23 사용) |
