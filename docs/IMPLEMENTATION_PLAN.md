# NAZIR — IMPLEMENTATION PLAN

> 문서 버전: 1.2 · 기준일: 2026-11-15 · 공개 목표 2026-11-30
> 일정은 목표이며 안전성 검증에 종속된다. P0 실패 시 실제 판매를 연기한다.
> 관련 문서: `DATABASE.md`, `API_SPEC.md`, `ARCHITECTURE.md`, `TEST_PLAN.md`, `DECISIONS.md`, `PROVIDERS.md`, `CLAUDE_HANDOFF.md`
> 이전 버전 원문: `docs/archive/v1.0/IMPLEMENTATION_PLAN`, `docs/archive/v1.1/IMPLEMENTATION_PLAN.md`

## 1. 개발 원칙

- 작은 단위로 구현하고 각 단계 실행·테스트 후 진행한다.
- NAZIR 전용 저장소(`kkkkmini/NAZIR`)를 사용한다. Preview AI 저장소 재사용 금지.
- DB가 정본, Sheets는 비동기 mirror.
- PG는 토스페이먼츠, 본인인증은 NICE아이디(D-009). 외부 계약·심사·승인이 끝날 때까지 개발을 멈추지 않고, 업체와 독립된 구조(Provider adapter + Mock/Sandbox)를 먼저 만든다.
- 개발·테스트 환경은 Mock/Sandbox provider를 사용하고, **운영 환경에서는 서버 시작 단계에서 Mock을 차단**한다(ARCH §6.5).
- 업체 API·결과 형식은 원문으로 확인된 것만 사용하며, 미확인 동작은 설정값으로 두고 sandbox로 확인한다(`PROVIDERS.md`).
- 실제 결제·인증이 실환경에서 검증되지 않았다면 production 완료로 표시하지 않는다.
- 코드와 문서가 달라지면 같은 작업에서 문서를 갱신한다(6개 문서 + `DECISIONS.md`).
- 미결정 항목(`DECISIONS.md` §3)은 설정값으로 구현하고 임의 확정하지 않는다.

## 2. 우선순위 [채택 A-022]

| 등급 | 정의 | 항목 |
|---|---|---|
| **P0** | 실제 판매 개시 전 필수. 하나라도 실패 시 No-Go | 저장소/기반, PostgreSQL schema + 계약 테스트, 공연/회차/좌석 조회, **본인인증·인증 세션·브라우저 바인딩**, **동일인 4석 한도·활성 주문 1건**, 원자적 점유·7분 만료·**취소 후 재예매**, 소유 주체 Idempotency, PG 결제 시작·**확인 펜싱·3분 보호·UNKNOWN 해소**·webhook, 판매 확정·티켓, 주문 접근 보안, **관리자 최소 기능 + 감사 로그**, **review case 처리**, **수동 환불 요청·검증 기록**, **outbox 이벤트 생성(트랜잭션 내)**, 백그라운드 작업(만료·재조회·환불 검증·webhook 재처리), rate limit, P0 테스트, 운영 리허설, 개인정보처리방침 게시 |
| **P1** | 공개 운영 필수이나 Go 판단 시 수동 대체 수단이 있으면 사용자 승인으로 예외 가능 | Sheets outbox worker·upsert·dead-letter, 정합성 검사·PG 일일 대사 자동화(수동 대사 절차로 대체 가능), 운영 매뉴얼 보강 |
| **P2** | 후속 | SMS 자동 발송, QR 체크인, 관리자 수동 판매, PG 취소 API 자동 환불, 고급 통계, 할인/쿠폰 |

v1.0에서 P1이던 환불 결과 검증/기록, 관리자 감사 로그, REVIEW_REQUIRED 처리는 P0 흐름(UNKNOWN, 초과 승인, 금액 불일치)이 직접 만들어내므로 P0로 이동했다.

## 3. 권장 저장소 구조

