# NAZIR — API SPECIFICATION

> 문서 버전: 1.2 · 기준일: 2026-11-15 · Base path `/api/v1` · REST + JSON
> 상태: 개발 전달 기준안. PG는 토스페이먼츠(결제창 API 개별 연동), 본인인증은 NICE아이디(통합인증)로 확정(D-009, D-010). 업체 고유 파라미터는 adapter 내부에서만 다루며, 원문 미확인 항목은 `PROVIDERS.md`에 표시한다.
> 관련 문서: `DATABASE.md`(테이블·상태·트랜잭션 정본), `DECISIONS.md`(정책·미결정), `PROVIDERS.md`(업체 근거), `ARCHITECTURE.md`, `TEST_PLAN.md`
> 이전 버전 원문: `docs/archive/v1.0/API_SPEC.md`, `docs/archive/v1.1/API_SPEC.md`

표기: **[확정]** 사용자 확정 정책 · **[채택]** 설계 채택안(승인 대기) · **[권장]** 미결정 항목 기본값 · **[외부 확인]**

## 1. 공통 원칙

- 서버가 가격, 좌석 상태, 주문 상태, 결제 결과, 인증 결과의 최종 권한을 가진다.
- 금액은 정수 KRW(JSON number, 서버가 BigInt를 명시 변환), 시간은 ISO 8601(UTC). 화면은 `Asia/Seoul`.
- 주문 생성·결제 시작은 `Idempotency-Key` 필수(128bit 이상 난수, 예: UUID v4).
- 주문번호만으로 주문 접근을 허용하지 않는다.
- 민감정보·토큰·PG/인증사 원문 payload를 응답·오류·로그에 노출하지 않는다.
- 상태값·필드 의미는 `DATABASE.md`가 정본이다. 다르면 구현 전에 문서를 수정한다.

**예매 흐름** [확정 D-004]: 본인인증 → 인증 세션 발급 → 공연·회차 선택 → 좌석 선택 → 점유·주문 생성 → 결제 → PG 승인 검증 → 티켓 발급

## 2. 공통 오류

```json
{
  "error": {
    "code": "SEAT_UNAVAILABLE",
    "message": "선택한 좌석 중 예약할 수 없는 좌석이 있습니다.",
    "details": {}
  }
}
```

| HTTP | 의미 |
|---|---|
| 400 | 요청 형식/값 오류 |
| 401 | 인증 세션 없음/만료/바인딩 불일치 |
| 403 | 권한 없음(다른 주체의 주문, 용도 외 세션 사용) |
| 404 | 리소스 없음(권한 없는 리소스도 존재 여부를 숨길 때 404 사용 가능) |
| 409 | 좌석 경합, 상태 충돌, 활성 주문 존재, idempotency 충돌 |
| 422 | 업무 규칙상 처리 불가(한도 초과, 판매 기간 외 등) |
| 429 | 요청 제한 초과 |
| 500 | 서버 오류 |
| 502/503 | 외부 서비스 장애 |

### 2.1 오류 코드 카탈로그

| 코드 | HTTP | 상황 |
|---|---|---|
| `VALIDATION_FAILED` | 400 | 형식 오류 |
| `IDEMPOTENCY_KEY_INVALID` | 400 | 키 누락·형식 위반 |
| `IDENTITY_SESSION_REQUIRED` | 401 | 인증 세션 없음·만료 |
| `BROWSER_BINDING_MISMATCH` | 401 | 세션과 브라우저 바인딩 불일치 |
| `CSRF_REJECTED` | 403 | Origin/CSRF 토큰 검증 실패 |
| `SESSION_PURPOSE_MISMATCH` | 403 | LOOKUP 세션으로 예매 시도 등 |
| `ORDER_ACCESS_DENIED` | 403/404 | 다른 주체의 주문 |
| `SEAT_UNAVAILABLE` | 409 | 좌석이 판매·차단·유효 점유 중 |
| `ACTIVE_ORDER_EXISTS` | 409 | 같은 회차에 활성 주문 존재 [확정 D-008] |
| `PAYMENT_IN_PROGRESS` | 409 | 결제 확인 중(CONFIRMING/UNKNOWN)이라 변경·취소·새 결제 불가 |
| `INVALID_STATE_TRANSITION` | 409 | 허용되지 않은 상태 전이 |
| `IDEMPOTENCY_KEY_REUSED` | 409 | 같은 키, 다른 본문 |
| `REQUEST_IN_PROGRESS` | 409 | 같은 키 요청 처리 중 |
| `PURCHASE_LIMIT_EXCEEDED` | 422 | 동일인·회차 4석 초과 [확정 D-006] |
| `SALES_NOT_OPEN` | 422 | 판매 기간 외, 회차 판매 중지·종료 |
| `HOLD_EXPIRED` | 422 | 점유 만료 |
| `HOLD_TIME_INSUFFICIENT` | 422 | 결제 시작 최소 잔여 시간 미달 [권장 Q-011] |
| `PAYMENT_METHOD_NOT_ALLOWED` | 422 | 허용 외 결제수단(가상계좌 등) [확정 D-005] |
| `IDENTITY_VERIFICATION_FAILED` | 422 | 인증 실패·만료·재사용 |
| `IDENTITY_SESSION_TIME_INSUFFICIENT` | 422 | 주문 생성 시 인증 세션 잔여 10분 미만 [확정 D-015] |
| `ORDER_CREATION_LIMITED` | 429 | 세션당·주체/회차 시간당 주문 생성 횟수 초과 [확정 D-015] |
| `PAYMENT_METHOD_UNAVAILABLE` | 422 | 현재 활성화되지 않은 결제수단·카드사(심사 미완료 등) [확정 D-012] |
| `RATE_LIMITED` | 429 | 요청 제한 |
| `PROVIDER_UNAVAILABLE` | 503 | PG/인증사 장애 |

