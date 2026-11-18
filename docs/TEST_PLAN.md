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
| INV-9 | `SOLD` 좌석에 live(`ACTIVE`/`CONFIRMING`) hold가 없다 *(DB 미보장 — Step 5 서비스·동시성 테스트와 정합성 검사로 확인, S2)* |
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

**Step 2 구현 상태 (2026-11-16):** MIG-01~16 구현·통과. 실행: `TEST_DATABASE_URL=postgresql://… npm run test:db` (실제 PostgreSQL 15+ 필수, 미설정 시 건너뛰지 않고 실패). CI는 `.github/workflows/ci.yml`의 `db` job(`postgres:16` 서비스 컨테이너). 파일과 범위:

| 파일 | 내용 |
|---|---|
| `tests/contract/schema/migrations.test.ts` | MIG-01(빈 DB에 `migrate deploy`, 재실행 멱등), MIG-02, MIG-03·**MIG-03b**(DB CHECK 어휘 = `src/server/db/constants.ts`), MIG-04(모든 FK RESTRICT 포함), MIG-05(카탈로그), MIG-06(정적 DROP 검사 + 합성 SQL로 검사기 검증), MIG-07, **DRIFT-01**, `DB_CONSTRAINT` 이름이 실제 DB 객체인지 검증, 음성 대조군(일부러 망가뜨린 DB에서 검사기가 위반을 검출) |
| `tests/contract/schema/migration-safety.test.ts` | **MIG-09**(모든 migration 트랜잭션 래핑 + 검사기 검증), **MIG-10**(실제 Prisma CLI, 실제 migration에 실패 주입, 롤백·`P3009`·`resolve --rolled-back`·재시도, 래퍼 없는 음성 대조군) |
| `tests/contract/schema/integrity.test.ts` | MIG-05(동작), MIG-08, 규칙 1~14의 동작 증명(SQLSTATE·제약 이름 단언), 실제 2커넥션 동시 INSERT, QTA-18·QTA-19·ORD-17 중 DB 수준 부분 |
| `tests/contract/schema/consistency.test.ts` | **MIG-11~15**: S3 주문↔결제 정합성(지연 constraint trigger는 `expectCommitError`와 실제 COMMIT으로 검증), S4 쿼터 FK와 DB 수준 동시성, Q-022 `OTHER`, Q-023 DELETE 차단, Q-024 인증 세션 FK, A-038 결제 원장(DELETE)·승인 금액 |
| `tests/contract/schema/ledger-claims.test.ts` | **MIG-17~21 후속(74개)**: A-038 승인 시각, A-039 요청 수단·원문·미승인 결제의 수단 일치(+39), A-040 인증 세션 무결성(두 claim 순서, 보존·삭제 시나리오 포함), A-041 원장성 테이블 보호(벌크·실제 COMMIT 포함) |
| `tests/unit/payment-method.test.ts` | A-039 서비스 규칙의 순수 함수 시험(DB 불필요, `npm test`): 생성 시 요청값 기록, 승인 시 요청값 불변, `DISALLOWED`→`OTHER`+원문, 원문 안전 검사 |
| `tests/contract/schema/client.test.ts` | DB-01: 앱의 Prisma Client(`getPrisma()`)가 실제 DB에 연결, uuid·bigint(>2^53)·timestamptz 왕복, 명시적 READ COMMITTED, DB↔환경 불일치 거부. **MIG-16(DB-02)**: 타임스탬프 출처 실측 |
| `tests/contract/schema/seed.test.ts` | SEED-01~04: 생성·멱등·production/미설정/staging 거부·DB↔환경 교차 검사 |
| `tests/unit/database-config.test.ts` | DB URL 파싱·개발/테스트 DB 분리·seed 가드(DB 불필요, `npm test`) |

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


### 2.2 후속 Step으로 이월한 DB 점검 (Step 2 기술 검토 S2·S5·S7·S8·S9·S10)

| 항목 | 내용 | 반영 Step | 테스트 |
|---|---|---|---|
| S2 | `SOLD` 좌석에 `ACTIVE`/`CONFIRMING` hold를 넣을 수 있다(DB 미보장). 주문 생성의 AVAILABLE 검사(§11.2 4단계)를 우회하는 경로가 없어야 한다. DB 방어(constraint trigger)의 가능성도 Step 5 시작 전 재검토 | Step 5 | SEAT-04·05의 `SOLD` 변형 신설, INV-9, 동시 요청 시험 |
| S5 | 종료 주문의 live hold, 미판매 좌석의 `ISSUED` 티켓 | Step 9 | INV-10 정합성 검사 + review case |
| S7 | Prisma가 트리거 오류(`23001`)를 `P2003`으로 위장하고 제약 이름은 `meta.driverAdapterError.cause`에 있음 | Step 5 시작 전 | 오류 매핑 단위 테스트: 모든 `DB_CONSTRAINT`가 의도한 도메인 오류로 변환 |
| S8 | MIG-06 검사기 개선: 같은 migration에서 같은 이름으로 다시 만드는 `DROP`+`ADD`(CHECK 어휘 확장)는 허용하되 진짜 제거는 계속 검출 | 별도 테스트 개선 | `findProtectedDrops` 합성 케이스 확장 |
| S9 | `lock_timeout`·`statement_timeout`·`idle_in_transaction_session_timeout`(현재 0), TLS 강제, 앱 DB 역할 분리(원장 UPDATE/DELETE/TRUNCATE 권한 제거) | Step 10 | 인프라 검증·리허설 |
| S10 | partial unique를 대상으로 한 `INSERT … ON CONFLICT`는 인덱스 predicate를 그대로 명시해야 한다 | Step 5 | 해당 쿼리의 통합 테스트 |

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
