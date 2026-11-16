# NAZIR — DATABASE

> 문서 버전: 1.2
> 기준일: 2026-11-15
> 데이터베이스: PostgreSQL
> 상태: 개발 전달 기준안 — 독립 기술 검토, 사용자 확정 정책, 토스페이먼츠·NICE아이디 원문 확인 결과 반영. **P0 검증 전 실제 판매 금지**
> 적용 범위: Phase 1 예매 MVP + Phase 2 이후 확장 기반
> 관련 문서: `DECISIONS.md`(정책·미결정), `PROVIDERS.md`(업체 근거), `API_SPEC.md`, `ARCHITECTURE.md`, `IMPLEMENTATION_PLAN.md`, `TEST_PLAN.md`, `CLAUDE_HANDOFF.md`
> 이전 버전 원문: `docs/archive/v1.0/DATABASE.md`, `docs/archive/v1.1/DATABASE.md`

표기: **[확정]** 사용자 확정 정책 · **[채택]** 설계 채택안(승인 대기) · **[권장]** 미결정 항목의 권장 기본값 · **[외부 확인]** 업체·법률 확인 필요. 상세는 `DECISIONS.md`.

---

## 1. 문서 목적과 설계 원칙

이 문서는 NAZIR 티켓 예매 서비스의 데이터 구조, 무결성 규칙, 상태 전이, 동시성 제어, 외부 연동 저장 방식을 정의한다.

### 1.1 핵심 원칙

1. **PostgreSQL이 유일한 Source of Truth다.** Google Sheets는 비동기 복제본이며 주문·결제·좌석 상태를 결정하지 않는다.
2. **중요한 상태 변경은 서버에서 검증한다.** 브라우저가 보낸 가격, 좌석 상태, 결제 성공 표시, 인증 성공 표시, 카운트다운은 신뢰하지 않는다.
3. **금전·좌석·티켓·인증 이력은 보존한다.** 일반 운영 흐름에서 주문·결제·환불·점유·인증 이력을 물리 삭제하지 않는다.
4. **결제 승인과 예매 확정은 별개다.** PG 거래가 서버에서 확인되고 좌석 판매가 원자적으로 확정된 뒤 티켓을 발급한다.
5. **동시성은 DB 제약조건과 트랜잭션으로 통제한다.** 애플리케이션 사전 조회만으로 중복 점유·판매·한도 초과를 방지했다고 간주하지 않는다.
6. **상태는 도메인별로 분리한다.** 주문, 좌석 점유, 결제, 환불, 티켓, 인증은 각자의 상태를 가진다.
7. **외부 호출은 DB 트랜잭션 밖에서 한다.** PG·인증사 네트워크 호출을 DB 트랜잭션 안에서 실행하지 않는다. 트랜잭션 사이의 안전성은 펜싱 상태로 보장한다(§11.6).
8. **미정 사업 정책은 미결정으로 남긴다.** `DECISIONS.md`에 권장안과 함께 기록하고 설정값으로 구현한다.

### 1.2 명명 및 공통 규칙

- 테이블·컬럼은 `snake_case`, 테이블은 복수형.
- 기본 키는 UUID. 외부 노출 식별자(주문번호·티켓번호)는 별도 컬럼.
- 시각은 `timestamptz`, 서버는 UTC로 처리하고 화면만 `Asia/Seoul`로 변환한다. Prisma 사용 시 `@db.Timestamptz`를 명시한다(Prisma 기본 DateTime 매핑에 의존하지 않는다).
- **만료·보호 시간 판정의 기준 시각은 DB 시각**이다. 서비스 계층은 Clock 인터페이스로 시각을 얻고(운영: DB 조회, 테스트: 고정값 주입), 같은 연산 안에서는 하나의 기준 시각을 사용한다. [채택 A-023]
- 금액은 `bigint` 원화 정수. 애플리케이션은 JSON 직렬화 시 BigInt를 정수 number 또는 문자열로 명시 변환한다.
- 상태값은 애플리케이션 상수와 DB `CHECK` 제약을 함께 관리한다(PostgreSQL enum 사용 여부는 구현자가 결정하되 의미는 이 문서를 따른다).
- 모든 주요 테이블에 `created_at`, 수정 가능한 레코드에 `updated_at`.
- 토큰·nonce·바인딩 값·Idempotency-Key·동일인 식별값은 **원문을 저장하지 않고 hash(또는 HMAC)만 저장**한다.
- 개인정보(이름·전화번호·이메일)는 최소 수집하며, 애플리케이션 레벨 암호화를 권장한다[권장 Q-016]. 로그·오류 메시지에 평문으로 남기지 않는다.

---

## 2. 서비스 범위와 데이터 경계

### 2.1 Phase 1

- 비회원 예매(회원 계정 없음, **본인인증 필수** [확정 D-004])
- 본인인증 → 인증 세션 → 공연·회차 선택 → 좌석 선택 → 점유·주문 생성 → 결제 → PG 승인 검증 → 티켓 발급
- 좌석 7분 임시 점유 [확정 D-002], 결제 확인 중 최대 3분 보호 [확정 D-003]
- 동일 인증 식별자 기준 동일 회차 최대 4석 [확정 D-006], 동일 회차 활성 주문 1건 [확정 D-008]
- 결제 수단: 카드, PG 지원 간편결제. 가상계좌 제외 [확정 D-005]
- 좌석 변경 없음. 취소 후 재예매 [확정 D-001]
- 주문 조회(조회용 본인인증) 및 모바일 예매 확인서
- 최소 관리자 기능, 운영자 확인 사안(review case) 처리
- PG 관리자 페이지 수동 환불 + DB 요청·검증 기록 [확정 D-007]
- Google Sheets 비동기 mirror(Outbox)

Phase 1 관객 화면에는 QR을 노출하지 않는다. 티켓 모델은 QR 및 현장 체크인 확장을 고려한다.

### 2.2 Phase 2·3 확장

- 환불 운영 자동화(PG 취소 API), 관리자 고도화, 관리자 수동 판매 채널
- SMS 자동 발송, QR 티켓 및 스태프 체크인, 중복 입장 방지, 현장 예외 처리

### 2.3 데이터 소유권

| 데이터 | 정본 | 보조 시스템 |
|---|---|---|
| 공연·회차·좌석 | PostgreSQL | 관리자 UI |
| 점유·주문·결제·환불·티켓·구매 한도 | PostgreSQL | 관리자 UI, PG 조회 |
| 본인인증 결과 | PostgreSQL의 최소 검증 기록 + 인증사 | 인증사 원본 거래 |
| 운영 메모 | PostgreSQL `orders.admin_memo` | (Phase 1 Sheets 역반영 없음 [권장 Q-014]) |
| Sheets 동기화 상태 | PostgreSQL `outbox_events` | Google Sheets |

---

## 3. 전체 테이블 목록

v1.1 기준 핵심 테이블은 **27개**다. (v1.0: 21개)

| 영역 | 테이블 |
|---|---|
| 공연 및 좌석 (5) | `venues`, `shows`, `show_sessions`, `seats`, `session_seats` |
| 본인인증 (3) | `identity_subjects`, `identity_verifications`, `identity_sessions` |
| 예매 및 점유 (8) | `orders`, `order_items`, `seat_holds`, `order_status_logs`, `seat_status_logs`, `order_access_sessions`, `purchase_quotas`, `idempotency_records` |
| 결제 및 환불 (5) | `payments`, `payment_webhook_events`, `payment_status_logs`, `refunds`, `refund_items` |
| 티켓 (1) | `tickets` |
| 관리자 (3) | `admins`, `admin_sessions`, `admin_audit_logs` |
| 운영·외부 연동 (2) | `review_cases`, `outbox_events` |

조건부: rate limit 저장소를 PostgreSQL로 결정하면 `rate_limit_counters`를 추가한다[권장 Q-013]. 이 경우 28개.

### 3.1 v1.0 대비 변경 요약

| 변경 | 내용 | 근거 |
|---|---|---|
| 추가 | `identity_subjects`, `identity_sessions`, `purchase_quotas` | 인증 선행(D-004), 4석 한도(D-006), B4 |
| 추가 | `admin_sessions` | B4 |
| 추가 | `order_status_logs`, `review_cases` | B2, M7 |
| 변경 | `identity_verifications`: `order_id` 제거, `purpose`·브라우저 바인딩·nonce 추가 | A, B4, Q-009 |
| 변경 | `orders`: `show_session_id`, `identity_subject_id`, `identity_session_id`, `confirmed_payment_id`, `hold_expires_at`, `confirm_protected_until` 추가 / `pending_customer_phone` 제거 / 상태 재정의 | A, B1, B2, H7 |
| 변경 | `order_items`: 생성 후 불변 | D-001, B3 |
| 변경 | `seat_holds`: `order_items`와 1:1, `CONFIRMING` 상태 추가, 만료 시각을 주문 단위로 이동 | B1, B3 |
| 변경 | `session_seats`: `venue_id`, `sold_order_item_id` 추가 | H1, H7 |
| 변경 | `payments`: 상태 재정의(`CONFIRMING`), `role`, `refunded_amount`, `merchant_payment_ref`, 재조회 컬럼 | B1, B2, H2 |
| 변경 | `refunds`: `refund_type`, 상태 재정의(`VERIFYING`, `WITHDRAWN`) / `refund_items`: `order_id` | H2, H3, E |
| 변경 | `idempotency_records`: 소유 주체 바인딩, 키 hash | B5 |
| 변경 | `order_access_sessions`: 브라우저 바인딩, 용도 한정 | B5 |
| 변경 | `payment_webhook_events`: 재처리 컬럼, `UNMATCHED` 상태 | H4 |
| 변경 | `tickets`: `session_seat_id` + 유효 티켓 partial unique | H1 |

### 3.2 ERD

```mermaid
erDiagram
    VENUES ||--o{ SHOWS : hosts
    VENUES ||--o{ SEATS : contains
    SHOWS ||--o{ SHOW_SESSIONS : has
    SHOW_SESSIONS ||--o{ SESSION_SEATS : offers
    SEATS ||--o{ SESSION_SEATS : appears_in

    IDENTITY_SUBJECTS ||--o{ IDENTITY_VERIFICATIONS : verified_as
    IDENTITY_VERIFICATIONS ||--o| IDENTITY_SESSIONS : claimed_as
    IDENTITY_SUBJECTS ||--o{ IDENTITY_SESSIONS : owns
    IDENTITY_SUBJECTS ||--o{ PURCHASE_QUOTAS : limited_by
    SHOW_SESSIONS ||--o{ PURCHASE_QUOTAS : scoped_to

    IDENTITY_SUBJECTS ||--o{ ORDERS : places
    IDENTITY_SESSIONS ||--o{ ORDERS : created_with
    SHOW_SESSIONS ||--o{ ORDERS : for_session
    ORDERS ||--|{ ORDER_ITEMS : contains
    SESSION_SEATS ||--o{ ORDER_ITEMS : selected_as
    ORDER_ITEMS ||--|| SEAT_HOLDS : held_by
    ORDERS ||--o{ ORDER_STATUS_LOGS : logs
    ORDERS ||--o{ ORDER_ACCESS_SESSIONS : accessed_by

    ORDERS ||--o{ PAYMENTS : attempts
    ORDERS |o--o| PAYMENTS : confirmed_by
    PAYMENTS ||--o{ PAYMENT_WEBHOOK_EVENTS : receives
    PAYMENTS ||--o{ PAYMENT_STATUS_LOGS : records
    PAYMENTS ||--o{ REFUNDS : refunded_from
    ORDERS ||--o{ REFUNDS : has
    REFUNDS ||--o{ REFUND_ITEMS : contains
    ORDER_ITEMS ||--o{ REFUND_ITEMS : refunded_item
    ORDER_ITEMS ||--o| TICKETS : issues
    SESSION_SEATS |o--o| ORDER_ITEMS : sold_to

    SESSION_SEATS ||--o{ SEAT_STATUS_LOGS : logs
    ADMINS ||--o{ ADMIN_SESSIONS : logs_in
    ADMINS ||--o{ ADMIN_AUDIT_LOGS : creates
    ORDERS ||--o{ REVIEW_CASES : may_raise
    OUTBOX_EVENTS }o--|| ORDERS : may_reference
```

> `outbox_events`는 `aggregate_type`·`aggregate_id`로 연결하며 도메인 테이블에 강한 FK를 두지 않는다. `review_cases`는 nullable FK로 주문·결제·환불을 참조한다.

---

## 4. 공연 및 좌석 테이블

### 4.1 `venues` — 공연장

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `name` | varchar(200) | NOT NULL |
| `address` | text | NULL 가능 |
| `timezone` | varchar(64) | NOT NULL, 기본 `Asia/Seoul` |
| `seat_map_version` | varchar(50) | NULL 가능 |
| `seat_map_asset_url` | text | NULL 가능 |
| `created_at` / `updated_at` | timestamptz | NOT NULL |

### 4.2 `shows` — 공연

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `venue_id` | uuid | FK → `venues.id`, NOT NULL |
| `title` | varchar(200) | NOT NULL |
| `slug` | varchar(220) | UNIQUE, NOT NULL |
| `description` | text | NULL 가능 |
| `poster_url` | text | NULL 가능 |
| `status` | varchar(20) | `DRAFT`, `PUBLISHED`, `CLOSED` |
| `sales_opens_at` | timestamptz | NULL 가능 |
| `sales_closes_at` | timestamptz | NULL 가능 |
| `created_at` / `updated_at` | timestamptz | NOT NULL |

제약: `UNIQUE (id, venue_id)` — 회차의 공연장 일치 복합 FK 대상.