목록 응답: `{ "items": [], "pagination": { "page": 1, "limit": 20, "total": 0 } }`.

## 3. 인증·쿠키 모델

### 3.1 쿠키

| 쿠키 | 용도 | 속성 |
|---|---|---|
| `__Host-nz_bind` | 브라우저 바인딩(익명, 첫 방문 시 발급) | HttpOnly, Secure, SameSite=Lax, Path=/ |
| `__Host-nz_idv` | 인증 세션(BOOKING/LOOKUP) | HttpOnly, Secure, SameSite=Lax, Path=/ |
| `__Host-nz_oa_{orderId 일부}` | 주문 확인서 접근 세션(주문별) | HttpOnly, Secure, SameSite=Lax, Path=/ |
| `__Host-nz_admin` | 관리자 세션 | HttpOnly, Secure, SameSite=Strict, Path=/ |

- DB에는 모든 토큰·바인딩 값의 hash만 저장한다.
- `__Host-` 접두사로 하위 도메인 쿠키 주입(session fixation)을 차단한다.
- 관객 쿠키를 SameSite=Lax로 두는 이유: PG·인증사에서 돌아오는 **최상위 GET 이동**에는 Lax 쿠키가 전송된다. cross-site **POST** 복귀에는 전송되지 않으므로 복귀 엔드포인트는 쿠키에 의존하지 않는다(§3.4). [채택 A-018]
- 주문별 접근 쿠키를 써서 한 브라우저의 여러 주문이 서로 덮어쓰지 않게 한다(쿠키 개수 상한은 구현 시 정리 정책으로 관리).

### 3.2 관객 인증 세션 [확정 D-004 / 채택 A-008, A-009]

- 좌석 선택 전 본인인증이 필수다. 인증 결과는 서버가 인증사에 재조회·검증하고, **같은 브라우저(바인딩 일치)에서의 1회 claim**으로만 인증 세션이 발급된다.
- `BOOKING` 세션: 발급 후 **고정 30분**, 활동에 따른 연장(sliding) 없음 [확정 D-015]. 주문 생성·취소·결제·조회 가능. 같은 브라우저에서는 유효기간 안에 재인증 없이 취소 후 재예매할 수 있다. 주문 생성은 잔여 10분 이상일 때만, 세션당·주체/회차 시간당 횟수 제한 내에서만 허용한다(DATABASE §6.3). NICE 측 결과 유지 제약은 미확인(Q-001).
- `LOOKUP` 세션: 권장 10분, 조회 전용.
- 모든 관객 API는 요청의 `__Host-nz_idv` hash와 `__Host-nz_bind` hash가 DB 세션과 모두 일치해야 한다. 다른 브라우저로 복사된 세션은 401 `BROWSER_BINDING_MISMATCH`.
- 세션이 만료돼도 진행 중 주문은 인증 주체에 귀속된다. 같은 사람이 재인증하면 같은 주문을 이어갈 수 있다.

### 3.3 CSRF

- 쿠키 인증을 쓰는 모든 상태 변경 API(POST/PATCH/DELETE)는 (1) `Origin`이 허용 출처인지(없으면 `Sec-Fetch-Site: same-origin`) 확인하고, (2) `X-CSRF-Token` 헤더를 검증한다. CSRF 토큰은 바인딩 쿠키에 묶인 값으로 `GET /bootstrap`에서 받는다.
- 예외: PG Webhook(서버 간, §4.9), PG·인증사 복귀 엔드포인트(쿠키 미사용, 단일 사용 거래 상태로 검증, §3.4).

### 3.4 외부 복귀 경로 [채택 A-018 / H9]

- `returnUrl`은 **서버가 결정**한다. 클라이언트는 복귀 주소를 보내지 않는다(open redirect 방지).
- 복귀 엔드포인트(`/payments/return/*`, `/identity-verifications/callback/*`)는 GET/POST를 모두 받을 수 있고, 쿠키 대신 **업체가 전달한 거래 식별자(토스 `orderId`, NICE `web_transaction_id`)와 그 거래의 단일 사용 상태**를 검증한 뒤 provider를 서버 측에서 재조회한다(nonce는 보존이 확인될 때 추가 검증, 아래 참조).
- 처리 후 **303 See Other**로 같은 출처 결과 페이지로 이동한다. 그 페이지에서부터 Lax 쿠키로 세션을 확인한다.

**업체별 복귀 형식(원문, PROVIDERS)**:

| 경로 | 업체가 붙이는 값 | 메서드 | 서버 검증 |
|---|---|---|---|
| 토스 successUrl | `paymentKey`, `orderId`, `amount`(항상) | 리다이렉트(GET) | `orderId`=`merchant_payment_ref`로 결제 시도를 찾고 단일 사용 여부·`amount` 대조 후 Tx1 |
| 토스 failUrl | 에러 코드·메시지 | 리다이렉트(GET) | 결제 시도를 `FAILED`/`CANCELED`로, 주문은 점유 남으면 `PENDING` 유지 |
| NICE return_url | `web_transaction_id` | GET(기본) 또는 POST(`method_type`) | 저장한 `request_no`·`transaction_id`와 함께 결과 요청 API 호출 → 복호화·무결성 검증 |

- 서버가 successUrl·return_url에 직접 붙인 query(nonce)가 업체 리다이렉트 후에도 보존되는지는 **미확인**이다. 따라서 결제 복귀의 단일 사용 검증은 128bit 이상 난수로 만든 `merchant_payment_ref`(토스 `orderId`, 6~64자 규칙 준수)와 결제 시도 상태로 수행하고, nonce 보존이 sandbox에서 확인되면 추가 검증으로 쓴다. NICE 복귀는 `web_transaction_id`가 저장된 거래와 맞는지 결과 요청으로 확인한다.

