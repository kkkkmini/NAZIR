# NAZIR — API SPECIFICATION

> 버전 1.0 · Base path `/api/v1` · REST + JSON  
> 상태: 개발 전달 기준안. PG/본인인증 provider 세부 규격은 업체 선정 후 확정한다.

## 1. 공통 원칙
- 서버가 가격, 좌석 상태, 주문 상태, 결제 결과의 최종 권한을 가진다.
- 금액은 정수 KRW, 시간은 ISO 8601. 저장/비교는 UTC, 화면은 `Asia/Seoul`.
- JSON 요청/응답을 기본으로 한다.
- 주문 생성·결제 생성은 `Idempotency-Key` 필수.
- 주문번호만으로 주문 접근을 허용하지 않는다.
- 민감정보·토큰·PG 원문 payload를 오류/로그에 노출하지 않는다.

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
| 401 | 인증 필요/실패 |
| 403 | 권한 없음 |
| 404 | 리소스 없음 |
| 409 | 좌석 경합, 상태 충돌, idempotency key 본문 불일치 |
| 422 | 업무 규칙상 처리 불가 |
| 429 | 요청 제한 초과 |
| 500 | 서버 오류 |
| 502/503 | 외부 서비스 장애 |

목록 응답은 `{ "items": [], "pagination": { "page": 1, "limit": 20, "total": 0 } }` 구조를 기본으로 한다.

## 3. 인증 모델
### 관객
- 주문 생성 성공 시 서버가 암호학적 난수 접근 토큰을 발급하고 HttpOnly·Secure·적절한 SameSite 쿠키로 설정한다.
- DB에는 토큰 hash만 저장한다.
- 주문 상세·좌석 변경·고객 정보·결제 API는 활성 주문 접근 세션을 검증한다.
- 휴대폰 본인인증 조회는 성공 후 별도의 짧은 수명 조회 세션을 발급한다.
- 주문번호는 식별자일 뿐 인증 수단이 아니다.

### 관리자
- 이메일/비밀번호 로그인, 서버 측 세션, HttpOnly·Secure 쿠키.
- 매 요청 권한 확인, 로그인 rate limit, 로그아웃 시 세션 폐기.

## 4. 관객 API

| Method | Endpoint | 설명 |
|---|---|---|
| GET | `/shows` | 공개 공연 목록 |
| GET | `/shows/{showId}` | 공연 상세 |
| GET | `/shows/{showId}/sessions` | 회차 목록 |
| GET | `/sessions/{sessionId}/seats` | 좌석/계산된 판매 상태 |
| POST | `/orders` | 좌석 전체 원자적 점유 및 주문 생성 |
| PATCH | `/orders/{orderId}/seats` | 좌석 변경 |
| POST | `/orders/{orderId}/customer` | 예매자 정보 저장 |
| POST | `/identity-verifications` | 본인인증 시작 |
| POST | `/identity-verifications/{id}/confirm` | 인증 결과 서버 검증 |
| POST | `/orders/{orderId}/payments` | PG 결제 시도 생성 |
| GET | `/orders/{orderId}/payments/{paymentId}` | 결제 상태 조회 |
| POST | `/payments/webhook` | PG Webhook 수신 |
| POST | `/orders/lookup-verifications` | 조회용 본인인증 시작 |
| POST | `/orders/lookup-verifications/{id}/confirm` | 조회 인증 검증 및 조회 세션 발급 |
| GET | `/orders/lookup` | 인증된 번호의 주문 목록 |
| GET | `/orders/{orderId}/confirmation` | 모바일 예매 확인서 |

### 4.1 주문 생성

`POST /orders` — `Idempotency-Key` 필수.

```json
{
  "sessionId": "uuid",
  "seatIds": ["session-seat-uuid-1", "session-seat-uuid-2"]
}
```

서버는 좌석 전체를 DB 트랜잭션으로 검증·점유하고 주문/항목/hold/접근 세션을 생성한다. 한 좌석이라도 실패하면 전체 rollback. 점유 만료는 서버 기준 7분이다.

동일 key와 동일 본문 재요청은 기존 주문을 반환하며 접근 쿠키를 재발급한다. 동일 key와 다른 본문은 `409 IDEMPOTENCY_KEY_REUSED`.

### 4.2 좌석 변경

`PATCH /orders/{orderId}/seats`

```json
{ "sessionSeatIds": ["session-seat-uuid"] }
```