### 4.3 `show_sessions` — 공연 회차

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `show_id` | uuid | NOT NULL |
| `venue_id` | uuid | NOT NULL, 공연의 공연장 비정규화 |
| `starts_at` | timestamptz | NOT NULL |
| `ends_at` | timestamptz | NULL 가능 |
| `sales_status` | varchar(20) | `ON_SALE`, `PAUSED`, `CLOSED`, `CANCELED` |
| `max_seats_per_identity` | smallint | NOT NULL, 기본 4 [확정 D-006], `CHECK (max_seats_per_identity BETWEEN 1 AND 4)` |
| `created_at` / `updated_at` | timestamptz | NOT NULL |

제약:
- 복합 FK `(show_id, venue_id)` → `shows(id, venue_id)` (공연장 변경 시 회차와 불일치 방지)
- `UNIQUE (id, venue_id)` — 판매 좌석 복합 FK 대상
- 인덱스 `(show_id, starts_at)`

`CANCELED`는 공연 취소 표시이며, Phase 1 대량 환불은 수동 절차로 처리한다. `max_seats_per_identity`의 상한 4는 확정 정책이며, 회차별로 더 낮출 수 있으나 4를 넘을 수 없다.

### 4.4 `seats` — 공연장의 물리적 좌석

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `venue_id` | uuid | FK → `venues.id`, NOT NULL |
| `svg_seat_id` | varchar(100) | NOT NULL |
| `section_name` | varchar(100) | NULL 가능 |
| `row_label` | varchar(30) | NULL 가능 |
| `seat_number` | varchar(30) | NOT NULL |
| `seat_label` | varchar(100) | 화면 표시명 |
| `created_at` / `updated_at` | timestamptz | NOT NULL |

제약:
- `UNIQUE (venue_id, svg_seat_id)`
- `UNIQUE NULLS NOT DISTINCT (venue_id, section_name, row_label, seat_number)` — PostgreSQL 15 이상 필요, raw SQL migration으로 관리. 구역·열이 NULL인 좌석의 중복을 막는다. (PostgreSQL 15 미만이면 `COALESCE` 표현식 unique index로 대체)
- `UNIQUE (id, venue_id)` — 복합 FK 대상

SVG는 시각적 배치만 담당하며 판매 상태는 DB에서 조회한다. SVG 교체 시에도 `seats.id`는 유지한다.

### 4.5 `session_seats` — 회차별 판매 좌석

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `show_session_id` | uuid | NOT NULL |
| `seat_id` | uuid | NOT NULL |
| `venue_id` | uuid | NOT NULL, 공연장 일치 검증용 비정규화 |
| `price` | bigint | NOT NULL, `CHECK (price >= 0)` |
| `status` | varchar(20) | `AVAILABLE`, `SOLD`, `BLOCKED` |
| `sold_order_item_id` | uuid | NULL 가능, **판매 소유 주문 항목** |
| `created_at` / `updated_at` | timestamptz | NOT NULL |

제약:
- 복합 FK `(show_session_id, venue_id)` → `show_sessions(id, venue_id)`
- 복합 FK `(seat_id, venue_id)` → `seats(id, venue_id)` — **회차 공연장에 속한 좌석만 판매** [H7]
- 복합 FK `(sold_order_item_id, id)` → `order_items(id, session_seat_id)` — 소유 항목은 반드시 이 좌석의 항목 [H1]
- `UNIQUE (sold_order_item_id)` (NULL 제외)
- `CHECK ((status = 'SOLD') = (sold_order_item_id IS NOT NULL))`
- `UNIQUE (show_session_id, seat_id)`, `UNIQUE (id, show_session_id)`(주문 항목 복합 FK 대상)
- 인덱스 `(show_session_id, status)`

`HELD`는 영구 상태가 아니다. 유효 hold(`ACTIVE` + 주문의 `hold_expires_at` 미경과, 또는 `CONFIRMING`) 존재 여부로 계산한다(§11.1).

`session_seats`와 `order_items`는 상호 참조(순환 FK)한다. `sold_order_item_id`는 판매 확정 시점에만 설정되므로 삽입 순서 문제는 없다.

---

## 5. 예매 및 좌석 점유 테이블

### 5.1 `orders` — 주문

주문은 **한 인증 주체의 한 회차에 대한 한 번의 예매 시도**다. 좌석 변경이 없으므로 다른 좌석을 원하면 기존 주문을 취소하고 새 주문을 만든다 [확정 D-001].

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `order_number` | varchar(40) | UNIQUE, NOT NULL, 예: `NZ-202611-000001` (DB sequence 기반 생성) |
| `show_session_id` | uuid | FK → `show_sessions.id`, NOT NULL |
| `identity_subject_id` | uuid | FK → `identity_subjects.id`, NOT NULL |
| `identity_session_id` | uuid | NOT NULL, 주문 생성에 사용된 인증 세션 |
| `status` | varchar(30) | 아래 주문 상태 |
| `customer_name` | text | NOT NULL, 본인인증 결과 이름 snapshot(암호화 권장) |
| `customer_phone` | text | NOT NULL, 본인인증 결과 번호 snapshot(암호화 권장) |
| `customer_email` | varchar(254) | NULL 가능, 사용자 입력 |
| `total_amount` | bigint | NOT NULL, `CHECK (total_amount >= 0)`, 주문 항목 가격 합계 |
| `currency` | char(3) | NOT NULL, 기본 `KRW` |
| `hold_expires_at` | timestamptz | NOT NULL, **일반 점유 만료 시각 = 생성 시각 + 7분** |
| `confirm_protected_until` | timestamptz | NULL 가능, 결제 확인 보호 종료 시각 = 확인 진입 + 3분 |
| `confirmed_payment_id` | uuid | NULL 가능, 예매 확정에 사용된 결제 |
| `admin_memo` | text | NULL 가능, 운영 메모(개인정보 기재 금지) |
| `paid_at` | timestamptz | NULL 가능 |
| `closed_at` | timestamptz | NULL 가능, 비활성 상태 진입 시각 |
| `created_at` / `updated_at` | timestamptz | NOT NULL |

**주문 상태** [채택]:

| 상태 | 의미 | 활성 주문 |
|---|---|---|
| `PENDING` | 주문·점유 생성됨, 결제 확인 전(결제창 진행 포함) | 예 |
| `PAYMENT_CONFIRMING` | 서버가 PG 승인 확인 단계에 진입, 3분 보호 중 | 예 [확정] |
| `PAYMENT_UNKNOWN` | 3분 내 결과 미확정, 재조회 중. 좌석 보호 유지 | 예 [확정] |
| `REVIEW_REQUIRED` | 승인 금액 불일치 등 자동 확정 불가. **좌석이 `CONFIRMING`으로 보호 중이거나 결제 결과가 미해결**인 상태로 한정 | 예 [확정 D-014] |
| `UNFULFILLED` | 발권 불가 확정: 결제 결과(승인됨)가 확정되고 좌석 해제·쿼터 반환이 끝남. 남은 초과 결제 환불은 `refunds`·`review_cases`가 추적 | 아니오 [확정 D-014] |
| `PAID` | PG 승인 확인 및 좌석 판매 확정 완료. 부분 환불·초과 승인 발생 시에도 유지 | 아니오 |
| `CANCELED` | 결제 확인 전 사용자 취소 | 아니오 |
| `EXPIRED` | 결제 확인 전 7분 만료, 또는 결제 실패 확정 시점에 점유가 이미 만료 | 아니오 |
| `REFUNDED` | 모든 좌석(및 초과 결제) 환불 완료 | 아니오 |

> 활성 주문 = `PENDING`/`PAYMENT_CONFIRMING`/`PAYMENT_UNKNOWN`/`REVIEW_REQUIRED` [확정 D-008, D-014]. `UNFULFILLED`·`PAID`·`CANCELED`·`EXPIRED`·`REFUNDED`는 비활성이다.

제약:
- 복합 FK `(identity_session_id, identity_subject_id)` → `identity_sessions(id, identity_subject_id)` — 세션과 주체 일치
- 복합 FK `(confirmed_payment_id, id)` → `payments(id, order_id)` — **확정 결제는 같은 주문의 결제** [B2]
- `UNIQUE (confirmed_payment_id)` (NULL 제외)
- `UNIQUE (id, show_session_id)` — 주문 항목 복합 FK 대상
- **활성 주문 1건:** `UNIQUE (identity_subject_id, show_session_id) WHERE status IN ('PENDING','PAYMENT_CONFIRMING','PAYMENT_UNKNOWN','REVIEW_REQUIRED')` [확정 D-008, D-014]
- `CHECK (status <> 'PAID' OR confirmed_payment_id IS NOT NULL)`
- `CHECK (status NOT IN ('PAYMENT_CONFIRMING','PAYMENT_UNKNOWN') OR confirm_protected_until IS NOT NULL)`
- 인덱스: `(status, hold_expires_at)`, `(status, confirm_protected_until)`, `(identity_subject_id, created_at)`

`orders.hold_expires_at`이 **점유 만료의 단일 기준**이다. 한 주문의 모든 hold는 같은 시각에 생성되고 함께 전이하므로 좌석별 만료 시각을 두지 않는다[채택 A-007]. 이 시각은 연장하지 않는다 [확정 D-002]. `confirm_protected_until`은 결제 확인 보호 시간이며, 이 시각이 지나도 **결제 실패 처리나 좌석 해제의 근거가 아니다** [확정 D-003].

### 5.2 `order_items` — 주문 좌석 항목 (불변)

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `order_id` | uuid | NOT NULL |
| `show_session_id` | uuid | NOT NULL, 소속 회차 일치 검증용 |
| `session_seat_id` | uuid | NOT NULL |
| `price` | bigint | NOT NULL, `CHECK (price >= 0)`, 점유 시점 가격 snapshot |
| `created_at` | timestamptz | NOT NULL |

제약:
- 복합 FK `(order_id, show_session_id)` → `orders(id, show_session_id)`
- 복합 FK `(session_seat_id, show_session_id)` → `session_seats(id, show_session_id)` — **한 주문의 모든 항목은 같은 회차** [H7]
- `UNIQUE (order_id, session_seat_id)`
- `UNIQUE (id, order_id)`, `UNIQUE (id, session_seat_id)`, `UNIQUE (id, order_id, session_seat_id)` — 복합 FK 대상

**불변 규칙** [확정 D-001 / 채택 A-006]: `order_items`는 주문 생성 트랜잭션에서만 삽입하며 이후 UPDATE·DELETE하지 않는다. `updated_at`을 두지 않는다. DB 권한 또는 트리거로 UPDATE를 차단하는 방안을 구현 시 검토한다. 주문 항목 수는 1~`max_seats_per_identity`.

### 5.3 `seat_holds` — 좌석 임시 점유 (주문 항목과 1:1)

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `order_id` | uuid | NOT NULL |
| `order_item_id` | uuid | NOT NULL, UNIQUE |
| `session_seat_id` | uuid | NOT NULL |
| `status` | varchar(20) | `ACTIVE`, `CONFIRMING`, `CONVERTED`, `RELEASED`, `EXPIRED` |
| `released_reason` | varchar(30) | NULL 가능: `USER_CANCELED`, `PAYMENT_FAILED`, `ADMIN_RESOLVED`, `REFUND_RESOLVED` |
| `ended_at` | timestamptz | NULL 가능, 종료 상태 진입 시각 |
| `created_at` / `updated_at` | timestamptz | NOT NULL |

- `ACTIVE`: 일반 7분 점유
- `CONFIRMING`: 결제 확인 중 펜싱. **일반 만료 작업이 회수할 수 없다.** 결제 UNKNOWN 동안에도 유지한다.
- `CONVERTED`: 판매 확정
- `RELEASED`: 사용자 취소, 결제 실패 후 해제, 운영자 해제
- `EXPIRED`: 7분 만료 처리

제약:
- 복합 FK `(order_item_id, order_id, session_seat_id)` → `order_items(id, order_id, session_seat_id)` — **hold의 주문·좌석이 항목과 일치** [H7]. 항목이 불변이므로 가능하다.
- `UNIQUE (order_item_id)` — 항목당 hold 1개
- **좌석당 유효 점유 1개:** `UNIQUE (session_seat_id) WHERE status IN ('ACTIVE','CONFIRMING')`
- 인덱스 `(order_id, status)`

**단순화 검토 결과** [채택]: 좌석 변경 제거로 `order_items`가 불변이 되어 hold와 항목이 1:1이 되었다. `seat_holds`를 `order_items`에 병합하는 안도 검토했으나, (1) 점유 상태와 주문 항목(가격·소속)의 도메인 분리 원칙, (2) partial unique 인덱스를 상태 전용 테이블에 두는 명확성, (3) Phase 2 이후 재점유 정책 확장 여지 때문에 **별도 테이블을 유지**하고 관계만 1:1로 단순화했다. v1.0의 "항목 갱신 + hold 이력" 모델과 A→B→A 시나리오는 제거되었다.

### 5.4 `order_status_logs` — 주문 상태 변경 로그

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `order_id` | uuid | FK → `orders.id`, NOT NULL |
| `from_status` | varchar(30) | NULL 가능 |
| `to_status` | varchar(30) | NOT NULL |
| `source` | varchar(30) | `API`, `RETURN`, `WEBHOOK`, `PG_REQUERY`, `EXPIRY_JOB`, `ADMIN`, `SYSTEM` |
| `admin_id` | uuid | FK → `admins.id`, NULL 가능 |
| `note` | text | NULL 가능, 개인정보 금지 |
| `created_at` | timestamptz | NOT NULL |

상태 변경과 같은 트랜잭션에서 삽입한다. 인덱스 `(order_id, created_at)`.

### 5.5 `seat_status_logs` — 좌석 상태 변경 로그

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `session_seat_id` | uuid | FK → `session_seats.id`, NOT NULL |
| `from_status` | varchar(20) | NULL 가능 |
| `to_status` | varchar(20) | NOT NULL |
| `order_item_id` | uuid | NULL 가능, 판매·해제 관련 항목 |
| `reason` | text | NULL 가능 |
| `actor_type` | varchar(20) | `ADMIN`, `SYSTEM` |
| `admin_id` | uuid | FK → `admins.id`, NULL 가능 |
| `created_at` | timestamptz | NOT NULL |