### 3.5 관리자

- 이메일/비밀번호 로그인, 서버 측 세션(`admin_sessions`), 로그인 성공 시 새 토큰 발급, 로그아웃·비활성화 시 세션 폐기.
- SUPER_ADMIN MFA 권장[Q-015]. 매 요청 권한 확인. 로그인 rate limit.

## 4. 관객 API

### 4.0 엔드포인트 목록

| Method | Endpoint | 인증 | 설명 |
|---|---|---|---|
| GET | `/bootstrap` | — | 바인딩 쿠키 발급(없을 때), CSRF 토큰 반환 |
| POST | `/identity-verifications` | 바인딩 | 본인인증 시작(`purpose`) |
| GET/POST | `/identity-verifications/callback/{provider}` | 단일 사용 검증 | 인증사 콜백(쿠키 미사용) → 303 |
| POST | `/identity-verifications/{id}/claim` | 바인딩 | 인증 결과를 세션으로 교환(1회) |
| GET | `/identity-session` | 세션 | 현재 세션 정보(purpose, 만료) |
| DELETE | `/identity-session` | 세션 | 세션 종료 |
| GET | `/shows` | — | 공개 공연 목록 |
| GET | `/shows/{showId}` | — | 공연 상세 |
| GET | `/shows/{showId}/sessions` | — | 회차 목록 |
| GET | `/sessions/{sessionId}/seats` | — | 좌석·계산된 판매 상태 |
| GET | `/sessions/{sessionId}/my-quota` | BOOKING | 남은 구매 가능 수, 활성 주문 |
| GET | `/payment-methods` | — | 현재 활성화된 결제수단·카드사 목록(서버 설정 기준) [확정 D-012] |
| POST | `/orders` | BOOKING | 좌석 전체 원자적 점유 및 주문 생성 |
| GET | `/orders/{orderId}` | 주문 접근 | 주문 상세 |
| POST | `/orders/{orderId}/cancel` | BOOKING | 결제 전 주문 취소(재예매용) |
| PATCH | `/orders/{orderId}/customer` | BOOKING | 이메일 변경 |
| POST | `/orders/{orderId}/payments` | BOOKING | 결제 시도 생성 |
| GET/POST | `/payments/return/{provider}` | 단일 사용 검증 | PG 복귀 → 승인 확인 → 303 |
| GET | `/orders/{orderId}/payments/{paymentId}` | 주문 접근 | 결제 상태 조회 |
| POST | `/payments/webhook/{provider}` | PG 검증 | Webhook 수신 |
| GET | `/orders` | BOOKING/LOOKUP | 인증 주체의 주문 목록 |
| GET | `/orders/{orderId}/confirmation` | 주문 접근 | 모바일 예매 확인서 |

**제거된 API(v1.0 대비):** `PATCH /orders/{orderId}/seats`(좌석 변경 — [확정 D-001]), `POST /orders/{orderId}/customer`(→ `PATCH …/customer`, 이메일만), `POST /orders/lookup-verifications*`(→ `/identity-verifications` `purpose=LOOKUP`), `GET /orders/lookup`(→ `GET /orders`).

"주문 접근" = 주문 주체와 같은 subject의 BOOKING/LOOKUP 세션 또는 해당 주문의 접근 세션, 모두 바인딩 일치(DATABASE §11.10).

### 4.1 Bootstrap

`GET /bootstrap` → `{ "csrfToken": "…" }`. 바인딩 쿠키가 없으면 새로 발급한다. 캐시 금지.

**구현(Step 4, 2026-11-24, A-044)** — `src/server/identity/bootstrap.ts`, `src/server/lib/{secrets,cookies,csrf}.ts`, `src/server/lib/crypto/hmac.ts`. DB 접근 없음.
- 유효한 `__Host-nz_bind`(43자 base64url)가 있으면 재사용하고 `Set-Cookie`를 보내지 않는다(30일 수명 연장 없음). 없음·형식 오류·중복이면 새 값 발급.
- 응답 `Cache-Control: no-store`. 보안 설정(`NAZIR_APP_ORIGIN`, `NAZIR_CSRF_KEYS`/`_KEY_CURRENT`)이 없거나 잘못되면 500 `INTERNAL_ERROR`, 쿠키·토큰 없음.
- 토큰 형식 `v<N>.<base64url 43자>`. 상태 변경 API는 `assertCsrf`(Origin 정확 일치 + `Sec-Fetch-Site` + 토큰)를 호출한다.

### 4.2 본인인증 및 인증 세션

**시작:** `POST /identity-verifications`

```json
{ "purpose": "BOOKING" }
```

응답: `{ "verificationId": "uuid", "launch": { … } }` — `launch`는 인증창을 여는 데 필요한 값(NICE: 인증 URL). 서버는 바인딩 hash와 단일 사용 nonce를 기록한다. Rate limit 대상(IP·바인딩).

서버 처리(NICE 통합인증, 원문 PROVIDERS §2.2): adapter가 공유 토큰 캐시의 접근토큰(24시간 유효)으로 `POST /ido/intc/v1.0/auth/url`을 호출한다(`request_no` 20~50자, `return_url` = 서버 결정 콜백 URL, `svc_types: ["M"]`). 응답의 `transaction_id`·인증 URL은 10분 유효하며, `request_no`·`transaction_id`·토큰 참조 ID만 `provider_context_encrypted`에 저장한다(DATABASE §6.2).