```text
/
├─ app/ (public, booking, identity, admin, api/v1)
├─ src/
│  ├─ modules/ (identity, catalog, booking, payments, refunds, tickets, admin, integrations)
│  ├─ jobs/ (hold-expiry, payment-requery, ready-cleanup, refund-verify, webhook-process, nice-token-refresh, outbox, consistency, reconciliation)
│  ├─ providers/ (identity/{interface,mock,nice}, payment/{interface,mock,toss}, stage-guard)
│  ├─ lib/ (clock, db, crypto/hmac, secrets, cookies, csrf, rate-limit, token-cache, errors)
│  └─ components/
├─ prisma/ (schema.prisma, migrations/ — raw SQL 포함)
├─ tests/ (unit, integration, concurrency, contract/schema, e2e, security, load)
├─ docs/ (DATABASE.md, API_SPEC.md, ARCHITECTURE.md, IMPLEMENTATION_PLAN.md, TEST_PLAN.md, CLAUDE_HANDOFF.md, DECISIONS.md, PROVIDERS.md, archive/)
└─ README.md
```

실제 구조는 Next.js 권장 방식에 맞게 조정하되 도메인 경계를 유지한다.

## 4. 단계별 실행

| Step | 작업 | 완료 기준 | 선행 결정 / 외부 의존 |
|---|---|---|---|
| 0 | 문서/저장소 조사, 독립 기술 검토 | BLOCKER/HIGH 보고 | 완료 |
| 0.5 | 검토 반영 문서 개정(v1.1 → v1.2), `DECISIONS.md`, `PROVIDERS.md` | 문서 교차 일치, **사용자 승인** | 진행 중 |
| 1 | Next.js/TS 기반, lint/typecheck/test/build, env schema, CI, Clock 인터페이스, 오류 체계, **Provider 단계 설정·fail-closed 기동 검사**(ARCH §6.5), Secret 로딩 | clean clone에서 README대로 실행, CI 통과, PRV-01~05 통과 | 없음 |
| 2 | Prisma schema + raw SQL migration(제약 전체, `UNFULFILLED`, `provider_context_encrypted`, `card_company`), seed(임시 좌석), **스키마 계약 테스트** | 빈 PostgreSQL migration 성공, MIG-* 통과 | v1.2 승인(Q-004는 D-014로 해소). **구현·보완 완료, main 병합 승인 대기**(2026-11-16): `DATABASE.md` §19, 결정 A-032~A-041·D1~D8(`DECISIONS.md`). 후속 이월 항목은 §4.1 |
| 3 | 공연/회차/좌석 조회, 판매 가능 조건, 임시 seat map, **카드사 심사용 공개 페이지**(상품·약관·환불규정·사업자정보 자리) | DB 상태와 UI 일치 | E-003(실제 좌석은 자료 수령 후), E-008. **코드 구현 완료(2026-11-22, 미병합)**: DbClock·판매/좌석 표시 상태(1차), 앱 DB 연결 `TimeZone=UTC`(S11), Neon Pooled/Direct 분리, 공개 조회 API 4종·공연/회차/좌석 페이지·임시 격자 배치도·정책/사업자 정보 페이지(입력 대기). **남은 조건:** 실제 Neon 연결 검증(`npm run verify:db-session`), 사업자 정보·약관·환불 규정·개인정보처리방침 본문(E-005·E-006·E-008), 실제 좌석·가격(E-003·E-004), 사용자 결정 Q-030~Q-033 |
| 4 | identity: 바인딩·CSRF bootstrap, 인증 시작·콜백·claim, 인증 세션(고정 30분·잔여 10분·주문 생성 제한), subject HMAC, **Mock IdentityProvider**, NICE adapter 골격(원문 기준, 실호출 전) | IDV-* 통과(Mock), NIC-01~04(Mock 시나리오) | Q-002(식별값 — 설정 가능하게) |
| 5 | booking: 주문 생성(한도 잠금·READ COMMITTED·잠금 후 판단·활성 주문·다중 점유), `expireOrder`, 취소 후 재예매, 소유 주체 Idempotency, 접근 세션, rate limit | SEAT-*, ORD-*, QTA-* 통과 | Q-011, Q-013(설정값) |
| 6 | payments: 결제수단 목록·허용 목록, 결제 시작, 토스 success/fail 복귀, Tx1/confirm(멱등·60초·재시도)/Tx2/Tx3, 판매 확정·티켓, 재조회 작업, 웹훅 수신(서명·dedupe·10초 200)·비동기 처리, **Mock PaymentProvider 장애 주입 → 토스 Sandbox 연동** | PAY-*, WH-* 통과(Mock), SBX-* 통과(토스 테스트 키) | 토스 테스트 키(계약 전 발급 가능) |
| 7 | 모바일 확인서, 주문 목록(LOOKUP), 접근 권한 매트릭스 | 타인 주문 조회 불가, IDV-11~13, ORD-09~11 | 없음 |
| 8 | admin: 로그인·세션·권한·감사 로그, 주문/좌석/결제 조회, 좌석 차단, review case action(`RELEASE_SEATS` → `UNFULFILLED` 포함), 환불 요청·PG 실행 기록·취소 후보 제시·검증·완료, 결제수단 활성화 설정 | ADM-*, REF-*, QTA-22~25 통과, DB 직접 수정 없이 복구 | Q-005, Q-012, Q-015 |
| 9 | Outbox worker/Sheets upsert/retry/dead-letter(P1), 정합성 검사(Mock 레코드 탐지 포함), PG 일일 대사 | OUT-*, OPS-*, PRV-06 통과 | Q-014, E-011 |
| 10 | **NICE 실연동**(토큰·URL·결과·복호화), 토스 라이브 키 전환, 통합·보안·부하·배포·백업 리허설, 운영 리허설 | P0 전부 통과 + Go 승인 | E-001(NICE 계약·IP 등록·통신사 심사), E-002(토스 계약·카드사 심사), E-007, Q-019, Q-020 |