관리자 차단은 `AVAILABLE`이고 유효 hold가 없을 때만 허용한다. 만료가 지났지만 아직 `ACTIVE`인 hold가 있으면 먼저 `expireOrder`(§11.4)를 실행한 뒤 재시도한다. 차단 트랜잭션은 다른 주문의 hold를 직접 변경하지 않는다.

### 5.6 `order_access_sessions` — 주문 확인서 접근 세션

인증 세션(30분)이 만료된 뒤에도 같은 브라우저에서 예매 확인서를 볼 수 있도록 하는 **읽기 전용** 접근 세션이다. 주문 변경·결제에는 사용할 수 없다.

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `order_id` | uuid | FK → `orders.id`, NOT NULL |
| `token_hash` | varchar(255) | UNIQUE, NOT NULL |
| `browser_binding_hash` | varchar(255) | NOT NULL |
| `scope` | varchar(30) | NOT NULL, Phase 1은 `CONFIRMATION_VIEW`만 |
| `status` | varchar(20) | `ACTIVE`, `REVOKED`, `EXPIRED` |
| `expires_at` | timestamptz | NOT NULL [권장 Q-013: 회차 종료 후 24시간, 최대 30일] |
| `last_used_at` | timestamptz | NULL 가능 |
| `revoked_at` | timestamptz | NULL 가능 |
| `created_at` / `updated_at` | timestamptz | NOT NULL |

인덱스 `(order_id, status)`. 요청의 바인딩 쿠키 hash가 `browser_binding_hash`와 다르면 거부한다. 발급 조건은 §11.10.

### 5.7 `purchase_quotas` — 동일인·회차 구매 한도 카운터

동일 인증 주체의 동일 회차 구매 한도(최대 4석)를 직렬화하고 DB 제약으로 보장한다 [확정 D-006 / 채택 A-011].

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `identity_subject_id` | uuid | PK(복합), FK → `identity_subjects.id` |
| `show_session_id` | uuid | PK(복합), FK → `show_sessions.id` |
| `seat_limit` | smallint | NOT NULL, 행 생성 시 `show_sessions.max_seats_per_identity` snapshot, `CHECK (seat_limit BETWEEN 1 AND 4)`. **이후 회차 한도를 변경해도 기존 행에는 반영하지 않는다**(변경이 필요하면 관리자 절차로 별도 처리 — Phase 1 범위 밖) [채택 A-029] |
| `counted_seats` | smallint | NOT NULL, 기본 0, `CHECK (counted_seats >= 0 AND counted_seats <= seat_limit)` |
| `version` | bigint | NOT NULL, 변경마다 증가 |
| `created_at` / `updated_at` | timestamptz | NOT NULL |

**`counted_seats`에 포함되는 좌석** [확정 — DECISIONS §1.1]:

| 좌석 상태 | 포함 |
|---|---|
| hold `ACTIVE`(만료 처리 전 포함) | 포함 |
| hold `CONFIRMING`(결제 확인 중, UNKNOWN 포함) | 포함 |
| hold `CONVERTED`이며 해당 항목의 좌석 환불이 `COMPLETED`가 아님(환불 요청·검증 중 포함) | 포함 |
| hold `EXPIRED`, `RELEASED` | 제외 |
| 좌석 환불 `COMPLETED`로 판매 좌석이 해제된 항목 | 제외 |

카운터 변경 지점: 주문 생성(+n), 취소·만료·결제 실패 후 해제·운영자 해제(−n), 좌석 환불 완료(−k). 모든 변경은 이 행을 `FOR UPDATE`로 잠근 트랜잭션에서 수행한다(§11.2, §13.2).

**정합성 감시:** 카운터와 위 규칙으로 계산한 파생 값이 다르면 `review_cases(QUOTA_MISMATCH)`를 생성하는 정기 검사를 둔다. 파생 값으로 카운터를 자동 덮어쓰지 않는다.

> 만료 처리 전의 `ACTIVE` hold(만료 시각은 지났으나 아직 `EXPIRED`로 전이되지 않은 것)는 보수적으로 포함한다. 해당 주체가 새 주문을 시도하면 먼저 자신의 만료 주문을 `expireOrder`로 정리한다(§11.2).

### 5.8 `idempotency_records` — 요청 멱등성 기록

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `scope` | varchar(200) | NOT NULL, **실제 경로 값 포함**: `POST /orders`, `POST /orders/{실제 orderId}/payments` |
| `owner_key_hash` | varchar(255) | NOT NULL, `HMAC(identity_subject_id ‖ browser_binding_hash)` |
| `idempotency_key_hash` | varchar(255) | NOT NULL, 클라이언트 키의 hash |
| `request_hash` | varchar(255) | NOT NULL, 정규화된 요청 본문 hash |
| `resource_type` | varchar(50) | NULL 가능, `ORDER`, `PAYMENT` |
| `resource_id` | uuid | NULL 가능(처리 완료 후 설정) |
| `response_status` | integer | NULL 가능 |
| `response_body` | jsonb | NULL 가능, 최소 응답 snapshot(토큰·개인정보 제외) |
| `status` | varchar(20) | `PROCESSING`, `COMPLETED`, `FAILED` |
| `locked_until` | timestamptz | NULL 가능, `PROCESSING` lease 만료 |
| `expires_at` | timestamptz | NOT NULL |
| `created_at` / `updated_at` | timestamptz | NOT NULL |

제약: `UNIQUE (scope, owner_key_hash, idempotency_key_hash)`, 인덱스 `(expires_at)`.

규칙 [채택 A-010]:
- 키 형식: 128bit 이상 난수(UUID v4 등). 형식 위반은 400.
- **소유 주체(인증 주체 + 브라우저 바인딩)가 다르면 같은 키라도 별개 레코드**로 취급한다. 다른 주체의 결과·쿠키를 절대 반환하지 않는다.
- 같은 소유 주체 + 같은 키 + 같은 request hash → `COMPLETED`면 저장 응답 재반환, `PROCESSING`이고 lease 유효하면 409 `REQUEST_IN_PROGRESS`, lease 만료면 재처리.
- 같은 소유 주체 + 같은 키 + 다른 request hash → 409 `IDEMPOTENCY_KEY_REUSED`.
- 멱등성 레코드 삽입은 리소스 생성과 **같은 트랜잭션**에서 수행해, 동시 요청이 unique 인덱스에서 직렬화되게 한다. 트랜잭션 롤백 시 레코드도 사라진다.
- 결제 원장(`payments`)은 Idempotency 레코드 만료와 무관하게 보존한다. 결제 요청의 멱등성 정본은 이 테이블이며, `payments`에는 Idempotency 키를 중복 저장하지 않는다.

---

## 6. 본인인증 테이블

흐름 [확정 D-004]: **본인인증 → 인증 세션 발급 → 공연·회차 선택 → 좌석 선택 → 점유·주문 생성 → 결제 → PG 승인 검증 → 티켓 발급**

### 6.1 `identity_subjects` — 동일인 식별 주체

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `subject_key_hash` | varchar(255) | NOT NULL, 안정적 동일인 식별값의 HMAC |
| `subject_key_type` | varchar(20) | NOT NULL, `DI`, `CI`, `PHONE` [외부 확인 / 권장 Q-002] |
| `key_version` | smallint | NOT NULL, HMAC 키 버전 |
| `created_at` / `updated_at` | timestamptz | NOT NULL |

제약: `UNIQUE (subject_key_type, key_version, subject_key_hash)`.

- 식별값 원문(DI/CI/전화번호)은 저장하지 않는다. HMAC 비밀키는 secret manager에 보관하고 키 교체 절차를 운영 문서에 둔다.
- **어떤 식별값을 쓸지는 미결정이다(Q-002).** 권장은 DI 우선, CI 미저장, 불가 시 전화번호 HMAC(다회선 우회 위험 기록).
- 이 행은 구매 한도·활성 주문·조회 권한의 기준이다.

### 6.2 `identity_verifications` — 본인인증 거래 기록

주문 생성 전에 수행된다. **`order_id`를 두지 않는다** [채택 A-008]. 주문과의 연결은 `identity_sessions` → `orders.identity_session_id`로 한다.

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `purpose` | varchar(20) | NOT NULL, `BOOKING`, `LOOKUP` |
| `provider` | varchar(50) | NOT NULL |
| `provider_transaction_id` | varchar(200) | NULL 가능(인증사가 반환한 뒤 설정) |
| `browser_binding_hash` | varchar(255) | NOT NULL, 인증을 시작한 브라우저 |
| `state_nonce_hash` | varchar(255) | NOT NULL, 서버가 생성한 단일 사용 값. 콜백 URL에서 보존이 확인되면 추가 검증에 사용(보존 여부 미확인 — API §3.4). 1차 검증은 저장 문맥 + 결과 요청 |
| `provider_context_encrypted` | text | NULL 가능, **거래별 임시 문맥만** 애플리케이션 암호화해 저장(NICE: `request_no`, `transaction_id`, 사용한 접근토큰의 참조 ID). 검증 완료·실패·만료 시 NULL로 지움 [채택 A-028] |
| `status` | varchar(20) | `PENDING`, `VERIFIED`, `CONSUMED`, `FAILED`, `EXPIRED` |
| `identity_subject_id` | uuid | FK → `identity_subjects.id`, NULL 가능(검증 후 설정) |
| `verified_name` | text | NULL 가능, 암호화 권장 |
| `verified_phone` | text | NULL 가능, 암호화 권장 |
| `verified_at` | timestamptz | NULL 가능 |
| `claim_expires_at` | timestamptz | NULL 가능, `VERIFIED` 후 세션 교환 허용 기한 [권장 5분] |
| `expires_at` | timestamptz | NOT NULL, 인증 시도 자체의 만료 |
| `failure_code` | varchar(100) | NULL 가능 |
| `created_at` / `updated_at` | timestamptz | NOT NULL |

상태:
- `PENDING`: 인증 시작
- `VERIFIED`: 콜백을 받아 **서버가 인증사 결과를 재조회·검증**함. 아직 세션 미발급
- `CONSUMED`: 같은 브라우저의 claim으로 인증 세션 발급 완료(1회성)
- `FAILED`, `EXPIRED`

제약:
- `UNIQUE (provider, provider_transaction_id)` (NULL 제외) — **같은 인증 거래 재사용 차단** [M11]
- `CHECK (status NOT IN ('VERIFIED','CONSUMED') OR identity_subject_id IS NOT NULL)`
- 인덱스 `(browser_binding_hash, created_at)`, `(status, expires_at)`

저장 최소화: 인증사 원본 응답 전체를 저장하지 않는다. 생년월일·성별·CI 등은 구매 한도·연락에 필요하지 않으면 저장하지 않는다. 필요 필드는 인증사 계약 확인 후 확정한다[외부 확인 E-001, E-006].

**`provider_context_encrypted` 규칙** [채택 A-028]:
- 저장 대상은 한 인증 거래에만 쓰이는 임시 값이다. NICE 원문상 인증 URL·`transaction_id`는 10분 유효하다(PROVIDERS §2.2).
- **저장 금지:** NICE `client_id`/`client_secret`, 토스 시크릿 키·보안 키, HMAC 키, 데이터 암호화 키 등 고정 비밀값. 이 값들은 서버 Secret 관리 체계에만 둔다.
- NICE 접근토큰(24시간 유효)과 결과 복호화 키 유도에 쓰이는 `ticket`·`iterators`는 여러 거래가 공유하는 값이므로 이 컬럼에 복제하지 않고, 암호화된 공유 토큰 캐시(만료 < 24시간)에 둔다. 컬럼에는 토큰 참조 ID만 저장한다. 저장소는 rate limit 저장소와 함께 결정한다(Q-013).
- 결과 요청을 URL 요청 때와 같은 접근토큰으로 해야 하는지는 **미확인**이다. 토큰 캐시가 유실되어 결과를 받지 못하면 인증을 `FAILED`로 처리하고 재인증을 안내한다.
- 이 컬럼의 암호화 키는 개인정보 암호화 키와 분리해 관리한다(Q-016).

### 6.3 `identity_sessions` — 인증 세션

서버가 검증한 인증 결과를 브라우저에 바인딩해 유지하는 세션이다. `BOOKING`(예매용)과 `LOOKUP`(조회용, 읽기 전용)을 구분한다.

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `identity_verification_id` | uuid | FK → `identity_verifications.id`, NOT NULL, **UNIQUE** |
| `identity_subject_id` | uuid | FK → `identity_subjects.id`, NOT NULL |
| `purpose` | varchar(20) | NOT NULL, `BOOKING`, `LOOKUP` |
| `token_hash` | varchar(255) | UNIQUE, NOT NULL |
| `browser_binding_hash` | varchar(255) | NOT NULL |
| `status` | varchar(20) | `ACTIVE`, `REVOKED`, `EXPIRED` |
| `expires_at` | timestamptz | NOT NULL — BOOKING: 발급 + **고정 30분**(sliding 없음) [확정 D-015, NICE 측 제약은 미확인 Q-001], LOOKUP: 권장 10분 |
| `last_used_at` | timestamptz | NULL 가능 |
| `revoked_at` | timestamptz | NULL 가능 |
| `created_at` / `updated_at` | timestamptz | NOT NULL |

제약:
- `UNIQUE (identity_verification_id)` — 인증 1건 → 세션 1개
- `UNIQUE (id, identity_subject_id)` — 주문 복합 FK 대상
- `purpose`는 원 인증의 purpose와 같아야 한다(claim 트랜잭션에서 검증)
- 인덱스 `(identity_subject_id, status)`, `(browser_binding_hash, status)`