**콜백:** `GET|POST /identity-verifications/callback/{provider}` — 쿠키 미사용. NICE는 `web_transaction_id`를 전달한다(기본 GET). 서버는 저장된 문맥으로 `POST /ido/intc/v1.0/auth/result`를 호출하고, 응답을 adapter 내부에서 복호화·무결성 검증한다. 성공 시 정규화 결과(이름·휴대폰 번호·동일인 식별값 HMAC)로 `VERIFIED`(subject 결정, `claim_expires_at` 설정), 실패·검증 불일치 시 `FAILED` → 303 `/identity/complete?vid={id}`. 결과 요청 가능 기한·재조회 가능 여부·토큰 동일성 요건은 **미확인**이다.

생년월일·성별 등 정책상 필요 없는 결과 항목은 adapter에서 폐기하고 도메인·DB·로그로 전달하지 않는다.

**Claim:** `POST /identity-verifications/{id}/claim` (CSRF 필수)
- 조건: 바인딩 hash 일치, 상태 `VERIFIED`, `claim_expires_at` 이전.
- 동작(한 트랜잭션): 인증 `CONSUMED`, 같은 바인딩·purpose의 기존 세션 `REVOKED`, 새 `identity_sessions` 발급(새 토큰), 쿠키 설정.
- 응답: `{ "purpose": "BOOKING", "expiresAt": "…", "displayName": "홍*동" }`.
- 실패: 다른 브라우저(바인딩 불일치) 401, 재사용(`CONSUMED`) 422 `IDENTITY_VERIFICATION_FAILED`.

### 4.3 공연·회차·좌석 조회

- 공개 API. `GET /sessions/{id}/seats`는 DATABASE §11.1 우선순위로 `AVAILABLE`/`HELD`/`SOLD`/`BLOCKED`를 계산한다. 개별 점유 주체 정보는 노출하지 않는다.
- `GET /sessions/{id}/my-quota` → `{ "seatLimit": 4, "countedSeats": 2, "remaining": 2, "activeOrderId": "uuid|null" }`.
- IP 기반 rate limit 및 짧은 캐시를 허용한다(좌석 상태는 최종 판단 근거가 아님).

**구현(Step 3, 2026-11-22)** — `src/server/catalog/`(서비스 `public-catalog.ts`, HTTP `http.ts`), 경로 `src/app/api/v1/…`:

| 엔드포인트 | 응답 | 오류 |
|---|---|---|
| `GET /shows` | `{ items: ShowSummary[], pagination }` | — |
| `GET /shows/{showId}` | `ShowDetail` = `ShowSummary` + `sessions: Session[]` + `priceTable: {section, price}[]` | 400 `VALIDATION_FAILED`(UUID 아님), 404 `NOT_FOUND`(없음·비공개) |
| `GET /shows/{showId}/sessions` | `{ items: Session[], pagination }` | 400, 404 |
| `GET /sessions/{sessionId}/seats` | `{ show, session: Session, seatMap: {version, assetUrl}, seats: Seat[] }` | 400, 404 |

- `ShowSummary` = `id, slug, title, description, posterUrl, venue{name,address,timezone}, salesOpensAt, salesClosesAt, priceRange{min,max}|null`
- `Session` = `id, startsAt, endsAt, status, sellable, maxSeatsPerIdentity, seats{available,held,sold,blocked,total}` — `status`는 `sales-status.ts`가 §11.11과 §11.1 좌석 집계로 계산한다(`ON_SALE`·`TEMPORARILY_UNAVAILABLE`·`SOLD_OUT`·`UPCOMING`·`PAUSED`·`CLOSED`·`CANCELED`). `sellable`은 `status = ON_SALE`일 때만 참이다.
- `Seat` = `id`(session_seats.id), `key`(seats.svg_seat_id, 배치도 매핑 키), `section, row, number, label, price, status`(§11.1: `AVAILABLE`/`HELD`/`SOLD`/`BLOCKED`).
- 공개 대상은 `PUBLISHED` 공연뿐이다(`CLOSED` 노출은 미결정 Q-030, 임시로 숨김). 주문·hold·결제·인증 식별자와 `sold_order_item_id`는 응답에 없다(허용 목록, CAT-API-05).
- 시각은 DB 기준(DbClock), 한 요청 안에서 같은 `now`로 좌석과 회차 상태를 함께 계산한다. 금액은 정수 KRW(number).
- `Cache-Control: no-store`, rate limit 미구현 — 수치·저장소 미정(Q-013, Q-031).

### 4.4 주문 생성

`POST /orders` — BOOKING 세션, CSRF, `Idempotency-Key` 필수.

```json
{
  "sessionId": "show-session-uuid",
  "sessionSeatIds": ["session-seat-uuid-1", "session-seat-uuid-2"]
}
```

서버 처리(DATABASE §11.2):
- 인증 세션 잔여 10분 미만이면 422 `IDENTITY_SESSION_TIME_INSUFFICIENT`, 주문 생성 횟수 제한 초과면 429 `ORDER_CREATION_LIMITED` [확정 D-015].
- 판매 가능 조건(DATABASE §11.11) 검증, 좌석 수 1 ≤ n ≤ 회차 `max_seats_per_identity`(최대 4).
- 동일 인증 주체·회차의 `purchase_quotas` 행 잠금으로 동시 요청을 직렬화하고, 활성 주문 존재 시 409 `ACTIVE_ORDER_EXISTS`(`details.activeOrderId`), 한도 초과 시 422 `PURCHASE_LIMIT_EXCEEDED`(`details.remaining`).
- 좌석 전체를 원자적으로 점유. 하나라도 실패하면 전체 롤백, 409 `SEAT_UNAVAILABLE`(`details.unavailableSeatIds`).
- 점유 만료는 서버 기준 7분 [확정 D-002].
- 주문 확인서 접근 쿠키 발급.

응답 201:

```json
{
  "orderId": "uuid",
  "orderNumber": "NZ-202611-000001",
  "status": "PENDING",
  "holdExpiresAt": "2026-11-30T10:07:00Z",
  "items": [{ "sessionSeatId": "uuid", "seatLabel": "A열 1번", "price": 70000 }],
  "totalAmount": 140000
}
```