### 4.1 Step 간 이월 점검 사항 (Step 2 기술 검토 결과, 2026-11-16)

Step 2에서 DB가 보장하는 범위와 **보장하지 않아 이후 Step이 책임져야 하는 범위**를 정리했다. 항목 이름 S1~S10은 Step 2 기술 검토의 번호이며, S1·S3·S4는 Step 2에서 해결했다(`DECISIONS.md` A-032·A-033·A-037).

| 항목 | 내용 | 반영 Step | 완료 조건 |
|---|---|---|---|
| S2 | `SOLD` 좌석과 live hold의 교차 정합성은 DB가 막지 않는다. Step 5의 주문 생성이 `SELECT … FOR UPDATE`로 좌석을 잠그고 `AVAILABLE`을 확인한 뒤에만 hold를 만든다. **착수 전 DB 방어(constraint trigger) 가능성 재검토** | **Step 5** | SEAT 테스트 `SOLD` 변형·INV-9 통과 |
| S7 | Prisma 오류 코드·제약 이름 매핑 검증: 트리거 `23001`→`P2003` 위장, 제약 이름은 `meta.driverAdapterError.cause`, 지연 constraint trigger 오류는 **COMMIT에서** 발생(`23514`) | **Step 5 착수 전** | 모든 `DB_CONSTRAINT`가 의도한 도메인 오류로 변환됨 |
| S10 | partial unique를 대상으로 한 `INSERT … ON CONFLICT`는 predicate를 명시, 쿼터 행 확보(`INSERT … ON CONFLICT DO NOTHING` + `FOR UPDATE`)는 주문 INSERT보다 먼저(`orders_quota_fk`), raw SQL UPDATE는 `updated_at` 명시 갱신(D3), 쓰기는 READ COMMITTED·§13.2 잠금 순서 | **Step 5** 구현 지침 | 코드 리뷰 체크리스트 + 통합 테스트 |
| Q-025 | 주문번호 전역 sequence 형식(월 표기·자릿수·검증 문자) 확정, 그 후 sequence 생성 migration | **Step 5 시작 전** | `order_number` 생성기 구현 |
| S5 | 종료 주문의 live hold, 미판매 좌석의 티켓 → 정합성 검사와 review case | **Step 9** | INV-10 검사·경보 |
| S8 | MIG-06 검사기 개선(`DROP`+같은 이름 `ADD` 허용, 진짜 제거는 계속 검출) | 별도 테스트 개선(Step 3 이전 가능) | 합성 케이스 통과 |
| S9 | DB 운영 타임아웃, TLS 강제, DB 역할 분리(앱 역할에서 원장 테이블의 UPDATE/DELETE/TRUNCATE 제거, migration 역할 분리), 커넥션 풀러와 지연 constraint 검사 호환성 | **Step 10** | 리허설·인프라 검증 |
| Q-027 (A-039) | **구현 완료.** `payments.requested_method_type`·`provider_method_raw`가 DB에 있다. **Step 6 구현 지침**: 결제 시도 생성 시 `requested_method_type`과 `method_type`에 요청 수단(`CARD`/`EASY_PAY`)을 함께 쓰고(`paymentCreationMethodColumns`), 승인(Tx2) UPDATE에서는 **`requested_method_type`을 절대 갱신하지 않는다**(`paymentApprovalMethodColumns`가 반환하지 않으며 DB 트리거가 거부). adapter는 PG 수단 라벨 원문을 **정규화·마스킹 없이** `methodRaw`로 반환하고, 도메인 계층이 `DISALLOWED`→`OTHER` + `provider_method_raw`를 저장한다. 원문이 CHECK(9자리 이상 숫자·`@`·제어문자·공백)에 걸리면 원문을 버리지 말고 마스킹 후 저장하거나 review case로 보낸다 | **Step 6** | PAY-17·PAY-27, MIG-19 |
| Q-028 (A-040) | **구현 완료.** 4열 복합 FK + 지연 constraint trigger 2개. **Step 4 구현 지침**: claim 트랜잭션은 인증 `VERIFIED→CONSUMED`와 세션 INSERT를 **한 트랜잭션에서 어느 순서로 써도 된다**. 불일치는 **COMMIT에서** SQLSTATE `23514`(`identity_sessions_verification_consumed_ck` / `identity_verifications_consumed_session_ck`)로 나오므로 claim 서비스는 커밋 실패를 도메인 오류로 변환한다. `claim_expires_at`·인증 `expires_at` 판단은 서비스(Clock). **보존 정책 충돌**: 주문을 만든 세션·인증은 `orders.identity_session_id` RESTRICT 때문에 물리 삭제할 수 없다. 개인정보 컬럼은 UPDATE로 제거 가능. 보존 기간 정책(Q-016, E-006)은 Step 4 시작 전 사용자 결정 필요 | **Step 4** | IDV-*, MIG-20 |
| Q-029 (A-041) | **한정 범위 구현 완료**: `admin_audit_logs`·`payment_status_logs`·`refund_items`(UPDATE+DELETE 차단), `refunds`(DELETE 차단). **남은 결정**: `tickets`·`orders`·`seat_holds`·`order_status_logs`·`seat_status_logs`·`payment_webhook_events`는 보호하지 않았다 — 해당 서비스를 구현하는 Step(5·6·8)에서 실제 쓰기 패턴을 보고 `ledger_reject_*()` 재사용 여부를 결정한다. 개인정보가 섞인 감사 로그의 파기·정정 절차는 Q-016과 함께 결정 | **Step 5·6·8** | MIG-21, 해당 Step 테스트 |
| A-042 승인 증거 | **구현 완료.** `SUCCEEDED` 이후 `approved_amount`·`approved_at`·수단 필드·PG 거래 식별값·`status` 등은 DB가 불변으로 지킨다. **Step 6 구현 지침**: 승인 UPDATE(Tx2)가 `status`·`role`·`approved_amount`·`approved_at`·`method_type`·`provider_method_raw`·`card_company`·`easy_pay_provider`·`pg_transaction_id`·`provider_payment_id`를 **한 문장으로 모두** 쓴다(나중에 채울 수 없다). 재조회·웹훅이 이미 `SUCCEEDED`인 결제를 다시 확인할 때는 `last_verified_at`·`requery_count`만 갱신한다. **Step 8 과제**: 잘못 기록된 승인 값의 정정 절차(감사 로그 + 관리자 전용 권한)를 설계한다 — 일반 UPDATE로는 고칠 수 없다 | **Step 6·8** | PAY-*, MIG-22 |
| A-042 환불 핵심·합계 | **구현 완료.** `refunds`의 `order_id`·`payment_id`·`refund_type`·`provider`·`total_amount` 등은 생성 후 불변, 상태·운영 메타데이터 UPDATE는 허용. **Step 8 구현 지침**: 환불 생성 트랜잭션은 `refunds` → `refund_items` 순서로 쓰고 `SEAT`의 항목 합계 = `total_amount`(항목 1건 이상), `PAYMENT_EXCESS`는 항목 없음. 위반은 **COMMIT에서** `23514`(`refunds_seat_items_total_ck`/`refunds_excess_no_items_ck`)로 나오므로 도메인 오류로 변환한다. 금액이나 대상 결제를 바꿔야 하면 환불을 `WITHDRAWN`/`FAILED`로 닫고 새로 만든다 | **Step 8** | REF-*, MIG-23 |
| A-042 CLI 환경 가드 | **구현 완료.** `prisma.config.ts`가 `DATABASE_URL`과 `SHADOW_DATABASE_URL`을 `NAZIR_RUNTIME_ENV`와 대조하고 두 URL이 같은 DB이면 거부한다(Shadow DB는 CLI가 초기화하므로 `migrate dev`·`migrate diff`용 Shadow DB도 같은 환경 규칙을 따라야 한다). 로컬 개발·CI·운영 배포 스크립트는 **`NAZIR_RUNTIME_ENV`를 명시**해야 한다(누락은 production으로 간주되어 `_test` DB가 거부된다). Step 10 배포 파이프라인에서 `migrate deploy` 실행 환경의 `NAZIR_RUNTIME_ENV`와 DB 이름 규칙을 확인한다 | **Step 10** | MIG-24 |