규칙 [채택 A-009]:
- 요청마다 쿠키 토큰 hash와 **바인딩 쿠키 hash가 모두 일치**해야 유효하다. 다른 브라우저로 복사된 세션 쿠키는 바인딩 불일치로 거부된다.
- 세션 만료 후에도 진행 중인 주문은 인증 주체에 귀속되므로, 같은 사람이 재인증하면 새 세션으로 같은 주문을 이어갈 수 있다.
- 같은 브라우저 바인딩에서 같은 purpose의 새 세션을 발급하면 기존 `ACTIVE` 세션은 `REVOKED`로 전이한다.
- `LOOKUP` 세션은 조회 전용이며 주문 생성·취소·결제에 사용할 수 없다. `BOOKING` 세션은 본인 주문 조회도 허용한다.

**BOOKING 세션 사용 규칙** [확정 D-015]:
- **고정 만료:** `expires_at`은 발급 시 정하고 어떤 요청으로도 연장하지 않는다(`last_used_at`만 갱신).
- **같은 브라우저 재사용:** 유효기간 안에서는 주문 취소 후 재예매에 재인증이 필요 없다. 주문 취소·만료는 세션을 폐기하지 않는다.
- **다른 브라우저:** 바인딩 불일치로 사용할 수 없다. 다른 브라우저는 새로 인증해야 하며, 같은 subject이므로 한도·활성 주문은 공유된다.
- **주문 생성 최소 잔여 시간:** 주문 생성 시점에 `expires_at - now >= 10분`(점유 7분 + 결제 확인 보호 3분)이어야 한다. 미달이면 422 `IDENTITY_SESSION_TIME_INSUFFICIENT`로 좌석 선택 전 재인증을 안내한다. 이로써 결제 단계 도중 세션이 만료되지 않는다.
- **주문 생성 횟수 제한:** 세션당 주문 생성 횟수, 인증 주체·회차별 시간당 주문 생성 횟수를 제한한다(수치 권장 Q-013: 3회 / 시간당 5회). 남용 방지 규칙이므로 rate limit 저장소로 관리하며, 동시 요청 경합에서 소폭 초과를 허용한다. 무결성 규칙(한도 4석·활성 주문 1건)은 §11.2의 DB 제약이 보장한다.

### 6.4 구매 한도와 인증의 관계

- 한도의 "동일인"은 `identity_subjects.id`다 [확정 D-006].
- 한 사람이 여러 휴대폰으로 인증해도 DI/CI 기반이면 같은 subject가 된다. 전화번호 기반이면 다른 subject가 되어 우회 가능하다(Q-002 위험).

---

## 7. 결제 및 환불 테이블

### 7.1 `payments` — PG 결제 시도 및 거래 원장

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `order_id` | uuid | FK → `orders.id`, NOT NULL |
| `provider` | varchar(50) | NOT NULL |
| `merchant_payment_ref` | varchar(64) | UNIQUE, NOT NULL, PG에 전달하는 가맹점 결제 식별자(시도마다 신규) |
| `provider_payment_id` | varchar(200) | NULL 가능, PG 결제 객체 ID/결제 키 |
| `pg_transaction_id` | varchar(200) | NULL 가능, PG 승인 거래 ID |
| `status` | varchar(30) | 아래 결제 상태 |
| `role` | varchar(20) | NULL 가능, 승인 후 `PRIMARY` 또는 `EXCESS` |
| `method_type` | varchar(20) | NOT NULL, `CARD`, `EASY_PAY` [확정 D-005] |
| `easy_pay_provider` | varchar(50) | NULL 가능. Phase 1 허용 값: `TOSSPAY`, `NAVERPAY`(NAZIR 내부 정규화 값, 토스 `easyPay` 코드 문자열과의 대응은 adapter가 관리 — 코드 값 미확인) [확정 D-011] |
| `card_company` | varchar(50) | NULL 가능, 승인 응답의 카드사를 adapter가 정규화한 값(허용 목록 검증용) |
| `requested_amount` | bigint | NOT NULL, 서버가 결정한 금액 |
| `approved_amount` | bigint | NULL 가능, PG가 승인한 금액 |
| `refunded_amount` | bigint | NOT NULL, 기본 0, 완료된 환불 누적액 |
| `currency` | char(3) | NOT NULL, 기본 `KRW` |
| `return_nonce_hash` | varchar(255) | NOT NULL, 서버가 생성한 단일 사용 값. successUrl query 보존이 확인되면(TEST SBX-10) 추가 검증에 사용. 1차 검증은 `merchant_payment_ref` + 결제 상태 `READY`(API §3.4) |
| `checkout_expires_at` | timestamptz | NOT NULL, 결제창 유효 기한(≤ 주문 `hold_expires_at`) |
| `confirm_started_at` | timestamptz | NULL 가능 |
| `unknown_since` | timestamptz | NULL 가능 |
| `next_requery_at` | timestamptz | NULL 가능 |
| `requery_count` | integer | NOT NULL, 기본 0 |
| `last_verified_at` | timestamptz | NULL 가능 |
| `approved_at` / `failed_at` / `canceled_at` | timestamptz | NULL 가능 |
| `failure_code` | varchar(100) | NULL 가능 |
| `failure_message` | text | NULL 가능, 민감정보 제거 |
| `created_at` / `updated_at` | timestamptz | NOT NULL |

**결제 상태** [채택]:

| 상태 | 의미 |
|---|---|
| `READY` | 결제 시도 생성, 결제창 진행 중. 서버 confirm 전이므로 결제 미확정 |
| `CONFIRMING` | 서버가 confirm 호출을 위해 펜싱을 적용함(호출 직전·호출 중) |
| `UNKNOWN` | 보호 3분 내 결과 미확정. 재조회 중 |
| `SUCCEEDED` | PG 승인 확인 |
| `FAILED` | PG 승인 실패 또는 승인 없음 확정 |
| `CANCELED` | confirm 전 폐기(결제창 이탈, 새 시도로 대체, 주문 취소·만료) |

**결제 역할(`role`)**:
- `PRIMARY`: 예매 확정에 사용된 승인 결제(`orders.confirmed_payment_id`와 일치)
- `EXCESS`: 확정에 쓰이지 않은 승인 결제(중복 승인, 금액 불일치, 발권 불가). **전액 환불 대상**이며 기록을 삭제하지 않는다.

환불 진행 상황은 결제 상태에 섞지 않는다. 결제의 환불 정도는 `refunded_amount`(완료 누적)와 `approved_amount`로 계산한다(v1.0의 `PARTIALLY_REFUNDED`/`REFUNDED`/`REVIEW_REQUIRED` 결제 상태는 제거).

제약·인덱스:
- `UNIQUE (provider, pg_transaction_id)` (NULL 제외), `UNIQUE (provider, provider_payment_id)` (NULL 제외)
- `UNIQUE (id, order_id)` — 주문·환불 복합 FK 대상
- **진행 중 결제 1건:** `UNIQUE (order_id) WHERE status IN ('READY','CONFIRMING','UNKNOWN')` [채택 A-005]
- `CHECK (method_type IN ('CARD','EASY_PAY'))` — 가상계좌 등 제외 [확정 D-005]
- `CHECK (requested_amount > 0)`, `CHECK (approved_amount IS NULL OR approved_amount >= 0)`
- `CHECK (refunded_amount >= 0 AND refunded_amount <= COALESCE(approved_amount, 0))` — **결제별 누적 환불 ≤ 승인 금액** [H2]
- `CHECK ((status = 'SUCCEEDED') = (role IS NOT NULL))`
- 인덱스 `(order_id, created_at)`, `(status, next_requery_at)`

"주문별 확정 결제 1건"은 `orders.confirmed_payment_id`(UNIQUE + 복합 FK)로 보장한다. status 기반 partial unique는 사용하지 않는다(중복 승인 이력을 보존해야 하므로).

PG가 confirm 결과로 허용되지 않은 결제수단(가상계좌 등), 허용 목록 밖 카드사·간편결제사를 보고하면 확정하지 않고 `role = EXCESS` + `review_cases(DISALLOWED_METHOD)`로 처리한다 [채택 A-030]. 허용 목록은 결제 시작 시점의 설정을 기준으로 한다.

**토스페이먼츠 필드 대응** [확정 D-010, 원문 PROVIDERS §1]:

| NAZIR 컬럼 | 토스 값 | 비고 |
|---|---|---|
| `merchant_payment_ref` | `orderId` | 6~64자, 영문 대소문자·숫자·`-` `_` `=`. 결제 시도마다 새 128bit 이상 난수로 생성. orderId 조회 API의 키 |
| `provider_payment_id` | `paymentKey` | 최대 200자, 받은 값 그대로 저장 |
| `pg_transaction_id` | 승인 거래의 `lastTransactionKey` | 결제 객체의 `transactionKey`는 DEPRECATED |
| `status` 반영 | `DONE`→`SUCCEEDED`, `ABORTED`/`EXPIRED`→`FAILED`, `IN_PROGRESS`→(confirm 재시도 대상) | 변환은 adapter가 수행하고 도메인에는 정규화 결과만 전달 |
| `method_type`·`easy_pay_provider`·`card_company` | 응답 `method`(한글 문자열)·간편결제·카드 정보 | adapter가 정규화, 허용 외 값은 `DISALLOWED` |

Provider 실행 단계(Mock/Sandbox/Live)는 컬럼으로 저장하지 않는다(§14.2).

카드번호·CVC 등 결제 민감정보는 저장하지 않는다. PG 결제 키·거래 ID는 계약상 저장 가능한 범위에서만 보관한다.

### 7.2 `payment_webhook_events` — PG Webhook 수신 원장

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `provider` | varchar(50) | NOT NULL |
| `provider_event_id` | varchar(200) | NULL 가능 |
| `deduplication_key` | varchar(255) | NOT NULL |
| `payment_id` | uuid | FK → `payments.id`, NULL 가능 |
| `event_type` | varchar(100) | NOT NULL |
| `signature_verified` | boolean | NOT NULL, PG가 서명을 제공하지 않으면 false |
| `payload_hash` | varchar(255) | NOT NULL |
| `payload_redacted` | jsonb | 민감정보 제거 payload |
| `status` | varchar(20) | `RECEIVED`, `PROCESSING`, `PROCESSED`, `FAILED`, `IGNORED`, `UNMATCHED` |
| `attempt_count` | integer | NOT NULL, 기본 0 |
| `locked_until` | timestamptz | NULL 가능, 처리 lease |
| `failure_reason` | text | NULL 가능 |
| `received_at` / `last_received_at` | timestamptz | NOT NULL |
| `processed_at` | timestamptz | NULL 가능 |

제약: `UNIQUE (provider, deduplication_key)`, 인덱스 `(status, received_at)`.

규칙 [채택 A-016, A-027 / H4]:
- **웹훅은 결제 성공의 직접 증거가 아니다.** 수신 엔드포인트는 (1) 서명 검증, (2) 이벤트 저장(dedupe), (3) **10초 이내 200 응답**만 수행하고, 상태 반영은 비동기 작업이 **결제 조회 API 결과로** 수행한다(토스 원문: 10초 내 200 미응답 시 최대 7회 재전송).
- **서명:** 토스 웹훅 헤더 `tosspayments-webhook-signature`를 보안 키로 HMAC SHA-256 검증한다(원문 PROVIDERS §1.7). 헤더가 있는데 검증에 실패하면 거부(상태 변경 없음, 사유 기록). 결제 웹훅 수신 시 헤더가 실제로 존재하는지는 sandbox에서 확인하며, 없더라도 조회 API 교차 확인으로 반영한다(`signature_verified = false`).
- **dedupe 키:** 본문 `eventId`가 있으면 그 값, 없으면 adapter가 `eventType`·`paymentKey`(또는 `orderId`)·결제 `status`·본문 `createdAt` 조합으로 생성한다. 발송마다 새로 발급되는 `tosspayments-webhook-transmission-id`는 dedupe에 쓰지 않는다(원문).
- 같은 dedupe 키 재수신 시 `last_received_at`을 갱신하고, 기존 상태가 `PROCESSED`·`IGNORED`면 처리하지 않는다. **`RECEIVED`, `FAILED`, lease가 만료된 `PROCESSING`이면 다시 처리한다.**
- 조회 결과 대조 항목: `orderId`(= `merchant_payment_ref`), 금액, 상태, MID(원문 보안 체크리스트).
- 결제를 찾을 수 없으면 `UNMATCHED` + `review_cases(WEBHOOK_UNMATCHED)`.
- 반복 실패(설정 횟수 초과)는 `review_cases(WEBHOOK_FAILED)`.
- eventId가 없을 때의 조합 키 규칙은 sandbox에서 실제 본문 형식을 확인한 뒤 확정한다(TEST SBX-08).

### 7.3 `payment_status_logs` — 결제 상태 변경 로그

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `payment_id` | uuid | FK → `payments.id`, NOT NULL |
| `from_status` | varchar(30) | NULL 가능 |
| `to_status` | varchar(30) | NOT NULL |
| `source` | varchar(30) | `API`, `RETURN`, `WEBHOOK`, `PG_REQUERY`, `ADMIN`, `SYSTEM` |
| `source_event_id` | uuid | NULL 가능 |
| `note` | text | NULL 가능 |
| `created_at` | timestamptz | NOT NULL |

상태 변경과 로그 삽입은 같은 트랜잭션. 인덱스 `(payment_id, created_at)`.

### 7.4 `refunds` — 환불 단위