**Idempotency** [채택 A-010 / B5]: 레코드는 (인증 주체 + 브라우저 바인딩) 소유다.
- 같은 소유 주체 + 같은 키 + 같은 본문: 기존 응답 재반환 + 접근 쿠키 재설정. 새 주문 없음.
- 같은 소유 주체 + 같은 키 + 다른 본문: 409 `IDEMPOTENCY_KEY_REUSED`.
- **다른 소유 주체의 같은 키는 별개 요청**으로 처리된다. 다른 사람의 주문·쿠키를 받을 수 없다.
- 처리 중 재요청: 409 `REQUEST_IN_PROGRESS`.

### 4.5 주문 취소(재예매) [확정 D-001]

`POST /orders/{orderId}/cancel` — BOOKING 세션, CSRF.
- 조건: 주문 `PENDING`(결제 확인 진입 전). `READY` 결제는 함께 폐기.
- 결과: 주문 `CANCELED`, hold `RELEASED`, 구매 한도 복구. 이후 새 좌석으로 `POST /orders`.
- `PAYMENT_CONFIRMING`/`PAYMENT_UNKNOWN`/`REVIEW_REQUIRED`: 409 `PAYMENT_IN_PROGRESS`.
- 이미 `CANCELED`/`EXPIRED`: 멱등 성공(현재 상태 반환).

### 4.6 결제 시작

`POST /orders/{orderId}/payments` — BOOKING 세션, CSRF, `Idempotency-Key` 필수.

```json
{ "methodType": "CARD" }
```
또는
```json
{ "methodType": "EASY_PAY", "easyPayProvider": "TOSSPAY" }
```

- `methodType`: `CARD` 또는 `EASY_PAY`. Phase 1 `easyPayProvider`는 `TOSSPAY`, `NAVERPAY`(NAZIR 내부 값) [확정 D-011]. 카카오페이는 추후 검토(Q-017), 페이코·가상계좌 등 그 외 수단은 422 `PAYMENT_METHOD_NOT_ALLOWED` [확정 D-005, D-011].
- **활성화된 수단만 허용** [확정 D-012]: 서버 설정상 비활성(심사 미완료 등) 수단은 422 `PAYMENT_METHOD_UNAVAILABLE`. 관객 화면은 `GET /payment-methods` 결과만 노출한다.
  ```json
  { "methods": [ { "methodType": "CARD", "cardCompanies": ["…승인 완료 카드사…"] }, { "methodType": "EASY_PAY", "easyPayProvider": "TOSSPAY" } ] }
  ```
- **토스 결제창 파라미터 대응(adapter 내부, 원문 PROVIDERS §1.5):** 카드는 `method: "CARD"` + `flowMode: "DEFAULT"` + 활성 카드사만 `cardCompany`로 지정(통합결제창에 지정 카드사만 표시). 간편결제는 `method: "CARD"` + `flowMode: "DIRECT"` + `easyPay` 코드(코드 문자열 **미확인**). 통합결제창에서 간편결제 노출을 숨길 수 있는지는 **미확인**(Q-021)이므로, 승인 응답의 수단·카드사·간편결제사를 허용 목록으로 다시 검증해 벗어나면 자동 확정하지 않는다(A-030).
- 금액은 서버가 `orders.total_amount`로 결정한다. 클라이언트 금액·`returnUrl`을 받지 않는다.
- 조건: 주문 `PENDING`, 판매 상태 재확인, 남은 점유 시간 ≥ 최소 기준(권장 60초, Q-011) — 미달 시 422 `HOLD_TIME_INSUFFICIENT`.
- 기존 `READY` 결제가 있으면 같은 트랜잭션에서 `CANCELED` 후 새 `READY` 생성(서버 confirm 전이므로 결제 미발생 — A-001). `CONFIRMING`/`UNKNOWN` 결제가 있으면 409 `PAYMENT_IN_PROGRESS`.
- 응답: `{ "paymentId": "uuid", "checkout": { … provider 파라미터 … }, "checkoutExpiresAt": "…" }`. 결제창 유효기한은 점유 만료를 넘지 않는다.
- Idempotency scope는 실제 `orderId`를 포함한다(`POST /orders/{실제 ID}/payments`).

### 4.7 PG 복귀 및 승인 확인 [확정 D-003 / 채택 A-001~A-003]

`GET /payments/return/toss/success?paymentKey=…&orderId=…&amount=…` · `GET /payments/return/toss/fail?code=…&message=…&orderId=…` — 쿠키 미사용(토스가 붙이는 파라미터는 원문 PROVIDERS §1.2; failUrl의 정확한 파라미터 이름은 sandbox 확인).

서버 처리(DATABASE §11.6):
1. `orderId`(= `merchant_payment_ref`)로 결제 시도 조회, 상태가 `READY`인지(단일 사용), `amount` = `requested_amount` = 주문 금액인지, **hold 유효성(`now < hold_expires_at`)** 확인.
2. 실패 시 confirm을 호출하지 않는다(결제 미발생 — 토스는 인증 후 10분 내 승인하지 않으면 만료). 점유 만료면 주문 `EXPIRED`.
3. 성공 시 펜싱 커밋(hold `CONFIRMING`, 주문 `PAYMENT_CONFIRMING`, 보호 3분) → **트랜잭션 밖에서** `POST /v1/payments/confirm`(결제 시도별 고정 `Idempotency-Key`, timeout 초기 60초) → 결과 반영. 불명확하면 3분 보호 안에서 orderId 조회·같은 멱등 키 재시도(DATABASE §11.6 A-031).
4. 303 `/booking/orders/{orderId}/result`. 결과 페이지는 §4.8을 polling한다.
5. 요청 처리 시간 제한이 confirm 대기를 수용하지 못하면, 복귀 처리는 Tx1 커밋 후 즉시 303하고 confirm은 작업으로 실행한다(E-007).