## 5. 외부 업체 지연과 일정 [권장 — 사용자 확정 아님, 판매 개시 조건만 확정 D-012·D-013]

오늘(2026-11-15, 일요일) 기준 공개 목표까지 15일이다. 계약·심사·승인이 끝날 때까지 개발을 멈추지 않는다. 외부 의존 작업은 Provider adapter 뒤에 두고, 업체와 무관한 작업을 먼저 끝낸다.

### 5.1 심사 지연 시 진행 가능한 작업 / 대기 작업

| 지금 진행 가능(외부 승인 무관) | 외부 승인 대기 |
|---|---|
| Step 1~2 전체(기동 검사 포함) | NICE `client_id`/`client_secret` 수령(**Outbound IP 등록 선행** — 원문) |
| Step 3 카탈로그·심사용 공개 페이지 | NICE 통신사 3사 승인심사(영업일 3~5일 — 원문) 및 실인증 테스트(무료 테스트 없음 — 원문) |
| Step 4 인증 전체 로직(Mock), NICE adapter 골격 | NICE DI/CI 제공 범위 확인 |
| Step 5 예매·한도·만료·취소 | 토스 라이브 키·MID(전자결제 계약 후 — 원문) |
| Step 6 결제 전체 로직(Mock) **및 토스 Sandbox**(테스트 키는 회원가입만으로 발급 — 원문) | 토스 카드사 심사(요청 후 7~10일, 최대 14일 — 원문)와 간편결제 라이브 사용 가능 여부 |
| Step 7~9 | 카카오페이 테스트(계약 후 — 원문, Q-017) |
| PRV·SBX 테스트, 운영 매뉴얼 초안 | 라이브 결제수단 선택적 활성화 가능 여부 확인(D-012) |