Phase 1: 운영자가 **DB에 환불 요청을 먼저 기록**하고, PG 관리자 페이지에서 환불을 실행한 뒤, **PG 재조회로 성공을 검증**하고 완료 처리한다 [확정 D-007 / 채택 A-015].

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `order_id` | uuid | NOT NULL |
| `payment_id` | uuid | NOT NULL |
| `refund_type` | varchar(20) | NOT NULL, `SEAT`, `PAYMENT_EXCESS` |
| `provider` | varchar(50) | NOT NULL |
| `provider_refund_id` | varchar(200) | NULL 가능, PG 취소/환불 거래 ID. 토스: 결제 조회 응답 `cancels[].transactionKey`(원문) |
| `total_amount` | bigint | NOT NULL, `CHECK (total_amount > 0)` |
| `status` | varchar(20) | `REQUESTED`, `VERIFYING`, `COMPLETED`, `FAILED`, `WITHDRAWN` |
| `reason` | text | NULL 가능, 개인정보 금지 |
| `requested_by_admin_id` | uuid | FK → `admins.id`, NULL 가능 |
| `pg_executed_by_admin_id` | uuid | FK → `admins.id`, NULL 가능 |
| `verified_at` / `completed_at` | timestamptz | NULL 가능 |
| `failure_reason` | text | NULL 가능 |
| `created_at` / `updated_at` | timestamptz | NOT NULL |

상태:
- `REQUESTED`: DB에 환불 요청 기록(PG 실행 전). 티켓·좌석·한도 유지
- `VERIFYING`: 운영자가 PG 관리자 페이지에서 실행했다고 기록하고 PG 재조회로 검증 중. 티켓·좌석·한도 유지
- `COMPLETED`: PG 재조회로 환불 성공 확인 → 티켓 VOID, 좌석 해제, 한도 복구(§11.8)
- `FAILED`: PG 재조회 결과 환불 없음/실패 확인. 티켓·좌석 유지
- `WITHDRAWN`: PG 실행 전 요청 철회

유형:
- `SEAT`: `PRIMARY` 결제의 좌석 환불. `refund_items` 1건 이상 필수
- `PAYMENT_EXCESS`: `EXCESS` 결제의 환불(중복 승인·금액 불일치·발권 불가). `refund_items` 없음. 좌석·티켓·한도에 영향 없음

제약:
- 복합 FK `(payment_id, order_id)` → `payments(id, order_id)` — **환불과 결제의 주문 일치 의무화** [H2]
- `UNIQUE (id, order_id)` — 환불 항목 복합 FK 대상
- `UNIQUE (provider, provider_refund_id)` (NULL 제외) — 같은 PG 환불을 두 번 기록하지 않음
- 인덱스 `(order_id, created_at)`, `(status, updated_at)`

`refund_type`과 결제 `role`의 일치(`SEAT` ↔ `PRIMARY`, `PAYMENT_EXCESS` ↔ `EXCESS`)는 환불 생성 트랜잭션에서 결제 행을 잠그고 검증한다.

### 7.5 `refund_items` — 좌석 환불 항목

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `refund_id` | uuid | NOT NULL |
| `order_id` | uuid | NOT NULL |
| `order_item_id` | uuid | NOT NULL |
| `amount` | bigint | NOT NULL, `CHECK (amount > 0)`, 해당 항목 가격 이하 |
| `created_at` | timestamptz | NOT NULL |

제약:
- 복합 FK `(refund_id, order_id)` → `refunds(id, order_id)`
- 복합 FK `(order_item_id, order_id)` → `order_items(id, order_id)` — **환불 항목이 환불 주문에 속함** [H2]
- `UNIQUE (refund_id, order_item_id)`
- 인덱스 `(order_item_id)`

검증 규칙(환불 생성·완료 트랜잭션, 결제 행 `FOR UPDATE` 하에서):
1. `refunds.total_amount = SUM(refund_items.amount)` (`SEAT` 유형)
2. 한 주문 항목에 대해 `REQUESTED`/`VERIFYING`/`COMPLETED` 상태의 환불이 동시에 2건 이상 존재하지 않는다(Phase 1은 좌석당 1회 환불).
3. `amount <= order_items.price`(취소 수수료 정책 확정 전까지 `amount = price`가 기본 [외부 확인 E-005])
4. 결제별: `완료 누적 + 진행 중(REQUESTED/VERIFYING) 합계 + 신규 금액 <= approved_amount`. 완료 시에는 `payments.refunded_amount` CHECK가 최종 방어한다.

---

## 8. 티켓 테이블

### 8.1 `tickets` — 좌석별 티켓

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `ticket_number` | varchar(40) | UNIQUE, NOT NULL |
| `order_item_id` | uuid | NOT NULL, UNIQUE |
| `session_seat_id` | uuid | NOT NULL |
| `status` | varchar(20) | `ISSUED`, `USED`, `VOID` |
| `qr_token_hash` | varchar(255) | NULL 가능(Phase 2) |
| `issued_at` | timestamptz | NOT NULL |
| `used_at` / `voided_at` | timestamptz | NULL 가능 |
| `created_at` / `updated_at` | timestamptz | NOT NULL |

제약:
- 복합 FK `(order_item_id, session_seat_id)` → `order_items(id, session_seat_id)`
- **좌석당 유효 티켓 1장:** `UNIQUE (session_seat_id) WHERE status IN ('ISSUED','USED')` [H1]

티켓은 판매 확정 트랜잭션에서만 생성한다(§11.7). 좌석 환불 완료 시 `VOID`. 환불 요청·검증 중에는 `ISSUED` 유지 [확정 D-007].

---

## 9. 관리자 테이블

### 9.1 `admins`

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `email` | varchar(254) | UNIQUE, NOT NULL |
| `password_hash` | text | NOT NULL, 강한 password hashing(예: Argon2id 또는 bcrypt — 구현 시 확정) |
| `name` | varchar(100) | NOT NULL |
| `role` | varchar(30) | `SUPER_ADMIN`, `STAFF` (권한 매트릭스: API_SPEC §5.1) |
| `mfa_secret_encrypted` | text | NULL 가능 [권장 Q-015] |
| `is_active` | boolean | NOT NULL, 기본 true |
| `last_login_at` | timestamptz | NULL 가능 |
| `created_at` / `updated_at` | timestamptz | NOT NULL |

### 9.2 `admin_sessions`

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `admin_id` | uuid | FK → `admins.id`, NOT NULL |
| `token_hash` | varchar(255) | UNIQUE, NOT NULL |
| `status` | varchar(20) | `ACTIVE`, `REVOKED`, `EXPIRED` |
| `idle_expires_at` | timestamptz | NOT NULL [권장: 30분 유휴] |
| `absolute_expires_at` | timestamptz | NOT NULL [권장: 12시간] |
| `mfa_verified_at` | timestamptz | NULL 가능 |
| `ip_address` | inet | NULL 가능 |
| `user_agent` | text | NULL 가능 |
| `last_used_at` / `revoked_at` | timestamptz | NULL 가능 |
| `created_at` | timestamptz | NOT NULL |

로그인 성공 시 새 토큰 발급(fixation 방지), 로그아웃·비활성화·권한 변경 시 해당 관리자의 세션 폐기. 인덱스 `(admin_id, status)`.

### 9.3 `admin_audit_logs`

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `admin_id` | uuid | FK → `admins.id`, NULL 가능 |
| `action` | varchar(100) | NOT NULL |
| `target_type` | varchar(50) | NOT NULL |
| `target_id` | uuid | NULL 가능 |
| `before_data` / `after_data` | jsonb | 민감정보 제거 |
| `evidence_note` | text | NULL 가능, 증빙 기반 수동 처리 사유 |
| `ip_address` | inet | NULL 가능 |
| `user_agent` | text | NULL 가능 |
| `created_at` | timestamptz | NOT NULL |

**P0 필수** [채택 A-022]. 모든 관리자 변경 API는 대상 변경과 같은 트랜잭션에서 감사 로그를 남긴다.

---

## 10. 운영 및 외부 연동 테이블

### 10.1 `review_cases` — 운영자 확인 필요 사안

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `case_type` | varchar(40) | 아래 목록 |
| `severity` | varchar(10) | `INFO`, `WARN`, `CRITICAL` |
| `status` | varchar(20) | `OPEN`, `IN_PROGRESS`, `RESOLVED` |
| `order_id` / `payment_id` / `refund_id` | uuid | FK, NULL 가능 |
| `dedupe_key` | varchar(255) | NOT NULL |
| `detail` | jsonb | 민감정보 제거 |
| `assigned_admin_id` / `resolved_by_admin_id` | uuid | FK → `admins.id`, NULL 가능 |
| `resolution_action` | varchar(50) | NULL 가능 |
| `resolution_note` | text | NULL 가능 |
| `resolved_at` | timestamptz | NULL 가능 |
| `created_at` / `updated_at` | timestamptz | NOT NULL |

`case_type`: `PAYMENT_UNKNOWN_PROLONGED`, `EXCESS_PAYMENT`, `AMOUNT_MISMATCH`, `DISALLOWED_METHOD`, `UNFULFILLABLE_APPROVAL`, `REFUND_VERIFICATION_PENDING`, `REFUND_UNRECORDED`, `REFUND_MISMATCH`, `WEBHOOK_UNMATCHED`, `WEBHOOK_FAILED`, `QUOTA_MISMATCH`, `SEAT_OWNERSHIP_MISMATCH`, `OUTBOX_DEAD`.

제약: `UNIQUE (case_type, dedupe_key) WHERE status <> 'RESOLVED'` — 같은 사안의 중복 open 방지. 관리자 해결 action은 API_SPEC §5.4의 열거된 목록만 허용한다.

### 10.2 `outbox_events` — 비동기 외부 연동 이벤트

| 컬럼 | 타입 | 제약 / 설명 |
|---|---|---|
| `id` | uuid | PK |
| `event_type` | varchar(100) | NOT NULL |
| `aggregate_type` | varchar(50) | NOT NULL |
| `aggregate_id` | uuid | NOT NULL |
| `aggregate_version` | bigint | NOT NULL, 집계의 변경 순번 |
| `payload` | jsonb | 전송 시점이 아닌 **이벤트 시점 집계 snapshot**(최소 필드, 전화번호 마스킹) |
| `status` | varchar(20) | `PENDING`, `PROCESSING`, `SENT`, `RETRY`, `DEAD`, `SUPERSEDED` |
| `attempt_count` | integer | NOT NULL, 기본 0 |
| `next_retry_at` | timestamptz | NULL 가능 |
| `locked_until` | timestamptz | NULL 가능 |
| `locked_by` | varchar(100) | NULL 가능 |
| `last_error` | text | NULL 가능 |
| `sent_at` | timestamptz | NULL 가능 |
| `created_at` / `updated_at` | timestamptz | NOT NULL |

처리 규칙:
- 핵심 DB 변경과 outbox 삽입은 같은 트랜잭션(**P0**). Sheets 전송 worker는 P1 [채택 A-022].
- worker는 `FOR UPDATE SKIP LOCKED`로 claim하되 **같은 aggregate는 순차 처리**한다(같은 aggregate의 더 오래된 미전송 이벤트가 있으면 건너뜀).
- 같은 aggregate의 더 새 이벤트가 이미 `SENT`면 오래된 이벤트는 `SUPERSEDED`로 종료(오래된 상태가 최신 행을 덮어쓰지 않음) [M5].
- Sheets 행은 `order_number` 등 aggregate 키로 upsert하며, 시트에 기록된 version보다 낮은 이벤트는 쓰지 않는다. Sheets API 쿼터를 고려해 backoff를 적용한다.
- lease 만료 `PROCESSING`은 회수, 지수 backoff 재시도, 최대 횟수 초과 시 `DEAD` + `review_cases(OUTBOX_DEAD)`.
- Sheets 장애는 주문·결제 응답에 영향을 주지 않는다.

---

## 11. 핵심 상태 및 업무 규칙

### 11.1 좌석 표시 상태 우선순위

1. `session_seats.status = SOLD` → 판매 완료
2. `session_seats.status = BLOCKED` → 판매 불가
3. `CONFIRMING` hold 존재 → 임시 점유(결제 확인 중)
4. `ACTIVE` hold 존재 + 주문 `hold_expires_at > now` → 임시 점유
5. 그 외 → 예약 가능(만료됐지만 아직 정리되지 않은 `ACTIVE` hold 포함 — 예약 시도 시 서버가 정리)

### 11.2 주문 생성 (점유 + 한도 + 활성 주문) [확정 D-002, D-006, D-008 / 채택 A-011]

전제: 유효한 `BOOKING` 인증 세션(바인딩 일치, **잔여 10분 이상**, 주문 생성 횟수 제한 이내 — §6.3), 판매 가능 조건(§11.11), 좌석 수 1 ≤ n ≤ `max_seats_per_identity`.

**사전 정리(별도 트랜잭션):**
- 요청 주체의 같은 회차 활성 주문이 `PENDING`이고 `hold_expires_at`이 지났으면 `expireOrder`(§11.4) 실행.
- 요청 좌석에 `ACTIVE` hold가 있고 그 주문의 `hold_expires_at`이 지났으면 해당 주문에 `expireOrder` 실행(주문 ID 정렬 순서).

**메인 트랜잭션(READ COMMITTED):**
1. `purchase_quotas(subject, session)` 행을 `INSERT … ON CONFLICT DO NOTHING`으로 보장하고 `SELECT … FOR UPDATE`로 잠근다. → **같은 주체의 동시 요청이 여기서 직렬화된다.**
2. 같은 주체·회차의 활성 주문 존재 여부 확인 → 있으면 409 `ACTIVE_ORDER_EXISTS`(기존 주문 ID 반환). partial unique 인덱스가 최종 방어.
3. `counted_seats + n <= seat_limit` 확인 → 초과 시 422 `PURCHASE_LIMIT_EXCEEDED`. `counted_seats += n` 갱신(CHECK 제약이 최종 방어).
4. 요청 `session_seats`를 `id` 정렬 순서로 `SELECT … FOR UPDATE`. 모두 해당 회차 소속(`show_session_id` 일치)이고 `AVAILABLE`인지 확인.
5. `orders`(`hold_expires_at = now + 7분`), `order_items`, `seat_holds(ACTIVE)` 삽입. 좌석에 유효 hold가 이미 있으면 partial unique 위반 → **전체 롤백**, 409 `SEAT_UNAVAILABLE`.
6. `order_access_sessions`, `idempotency_records(COMPLETED)`, `order_status_logs`, `outbox_events` 삽입 후 커밋.