응답 의미:
- 3분 안에 승인 확인 → `PAID`.
- 실패 확정 → 점유가 남았으면 `PENDING`(재시도 가능), 아니면 `EXPIRED`.
- 결과 불명확 → `PAYMENT_CONFIRMING` 유지, 3분 경과 시 `PAYMENT_UNKNOWN`. **좌석은 계속 보호되며 재판매되지 않는다.** 사용자에게 "결제 결과 확인 중" 안내, 재결제 불가.

브라우저 복귀 파라미터는 결제 확정의 근거가 아니다. 확정은 서버의 PG confirm 응답 또는 PG 재조회 결과로만 한다.

### 4.8 결제 상태 조회

`GET /orders/{orderId}/payments/{paymentId}` — 주문 접근 자격.

```json
{
  "paymentId": "uuid",
  "status": "UNKNOWN",
  "orderStatus": "PAYMENT_UNKNOWN",
  "message": "결제 결과를 확인하고 있습니다. 좌석은 보호되고 있습니다."
}
```

`CONFIRMING`/`UNKNOWN`이면 서버가 PG 재조회를 트리거할 수 있다(결제당 최소 간격 적용, rate limit). 응답에 PG 원문을 포함하지 않는다.

### 4.9 Webhook [채택 A-016, A-027 / H4]

`POST /payments/webhook/toss`

**웹훅은 결제 성공의 직접 증거가 아니다.** 최종 상태는 서버의 결제 조회 결과로만 결정한다.

수신 엔드포인트(동기, 10초 이내 응답 — 원문: 10초 내 200 미응답 시 최대 7회 재전송):
1. 원본 본문과 헤더를 보존한 채 `tosspayments-webhook-signature`를 보안 키로 검증(`{payload}:{transmission-time}` HMAC SHA-256, `v1:` 서명 여러 개 중 하나 일치). 헤더가 있고 불일치면 400 응답, 상태 변경 없음. 헤더가 없으면 `signature_verified = false`로 기록하고 계속(조회 교차 확인이 기본 방어선 — 원문).
2. dedupe 키(본문 `eventId`, 없으면 adapter 조합 키 — `transmission-id` 사용 금지)로 `payment_webhook_events`에 저장. 이미 `PROCESSED`/`IGNORED`면 그대로 200.
3. **200 응답.** 이 단계에서 결제·주문 상태를 바꾸지 않는다.

비동기 처리(작업):
4. `paymentKey` 또는 `orderId`로 결제 조회 API 호출 → `orderId`·금액·상태·MID 대조 → DATABASE §11.6 Tx2 규칙으로 반영.
5. 실패·중단 이벤트는 재처리(lease, 횟수 초과 시 review case).

- 이벤트 범위: `PAYMENT_STATUS_CHANGED`(카드·간편결제). `CANCEL_STATUS_CHANGED`는 해외 비동기 간편결제 전용이라 Phase 1 대상 아님(원문). 국내 결제의 취소 시 `PAYMENT_STATUS_CHANGED` 발송 여부는 **미확인** → 환불 대사는 일일 PG 대사를 기본으로 한다(DATABASE §11.8).
- 구매자가 결제창을 닫으면 웹훅이 오지 않는다(원문) → READY 정리는 작업이 담당.
- 중복·지연·순서 역전에 멱등.

### 4.10 주문 목록·확인서

- `GET /orders` — BOOKING 또는 LOOKUP 세션의 인증 주체 주문만 반환. 전화번호 입력·주문번호만으로는 조회할 수 없다.
- `GET /orders/{orderId}/confirmation` — 주문 접근 자격. `PAID` 주문만 확인서를 반환(그 외 상태는 상태 안내). Phase 1은 QR 미노출.

### 4.11 고객 정보

`PATCH /orders/{orderId}/customer` — BOOKING 세션, CSRF.

```json
{ "email": "optional@example.com" }
```

- 이름·전화번호는 본인인증 결과로만 설정되며 변경할 수 없다.
- 주문 `PENDING`이고 진행 중 확인 결제가 없을 때만 허용 [채택 A-017]. 그 외 409 `PAYMENT_IN_PROGRESS`.

## 5. 관리자 API

### 5.1 권한 매트릭스 [권장 Q-015]

| 작업 | STAFF | SUPER_ADMIN |
|---|---|---|
| 주문·결제·환불·좌석·review case 조회 | O | O |
| 좌석 차단/해제 | O | O |
| PG 재조회 실행 | O | O |
| 환불 요청 기록, PG 실행 기록, 재검증 | O | O |
| 환불 요청 철회 | O | O |
| review case 일반 action | O | O |
| 증빙 기반 결제 결과 수동 확정(`*_WITH_EVIDENCE`) | X | O |
| 관리자 계정 관리 | X | O |
| Outbox DEAD 재시도 | O | O |

모든 관리자 API는 서버 측 세션·권한을 검증하고, 변경 API는 같은 트랜잭션에서 감사 로그를 남긴다(P0). 전화번호는 기본 마스킹하며 원문 열람은 별도 권한·감사 대상으로 둔다.

### 5.2 엔드포인트