### 5.2 외부 업체 트랙(사용자·운영 작업)

| 권장 시점 | 토스페이먼츠 | NICE아이디 |
|---|---|---|
| 11/16(월) | 회원가입·테스트 키 확보, **전자결제 계약 신청** | **도입문의 신청**(컨설턴트 안내 영업일 1~2일 — 원문) |
| 11/17~18 | 토스 심사(1~2일 — 원문) | 견적·서류 안내 수령, **호스팅 고정 Outbound IP 확보 방법 확정 후 NICE에 문의(Q-020)** |
| 11/18~19 | **카드사 심사 요청 전 공개 판매 사이트 배포**(테스트 키 결제창 연동 상태 — 원문 요건) | 서류 제출(대표자 인감, 원본 발송), 이용료, 과금시작일 협의 |
| 11/19~20 | 카드사 심사 요청 | IP 등록 → client_id/secret 수령 → 통신사 3사 심사 시작 |
| 11/25~28 | 카드사 심사 완료 예상(요청 후 7~10일) — 카드사별로 다를 수 있음 | 통신사 심사 완료 예상(3~5영업일) → 실인증 테스트 |
| ~12/2 | 카드사 심사 최대 14일 경우 | — |

### 5.3 개발 로드맵

| 일자 | 개발 |
|---|---|
| 11/16 | v1.2 승인 시 Step 1(기동 검사 포함) |
| 11/17 | Step 2 schema + 계약 테스트 |
| 11/18 | Step 3 + 심사용 공개 페이지, 토스 Sandbox 결제창 최소 연동(심사 대비) |
| 11/19~20 | Step 4(Mock 인증, NICE adapter 골격) |
| 11/21~22 | Step 5 예매·한도 |
| 11/23~24 | Step 6 결제(Mock → 토스 Sandbox, SBX-*) |
| 11/25 | Step 7, Step 8 |
| 11/26 | Step 9, NICE 실연동(client 수령·통신사 승인 시) |
| 11/27~28 | 토스 라이브 키 전환, 실환경 검증, 운영·백업 리허설 |
| 11/29 | Go/No-Go |