> **COUNT 후 INSERT 금지**: 한도 판단은 잠긴 카운터 행 + CHECK 제약으로, 좌석 중복은 partial unique로, 활성 주문 중복은 partial unique로 각각 DB가 최종 방어한다. 부분 점유는 발생하지 않는다.

**잠금 후 판단 규칙** [채택 A-029]: 2~3단계의 활성 주문·카운터 판정은 1단계 잠금을 획득한 **이후에 실행한 statement 결과**로만 한다. 잠금 전에 읽은 값(사전 조회, 캐시, 앞 요청의 응답)을 판정에 재사용하지 않는다. READ COMMITTED에서는 statement마다 새 snapshot을 쓰므로, 잠금 대기 후 실행한 조회는 앞선 트랜잭션이 커밋한 값을 본다.

**PostgreSQL 동시 실행 순서(행이 아직 없는 경우)**: 같은 주체의 T1·T2가 동시에 1단계를 실행하면 T1이 행을 삽입(미커밋)하고, T2의 `INSERT … ON CONFLICT DO NOTHING`은 unique 인덱스에서 T1 종료까지 대기한다. T1 커밋 후 T2는 충돌로 0행 처리되고 `SELECT … FOR UPDATE`에서 T1이 커밋한 카운터를 읽는다. T1이 롤백하면 T2의 삽입이 진행된다. 행이 이미 있으면 직렬화는 `FOR UPDATE`에서 일어난다. 어느 경우든 한도를 넘지 않는다(TEST QTA-06/07/20/21).

### 11.3 일반 점유 7분

- 만료 시각은 주문 생성 시 `now + 7분`으로 고정한다. 뒤로 가기, 결제창 취소, 결제 실패, 재인증으로 연장하지 않는다 [확정 D-002].
- 결제 시작은 남은 점유 시간이 최소 기준 이상일 때만 허용한다[권장 Q-011: 60초].
- 결제창 유효 기한(`checkout_expires_at`)은 `hold_expires_at`을 넘지 않는다.

### 11.4 만료 처리 `expireOrder(orderId)`

다른 주문의 hold를 회수해야 하는 모든 경로(만료 작업, 주문 생성 사전 정리, 관리자 차단 전)는 이 루틴을 **별도 트랜잭션**으로 호출한다[채택 A-020].

1. 해당 주문의 `purchase_quotas` 행 `FOR UPDATE` → 주문 행 `FOR UPDATE`.
2. 주문이 `PENDING`이고 `hold_expires_at <= now`인지 재확인. 아니면 종료(아무것도 하지 않음). **`PAYMENT_CONFIRMING`/`PAYMENT_UNKNOWN` 주문과 `CONFIRMING` hold는 절대 회수하지 않는다** [확정 D-003].
3. `READY` 결제가 있으면 `CANCELED`(서버 confirm 전이므로 결제 미발생 — A-001 전제).
4. `ACTIVE` hold → `EXPIRED`, 주문 → `EXPIRED`(`closed_at`), `counted_seats -= n`.
5. 로그·outbox 삽입 후 커밋.

정기 만료 작업은 권장 1분 주기로 실행한다[외부 확인 E-007]. 작업이 지연되어도 주문 생성·차단 경로가 직접 정리하므로 정합성은 유지된다.

### 11.5 취소 후 재예매 [확정 D-001]

- 좌석을 바꾸려면 사용자는 `POST /orders/{id}/cancel`로 기존 주문을 취소하고 새 주문을 만든다.
- 취소 조건: 주문 `PENDING`(진행 중 확인 결제 없음). `READY` 결제는 `CANCELED`로 함께 폐기.
- 취소 트랜잭션: quota 잠금 → 주문 잠금 → hold `RELEASED(USER_CANCELED)` → 주문 `CANCELED` → `counted_seats -= n` → 로그·outbox.
- 이전 주문과 새 주문은 별개의 `orders`/`order_items`/`seat_holds`/`payments`를 가지며 서로 참조하지 않는다. 이전 주문의 이력은 보존된다.
- `PAYMENT_CONFIRMING`/`PAYMENT_UNKNOWN` 중에는 취소할 수 없다(409 `PAYMENT_IN_PROGRESS`).

### 11.6 결제 확인 펜싱과 3분 보호 [확정 D-003 / 채택 A-001~A-003]

PG는 서버 승인(confirm)형을 전제로 한다[외부 확인 E-002]. PG confirm 호출은 **DB 트랜잭션 밖**에서 실행한다.

```
[Tx1: 확인 진입]  ──커밋──▶  [PG confirm 호출(트랜잭션 밖)]  ──▶  [Tx2: 결과 반영]
                                         │ 응답 없음/timeout
                                         ▼
                           (상태 CONFIRMING 유지) ── 3분 경과 ──▶ [Tx3: UNKNOWN 전이] ──▶ 재조회 작업
```

**Tx1 — 확인 진입(짧은 트랜잭션):**
1. quota 행 → 주문 행 → 결제 행 `FOR UPDATE`.
2. 검증: 주문 `PENDING`, 결제 `READY`(복귀 `orderId` = `merchant_payment_ref`, 단일 사용), 복귀 nonce 일치(보존이 확인된 경우), 복귀 금액 = `requested_amount` = `orders.total_amount`, 결제수단 허용, **`now < hold_expires_at`**, 모든 hold `ACTIVE`.
3. 실패 시: 결제 `CANCELED`(또는 금액 불일치는 `FAILED`) — **confirm을 호출하지 않으므로 결제 미발생**. 점유가 만료됐으면 `expireOrder` 경로로 주문 `EXPIRED`.
4. 성공 시: hold `ACTIVE → CONFIRMING`, 주문 `PENDING → PAYMENT_CONFIRMING`, `confirm_protected_until = now + 3분`, 결제 `READY → CONFIRMING`(`confirm_started_at`, `provider_payment_id` 기록). 로그 후 **커밋**.

**PG confirm 호출(트랜잭션 밖):** 결제 시도별로 고정한 멱등 키(토스 `Idempotency-Key`, 15일 유효 — 원문)를 사용한다. 호출 timeout은 설정값이며 초기값 60초다[채택 A-031].

**confirm timeout과 3분 보호의 관계** [채택 A-031]:
- 3분 보호(`confirm_protected_until`)는 "승인 결과를 기다리는 동안 좌석을 지키는 시간"이고, timeout은 "한 번의 HTTP 호출을 기다리는 시간"이다. 60초 timeout이면 3분 안에 confirm 시도와 orderId 조회를 2~3회 수행할 수 있다.
- 불명확 결과(INDETERMINATE) 처리 순서: orderId 조회(`GET /v1/payments/orders/{orderId}`) → `DONE`이면 확정, `ABORTED`/`EXPIRED`이면 실패 확정, `IN_PROGRESS`(인증 완료·승인 전)이고 인증 후 10분 이내면 **같은 멱등 키로 confirm 재시도**, 조회 자체가 불명확하면 대기 후 반복.
- 토스는 인증 후 10분 안에 승인하지 않은 결제를 `EXPIRED`로 만든다(원문). 따라서 confirm이 토스에 도달하지 않은 UNKNOWN은 인증 후 10분 이후 조회로 실패를 확정할 수 있을 것으로 예상한다(`IN_PROGRESS`·`EXPIRED` 결제의 조회 응답 형식은 **미확인**, sandbox에서 확인 — TEST SBX-06/07).
- 함수 실행 시간 제한이 60초 호출을 수용하지 못하는 호스팅이면 confirm 호출을 요청 처리와 분리된 작업으로 옮긴다(E-007).
- **3분 경과만으로 좌석을 해제하거나 결제를 실패 처리하지 않는다**(Tx3, 확정 D-003).

**Tx2 — 결과 반영:** quota → 주문 → 결제 잠금 후, 결제가 여전히 `CONFIRMING` 또는 `UNKNOWN`일 때만 반영(이미 반영됐으면 무시 — 멱등).
- 승인 + 금액 일치 + 허용 수단 → §11.7 판매 확정.
- 승인 + 금액 불일치/허용 외 수단 → 결제 `SUCCEEDED`, `role = EXCESS`, 주문 `REVIEW_REQUIRED`, `review_cases(AMOUNT_MISMATCH | DISALLOWED_METHOD)`. hold는 `CONFIRMING` 유지(운영자 해결까지 좌석 보호).
- **실패 확정**(PG가 명확한 실패 응답) → 결제 `FAILED`. `now < hold_expires_at`이면 hold `ACTIVE` 복귀·주문 `PENDING`(새 결제 시도 가능, 만료 시각 불변), 아니면 hold `EXPIRED`·주문 `EXPIRED`·`counted_seats -= n`.
- **불명확**(timeout, 네트워크 오류, 5xx, 판독 불가 응답) → 아무 상태도 바꾸지 않는다(`CONFIRMING` 유지). 즉시 1회 재조회를 시도할 수 있다.

**Tx3 — 3분 경과(재조회 작업이 수행):** `confirm_protected_until <= now`이고 결제가 아직 `CONFIRMING`이면 결제 `UNKNOWN`(`unknown_since`, `next_requery_at`), 주문 `PAYMENT_UNKNOWN`. **hold는 `CONFIRMING` 유지 — 다른 사용자에게 재판매하지 않는다.** 3분 경과는 실패·해제의 근거가 아니다.

**UNKNOWN 해소:** 재조회 작업이 `next_requery_at` 일정(권장 Q-003)에 따라 PG를 재조회하고 Tx2와 같은 규칙으로 반영한다. 장기화 시 경보·`review_cases(PAYMENT_UNKNOWN_PROLONGED)`·관리자 복구 절차(Q-005)로 처리한다. UNKNOWN 상태에서는 같은 주문의 새 결제를 허용하지 않는다(진행 중 결제 partial unique).

**경합 정리:**
- `expireOrder`와 Tx1은 주문 행 잠금으로 직렬화된다. Tx1이 먼저면 주문이 `PAYMENT_CONFIRMING`이 되어 `expireOrder`는 아무것도 하지 않는다. `expireOrder`가 먼저면 Tx1이 `PENDING`이 아님을 보고 confirm을 호출하지 않는다.
- `CONFIRMING` hold가 좌석 partial unique를 점유하므로 다른 주문은 해당 좌석을 점유할 수 없다.

### 11.7 판매 확정 (Tx2 성공 경로)

하나의 트랜잭션에서:
1. (quota →) 주문 → 결제 행 잠금(이미 Tx2에서 획득)
2. 주문 `PAYMENT_CONFIRMING`/`PAYMENT_UNKNOWN`, `confirmed_payment_id IS NULL` 확인
3. 주문 항목의 `session_seats`를 `id` 순 `FOR UPDATE`, 각 좌석이 `AVAILABLE`이고 `sold_order_item_id IS NULL`인지, hold가 `CONFIRMING`이고 이 주문 소속인지 확인
4. `session_seats.status = SOLD`, `sold_order_item_id = 항목`
5. hold `CONVERTED`
6. 결제 `SUCCEEDED`, `role = PRIMARY`, `approved_amount`, `approved_at`
7. 주문 `PAID`, `confirmed_payment_id`, `paid_at`, `closed_at`
8. 좌석별 티켓 `ISSUED`
9. 주문·결제·좌석 로그, outbox

3단계 검증이 실패하는 경우(펜싱이 정상 동작하면 발생하지 않아야 함)는 결제 `role = EXCESS`, 주문 `REVIEW_REQUIRED`, `review_cases(UNFULFILLABLE_APPROVAL, CRITICAL)`로 처리하고 자동 발권하지 않는다. 중복 webhook·복귀·재조회가 반복되어도 2단계 조건과 `tickets.order_item_id` UNIQUE, 유효 티켓 partial unique로 티켓은 한 번만 생성된다.

**이미 확정된 주문에 다른 결제의 승인이 확인되면** 해당 결제는 `role = EXCESS`, `review_cases(EXCESS_PAYMENT)`로 분류하고 주문은 `PAID`를 유지한다.

### 11.8 환불 [확정 D-007 / 채택 A-014, A-015]

**순서:**
1. **요청 기록**(관리자 API): 결제 행 `FOR UPDATE` → 검증(§7.5) → `refunds(REQUESTED)` + `refund_items` 삽입 + 감사 로그. 티켓·좌석·한도 변화 없음.
2. **PG 실행**: 운영자가 PG 관리자 페이지에서 환불을 실행하고, 관리자 화면에 PG 환불 거래 ID를 입력 → `VERIFYING`.
3. **검증**: 서버가 PG API로 환불 거래를 재조회. 금액·결제 일치 시 완료 트랜잭션, 환불 없음/실패면 `FAILED`(티켓·좌석 유지), 조회 불가면 `VERIFYING` 유지 + 재시도 + 장기화 시 `review_cases(REFUND_VERIFICATION_PENDING)`.

**완료 트랜잭션(Q-007 원자성):** quota 행(SEAT 유형) → 주문 → 결제 → 환불 → 해당 `session_seats`(id 순) → 티켓 순으로 잠그고:
- 환불 `COMPLETED`, 결제 `refunded_amount += total_amount`(CHECK가 승인 금액 초과 차단)
- `SEAT` 유형: 각 항목 티켓 `VOID`, 좌석이 **`sold_order_item_id = 해당 항목`일 때만** 해제(`sold_order_item_id = NULL`, 상태는 재판매 정책에 따라 `AVAILABLE` 또는 `BLOCKED` [권장 Q-012: BLOCKED]), 소유 불일치면 해제하지 않고 `review_cases(SEAT_OWNERSHIP_MISMATCH)`, `counted_seats -= 해제된 좌석 수`
- 주문의 모든 항목 좌석 환불 완료 + 모든 `EXCESS` 결제 환불 완료 → 주문 `REFUNDED`. 부분 환불은 `PAID` 유지
- 로그·감사·outbox