| Method | Endpoint | 설명 |
|---|---|---|
| POST | `/admin/auth/login` | 로그인(rate limit) |
| POST | `/admin/auth/logout` | 로그아웃(세션 폐기) |
| GET | `/admin/me` | 현재 관리자 |
| GET | `/admin/orders` | 주문 검색/목록 |
| GET | `/admin/orders/{id}` | 주문 상세(항목·hold·결제·환불·티켓·로그) |
| GET | `/admin/sessions/{id}/seats` | 회차 좌석 현황 |
| POST | `/admin/session-seats/{id}/block` | 좌석 차단(AVAILABLE + 유효 hold 없음) |
| POST | `/admin/session-seats/{id}/unblock` | 차단 해제 |
| GET | `/admin/payments` | 결제 목록(상태·role 필터) |
| GET | `/admin/payments/{id}` | 결제 상세 |
| POST | `/admin/payments/{id}/requery` | PG 재조회 실행 |
| GET | `/admin/refunds` | 환불 목록 |
| POST | `/admin/orders/{id}/refunds` | 환불 요청 기록(REQUESTED) |
| POST | `/admin/refunds/{id}/pg-executed` | PG 관리자 페이지 실행 기록 → VERIFYING + 검증 |
| POST | `/admin/refunds/{id}/verify` | 재검증 |
| POST | `/admin/refunds/{id}/withdraw` | PG 실행 전 요청 철회 |
| GET | `/admin/review-cases` | 운영자 확인 사안 목록 |
| GET | `/admin/review-cases/{id}` | 상세 |
| POST | `/admin/review-cases/{id}/actions` | 허용된 해결 action |
| GET | `/admin/outbox?status=DEAD` | 실패 이벤트 |
| POST | `/admin/outbox/{id}/retry` | 재시도 |

v1.0의 `/admin/orders/review-required`, `/admin/orders/{id}/resolve`, `/admin/orders/{id}/refund-records`는 review case·환불 API로 대체했다.

### 5.3 환불 [확정 D-007 / 채택 A-014, A-015]

**요청 기록:** `POST /admin/orders/{id}/refunds`

```json
{
  "paymentId": "uuid",
  "refundType": "SEAT",
  "items": [{ "orderItemId": "uuid", "amount": 70000 }],
  "reason": "고객 요청"
}
```

- `SEAT`: `PRIMARY` 결제, 항목 1개 이상, 합계 = 총액, 항목당 1회.
- `PAYMENT_EXCESS`: `EXCESS` 결제, `items` 없음, `amount` 필드로 금액 지정.
- 결제별 `완료 누적 + 진행 중 + 신규 ≤ 승인 금액`. 위반 시 422.
- 결과 `REQUESTED`. 티켓·좌석·한도는 그대로.

**PG 실행 기록:** `POST /admin/refunds/{id}/pg-executed` `{ "providerRefundId": "…" }`(선택) → `VERIFYING` → 서버가 PG 재조회:
- 토스: 결제 조회 응답의 `cancels[]`(각 `transactionKey`·금액·상태)를 읽는다(원문). 상점관리자 화면에 취소 거래 키가 보이는지는 **미확인**이므로 `providerRefundId`는 선택 입력이다. 입력이 없으면 서버가 아직 다른 환불에 연결되지 않은 취소 거래 중 금액이 일치하는 후보를 보여주고, 운영자가 선택해 확정한다.
- 성공 확인: `COMPLETED`. `SEAT`이면 티켓 VOID, 소유 확인 후 좌석 해제, 한도 복구(한 트랜잭션).
- 환불 없음/실패: `FAILED`. 티켓·좌석 유지.
- 조회 불가: `VERIFYING` 유지, 재검증 대상.

운영자가 입력한 사실만으로 완료하지 않는다. 검증 불가 상태를 완료로 표시하지 않는다.

### 5.4 Review case action

`POST /admin/review-cases/{id}/actions` `{ "action": "REQUERY", "note": "…", "evidence": "…" }`

| action | 대상 case | 효과 | 권한 |
|---|---|---|---|
| `REQUERY` | 결제·환불 관련 | PG 재조회 후 규칙대로 반영 | STAFF+ |
| `FULFILL_AFTER_VERIFICATION` | `AMOUNT_MISMATCH` 등 | PG 재조회로 승인 금액 = 주문 금액, 허용 수단, 좌석 CONFIRMING 유지 확인 시 판매 확정 | SUPER_ADMIN |
| `RELEASE_SEATS` | `REVIEW_REQUIRED` 주문 | 모든 결제가 종료 상태이고 승인 결제가 모두 EXCESS일 때만: 한 트랜잭션에서 hold RELEASED, 한도 복구, 주문 `UNFULFILLED`(활성 주문 해제). 결제 미해결이면 409 `PAYMENT_IN_PROGRESS`. 좌석 판매 상태 불변 [확정 D-014] | STAFF+ |
| `CREATE_EXCESS_REFUND_REQUEST` | `EXCESS_PAYMENT` 등 | `PAYMENT_EXCESS` 환불 요청 생성 | STAFF+ |
| `RESOLVE_AS_FAILED_WITH_EVIDENCE` | `PAYMENT_UNKNOWN_PROLONGED` | PG 조회 장애 지속 시 PG 관리자 페이지 증빙으로 실패 확정 | SUPER_ADMIN [Q-005 미결정] |
| `RESOLVE_AS_APPROVED_WITH_EVIDENCE` | `PAYMENT_UNKNOWN_PROLONGED` | 증빙으로 승인 확정 후 판매 확정 | SUPER_ADMIN [Q-005 미결정] |
| `LINK_UNRECORDED_REFUND` | `REFUND_UNRECORDED` | PG에서 발견된 환불을 요청으로 사후 기록 후 검증 | STAFF+ |
| `ACKNOWLEDGE` | 정보성 case | 조치 없음 종료(사유 필수) | STAFF+ |

모든 action은 감사 로그와 사유를 남긴다. 열거되지 않은 수동 수정은 제공하지 않으며 DB 직접 수정은 금지한다.

## 6. Idempotency 규칙