활성 접근 세션 필요. 새 좌석 집합을 원자적으로 확보할 수 있을 때만 변경한다. 실패하면 기존 점유를 유지한다. 기존 hold는 `RELEASED`, 새 hold는 `ACTIVE`. 최초 hold의 만료시각은 연장하지 않는다.

### 4.3 예매자 정보/본인인증
`POST /orders/{orderId}/customer` 예시:

```json
{ "name": "홍길동", "phone": "01012345678", "email": "optional@example.com" }
```

전화번호는 인증 전 `pending_customer_phone`에 저장하고, 인증사 서버 검증 성공 및 요청 번호 일치 확인 후 `customer_phone`으로 확정한다. 브라우저가 전달한 성공 플래그만으로 인증을 완료하지 않는다.

### 4.4 결제
`POST /orders/{orderId}/payments` — `Idempotency-Key` 필수.

```json
{ "returnUrl": "https://example.com/booking/return" }
```

서버는 DB 주문 금액으로 PG 요청을 만든다. 클라이언트 금액을 받거나 신뢰하지 않는다. 결제 UNKNOWN이면 PG 거래 조회 전 새 결제를 차단한다. 브라우저 복귀는 결제 확정 근거가 아니다.

### 4.5 Webhook
- PG signature/authentication 검증 필수.
- 이벤트를 중복 수신 안전하게 저장한다.
- 필요 시 PG API로 거래를 재조회한다.
- 중복·지연·순서 역전 이벤트에 idempotent해야 한다.
- 실제 서명, path, 응답 코드, 재시도 규칙은 PG 선정 후 확정한다.

### 4.6 예매 조회
`GET /orders/lookup`은 조회용 본인인증 세션을 반드시 요구한다. 전화번호 입력 또는 주문번호만으로 조회할 수 없다.

## 5. 관리자 API

| Method | Endpoint | 설명 |
|---|---|---|
| POST | `/admin/auth/login` | 로그인 |
| POST | `/admin/auth/logout` | 로그아웃 |
| GET | `/admin/orders` | 주문 검색/목록 |
| GET | `/admin/orders/{id}` | 주문 상세 |
| GET | `/admin/sessions/{id}/seats` | 회차 좌석 현황 |
| POST | `/admin/session-seats/{id}/block` | 좌석 차단 |
| POST | `/admin/session-seats/{id}/unblock` | 차단 해제 |
| GET | `/admin/payments` | 결제 목록 |
| GET | `/admin/payments/{id}` | 결제 상세/PG 거래 |
| GET | `/admin/refunds` | 환불 목록 |
| POST | `/admin/orders/{id}/refund-records` | 수동 환불 결과 기록 요청 |
| GET | `/admin/orders/review-required` | 운영자 확인 필요 주문 |
| POST | `/admin/orders/{id}/resolve` | 허용된 복구 작업 |

모든 관리자 API는 서버 측 세션과 권한을 검증하고 감사 로그를 남긴다. 수동 환불 결과는 가능한 경우 PG API로 재검증한다. 검증 불가 상태를 완료로 표시하지 않는다.

## 6. Idempotency 규칙
- scope별 key unique.
- 동일 key + 동일 request hash: 기존 결과 반환.
- 동일 key + 다른 hash: 409.
- 동시 요청은 한 요청만 처리.
- 주문 생성 응답 유실 후 재요청 시 기존 주문을 새로 만들지 않고 접근 쿠키를 재발급.
- key 만료와 별개로 결제 원장은 보존.

## 7. 보안 및 운영
- 쿠키 기반 API CSRF 방어, HTTPS, CORS allowlist.
- 인증/로그인/주문 조회/주문 생성/결제 rate limit.
- PG Webhook signature와 replay/deduplication 검증.
- 모든 금액은 서버 계산.
- PG/인증사 통신은 timeout 및 provider adapter를 통해 격리.
- API schema와 OpenAPI 또는 동등한 타입 계약을 유지.

## 8. 미결정 사항
PG checkout/승인/조회/취소 규격, 간편결제 지원 범위, 본인인증 callback, 부분 취소, 조회 세션 TTL, rate limit 수치, 구매 좌석 수 제한, 할인/쿠폰 범위는 계약/정책 확정 후 결정한다.

## 9. 완료 기준
각 endpoint는 request/response schema, 인증 조건, 오류 코드, idempotency, 로그/감사 정책, 테스트를 갖춰야 한다. DB 문서와 상태값/필드 의미가 다르면 구현 전에 문서를 수정한다.