**복구:**
- PG 환불 성공 후 DB 반영 실패 → `VERIFYING`이 남으므로 재검증(관리자 action 또는 작업)으로 멱등 복구. `(provider, provider_refund_id)` UNIQUE로 이중 기록 방지.
- DB 요청 없이 PG에서 환불된 경우(절차 위반) → PG 취소 webhook·일일 대사로 탐지해 `review_cases(REFUND_UNRECORDED)`. 운영자가 사후 요청을 기록하고 검증한다.

**REVIEW_REQUIRED → UNFULFILLED 전이** [확정 D-014]: 발권하지 않은 주문(금액 불일치·허용 외 수단·발권 불가)은 관리자 action `RELEASE_SEATS`로 다음을 **한 트랜잭션에서 원자적으로** 수행한다(잠금 순서 §13.2: quota → order → payments → seat_holds).
1. **결제 결과 확정 확인:** 주문의 모든 결제가 종료 상태(`SUCCEEDED`/`FAILED`/`CANCELED`)이고, `SUCCEEDED`인 결제는 모두 `role = EXCESS`다. `CONFIRMING`/`UNKNOWN` 결제가 있으면 거부(409 `PAYMENT_IN_PROGRESS`) — 결과가 미해결이면 `REVIEW_REQUIRED`(활성)를 유지한다.
2. **좌석 해제:** 이 주문의 `CONFIRMING` hold를 `RELEASED(ADMIN_RESOLVED)`. 좌석 판매 상태(`session_seats`)는 건드리지 않는다.
3. **쿼터 반환:** `purchase_quotas.counted_seats -= 해제 좌석 수`.
4. **active-order lock 해제:** 주문 `REVIEW_REQUIRED → UNFULFILLED`. 활성 주문 partial unique 대상에서 빠지므로 같은 주체가 같은 회차에 새 주문을 만들 수 있다.
5. 로그·감사·outbox, `EXCESS` 결제에 대한 `PAYMENT_EXCESS` 환불 요청 또는 `review_cases(EXCESS_PAYMENT)` 유지.

넷 중 하나라도 실패하면 전체 롤백한다. 이후 초과 결제 환불이 완료되면 주문 `UNFULFILLED → REFUNDED`. PG 재조회로 승인이 없었음이 확정되면(`EXCESS` 결제 없음) 1~4단계 후 주문은 `EXPIRED`로 둔다.

### 11.9 Google Sheets 동기화

- DB 트랜잭션 안에서 outbox 이벤트만 생성(P0), worker가 비동기 전송(P1).
- Phase 1은 읽기 전용 mirror를 권장한다[권장 Q-014]. 주문·결제·좌석 상태를 Sheets 값으로 갱신하지 않는다.

### 11.10 주문 접근 권한

| 작업 | 허용 자격 |
|---|---|
| 주문 상세 조회, 결제 상태 조회 | 주문 주체와 같은 subject의 `BOOKING`/`LOOKUP` 세션(바인딩 일치), 또는 해당 주문의 `order_access_sessions`(바인딩 일치) |
| 예매 확인서 조회 | 위와 같음 |
| 취소, 이메일 변경, 결제 시작 | 주문 주체와 같은 subject의 유효 `BOOKING` 세션(바인딩 일치) |
| 주문 목록 조회 | `BOOKING` 또는 `LOOKUP` 세션의 subject 주문만 |

`order_access_sessions`는 주문 생성 시 발급하며, 같은 Idempotency 재요청에서는 같은 소유 주체(§5.8)일 때만 재발급한다. 주문번호만으로는 어떤 접근도 허용하지 않는다.

### 11.11 판매 가능 조건

주문 생성 시 모두 만족해야 한다: 공연 `PUBLISHED`, `sales_opens_at <= now < sales_closes_at`(NULL은 제한 없음), 회차 `ON_SALE`, 회차 `starts_at > now`(판매 마감 시점 정책은 미정 — 기본 시작 시각). 결제 시작 시에도 회차 `ON_SALE`과 시작 전 여부를 재확인한다. 이미 `PAYMENT_CONFIRMING`에 들어간 주문은 판매 상태 변경과 무관하게 확정 절차를 완료한다.

### 11.12 고객 정보 변경 [채택 A-017]

- 이름·전화번호는 본인인증 결과로만 설정하며 사용자가 변경할 수 없다.
- 이메일은 주문 `PENDING`이고 진행 중 확인 결제가 없을 때만 변경할 수 있다.
- `PAYMENT_CONFIRMING`/`PAYMENT_UNKNOWN`/`REVIEW_REQUIRED` 중에는 주문의 어떤 사용자 변경도 허용하지 않는다.

---

## 12. 상태 전이표

### 12.1 주문

| 현재 | 이벤트 | 다음 | 주체 | 부수 효과 |
|---|---|---|---|---|
| (없음) | 주문 생성 성공 | `PENDING` | API | hold ACTIVE, 한도 +n |
| `PENDING` | 사용자 취소 | `CANCELED` | API | hold RELEASED, READY 결제 CANCELED, 한도 −n |
| `PENDING` | `hold_expires_at` 경과 | `EXPIRED` | 만료 작업/사전 정리 | hold EXPIRED, READY 결제 CANCELED, 한도 −n |
| `PENDING` | Tx1 성공 | `PAYMENT_CONFIRMING` | RETURN/API | hold CONFIRMING, 결제 CONFIRMING |
| `PAYMENT_CONFIRMING` | 승인 확인 | `PAID` | RETURN/WEBHOOK/PG_REQUERY | 좌석 SOLD, hold CONVERTED, 티켓 |
| `PAYMENT_CONFIRMING` | 실패 확정, 점유 남음 | `PENDING` | 위와 같음 | hold ACTIVE, 결제 FAILED |
| `PAYMENT_CONFIRMING` | 실패 확정, 점유 만료 | `EXPIRED` | 위와 같음 | hold EXPIRED, 결제 FAILED, 한도 −n |
| `PAYMENT_CONFIRMING` | 3분 경과, 결과 없음 | `PAYMENT_UNKNOWN` | 재조회 작업 | 결제 UNKNOWN, hold CONFIRMING 유지 |
| `PAYMENT_CONFIRMING`/`PAYMENT_UNKNOWN` | 승인 + 금액 불일치/허용 외 수단/발권 불가 | `REVIEW_REQUIRED` | 위와 같음 | 결제 EXCESS, review case |
| `PAYMENT_UNKNOWN` | 승인 확인 | `PAID` | PG_REQUERY/WEBHOOK/ADMIN | 판매 확정 |
| `PAYMENT_UNKNOWN` | 실패 확정 | `PENDING` 또는 `EXPIRED` | 위와 같음 | 점유 만료 여부에 따름 |
| `REVIEW_REQUIRED` | 관리자 `FULFILL_AFTER_VERIFICATION`(승인 금액 일치 재확인, 좌석 CONFIRMING 유지 시) | `PAID` | ADMIN | 판매 확정 |
| `REVIEW_REQUIRED` | 관리자 `RELEASE_SEATS`(모든 결제 종료 상태, 승인 결제는 모두 EXCESS) | `UNFULFILLED` | ADMIN | hold RELEASED, 한도 −n, 활성 주문 해제(한 트랜잭션, §11.8) |
| `REVIEW_REQUIRED` | 관리자 `RELEASE_SEATS`, PG 재조회로 승인 없음 확정(EXCESS 결제 없음) | `EXPIRED` | ADMIN/PG_REQUERY | hold RELEASED, 한도 −n |
| `UNFULFILLED` | 모든 EXCESS 결제 환불 완료 | `REFUNDED` | ADMIN | — |
| `PAID` | 일부 좌석 환불 완료 | `PAID` | ADMIN | 티켓 VOID, 좌석 해제, 한도 −k |
| `PAID` | 전 좌석·초과 결제 환불 완료 | `REFUNDED` | ADMIN | — |

정의되지 않은 전이는 거부한다(409 `INVALID_STATE_TRANSITION`). `EXPIRED`/`CANCELED`/`UNFULFILLED` 주문은 `PAID`가 될 수 없다. 이런 주문에 대한 승인이 확인되면(A-001 전제 위반) 결제는 `EXCESS`로 분류하고 새 review case를 연다.

### 12.2 결제

| 현재 | 다음 | 조건 |
|---|---|---|
| (없음) | `READY` | 결제 시작(주문 PENDING, 진행 중 결제 없음 또는 기존 READY를 같은 트랜잭션에서 CANCELED) |
| `READY` | `CONFIRMING` | Tx1 |
| `READY` | `CANCELED` | 새 시도로 대체, 주문 취소·만료, `checkout_expires_at` 경과, Tx1 검증 실패 |
| `READY` | `FAILED` | 복귀 금액 불일치 등 명백한 위변조 |
| `CONFIRMING` | `SUCCEEDED` | 승인 확인(`role` 지정) |
| `CONFIRMING` | `FAILED` | 실패 확정 |
| `CONFIRMING` | `UNKNOWN` | 3분 경과 |
| `UNKNOWN` | `SUCCEEDED` / `FAILED` | 재조회·관리자 증빙 처리 |
| `FAILED`/`CANCELED` | `SUCCEEDED`(`role = EXCESS`) | 이후 PG에서 승인 사실이 발견된 예외 — review case |

### 12.3 hold

`ACTIVE → CONFIRMING`(Tx1), `ACTIVE → EXPIRED`(expireOrder), `ACTIVE → RELEASED`(취소), `CONFIRMING → CONVERTED`(판매 확정), `CONFIRMING → ACTIVE`(실패 확정, 점유 남음), `CONFIRMING → EXPIRED`(실패 확정, 점유 만료), `CONFIRMING → RELEASED`(관리자 해결). 종료 상태(`CONVERTED`, `RELEASED`, `EXPIRED`)에서는 전이하지 않는다.

### 12.4 환불

`REQUESTED → VERIFYING → COMPLETED | FAILED`, `REQUESTED → WITHDRAWN`, `FAILED → VERIFYING`(운영자가 PG 재실행 후 재검증). `COMPLETED`는 종료 상태.

---

## 13. 트랜잭션 및 동시성 요구사항

### 13.1 트랜잭션 필수 작업

주문 생성(한도·점유), 취소, 만료(`expireOrder`), 결제 시작, Tx1/Tx2/Tx3, 판매 확정·티켓 발급, 관리자 좌석 차단·해제, 환불 요청·완료, 관리자 복구 action, 인증 claim(세션 발급 + 인증 CONSUMED), 상태 로그·감사 로그·outbox 생성.

### 13.2 전역 잠금 순서 [채택 A-020]

모든 트랜잭션은 필요한 행을 아래 순서로만 잠근다(필요 없는 단계는 건너뛸 수 있으나 역순 금지):

1. `purchase_quotas` (주체·회차) — 주문 상태·한도를 바꾸는 트랜잭션은 **반드시 먼저** 잠근다
2. `orders`
3. `payments`
4. `refunds`
5. `session_seats` (`id` 오름차순)
6. `seat_holds`
7. `tickets`

규칙:
- **격리 수준:** `purchase_quotas`를 잠그는 모든 트랜잭션(주문 생성, 취소, `expireOrder`, Tx2/Tx3의 해제 경로, `RELEASE_SEATS`, 환불 완료)은 **READ COMMITTED**로 실행한다 [채택 A-029]. REPEATABLE READ 이상에서는 `ON CONFLICT`·`FOR UPDATE`가 동시 갱신 행에서 serialization 오류를 내므로 사용하지 않는다(정합성은 유지되나 요청이 실패한다). 구현 시 DB 기본값에 의존하지 않고 트랜잭션 시작 시 격리 수준을 명시한다.
- **잠금 후 판단:** 상태·카운터 판정은 잠금 획득 이후 실행한 statement 결과로만 한다(§11.2).
- 한 트랜잭션은 한 주문만 상태 변경한다. 다른 주문의 hold 회수는 `expireOrder` 별도 트랜잭션으로 한다.
- 관리자 차단은 `session_seats`만 잠그며 다른 주문의 hold를 바꾸지 않는다.
- PostgreSQL deadlock 감지로 트랜잭션이 중단되면 정합성은 보존되며, 서비스는 제한 횟수 내 재시도한다(TEST SEAT-11).
- PG·인증사 호출은 트랜잭션 밖에서 한다. 트랜잭션은 짧게 유지하고 interactive transaction timeout을 명시 설정한다.

### 13.3 최종 방어 제약 요약

| 위험 | DB 최종 방어 |
|---|---|
| 같은 좌석 동시 점유 | `seat_holds` partial unique `(session_seat_id) WHERE status IN ('ACTIVE','CONFIRMING')` |
| 동일인 한도 초과 | `purchase_quotas` CHECK + 행 잠금 |
| 동일 회차 활성 주문 중복 | `orders` partial unique |
| 진행 중 결제 중복 | `payments` partial unique |
| 주문당 확정 결제 중복 | `orders.confirmed_payment_id` UNIQUE + 복합 FK |
| 중복 판매·중복 티켓 | `session_seats.sold_order_item_id` UNIQUE + CHECK, `tickets` 유효 partial unique, `tickets.order_item_id` UNIQUE |
| 초과 환불 | `payments.refunded_amount` CHECK |
| 소속 불일치 | §5~§8 복합 FK |
| 인증 재사용 | `identity_verifications (provider, provider_transaction_id)` UNIQUE, `identity_sessions.identity_verification_id` UNIQUE |

PostgreSQL 실제 환경에서 동시성 테스트를 수행한다. SQLite로 대체하지 않는다.

---

## 14. 인덱스 및 무결성 요약