- 레코드 고유성: `(scope, 소유 주체, 키 hash)`. scope는 실제 경로 값을 포함한다.
- 동일 소유 주체 + 동일 키 + 동일 request hash: 기존 결과 반환.
- 동일 소유 주체 + 동일 키 + 다른 hash: 409 `IDEMPOTENCY_KEY_REUSED`.
- 동시 요청: 한 요청만 처리(같은 트랜잭션의 unique 삽입으로 직렬화), 나머지는 결과 재반환 또는 409 `REQUEST_IN_PROGRESS`.
- 주문 생성 응답 유실 후 재요청: 같은 소유 주체일 때만 기존 주문 반환 + 접근 쿠키 재설정.
- 키는 원문 저장·로그 금지(hash만).
- 키 만료와 무관하게 결제 원장은 보존한다.

## 7. 보안 및 운영

- 쿠키 기반 API CSRF 방어(§3.3), HTTPS, CORS allowlist(관객·관리자 출처만).
- Rate limit [권장 Q-013, 수치 미정]: 인증 시작(IP·바인딩), claim, 주문 생성·취소 반복(인증 주체·회차), **BOOKING 세션당 주문 생성 횟수·주체/회차 시간당 주문 생성 횟수(D-015, 권장 3회 / 시간당 5회)**, 결제 시작, 결제 상태 조회 재조회 트리거, 관리자 로그인, 좌석 조회(IP). 저장소는 공유 저장소(PostgreSQL 또는 Redis)이며 서버리스 메모리 기반 금지. NICE 인증은 건당 과금되므로(원문) 인증 시작 rate limit은 비용 통제 수단이기도 하다.
- 좌석 점유 남용 방지 [H6]: 인증 선행(D-004) + 동일인·회차 4석(D-006) + 활성 주문 1건(D-008) + 취소·재생성 반복 rate limit.
- PG Webhook 서명 검증(보안 키), eventId dedupe, 10초 내 응답, 비동기 조회 기반 처리(§4.9).
- 운영 환경에서는 Mock provider가 기동되지 않으며(ARCHITECTURE §6.5), Mock 제어 엔드포인트는 local·test에만 존재한다. **Mock 인증을 실제 판매에 사용하지 않는다** [확정 D-013].
- 토스 시크릿·보안 키, NICE client_id/secret은 서버 Secret 관리 체계에만 두며 클라이언트 번들·응답·로그에 노출하지 않는다(토스 클라이언트 키만 브라우저 사용).
- 모든 금액은 서버 계산.
- PG/인증사 통신은 timeout 및 provider adapter로 격리.
- API schema는 OpenAPI 또는 동등한 타입 계약(zod 등)으로 유지한다.

## 8. 미결정 사항

`DECISIONS.md` 참조: NICE 측 세션 유지 제약(Q-001), 동일인 식별값 제공 조건(Q-002), UNKNOWN 재조회·경보(Q-003), 증빙 기반 수동 처리(Q-005), 결제 시작 최소 잔여 시간(Q-011), 환불 좌석 재판매(Q-012), rate limit 수치·저장소(Q-013), 관리자 MFA(Q-015), 카카오페이(Q-017), 판매 개시 최소 결제수단 기준(Q-018), 스테이징 NICE 실인증(Q-019), NICE Outbound IP(Q-020), 통합결제창 간편결제 노출(Q-021), 토스·NICE 미확인 항목(E-001, E-002, `PROVIDERS.md`), 할인·수수료(E-004), 환불 규정(E-005). 활성 주문 범위(Q-004)는 D-014로 확정.

## 9. 완료 기준

각 endpoint는 request/response schema, 인증 조건(세션 purpose·바인딩·CSRF), 오류 코드(§2.1), idempotency, 로그/감사 정책, 테스트(`TEST_PLAN.md` ID)를 갖춰야 한다. `DATABASE.md`와 상태값·필드 의미가 다르면 구현 전에 문서를 수정한다.

## 10. 변경 이력

| 버전 | 일자 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-11-13 | 개발 전달 기준안. 원문: `docs/archive/v1.0/API_SPEC.md` |
| 1.1 | 2026-11-14 | 인증 선행 흐름과 인증 세션·브라우저 바인딩·claim API, 쿠키 모델, CSRF, 외부 복귀 경로(서버 결정 returnUrl, 303), 좌석 변경 API 제거 및 주문 취소 API 추가, 주문 생성의 한도·활성 주문 오류, 결제 시작(수단 제한, 최소 잔여 시간), PG 복귀·펜싱·3분 보호·UNKNOWN 응답, webhook 재조회 기반 처리, 소유 주체 Idempotency, 관리자 권한 매트릭스·환불 3단계 API·review case action, 오류 코드 카탈로그 추가. lookup-verification API를 purpose로 통합 |
| 1.2 | 2026-11-15 | 토스페이먼츠(결제창 API 개별 연동)·NICE아이디(통합인증) 확정 반영. 업체별 복귀 형식 표(§3.4), NICE 인증 URL·결과 요청 흐름(§4.2), 인증 세션 고정 30분·잔여 10분·주문 생성 제한과 오류 코드(§3.2, §4.4), `GET /payment-methods`와 활성 수단만 허용·토스 결제창 파라미터 대응(§4.6, D-011, D-012), 토스 success/fail 복귀와 confirm 멱등·재시도(§4.7), 웹훅 서명·eventId·10초 응답·비동기 조회(§4.9), 환불 `providerRefundId` 선택 입력과 취소 후보 제시(§5.3), `RELEASE_SEATS` → `UNFULFILLED`(§5.4), Mock 판매 금지·Secret 노출 금지(§7). 이전 원문: `docs/archive/v1.1/API_SPEC.md` |
| 1.2.1 | 2026-11-22 | §4.3 Step 3 구현 기록(응답 형식·오류·캐시). 기존 명세는 변경 없음 |