### 5.4 실판매 개시 조건 [확정 D-012, D-013]

- **결제:** 카드사 심사가 일부만 완료되어도 조건부 개시 가능. 단 (1) 승인된 결제수단만 관객에게 노출, (2) 미승인 카드사·결제수단 사용 차단, (3) 주요 결제수단 사용 가능 여부와 PG 선택적 활성화 가능 여부 확인, (4) 결제 가능 범위가 지나치게 제한되면 판매 연기(판정 기준 Q-018).
- **본인인증:** NICE 승인이 늦어지면 **실판매 연기**. Mock 인증을 실제 판매에 사용하는 것은 어떤 경우에도 허용하지 않는다(기동 검사로 강제, ARCH §6.5).

### 5.5 일정 판단

- 토스 카드사 심사는 공개 판매 사이트가 필요하므로, 심사 요청 시점이 개발 일정(공개 페이지 배포)에 묶인다. 11/19 요청 기준 7~10일이면 11/26~29, 최대 14일이면 12/3까지 걸릴 수 있어 **11/30 전체 카드사 개시는 위험이 높다**. D-012의 조건부 개시가 현실적인 경로다.
- NICE는 Outbound IP 등록이 client 발급의 선행 조건이고, 통신사 심사가 영업일 3~5일이다. 호스팅의 고정 IP 확보(Q-020)가 늦어지면 NICE 일정 전체가 밀리며, 이 경우 D-013에 따라 실판매를 연기한다.
- 11/30은 목표일이지 보장된 납기가 아니다. 기능 범위보다 안전성을 우선한다.

## 6. Claude Code 작업 프로토콜

각 작업은 `Inspect → Plan → Implement → Test → Review → Report → Document`.

- 시작 전 변경 파일, 데이터 영향, 위험, 테스트 계획 제시.
- 종료 후 변경 내용, 실행 명령/결과, 실패·미실행 테스트, migration 영향, 보안·동시성 영향, 남은 위험 보고.
- 실패한 테스트를 약화하거나 숨기지 않는다.
- 대규모 리팩터링과 기능 구현을 한 번에 묶지 않는다.
- migration 생성 시 Prisma가 raw SQL 객체를 DROP하지 않는지 검토하고 계약 테스트를 실행한다.
- 커밋·푸시는 사용자 승인 후 지정 브랜치에만 한다.

## 7. 금지 사항