| 테이블 | 제약 / 인덱스 |
|---|---|
| `shows` | `UNIQUE (slug)`, `UNIQUE (id, venue_id)` |
| `show_sessions` | 복합 FK `(show_id, venue_id)`, `UNIQUE (id, venue_id)`, `(show_id, starts_at)`, CHECK `max_seats_per_identity` |
| `seats` | `UNIQUE (venue_id, svg_seat_id)`, `UNIQUE NULLS NOT DISTINCT (venue_id, section_name, row_label, seat_number)`, `UNIQUE (id, venue_id)` |
| `session_seats` | `UNIQUE (show_session_id, seat_id)`, `UNIQUE (id, show_session_id)`, 복합 FK 3개, `UNIQUE (sold_order_item_id)`, CHECK SOLD↔소유, `(show_session_id, status)` |
| `identity_subjects` | `UNIQUE (subject_key_type, key_version, subject_key_hash)` |
| `identity_verifications` | `UNIQUE (provider, provider_transaction_id)`, CHECK, `(browser_binding_hash, created_at)`, `(status, expires_at)` |
| `identity_sessions` | `UNIQUE (token_hash)`, `UNIQUE (identity_verification_id)`, `UNIQUE (id, identity_subject_id)`, `(identity_subject_id, status)` |
| `orders` | `UNIQUE (order_number)`, `UNIQUE (confirmed_payment_id)`, `UNIQUE (id, show_session_id)`, 활성 주문 partial unique, 복합 FK 2개, CHECK 2개, `(status, hold_expires_at)`, `(status, confirm_protected_until)` |
| `order_items` | `UNIQUE (order_id, session_seat_id)`, 복합 FK 대상 unique 3개, 복합 FK 2개 |
| `seat_holds` | `UNIQUE (order_item_id)`, 좌석 partial unique, 복합 FK, `(order_id, status)` |
| `purchase_quotas` | PK `(identity_subject_id, show_session_id)`, CHECK `counted_seats` |
| `order_access_sessions` | `UNIQUE (token_hash)`, `(order_id, status)` |
| `idempotency_records` | `UNIQUE (scope, owner_key_hash, idempotency_key_hash)`, `(expires_at)` |
| `payments` | `UNIQUE (merchant_payment_ref)`, nullable unique 2개, `UNIQUE (id, order_id)`, 진행 중 partial unique, CHECK 4개, `(status, next_requery_at)` |
| `payment_webhook_events` | `UNIQUE (provider, deduplication_key)`, `(status, received_at)` |
| `refunds` | 복합 FK, `UNIQUE (id, order_id)`, `UNIQUE (provider, provider_refund_id)`, `(status, updated_at)` |
| `refund_items` | 복합 FK 2개, `UNIQUE (refund_id, order_item_id)`, `(order_item_id)` |
| `tickets` | `UNIQUE (ticket_number)`, `UNIQUE (order_item_id)`, 유효 티켓 partial unique, 복합 FK |
| `admin_sessions` | `UNIQUE (token_hash)`, `(admin_id, status)` |
| `admin_audit_logs` | `(admin_id, created_at)`, `(target_type, target_id)` |
| `review_cases` | open partial unique `(case_type, dedupe_key)` |
| `outbox_events` | `(status, next_retry_at)`, `(aggregate_type, aggregate_id, aggregate_version)` |

FK 삭제 정책: 주문·결제·환불·티켓·인증·로그는 `ON DELETE RESTRICT`(cascade delete 금지). 복합 FK의 참조 대상 컬럼은 `ON UPDATE RESTRICT`.

### 14.1 Prisma 및 migration 전략 [채택 A-019 / H8]

- **Prisma schema**: 테이블, 컬럼 타입(`@db.Timestamptz`, `@db.Inet`, `BigInt`), 단순 FK, 단순 unique.
- **raw SQL migration**: partial unique, CHECK, `NULLS NOT DISTINCT`, Prisma relation으로 표현하기 어려운 복합 FK(예: nullable 컬럼이 섞인 복합 FK, 순환 FK), 필요 시 UPDATE 차단 트리거.
- Prisma가 schema에 없는 DB 객체를 drift로 보고 이후 migration에서 DROP하거나 누락할 수 있으므로, **생성된 migration SQL을 매번 검토**하고 raw SQL 객체를 제거하는 문장이 없는지 확인한다. 사용하는 Prisma 버전의 partial index 등 지원 여부는 도입 시점에 공식 문서로 확인하고, 지원되더라도 계약 테스트는 유지한다.
- **스키마 계약 테스트(CI 필수)**: 빈 PostgreSQL에 `migrate deploy` 후 `pg_indexes`/`pg_constraint`를 조회해 §13.3·§14의 필수 제약이 모두 존재하는지 검사한다(TEST MIG-*).
- 공유 환경(staging/production)에서는 `migrate deploy`만 사용하고 `db push`를 금지한다.
- 행 잠금(`FOR UPDATE`, `SKIP LOCKED`)은 Prisma Client API로 표현되지 않으므로 parameterized raw query로 작성한다. 문자열 연결 SQL 금지.
- unique 위반(PostgreSQL 23505 / Prisma P2002)은 제약 이름별로 도메인 오류(409 `SEAT_UNAVAILABLE`, `ACTIVE_ORDER_EXISTS` 등)로 변환한다. CHECK 위반(23514)도 제약 이름별로 변환한다.
- 서버리스 커넥션 풀러(트랜잭션 모드)와 interactive transaction·row lock의 호환성, prepared statement 설정을 호스팅 확정 후 검증한다[외부 확인 E-007].
- 격리 수준(READ COMMITTED)은 트랜잭션 시작 시 명시한다(§13.2).

### 14.2 Provider 실행 단계를 저장하지 않는 근거 [채택 A-025]

Mock/Sandbox/Live 단계를 결제·인증 레코드에 컬럼으로 저장하지 않는다.
- 환경(local/test/staging/production)마다 DB와 자격증명이 분리되어 있다.
- 서버 시작 단계 검사(ARCHITECTURE §6.5)가 production에서 Live 외 단계를 기동 실패로 막는다. 따라서 운영 DB의 레코드는 모두 Live라는 사실이 기동 조건으로 보장되며, 레코드별 단계 컬럼은 새 정보를 주지 않는다.
- 기존 `payments.provider`, `identity_verifications.provider` 값(`TOSS`/`NICE`/`MOCK`)으로 운영 DB에 Mock 레코드가 생겼는지 정합성 검사에서 탐지한다(TEST PRV-06).
- 남는 위험: 운영 DB에 staging 데이터를 복원하는 운영 실수. 이는 백업·복구 권한 통제와 복구 절차(운영 매뉴얼)로 다룬다.

---

## 15. 개인정보 및 보안

- 수집: 본인인증 결과의 이름·전화번호, 동일인 식별값(HMAC만), 선택 이메일. 동행자 정보 미수집.
- 동일인 식별값(DI/CI 등) 원문 미저장. 사용 가능 여부·저장 방식·고지는 별도 검토 항목이다[Q-002, E-006].
- 이름·전화번호는 애플리케이션 레벨 암호화 권장[Q-016]. 주문 조회는 인증 주체 기준이므로 전화번호 검색 인덱스를 두지 않는다.
- 인증·접근·관리자 세션 토큰, 바인딩 값, nonce, Idempotency-Key, QR 토큰은 hash만 저장한다.
- **고정 비밀값은 DB에 저장하지 않는다**: 토스 시크릿·보안 키, NICE client_id/secret, HMAC 키, 암호화 키는 서버 Secret 관리 체계에만 둔다. DB에는 거래별 임시 문맥(`provider_context_encrypted`)만 암호화 저장한다(§6.2) [채택 A-028].
- 카드번호·CVC 등 결제정보 미저장.
- 로그·webhook payload·감사 로그·outbox payload·Sheets에 원문 전화번호·토큰·인증 원문을 남기지 않는다(전화번호는 마스킹).
- 관리자 비밀번호는 강한 password hash. SUPER_ADMIN MFA 권장[Q-015].
- 주문번호만으로 주문 접근 불가(§11.10).
- 개인정보 보관·파기 기간과 처리방침은 법령·계약 검토 후 확정하며, **공개 전 개인정보처리방침 게시가 필요**하다[E-006].

---

## 16. 미결정 사항

상세 권장안·근거는 `DECISIONS.md` §3, §4.

| 항목 | 참조 |
|---|---|
| 인증 세션 30분의 NICE 측 제약(30분 고정 자체는 확정 D-015) | Q-001, E-001 |
| 동일인 식별값(DI/CI/전화번호) — NICE 결과에 DI·CI 존재(원문), 제공 조건 미확인 | Q-002, E-001, E-006 |
| UNKNOWN 재조회 주기·경보 기준 | Q-003 |
| ~~활성 주문 상태 범위~~ → 확정 D-014 | — |
| NICE 토큰 캐시·rate limit 저장소 | Q-013, A-028 |
| NICE 등록용 고정 Outbound IP | Q-020, E-007 |
| 토스 IN_PROGRESS·EXPIRED 조회 응답, easyPay 코드, 결제수단 노출 제어 | E-002, Q-021 |
| 3분 무응답 복구 절차·증빙 기반 수동 처리 | Q-005 |
| 결제 시작 최소 잔여 점유 시간 | Q-011 |
| 환불 좌석 재판매(AVAILABLE/BLOCKED) | Q-012 |
| 세션 TTL·rate limit 수치·저장소 | Q-013 |
| Sheets 역반영 | Q-014 |
| 관리자 MFA | Q-015 |
| 개인정보 암호화·보관기간 | Q-016, E-006 |
| 공연장·SVG, 가격·수수료, 환불 규정 (PG·인증사는 D-009로 확정) | E-003~E-005 |

---

## 17. 구현 전 데이터 모델 검토 게이트

v1.0 게이트 항목의 처리 결과:

| v1.0 게이트 | v1.1 처리 |
|---|---|
| `seat_holds.order_id`와 `order_items.order_id` 소속 일치 | 복합 FK `(order_item_id, order_id, session_seat_id)` (§5.3) |
| `session_seats`가 회차 공연장 좌석인지 | `venue_id` 비정규화 + 복합 FK (§4.3, §4.5) |
| 한 주문의 모든 항목이 같은 회차 | `orders.show_session_id` + 복합 FK (§5.1, §5.2) |
| `order_items` 갱신과 hold 이력 정합성 | 좌석 변경 제거로 `order_items` 불변, hold 1:1 (§5.2, §5.3) |
| 좌석 변경 실패 시 rollback | 해당 없음(좌석 변경 제거). 취소 후 재예매(§11.5) |
| 정상 승인 1건과 중복 승인 보존 | `confirmed_payment_id` + `role` (§5.1, §7.1) |
| 환불 누적액 잠금, PG 환불 후 DB 기록 실패 복구 | 결제 행 잠금 + CHECK, `VERIFYING` 재검증, 대사 (§7.4, §11.8) |
| 접근 세션 재발급 CSRF/fixation | 바인딩 + 소유 주체 Idempotency (§5.6, §5.8, §6.3) |
| partial unique/CHECK/복합 제약 migration | §14.1 전략 + 계약 테스트 |

v1.2 처리: Q-004는 D-014로 확정(§5.1 partial unique 조건 확정, `UNFULFILLED` 추가), E-002의 서버 승인형 전제는 토스 원문으로 확인(§11.6 유지, confirm timeout·재시도 규칙 보강). 남은 확인은 sandbox 항목(PROVIDERS §1.10, §2.5)이며 스키마 구조에는 영향이 없다.

---

## 18. 버전 변경 이력

| 버전 | 일자 | 변경 내용 |
|---|---|---|
| 0.1 | — | 초기 16개 테이블과 기본 예매·결제 모델 |
| 0.2 | — | 접근 세션, 본인인증, 멱등성, Webhook 및 결제 상태 추적 구조 추가 |
| 0.3 | — | 통합 구조 재작성. 좌석 변경 모델, 상태 분리, 접근 세션 재발급, 전화번호 인증 순서, 결제 금액 원장, 환불 무결성, Outbox 재시도, 21개 테이블 |
| 1.0 | 2026-11-13 | 개발 전달 기준안(0.3 내용 기준, 문서 상태 표기만 1.0). 원문: `docs/archive/v1.0/DATABASE.md` |
| 1.1 | 2026-11-14 | v1.0 독립 기술 검토(B1~B5, H1~H9, M1~M12) 및 사용자 확정 정책(D-001~D-008) 반영. 인증 선행 구조(`identity_subjects`/`identity_sessions`, `identity_verifications.order_id` 제거), 동일인·회차 4석 한도(`purchase_quotas`), 활성 주문 partial unique, 좌석 변경 제거(`order_items` 불변, hold 1:1), 주문 단위 7분 만료, 결제 확인 펜싱(`CONFIRMING`)과 3분 보호·UNKNOWN 해소, 확정 결제 FK와 `EXCESS` 결제, 판매 좌석 소유권, 환불 유형·검증 절차·결제별 누적 CHECK, webhook 재처리, 소유 주체 Idempotency, 관리자 세션, review case, 상태 전이표, 전역 잠금 순서, Prisma/raw SQL 전략. 테이블 21 → 27개 |
| 1.2 | 2026-11-15 | 토스페이먼츠·NICE아이디 확정(D-009~D-013) 및 원문 확인 반영. 주문 상태 `UNFULFILLED` 추가와 `RELEASE_SEATS` 원자 전이(결제 결과 확정 확인·좌석 해제·쿼터 반환·활성 주문 해제, D-014). `purchase_quotas` READ COMMITTED·잠금 후 판단·`seat_limit` snapshot·동시 실행 순서(A-029). BOOKING 세션 고정 30분·재사용·주문 생성 제한·잔여 10분(D-015). `identity_verifications.provider_context_encrypted`(거래별 임시 문맥만, A-028). `payments.card_company`, `easy_pay_provider` 허용 값, 토스 필드 대응표, 결제수단 허용 목록 검증(A-030). 웹훅 서명·eventId dedupe·10초 응답·비동기 조회(A-027). confirm timeout과 3분 보호 관계(A-031). Provider 단계 미저장 근거(§14.2). 테이블 수 변동 없음(27개). 이전 원문: `docs/archive/v1.1/DATABASE.md` |