- 브라우저 redirect·클라이언트 플래그만으로 결제 성공 또는 본인인증 성공 확정
- 클라이언트 가격·좌석 상태·returnUrl 신뢰
- 클라이언트 timer로 hold 만료 판정
- 3분 결제 보호 경과만으로 결제 실패 처리 또는 좌석 해제
- UNKNOWN에서 PG 조회 전 재결제 허용 또는 좌석 재판매
- PG·인증사 호출을 DB 트랜잭션 안에서 실행
- 구매 한도를 잠금 없는 COUNT 후 INSERT로 구현
- 좌석 변경 목적의 `order_items` UPDATE
- 다른 브라우저에서 인증 세션·인증 결과 재사용 허용
- SQLite로 PostgreSQL 동시성 대체
- DB 직접 수정으로 운영 복구
- 로그에 토큰·카드정보·인증 원문·동일인 식별값·전화번호 원문 저장
- Sheets를 정본으로 사용
- 공유 환경에서 `prisma db push`
- **Mock 인증·Mock 결제를 실제 판매에 사용**, 운영 환경에서 Mock provider·테스트 키로 기동(D-013)
- 고정 비밀값(토스 시크릿·보안 키, NICE client 정보, HMAC·암호화 키)을 DB·저장소·클라이언트 번들·로그에 저장
- 웹훅 본문만으로 결제 성공 확정
- 원문 미확인 업체 동작을 확정 사실로 가정한 구현
- P0 실패를 무시하고 공개

## 8. Definition of Done

기능은 코드 작성만으로 완료가 아니다. 타입 검사, lint, 관련 테스트(성공·실패·경합 경로), 스키마 계약 테스트, 보안 검토, 문서 반영까지 완료해야 한다. 전체 Go/No-Go는 `TEST_PLAN.md` §15 기준.

## 9. 변경 이력

| 버전 | 일자 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-11-13 | 개발 전달 기준안. 원문: `docs/archive/v1.0/IMPLEMENTATION_PLAN` |
| 1.1 | 2026-11-14 | 파일명 `IMPLEMENTATION_PLAN.md`로 정정. P0/P1 재정의(환불 기록·검증, 감사 로그, review case, outbox 생성을 P0로), Step 0.5 문서 개정 단계와 단계별 선행 결정 추가, 인증 선행·한도·결제 펜싱 단계 반영, 좌석 변경 제거, 일정 게이트(권장) 추가, 금지 사항 확장 |
| 1.2 | 2026-11-15 | 토스페이먼츠·NICE아이디 확정 반영. 개발 원칙에 외부 승인과 독립된 진행·운영 Mock 차단·원문 기준 구현 추가. 단계표에 기동 검사(Step 1), 심사용 공개 페이지(Step 3), NICE adapter 골격(Step 4), 토스 Sandbox(Step 6), NICE 실연동(Step 10) 반영. §5를 진행/대기 작업, 외부 업체 트랙, 개발 로드맵, 실판매 개시 조건(D-012, D-013), 일정 판단으로 교체. 저장소 구조·금지 사항 갱신. 이전 원문: `docs/archive/v1.1/IMPLEMENTATION_PLAN.md` |
| 1.2.1 | 2026-11-16 | Step 2 구현 상태 표기(단계표). 계획·일정은 변경 없음 |
| 1.2.2 | 2026-11-16 | §4.1 Step 간 이월 점검 사항 추가, Step 2 상태 갱신. 단계·일정은 변경 없음 |
| 1.2.3 | 2026-11-17 | §4.1에 Q-027~Q-029 결정 대기 항목 추가. 단계·일정은 변경 없음 |
| 1.2.4 | 2026-11-17 | §4.1: Q-027~Q-029를 구현 완료로 갱신하고 Step 4(claim 커밋 시점 오류·순서 무관·보존 정책 결정)·Step 6(요청 수단·PG 원문 기록)·Step 5·6·8(남은 원장성 테이블 결정) 지침을 추가. 단계·일정은 변경 없음 |
| 1.2.5 | 2026-11-18 | §4.1: A-042(승인 증거 불변, 환불 핵심·합계, Prisma CLI 환경 가드)에 대한 Step 6·8·10 지침과 Step 8 과제(승인 값 정정 절차) 추가. 단계·일정은 변경 없음 |
| 1.2.6 | 2026-11-18 | §4.1 A-042 CLI 환경 가드 행에 Shadow DB 규칙 반영. 단계·일정은 변경 없음 |
| 1.2.7 | 2026-11-20 | Step 3 진행 상태 표기(1차 작업). 단계·일정은 변경 없음 |
| 1.2.8 | 2026-11-22 | Step 3 구현 상태와 남은 조건 표기. 단계·일정은 변경 없음 |
