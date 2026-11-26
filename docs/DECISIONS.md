# NAZIR — DECISIONS

> 문서 버전: 1.2 · 기준일: 2026-11-15
> 목적: 사용자 확정 정책, 문서에 반영된 설계 채택안, 미결정 사항(권장안 포함), 외부 확인 필요 사항을 구분해 기록한다.
> 다른 문서와 이 문서가 충돌하면 **확정 정책(§1)** 이 우선하고, 그 외에는 충돌을 버그로 간주해 같은 작업에서 문서를 정정한다.

## 0. 분류 기준

| 표기 | 의미 | 변경 권한 |
|---|---|---|
| **[확정]** | 사용자가 확정한 제품·운영 정책 | 사용자만 변경 |
| **[채택]** | 기술 검토(v1.0 검토 보고서) 결과 문서 v1.1에 반영한 설계. 구현 기준선 | 사용자 승인 후 변경, 변경 시 6개 문서 동시 갱신 |
| **[권장]** | 미결정 항목에 대한 Claude Code 권장안. 구현 시 기본값으로 쓰되 확정 전까지 설정값/교체 가능하게 구현 | 사용자 결정 필요 |
| **[외부 확인]** | 인증사·PG·호스팅·법률 등 외부 자료/계약 확인 전에는 확정 불가 | 확인 후 사용자 결정 |

상태값: `확정`, `채택(승인 대기)`, `미결정`, `확인 필요`, `보류`.

---

## 1. 사용자 확정 정책 [확정]

| ID | 정책 | 반영 문서 |
|---|---|---|
| D-001 | **좌석 변경은 Phase 1에서 제외**한다. 좌석 변경 API를 제공하지 않으며, 사용자는 기존 주문의 점유를 취소한 뒤 새로 예매한다. | DATABASE §5, §11.5 / API §4.5 / TEST ORD-* |
| D-002 | **일반 좌석 점유 시간은 7분**이다. 연장하지 않는다. | DATABASE §11.3 / API §4.4 / TEST SEAT-*, PAY-* |
| D-003 | **결제 승인 확인 단계에서 최대 3분의 별도 보호 시간**을 적용한다. 3분은 보호 시간이며, 3분 경과만으로 결제 실패·좌석 해제를 하지 않는다. | DATABASE §11.6 / ARCH §5 / API §4.7 / TEST PAY-* |
| D-004 | **본인인증은 Phase 1부터 필수**이며 **좌석 선택 전에 완료**한다. | DATABASE §6 / API §4.2 / ARCH §4 / TEST IDV-* |
| D-005 | 결제 수단은 **카드 및 PG사가 지원하는 간편결제**. **가상계좌는 Phase 1에서 제외**한다. | DATABASE §7.1 / API §4.6 / TEST PAY-17 |
| D-006 | 구매 한도는 **동일한 본인인증 식별자 기준, 동일 회차 최대 4석**이다. | DATABASE §6.4, §11.2 / API §4.4 / TEST QTA-* |
| D-007 | 환불은 Phase 1에서 **PG 관리자 페이지를 통한 수동 환불**이며, **PG 환불 결과를 확인한 뒤 DB에 반영**한다. | DATABASE §7.4, §11.8 / API §5.3 / TEST REF-* |
| D-008 | **동일 회차에서 한 사람에게 활성 주문은 하나만 허용**한다. 결제 중, 결제 결과 UNKNOWN인 주문도 활성 주문이다. | DATABASE §5.1, §11.2 / API §4.4 / TEST QTA-* |

| D-009 | **PG는 토스페이먼츠, 휴대폰 본인인증은 NICE아이디**로 한다. 두 업체 모두 Provider Adapter로 격리한다. (2026-11-15) | ARCH §6 / PROVIDERS |
| D-010 | **토스 연동 방식은 결제창 API 개별 연동**(API 개별 연동 키 `test_ck`/`test_sk`·`live_ck`/`live_sk`, 결제창(구버전) SDK). 사유: 결제 결과가 불명확하거나 브라우저 복귀가 누락된 상황에서 `GET /v1/payments/orders/{orderId}` 서버 조회 경로를 확보하기 위함(해당 API는 API 개별 연동 시크릿 키로만 호출 가능 — PROVIDERS §1.3 원문). (2026-11-15) | ARCH §6.2 / API §4.6 |
| D-011 | **1차 결제수단: 카드, 토스페이, 네이버페이.** 카카오페이는 계약 및 테스트 가능 여부 확인 후 추가 검토(Q-017). **페이코는 Phase 1 제외.** 가상계좌 제외(D-005) 유지. (2026-11-15) | DATABASE §7.1 / API §4.6 / TEST PAY-26 |
| D-012 | **판매 개시 조건(결제):** 카드사 심사가 일부만 완료된 경우 조건부 개시 가능. 단 (1) 승인된 결제수단만 관객에게 노출, (2) 승인되지 않은 카드사·결제수단은 사용할 수 없도록 처리, (3) 주요 결제수단의 사용 가능 여부와 PG의 선택적 활성화 가능 여부를 확인, (4) 결제 가능 범위가 지나치게 제한되면 판매 연기(기준은 Q-018). (2026-11-15) | API §4.6 / TEST §15 |
| D-013 | **NICE아이디 승인이 늦어지면 실판매를 연기한다. Mock 인증을 실제 판매에 사용하는 것은 절대 허용하지 않는다.** (2026-11-15) | ARCH §6.5 / TEST PRV-* / §15 |
| D-014 | **활성 주문 범위 확정(Q-004 해소):** 활성 주문 = `PENDING`, `PAYMENT_CONFIRMING`, `PAYMENT_UNKNOWN`, `REVIEW_REQUIRED`. `REVIEW_REQUIRED`는 좌석이 보호 중이거나 결제 결과가 미해결인 경우로 한정한다. 좌석 해제가 끝나고 결제 결과가 확정된 발권 불가 주문은 **`UNFULFILLED`(비활성)**로 전이하며, 남은 초과 결제 환불은 `refunds`·`review_cases`가 추적한다. 정상 `PAID` 주문의 초과 승인은 주문을 `PAID`로 유지한다. (2026-11-15) | DATABASE §5.1, §11.8, §12.1 / API §5.4 / TEST QTA-22~25 |
| D-015 | **인증 세션:** BOOKING 세션은 발급 후 **고정 30분**, 활동에 따른 연장(sliding) 없음. 같은 브라우저에서는 유효기간 내 재인증 없이 취소 후 재예매 가능. 세션당 주문 생성 횟수와 주체·회차별 시간당 주문 생성 횟수를 제한한다(수치는 설정값, 권장 Q-013). **주문 생성 시 세션 잔여 시간이 10분(점유 7분 + 결제 보호 3분) 이상**이어야 한다. NICE 측 결과 유지 제약은 미확인(Q-001). (2026-11-15) | DATABASE §6.3 / API §3.2, §4.4 / TEST IDV-18~22 |

### 1.1 구매 한도 계산 규칙 [확정]

- **포함:** 활성 좌석 점유(`ACTIVE`), 결제 확인 중 좌석(`CONFIRMING`, 결제 UNKNOWN 포함), 결제 완료 좌석, 환불 요청·처리 중 좌석
- **제외:** 만료된 점유, 취소 또는 결제 실패로 해제된 좌석, PG 환불 성공이 확인되고 판매 좌석이 해제된 좌석
- 부분 환불은 **실제 환불 완료된 좌석만** 한도에서 제외한다.

### 1.2 확정 정책의 해석 메모

- D-008의 "한 사람에게 활성 주문은 하나만"은 **동일 회차 기준**으로 해석했다(정책 제목 "동일 회차 복수 주문" 및 설계 변경 요청 B항 근거). 서로 다른 회차에는 동시에 활성 주문을 가질 수 있다. → 해석이 다르면 Q-004에서 정정.

---

## 2. 설계 채택안 [채택] — 문서 v1.1~v1.2 반영, 사용자 승인 대기

| ID | 채택 내용 | 근거(검토 항목) |
|---|---|---|
| A-001 | PG는 **"클라이언트 인증 → 서버 승인(confirm) API" 방식**을 전제로 한다. 서버가 confirm을 호출하기 전에는 결제가 확정되지 않아야 한다. **토스페이먼츠 원문으로 확인: 요청·인증·승인 분리, 인증 후 10분 내 승인 API 미호출 시 만료(PROVIDERS §1.2).** | B1 |
| A-002 | 결제 확인 펜싱: confirm 직전 짧은 트랜잭션에서 hold를 `CONFIRMING`, 주문을 `PAYMENT_CONFIRMING`, 결제를 `CONFIRMING`으로 전이한 후 커밋하고, **트랜잭션 밖에서** PG confirm을 호출한다. | B1, C |
| A-003 | 3분 내 결과 미확정 시 결제 `UNKNOWN`, 주문 `PAYMENT_UNKNOWN`으로 전이하고, hold는 `CONFIRMING`을 유지(재판매 금지)한 채 재조회 작업·경보·수동 복구로 해소한다. | B1, B2, C |
| A-004 | `orders.confirmed_payment_id`(UNIQUE, 동일 주문 복합 FK)로 "주문별 확정 결제 1건"을 DB가 보장한다. 확정에 쓰이지 않은 승인 결제는 `role = EXCESS`로 보존하고 환불 대상으로 분류한다. | B2, H2 |
| A-005 | 주문당 진행 중 결제(`READY`, `CONFIRMING`, `UNKNOWN`)는 1건만 허용한다(partial unique). | B2 |
| A-006 | 좌석 변경 제거에 따라 `order_items`는 **생성 후 불변**이며, `seat_holds`는 `order_items`와 **1:1**이다. hold의 주문·좌석 소속은 복합 FK로 보장한다. | B3, D, H7 |
| A-007 | 점유 만료 시각은 **주문 단위**(`orders.hold_expires_at`)로 관리한다. 한 주문의 모든 hold는 함께 생성되고 함께 전이한다. | B3, D |
| A-008 | 본인인증을 주문보다 먼저 수행한다. `identity_verifications`에서 `order_id`를 제거하고 `purpose`(`BOOKING`/`LOOKUP`)로 구분한다. 서버가 검증한 결과는 `identity_sessions`로 관리하며, 주문은 생성 시 `identity_session_id`·`identity_subject_id`로 연결한다. | B4, A |
| A-009 | 모든 인증·접근 세션은 **브라우저 바인딩 쿠키**의 hash와 묶이며, 다른 브라우저에서 재사용할 수 없다. 인증 결과는 1회만 세션으로 교환(claim)된다. | B4, B5, A |
| A-010 | Idempotency 레코드는 소유 주체(인증 주체 + 브라우저 바인딩)에 귀속된다. 같은 키라도 소유 주체가 다르면 기존 결과·쿠키를 반환하지 않는다. | B5 |
| A-011 | 구매 한도는 `purchase_quotas` 행(주체 × 회차) 잠금 + 카운터 + CHECK 제약으로 직렬화한다. 단순 COUNT 후 INSERT를 금지한다. | B, H6 |
| A-012 | 동일 회차 활성 주문 1건은 `orders` partial unique 인덱스로 DB가 최종 방어한다. | D-008 |
| A-013 | 판매 좌석 소유자를 `session_seats.sold_order_item_id`로 기록하고, 유효 티켓은 좌석당 1장만 허용한다(partial unique). 환불 시 좌석 해제는 소유 항목일 때만 한다. | H1 |
| A-014 | 환불은 `refund_type`(`SEAT`/`PAYMENT_EXCESS`)으로 정상 결제의 좌석 환불과 초과 승인 결제 환불을 구분한다. 결제별 누적 완료 환불액은 승인 금액 이하(CHECK)이다. | H2, E |
| A-015 | 수동 환불 절차: DB에 환불 요청 기록 → PG 관리자 페이지 실행 → PG 재조회로 검증 → 완료. PG 취소 Webhook·일일 대사로 DB 미기록 환불을 탐지한다. | H3, E |
| A-016 | Webhook은 "PG 재조회 트리거"로만 사용하며, 처리 실패/중단된 이벤트는 재전송 시 재처리한다. | H4 |
| A-017 | 주문이 `PENDING`이고 진행 중 결제 확인(CONFIRMING/UNKNOWN)이 없을 때만 취소·고객 이메일 변경·결제 시작을 허용한다. 이름·전화번호는 본인인증 결과로만 설정한다. | H5 |
| A-018 | PG·본인인증 복귀 경로는 쿠키에 의존하지 않는다. 서버 측 상태(단일 사용 nonce)와 provider 재조회로 검증한 뒤 같은 출처 페이지로 303 이동한다. `returnUrl`은 서버가 결정한다. | H9 |
| A-019 | Prisma는 테이블·기본 관계를 관리하고, partial unique·CHECK·Prisma로 표현하기 어려운 복합 FK·`NULLS NOT DISTINCT`는 raw SQL migration으로 관리한다. 빈 DB 적용 후 필수 제약 존재를 검사하는 **스키마 계약 테스트**를 CI 필수로 둔다. | H8 |
| A-020 | 주문 상태를 바꾸는 모든 트랜잭션은 전역 잠금 순서(DATABASE §13.2)를 따른다. 다른 주문의 만료 회수는 별도 트랜잭션(`expireOrder`)에서 수행한다. | M1 |
| A-021 | `review_cases` 테이블로 운영자 확인 필요 사안을 추적하고, 관리자 복구 작업은 열거된 action만 허용한다. | M7, B2 |
| A-022 | 공개 우선순위 재정의: 환불 기록·검증, REVIEW 처리, 관리자 감사 로그, outbox 이벤트 생성은 **P0**. Sheets 전송 worker는 P1. | M8 |
| A-023 | 만료·결제 판정 시각은 DB 시각을 기준으로 한다. 서비스 계층은 Clock 인터페이스를 통해 시각을 받고, 테스트는 고정 시각을 주입한다. | M10 |
| A-024 | **Provider 실행 단계 3종**: `MOCK`(서버 내부 시뮬레이터, local·test만), `SANDBOX`(업체 테스트 환경, local·staging), `LIVE`(production만). **서버 시작 단계에서 fail-closed 검사**: 실행 환경 값이 없으면 production으로 간주, production에서 Mock 선택·토스 `live_` 외 키·NICE 운영 설정 불일치 시 기동 실패. Mock 제어 라우트는 local·test에서만 등록. | 사용자 지침 3, D-013 |
| A-025 | **Provider 실행 단계를 DB 레코드에 저장하지 않는다.** 근거: 환경별 DB·자격증명이 분리되고 A-024가 "production ⇒ LIVE"를 기동 시 강제하므로 레코드별 단계 정보가 새 정보를 주지 않는다. 기존 `provider` 컬럼(`TOSS`/`NICE`/`MOCK`)으로 운영 DB의 Mock 레코드를 정합성 검사로 탐지한다. | 사용자 지침 3 |
| A-026 | **Mock 코드의 운영 빌드 제거는 필수로 하지 않는다**(런타임 차단 A-024로 대체). 비교: 빌드 제거는 환경별 빌드 분기로 "staging에서 검증한 산출물을 그대로 운영 배포" 원칙을 깨고 조건부 import 관리 비용이 크며, 런타임 차단으로 남는 위험(서버 코드 변조)은 빌드 제거로도 막히지 않는다. Mock은 서버 전용 모듈로 두어 클라이언트 번들에 포함하지 않는다. | 사용자 지침 3 |
| A-027 | **토스 웹훅은 결제 성공의 직접 증거가 아니다.** 수신 → 서명 검증(헤더 존재 시, 보안 키) → eventId 기반 중복 저장 → 10초 이내 200 응답 → 비동기 작업이 결제 조회 API로 최종 상태 확인 후 반영. 서명 검증 실패는 거부. | H4, 사용자 지침 4 |
| A-028 | **`identity_verifications.provider_context_encrypted`에는 거래별 임시 문맥만 저장**(NICE `request_no`·`transaction_id`·접근토큰 참조 ID 등, 10분 수준 수명). `client_id`/`client_secret`, 토스 시크릿·보안 키, HMAC 키, 데이터 암호화 키 같은 고정 비밀값은 서버 Secret 관리 체계에만 둔다. NICE 접근토큰(24시간)과 `ticket`·`iterators`는 공유 토큰 캐시(암호화, 만료 < 24시간)에 두며 저장소는 Q-013과 함께 결정. | 사용자 지침 4 |
| A-029 | **구매 쿼터 동시성**: 쿼터를 잠그는 모든 트랜잭션은 READ COMMITTED. 한도·활성 주문 판정은 잠금 획득 **이후** 실행한 statement 결과로만 한다. `seat_limit`은 행 생성 시 snapshot이며 이후 회차 한도 변경은 기존 행에 반영하지 않는다. | 검증 항목 1 |
| A-030 | **결제수단 허용 목록 적용**: (1) 서버가 활성화된 수단만 결제수단 목록 API로 제공, (2) 카드는 통합결제창 + 승인 완료 카드사만 `cardCompany`로 지정, 간편결제는 `DIRECT` + `easyPay`로 개별 호출, (3) 승인 응답의 수단·카드사·간편결제사가 허용 목록 밖이면 자동 확정 금지(`role = EXCESS` + review case). 통합결제창의 간편결제 노출 제어는 미확인(Q-021). | D-011, D-012 |
| A-031 | **confirm timeout과 3분 보호의 관계**: confirm 호출 timeout은 설정값(초기 60초 — 토스 일반 승인 권장치는 검색만 확인, PROVIDERS §1.8). 3분 보호 안에서 "confirm(멱등키) → 불명확 시 orderId 조회 → `IN_PROGRESS`이고 인증 후 10분 이내면 같은 멱등키로 confirm 재시도"를 반복한다. 3분 경과 시 UNKNOWN으로 전환하되 **좌석은 해제하지 않으며**, 이후 재조회로 `DONE`이면 확정, `EXPIRED`/`ABORTED`이면 실패 확정. | B1, 사용자 지침 4 |
| A-032 | **결제·주문 정합성을 DB가 보장한다(S3).** 주문당 `PRIMARY` 결제 ≤ 1(partial unique, `EXCESS`는 여러 건), `PRIMARY` 승인 금액 = 요청 금액 = 주문 총액(CHECK + 복합 FK `payments(order_id, requested_amount)` → `orders(id, total_amount)`), 확정 결제는 그 주문의 `SUCCEEDED` `PRIMARY` 결제이며 `PRIMARY` ⇔ 주문의 확정 결제(DEFERRABLE INITIALLY DEFERRED constraint trigger 2개: 커밋 시점 최종 상태 검사, 어떤 문장 순서로도 원자적 판매 확정 허용). A-004·A-005의 구현 강화이며 결제 이력 보존 원칙은 유지. **사용자 승인 2026-11-16.** | Step 2 기술 검토 S3 |
| A-033 | **주문은 자기 주체·회차의 `purchase_quotas` 행 없이 존재할 수 없다(S4).** 복합 FK `orders(identity_subject_id, show_session_id)` → `purchase_quotas`. A-011(쿼터 행 잠금)의 DB 방어 강화. **사용자 승인 2026-11-16.** | Step 2 기술 검토 S4 |
| A-034 | **`payments.method_type`에 `OTHER` 추가(Q-022 확정).** 결제 시도 생성 시에는 사용자가 요청한 수단(`CARD`/`EASY_PAY`), PG가 승인된 결제를 허용 외 수단으로 보고하면 `OTHER`로 기록한다. `OTHER`는 `SUCCEEDED` + `EXCESS`에서만 허용(진행 중·실패·취소·`PRIMARY` 불가). 허용 외 카드사·간편결제사는 `card_company`·`easy_pay_provider`에 사실대로 기록(허용 값 CHECK 없음). A-030의 검증·초과 결제 보존 원칙은 유지. **사용자 승인 2026-11-16.** | Q-022 |
| A-035 | **인증 세션은 원 인증의 주체·용도를 그대로 가진다(Q-024 확정).** `identity_verifications UNIQUE (id, identity_subject_id, purpose)` + `identity_sessions` 복합 FK. **A-040이 이를 브라우저 바인딩까지 포함하는 4열 FK로 확장한다.** 인증 1건 → 세션 1개 규칙은 유지. A-008·A-009의 DB 방어 강화. **사용자 승인 2026-11-16.** | Q-024 |
| A-036 | **`order_items`는 UPDATE와 DELETE 모두 DB에서 차단한다(Q-023 확정).** A-006의 구현. 개인정보 파기·보관기간 만료는 이 원장을 임의 삭제하는 방식이 아니라 별도 정책·권한으로 다룬다(Q-016). **사용자 승인 2026-11-16.** | Q-023 |
| A-037 | **모든 DB migration은 트랜잭션(`BEGIN; … COMMIT;`)으로 실행한다(S1).** Prisma Migrate가 migration을 트랜잭션으로 실행하지 않음을 실측으로 확인(중간 실패 시 앞 문장이 남고 이후 배포가 `P3009`로 막힘). 트랜잭션 불가 문장은 별도 migration + `-- no-transaction:` 표지. A-019의 구현 강화. **사용자 승인 2026-11-16.** | Step 2 기술 검토 S1 |
| A-038 | **결제 원장 보존(결제 행 DELETE 불가)과 `SUCCEEDED`의 양수 `approved_amount`·`approved_at` 필수.** 결제 시도·승인 이력 전체(`FAILED`·`CANCELED`·`EXCESS` 포함)는 원장이며 폐기는 상태 전이로 한다(§1.1 원칙 3, §7.1 "EXCESS 기록을 삭제하지 않는다"). 승인 금액이 없는 `SUCCEEDED`는 환불 상한 CHECK 때문에 환불을 원장에 기록할 수 없게 만든다. **승인 시각도 필수(CHECK `status <> 'SUCCEEDED' OR approved_at IS NOT NULL`, INSERT·UPDATE, NULL 안전; 사용자 지시 2026-11-17).** 구현: 트리거 `payments_no_delete`, CHECK `payments_succeeded_amount_ck`·`payments_succeeded_approved_at_ck`. | Step 2 PR 전 검토, Step 2 후속 |
| A-039 | **결제수단의 요청값과 PG 보고 원문을 결제 행에 보존한다(Q-027 채택안 ①, 사용자 승인 2026-11-17).** `payments.requested_method_type`(NOT NULL, `CARD`|`EASY_PAY`, 생성 후 DB가 변경 거부)과 `payments.provider_method_raw`(varchar(100) NULL, PG 라벨 원문, **`method_type = OTHER`이면 필수**, 정규화 금지, 9자리 이상 숫자·`@`·제어문자·공백만의 값 거부). `method_type`·`easy_pay_provider`·`card_company`의 의미는 그대로(PG가 보고한 정규화 값). **요청 간편결제사 컬럼과 응답 JSON 스냅샷은 추가하지 않는다.** 구현: `payments_requested_method_type_ck`, `payments_other_requires_raw_ck`, `payments_provider_method_raw_ck`, **`payments_unapproved_method_matches_request_ck`(`status = 'SUCCEEDED' OR method_type = requested_method_type` — `method_type`이 요청값과 달라지는 것은 PG 승인 후에만 허용; 사용자 지시 2026-11-18)**, 트리거 `payments_requested_method_no_change`(SQLSTATE `23001`), 서비스 측 규칙 `src/server/db/payment-method.ts`(생성 시 요청값 기록, 승인 시 요청값 불변·`DISALLOWED`→`OTHER`+원문). A-034의 "요청 수단은 review case detail에 남긴다"는 보완책을 대체한다(review case detail은 운영자용 요약으로 유지). | Q-027 |
| A-040 | **인증 세션은 원 인증의 주체·용도·브라우저 바인딩을 가지며, 세션과 `CONSUMED` 인증은 양방향으로 대응한다(Q-028 채택, 사용자 승인 2026-11-17).** ① `identity_verifications UNIQUE (id, identity_subject_id, purpose, browser_binding_hash)` + `identity_sessions` 4열 복합 FK(`identity_sessions_verification_claim_fk`) — 다른 브라우저의 claim을 DB가 거부. ② 지연(DEFERRABLE INITIALLY DEFERRED) constraint trigger 2개 — 커밋 시점에 세션이 있으면 인증은 `CONSUMED`, `CONSUMED`이면 세션이 존재. claim 트랜잭션에서 인증 `VERIFIED→CONSUMED`와 세션 INSERT는 어느 순서로 써도 허용된다. 세션의 `REVOKED`·`EXPIRED`는 세션 수명주기이며 인증 상태와 무관하다. `claim_expires_at` 판단은 서비스가 Clock으로 한다(DB 시각 정책 없음). **보존 정책은 바꾸지 않는다**: `orders.identity_session_id`가 RESTRICT라 주문을 만든 세션·인증은 물리 삭제할 수 없고(개인정보 컬럼 제거는 UPDATE로 가능), 이것이 개인정보 보존 기간 정책(Q-016, E-006)과 충돌할 수 있음을 기록한다. | Q-028 |
| A-041 | **원장성 테이블 보호는 한정 범위로 적용한다(Q-029, 사용자 지시 2026-11-17).** `admin_audit_logs`·`payment_status_logs`·`refund_items`는 UPDATE·DELETE 모두 차단, `refunds`는 DELETE만 차단(UPDATE는 환불 상태 전이를 위해 허용 — 이 결정은 유지하며, 핵심 필드 보호는 A-042가 UPDATE 허용 위에 더한다). 트리거는 `ledger_reject_update()`/`ledger_reject_delete()`(SQLSTATE `23001`). **이번에 다루지 않는 것**: `tickets`·`orders`·`seat_holds`·`order_status_logs`·`seat_status_logs`·`payment_webhook_events` — 각 서비스의 쓰기 패턴과 보존 정책(Q-016)이 정해진 뒤 결정한다. TRUNCATE와 소유자·슈퍼유저 권한은 DB로 막을 수 없어 Step 10 역할 분리(S9)로 통제한다. | Q-029 |
| A-042 | **PR #2 기술 리뷰 후속 3건(사용자 지시 2026-11-18).** ① **승인 증거 불변**: `SUCCEEDED` 결제는 `PRIMARY`·`EXCESS` 모두 `approved_amount`·`approved_at`·`method_type`·`provider_method_raw`·`easy_pay_provider`·`card_company`·`merchant_payment_ref`·`provider_payment_id`·`pg_transaction_id`·`provider`·`status`·`order_id`·`requested_amount`·`currency`를 바꿀 수 없다(행 트리거 `payments_approved_evidence_no_change`, AFTER UPDATE). 환불 누적·재조회 관리 컬럼(`refunded_amount`, `last_verified_at`, `requery_count`, `next_requery_at` 등)과 `role`(지연 trigger가 관장)은 허용한다. `EXCESS`의 `FAILED`/`CANCELED` 강등은 `status` 불변으로 막는다. ② **환불 핵심 불변 + SEAT 합계**: `refunds`의 `id`·`order_id`·`payment_id`·`refund_type`·`provider`·`total_amount`·`requested_by_admin_id`·`created_at`은 생성 후 바꿀 수 없고(트리거 `refunds_core_no_change`), 상태 전이와 운영 메타데이터 UPDATE는 허용한다(A-041/Q-029의 "refunds UPDATE 허용"을 뒤집지 않음). `SEAT` 환불은 COMMIT에서 `total_amount = SUM(refund_items.amount)`(항목 1건 이상), `PAYMENT_EXCESS` 환불은 항목 없음을 지연 constraint trigger 2개가 검사한다. ③ **Prisma CLI 환경 가드**: `prisma.config.ts`가 명령 실행 전에 `DATABASE_URL`과 `SHADOW_DATABASE_URL`을 `NAZIR_RUNTIME_ENV`와 대조한다(test ⇔ `_test` DB, 누락·미지 값은 production, `DATABASE_URL` 없으면 주 DB 검사 없음). **Shadow DB도 같은 규칙으로 검사하고(CLI가 초기화·재작성하므로 `_test` Shadow DB로 개발 DB를 우회할 수 없다), 주 DB와 같은 DB는 거부하며, 미설정이면 기존 동작이다(2026-11-18 PR #2 추가 리뷰로 보강).** **알려진 결과:** 승인 값을 잘못 기록하면 UPDATE로 고칠 수 없으므로 정정 절차가 필요하다(Step 8, 감사 로그 + 관리자 전용 권한). 트리거를 AFTER로 둔 것은 CHECK·FK가 먼저 판정해 도메인 규칙 위반이 기존 제약 이름으로 계속 보고되게 하기 위함이다. | PR #2 기술 리뷰 (P1·P1·P2) |
| A-043 | **동일인 식별·개인정보 보호·키 관리(Q-002·Q-016 확정, 사용자 결정 2026-11-24).** ① 동일인 식별은 **NICE DI**. 원본 DI·CI는 DB에 저장하지 않고, DI 전용 키링의 HMAC(`subject_key_hash`)과 키 버전만 저장한다. **DI가 제공되지 않으면 CI·전화번호로 자동 대체하지 않고 중단·보고**한다(계약상 DI 제공 여부는 E-001 미확인). 키 교체: 새 버전으로 기록하고, 조회는 보관 중인 모든 버전으로 계산해 비교한 뒤 일치하면 현재 버전 값으로 갱신(전환). DI HMAC도 동일인 구별 정보로 보고 접근 제한·보관·파기 대상으로 둔다. ② 이름·전화번호 등 필요한 개인정보만 **AES-256-GCM**(96bit 랜덤 nonce, 128bit 태그, 키 버전 저장, 버전별 키 보관으로 교체 후에도 복호화). ③ 키는 환경 비밀(`<PREFIX>_KEYS`=`v1:<base64url>,…`, `<PREFIX>_KEY_CURRENT`)로만, CSRF·DI HMAC·암호화 키링은 서로 분리(같은 키 거부). ④ 보관 기간은 **미확정**: 실제 개인정보 수집·판매 개시 전 법령 확인 후 개인정보처리방침과 함께 확정(E-006). **구현(2026-11-25):** `src/server/lib/crypto/{subject-key,pii}.ts`, `src/server/identity/subjects.ts`, `src/server/privacy/erasure.ts`. 키 교체 절차: ① 새 버전을 모든 인스턴스 키링에 추가(current는 그대로) ② current 전환 ③ 남은 행이 없을 때 구버전 제거 — ①을 건너뛰면 중복 subject가 생길 수 있다(테스트 SUBJ-06b). 조회는 모든 버전으로 계산해 찾고, 더 낮은 버전에서 찾으면 같은 행을 현재 버전으로 갱신(낮추지는 않음). 두 버전에서 각각 찾으면 병합하지 않고 오류. 암호문 `v<N>.nonce.ct.tag`, 필드명을 AAD로 묶음. 구현은 개인정보 컬럼의 선택적 파기(UPDATE로 비움), 주문·결제 기록과 인증 개인정보의 보존 목적 분리, DB 관계로 인한 영구 보존 방지, 원문 없는 파기 이력, 백업 파기 정책 검토를 전제로 한다. 로그·오류·테스트 출력에 원문 금지. | Q-002, Q-016, E-006 |
| A-044 | **브라우저 바인딩·CSRF bootstrap(사용자 승인 2026-11-24, 구현 Step 4).** 바인딩 값 = 256bit 난수 base64url(43자), 원본은 저장하지 않고 행에는 SHA-256 hex만. 쿠키 `__Host-nz_bind`: Secure·HttpOnly·Path=/·SameSite=Lax·Domain 없음·Max-Age 30일·자동 갱신 없음(유효한 쿠키는 재발급·재설정하지 않음). 형식이 틀리거나 중복된 쿠키는 새로 발급. 모든 환경에서 같은 속성(local은 http://localhost 보안 컨텍스트). CSRF 토큰 = `v<N>.` + HMAC-SHA256(CSRF 전용 키, 용도 분리 레이블 + 바인딩 값), stateless, 보관 중인 버전은 검증 허용, timing-safe 비교. 상태 변경 요청은 `Origin`이 `NAZIR_APP_ORIGIN`과 정확히 일치해야 하고(누락·`null`·불일치 거부), `Sec-Fetch-Site`가 있으면 `same-origin`이어야 한다. `NAZIR_APP_ORIGIN`·CSRF 키: 형식 오류는 모든 환경에서 기동 거부, 누락은 staging·production 기동 거부, local·test는 기동하되 사용 시 500(기본값 없음). production·staging은 https만, local·test는 https 또는 http://localhost·127.0.0.1만. NICE callback은 쿠키·CSRF가 아닌 별도 state·무결성·재전송 방지 검증(§3.4). | API §3.1, §3.3, §4.1 |
| A-045 | **Rate limit 저장소(Q-013 확정, 사용자 결정 2026-11-24).** PostgreSQL 공유 카운터 테이블. 원자적 증가(단일 `INSERT … ON CONFLICT DO UPDATE`), DB 시각 기준 창, IP 원문 대신 HMAC 식별값, 바인딩 등 추가 기준, 만료·정리 작업, 임의 키로 인한 무한 증가 방지, 저장소 장애 시 민감한 인증 요청 fail-closed. 서버리스 메모리 전용 금지. NICE 토큰 캐시는 별도 테이블(별도 암호화·만료·접근 제한). 수치는 Q-013 권장안을 초기 설정값으로. **구현(2026-11-24):** 테이블 `rate_limit_counters`(DATABASE §3), `src/server/rate-limit/`. 키링 `NAZIR_RATE_LIMIT_KEYS`/`_KEY_CURRENT`(CSRF 키와 같으면 거부). 클라이언트 IP는 `NAZIR_CLIENT_IP_SOURCE=vercel`(`x-vercel-forwarded-for`만 신뢰, `x-forwarded-for`·`x-real-ip` 미사용, 값이 없거나 목록·형식 오류면 fail-closed) 또는 local·test 전용 `fixed`(`NAZIR_CLIENT_IP_FIXED`). IPv6는 /64 단위로 센다(A-047 확정). 저장소 장애·정책값 미설정은 503 `RATE_LIMIT_UNAVAILABLE`, 한도 초과는 429 `RATE_LIMITED`. 정책값은 `NAZIR_RATE_LIMIT_POLICIES`로 덮어쓴다. 인증 시작 수치는 A-047로 확정. 키링 버전 교체 시 카운터가 새로 시작된다(허용). | Q-013, Q-031 |
| A-046 | **Preview 보호(H2, 사용자 결정 2026-11-24).** Vercel Deployment Protection. 실제 DB를 Preview에 연결하기 전 활성화, 우회 접근은 필요한 인원에게만, 공개 전 rate limit 검증. Vercel 설정은 사용자가 직접 변경(개발 측이 변경하지 않음). | H2 |
| A-047 | **인증 시작 rate limit 정책 확정(사용자 결정 2026-11-25).** ① 집계 단위: IPv4 /32, IPv6 /64(privacy 주소가 바뀌어도 같은 /64는 같은 bucket, 다른 /64는 독립). IPv4-mapped IPv6(`::ffff:a.b.c.d`, `::ffff:XXXX:XXXX`)는 IPv4로 정규화. ② `identity.start.ip` **60회/10분**(네트워크 단위 악용 방지), `identity.start.binding` **5회/10분**(같은 브라우저 반복 호출 방지). 둘 다 적용하며 IP를 먼저 검사한다. 정상 바인딩 쿠키가 없으면 인증 시작을 진행하지 않는다. 초과는 429 `RATE_LIMITED` + `Retry-After`, 저장소 장애는 503 `RATE_LIMIT_UNAVAILABLE`. ③ **브라우저 기준 제한은 사람을 구분하는 강한 수단이 아니다**(쿠키는 클라이언트가 지우거나 새로 받을 수 있다). IP 기준 제한과 함께 쓰는 보조 방어다. ④ 선행 과제(공개 인증 API 운영 전): 만료 행 정리 스케줄(`deleteExpiredCounters`), 실제 Vercel Preview에서 `x-vercel-forwarded-for` 전달 확인 — **둘 다 미완료**. 주문 생성 수치(D-015 권장)는 여전히 미확정. | Q-013, A-045 |
| A-048 | **개인정보 선택적 파기 구조(A-043 구현, 2026-11-25).** 행은 지우지 않고 개인정보 **컬럼**만 비운다(주문·결제·쿼터·세션 FK가 RESTRICT이고 주문·결제 기록은 별도 보존 목적). ① `identity_verifications`: `verified_name`·`verified_phone`·`provider_context_encrypted` + `pii_erased_at`(CHECK: 파기 후 다시 채울 수 없음). ② `identity_subjects`: DI HMAC(`subject_key_hash`) 별도 파기 + `erased_at`(CHECK: 둘 중 하나만). 파기 후 같은 사람은 새 subject가 된다(과거 주문과 구매 한도 연결 끊김 — 보존 기간 결정 시 고려). ③ `orders`: `customer_name`·`customer_phone`·`customer_email`을 필드별로 + `customer_pii_erased_at`(CHECK: 표시 없이 이름·전화 제거 불가). ④ `pii_erasure_logs`: 대상·**컬럼 이름**·사유 코드(`^[A-Z][A-Z0-9_]{2,49}$`, 자유 텍스트 금지)·행위자만 기록, 값 없음, UPDATE·DELETE 차단. **보관 기간·호출 주체·주기는 미정**(E-006, 판매 전 확정). **미포함(후속):** `payment_webhook_events` 원문, `admin_audit_logs`(A-041로 변경 불가), 백업 파기 정책(호스팅 백업 보존 기간 확인 필요), Sheets mirror. | Q-016, E-006, A-043 |
| A-049 | **IdentityProvider와 인증 시작 API(2026-11-26).** ① 계약 `IdentityProvider.startVerification({verificationId, purpose, returnUrl}) → {providerTransactionId, launch{type:'redirect', url}, validForMs, context}`. NICE 고유 값(request_no·transaction_id·토큰 참조)은 adapter의 불투명 `context`에만 둔다. 콜백 결과 정규화는 NICE 계약 확인 후 callback 단계에서 정의(추측 금지). 오류는 `ProviderUnavailableError`(503 `PROVIDER_UNAVAILABLE`)와 `ProviderRejectedError`(502 `IDENTITY_START_FAILED`, 신규)로 구분. NICE adapter는 실제 호출 전까지 항상 `ProviderUnavailableError`(성공 흉내 없음). ② Mock: 생성자 자체가 local·test 외 환경을 거부(시작 검사와 별개 이중 방어), 행의 `provider='MOCK'`, 사용자 입력으로 신원을 받지 않음, 실행 화면은 같은 출처(`/identity/mock`, callback 단계에서 구현). ③ 검사 순서: 요청 형식(정확히 `{purpose}`, 다른 필드 거부 — 클라이언트가 복귀 주소를 정할 수 없음) → 바인딩 쿠키(없음·형식 오류 401 `BROWSER_BINDING_REQUIRED`, 신규) → Origin·CSRF → IP rate limit → 바인딩 rate limit → 거래 저장 → provider 호출(트랜잭션 밖) → 결과 저장. ④ 거래: state = 256bit 난수, 서버가 정한 callback URL(`/api/v1/identity-verifications/callback/{provider}?state=…`)에만 담고 DB에는 SHA-256만(`state_nonce_hash` UNIQUE). 원본 state·callback URL은 provider context(암호화)에 둔다. 만료 = DB `now()` + 10분(NICE 원문 10분 유효, provider가 더 짧게 주면 그 값). ⑤ 중복: 같은 바인딩·purpose의 PENDING은 1건(부분 unique). provider 응답 대기 중(30초 이내, 거래 id 미설정) 재요청은 409 `REQUEST_IN_PROGRESS`, 그 외 이전 PENDING은 `EXPIRED`(`failure_code='SUPERSEDED'`)로 대체. ⑥ provider context는 별도 키링 `NAZIR_PROVIDER_CTX_ENC`(AES-256-GCM, verification id를 AAD로)로 암호화 — DATABASE §6.2 "개인정보 암호화 키와 분리" 규정에 따라 5번째 키링 추가. ⑦ 응답 상태는 200(API_SPEC에 지정 없음, 변경 없음). | API §4.2, §3.4, A-028 |
| A-050 | **Mock 인증 화면과 Callback(2026-11-26).** ① 계약 추가: `completeVerification({context, callback}) → VERIFIED{di,name,phone} / CANCELED / FAILED`, 무결성 실패는 `ProviderRejectedError`. ② Mock: `/identity/mock?txn=`(local·test만, 그 외 404, PENDING·미만료·미완료 MOCK 거래만)에서 고정 가짜 인물 A·B·C 중 선택·취소·실패. 제어 라우트 `POST /api/v1/mock/identity/complete`(local·test만, Origin 정확 일치)가 결과와 256bit 결과 토큰의 SHA-256을 context에 1회만 기록하고, **시작 시 서버가 저장한 callback URL**로만 303(+`mock_result`). 사용자는 DI·이름을 입력할 수 없다. ③ Callback `GET /api/v1/identity-verifications/callback/{provider}`: 쿠키 미사용·세션 미발급. state 형식 → 경로 provider = 설정 provider → state hash로 행 잠금(PENDING·미만료·같은 provider) → provider 결과 확인(트랜잭션 밖) → 행 재잠금 후 1회만 전이. VERIFIED는 `resolveSubjectInTx`(DI만), 이름·전화 AES-256-GCM, `verified_at`, `claim_expires_at = now() + 5분`(DATABASE §6.2 **권장값**, 미확정), context 삭제, 바인딩 hash 보존. 실패 코드 `USER_CANCELED`·`PROVIDER_FAILED`·`INTEGRITY_FAILED`·`DI_UNAVAILABLE`·`EXPIRED_BEFORE_CALLBACK`. provider 일시 장애·전이 트랜잭션 오류는 PENDING 유지(롤백). ④ 응답은 항상 303 `/identity/complete?vid=`(state 미매칭은 vid 없음), `no-store`, `Referrer-Policy: no-referrer`, state 미포함. 재전송·동시 요청은 상태 불변 + 같은 303. 결과 페이지는 URL로 성공을 표시하지 않는다(claim에서 확인). ⑤ NICE: 복귀 HTTP 메서드 미확정이라 POST 핸들러는 두지 않음(405). 결과 재조회 가능 여부 미확인이므로 동시 callback 시 provider 결과 확인이 두 번 일어날 수 있음 — NICE 연동 시 재검토. | API §3.4, §4.2, A-043, A-049 |
| A-051 | **Claim·인증 세션(사용자 결정·구현 2026-11-27).** ① **Claim 유효기간 5분 확정**: DB의 `verified_at` 기준 `claim_expires_at = verified_at + 5분`, DB `now() < claim_expires_at`일 때만 허용(경계 시각은 거부). ② Claim 한 트랜잭션: 인증 행 잠금 → 바인딩 일치(불일치 401 `BROWSER_BINDING_MISMATCH`) → (바인딩, purpose) advisory lock → `VERIFIED`·창 안이면 같은 바인딩·purpose의 ACTIVE 세션 `REVOKED` → 인증 `CONSUMED` → 새 세션(토큰 256bit, DB에는 SHA-256만). 하나라도 실패하면 전체 롤백. 새 부분 unique `identity_sessions_active_binding_uq`(바인딩·purpose당 ACTIVE 1개)로 A-009 규칙을 DB가 보장. 세션 만료: BOOKING 고정 30분(D-015), LOOKUP 10분(A-052로 확정). sliding 없음. ③ **응답 유실 복구**: 같은 브라우저가 창 안에서 다시 claim하면, 그 인증의 세션이 ACTIVE·미만료·**한 번도 사용되지 않음**(`last_used_at IS NULL`)일 때만 같은 세션 행의 토큰을 새로 바꿔 준다(만료 연장 없음, 이전 토큰 즉시 무효). 그 밖에는 재인증. 토큰을 저장·반환하는 복구는 하지 않는다. 한계: 창(5분) 안에 바인딩 쿠키와 CSRF 토큰을 함께 탈취한 공격자는 미사용 세션을 가져갈 수 있다 — 바인딩 쿠키 탈취는 세션 쿠키 탈취와 같은 수준(둘 다 HttpOnly·__Host-)이라 위험 증가는 제한적으로 판단. 원치 않으면 이 복구만 끄고 재인증으로 대체할 수 있다. ④ `GET /identity-session`: 두 쿠키 모두 일치·ACTIVE·DB 시각 미만료일 때 `{purpose, expiresAt, displayName(마스킹)}`, `last_used_at`만 갱신(`expires_at` 불변). 다른 브라우저로 복사된 토큰은 401 `BROWSER_BINDING_MISMATCH`. `DELETE`: CSRF 필수, 두 쿠키가 모두 맞는 그 세션만 폐기, 쿠키는 같은 속성 + Max-Age=0으로 삭제, 반복 호출 204. CSRF 실패 시 폐기·삭제 없음. ⑤ **M7(부분)**: `src/server/db/errors.ts`의 `dbConstraintOf`가 문장 시점(`meta.driverAdapterError.cause`), COMMIT 시점(`DriverAdapterError.cause.originalCode`), node-pg 세 형태를 처리. **실측: adapter-pg 7.10.1은 constraint trigger의 COMMIT 오류에서 제약 이름을 넘기지 않는다**(SQLSTATE만). claim은 23514(이름 없음 또는 A-040 이름)를 422 `IDENTITY_VERIFICATION_FAILED`로, 다른 제약 이름은 매핑하지 않는다(500). 메시지는 읽지 않는다. | API §3.2, §4.2, DATABASE §6.3, M7 |
| A-052 | **LOOKUP 세션·응답 유실 복구 확정(사용자 결정 2026-11-27).** ① 세션 수명: BOOKING 고정 30분(D-015), **LOOKUP 고정 10분**, 둘 다 sliding 없음, 만료는 DB `now() >= expires_at`. ② 응답 유실 복구 **유지**, 조건(모두 SQL에서 DB 시각으로): 같은 verificationId, 인증 `CONSUMED`, 저장된 바인딩 hash = 현재 브라우저, 세션이 **그 인증의 세션**(`identity_verification_id = id`)이고 같은 바인딩, `ACTIVE`·미만료, `last_used_at IS NULL`, **`now() < 세션 created_at + 5분`**. 기준은 최초 claim 트랜잭션 시각(세션 `created_at`, DB가 기록 — COMMIT보다 수 ms 앞서므로 실제 창은 5분 이하)이며 인증의 `claim_expires_at`과 **무관**하다(A-051 ③의 "창 안" 표현을 이 조건으로 대체). 복구는 `token_hash`만 새 난수의 hash로 교체(같은 행, `expires_at` 불변, 인증 `CONSUMED` 유지, 이전 토큰 즉시 무효). | A-051, D-015 |
| A-053 | **Step 5 정책 결정(사용자 승인 2026-11-25).** ① **Git**: Step 4 브랜치(`2996b43`)를 세션 브랜치 `claude/pensive-allen-5djvof`로 `--ff-only` 이동 후 이 브랜치에서만 작업·push. ② **주문번호(Q-025 확정)**: `NZ-YYYYMM-NNNNNN`, 전역 PostgreSQL sequence 1개(월별 초기화 없음), `YYYYMM`은 DB 시각을 `Asia/Seoul`로 **명시 변환**한 값, 최소 6자리 0 채움·초과 시 자릿수 자동 확장, 롤백 결번 허용. 주문번호는 인증 비밀값·조회 접근 토큰으로 쓰지 않는다(ORD-11). ③ **S2 DB 방어**: live hold(`ACTIVE`/`CONFIRMING`) INSERT/UPDATE 시 좌석 행을 `FOR SHARE`로 읽어 `AVAILABLE`이 아니면 거부, 좌석을 `SOLD`로 바꾸는 트랜잭션은 COMMIT 시점에 그 좌석의 live hold가 없어야 한다(지연 constraint trigger). live 판정 규칙·잠금 순서는 기존 그대로. ④ **주문 생성 rate limit 확정(Q-013)**: `order.create.session` 3회/30분, `order.create.subject_session` 5회/1시간. 같은 키·같은 본문의 멱등 재요청은 횟수를 소비하지 않고, 새 Idempotency-Key는 새 요청으로 센다. ⑤ **주문 확인 접근 세션 수명(Q-013 확정)**: `min(회차 종료 시각 + 24시간, 발급 시각 + 30일)`, DB 시각 기준, sliding 없음. 인증 세션과 별개이며 만료는 주문 데이터 삭제가 아니다(만료 후 재인증으로 접근). ⑥ **멱등성 보존 24시간**: 키 원문 대신 hash, 소유 주체(인증 주체 + 바인딩)·scope 귀속, 같은 키·다른 본문은 409, 성공 결과 동일 재반환, 409·422 업무 거절은 완료 결과로 저장하지 않음(롤백), 동시 요청에도 주문 1건. ⑦ **A-041 확장**: `order_status_logs`·`seat_status_logs` UPDATE/DELETE 차단, `seat_holds` DELETE 차단(상태 변경은 UPDATE). ⑧ **M8 Pool**: 환경별 Pool max·연결 대기·idle·Prisma `maxWait`/`timeout`·`statement_timeout`·`lock_timeout`. local/test 명시 개발 기본값, staging/production 누락 시 fail-closed. Neon pooled 한도·Vercel 최대 인스턴스 수 확인 전에는 운영 수치를 확정하지 않고 Production 준비 완료로 표시하지 않는다. Pool 고갈·트랜잭션 만료는 503 `DATABASE_BUSY` + `Retry-After`. **구현 상태**: 2026-11-25 ⑧과 예약 트랜잭션 기반(DATABASE §19.13). 2026-11-25 ③⑦(DATABASE §19.14 — live hold 정의는 기존 `ACTIVE`/`CONFIRMING` 그대로이며 주문 만료 시각이 지난 `ACTIVE`도 `expireOrder` 전까지 live; ③의 COMMIT 검사는 COMMIT 시점 조회가 커밋된 hold를 보도록 `SOLD` 전환에 READ COMMITTED를 요구 — A-029의 기존 규칙을 DB가 강제). 2026-11-26 ②(주문번호 sequence·형식 CHECK, DATABASE §19.15), ④⑤⑥(주문 생성 API·rate limit·접근 세션·멱등성, DATABASE §19.16; 미결 세부 Q-034~Q-036). | Q-013, Q-025, S2, S10, M7, M8, A-041 |
| A-054 | **Q-034~Q-036 확정 + 주문 생애주기 구현(사용자 결정 2026-11-26).** ① **Q-034**: 회차 `ends_at`이 없으면 주문 확인 접근 세션 만료 = `min(starts_at + 24시간, 발급 + 30일)`(DB 시각) — 구현(`COALESCE(ends_at, starts_at)`)과 일치. ② **Q-035**: 주문 생성 rate limit은 **성공한 주문만** 센다. 업무 거절(409·422)·실패는 롤백과 함께 카운터 증가도 취소된다. 실패 요청만 반복하는 남용을 막는 별도 제한은 아직 없다 → **실판매 전 선행 과제**(IMPLEMENTATION_PLAN Step 5 행). ③ **Q-036**: 멱등성 소유 주체 = 도메인 분리 SHA-256(`nazir:idempotency-owner:` ‖ `identity_subject_id` ‖ `browser_binding_hash`). 입력은 내부 주체 UUID(DI와 무관)와 바인딩 쿠키의 SHA-256뿐이며 원본 DI·DI HMAC·이름·전화번호·세션 토큰은 쓰지 않는다. 키를 쓰지 않으므로 24시간 보존 중 키 교체·DI 키 교체·개인정보 파기의 영향을 받지 않는다(DATABASE §5.8 정정). ④ **구현**: `expireOrder`(§11.4), 주문 생성 사전 정리(§11.2), 정기 만료 작업(`GET /api/v1/internal/jobs/expire-orders`, `Bearer CRON_SECRET`), 취소 API(§11.5) — DATABASE §19.17. 미결: Q-037(취소 시 접근 세션), Q-038(정기 작업 주기·`CRON_SECRET` 필수화). | Q-034, Q-035, Q-036 |

### 2.1 Step 2 구현 결정 D1~D8 [채택 — 사용자 승인 2026-11-16]

`D1~D8`은 Step 2 구현 중 구현자가 고른 사항을 사용자가 확정한 것이며, 확정 정책 `D-001~D-015`와는 별개의 이름 공간이다. 구현 위치는 `DATABASE.md` §19.6. `S1~S10`은 Step 2 기술 검토(2026-11-16)의 항목 번호이며 정의와 후속 Step 배정은 `IMPLEMENTATION_PLAN.md` §4.1.

| ID | 결정 |
|---|---|
| D1 | `seat_status_logs (session_seat_id, created_at)` 인덱스 승인 |
| D2 | `purchase_quotas.version` 기본값 0 승인 |
| D3 | `created_at`은 DB 기본값(`CURRENT_TIMESTAMP`) 유지, `updated_at`은 Prisma `@updatedAt` 방식 유지. raw SQL UPDATE는 `updated_at`을 명시 갱신. 일괄 timestamp 트리거 없음(Q-026 확정). 실측: Prisma Client 쓰기는 `created_at`·`updated_at`을 앱 시각으로 명시 전송, raw SQL은 DB 기본값(트랜잭션 시작 시각) — `DATABASE.md` §19.5 |
| D4 | `easy_pay_provider`·`card_company`에 허용 값 CHECK를 두지 않는다 |
| D5 | 문서에 NOT NULL이 명시된 컬럼은 NOT NULL, 그 외는 기본 nullable. 단 `outbox_events.payload`는 NOT NULL 유지 |
| D6 | 로그의 `from_status`·`to_status`에 어휘 CHECK를 두지 않는다 |
| D7 | `order_items` UPDATE·DELETE 모두 차단(Q-023, A-036) |
| D8 | Step 2에서 주문번호 sequence를 만들지 않는다. Step 5에서 전역 sequence 방식으로 결정(Q-025) |

---

## 3. 미결정 사항과 권장안 [권장]

각 항목은 **임의 확정하지 않는다.** 권장안은 구현 시 기본값/설정값으로만 사용한다.

### Q-001. 인증 세션 30분 유효기간과 인증 업체 정책의 호환성
- **현재 문서 기준:** 인증(BOOKING) 세션 유효기간은 **고정 30분으로 확정(D-015)**. 남은 질문은 NICE 측 제약 유무뿐이다.
- **권장안:** 30분 유지. 단, (1) 인증사가 인증 결과의 재사용·보관 시간을 제한하는지, (2) 인증 결과를 서비스 세션으로 일정 시간 유지하는 것이 계약상 허용되는지 확인한다. 세션 만료 후에도 진행 중 주문은 인증 주체(subject)에 귀속되므로 재인증 시 이어서 진행할 수 있다.
- **근거:** 7분 점유 + 3분 결제 보호 + 공연·좌석 탐색 시간을 고려하면 10분 이하는 재인증 빈도가 높고, 1시간 이상은 공용 PC 등에서 세션 탈취 위험이 커진다.
- **조회(LOOKUP) 세션 권장:** 10분, 읽기 전용.
- **결정 담당/기한:** 사용자 / 인증사 계약 검토 시. **상태:** 30분 고정은 D-015로 확정. NICE 측 제약은 확인 필요(E-001).
- **결정(2026-11-24, A-043):** DI HMAC(키 버전 포함), CI·원본 미저장. DI 미제공 시 자동 대체 없이 중단·보고.
- **NICE 원문 확인(2026-11-15):** 접근토큰 24시간, 인증 URL·`transaction_id` 10분 유효. 인증 결과를 서비스 세션으로 유지하는 데 대한 제약 기술은 찾지 못함 → **미확인**(PROVIDERS §2.2).

### Q-002. 동일인 식별값
- **후보:**
  1. **DI(중복가입확인정보)** — 서비스(사이트)별로 동일인에게 고정 값. 사이트 내부 중복 판별 목적에 부합.
  2. **CI(연계정보)** — 서비스 간 공통 값. 동일인 판별은 강력하나 민감도가 높아 저장·이용 근거와 보호조치 부담이 큼.
  3. **휴대폰 번호** — 1인 다회선·번호 재할당으로 동일인 판별이 부정확.
- **권장안:** 인증사가 제공하고 계약·법령상 이용이 가능하면 **DI 우선**. 원문은 저장하지 않고 서버 비밀키 기반 HMAC 값(`identity_subjects.subject_key_hash`, 키 버전 포함)만 저장. CI는 저장하지 않는 것을 기본으로 한다. DI/CI 모두 사용 불가하면 휴대폰 번호 HMAC을 임시 기준으로 쓰되, 다회선으로 한도 우회가 가능함을 운영 위험으로 기록한다.
- **근거:** 구매 한도 목적에는 사이트 내부 고정 식별값이면 충분하며, 최소 수집 원칙상 서비스 간 연계값(CI)은 불필요하다.
- **확인 필요:** 인증사별 DI/CI 제공 여부·필드명·이용 조건, 관련 법령(정보통신망법상 연계정보 처리 등) 및 개인정보처리방침 고지 문구. **상태:** 확인 필요(E-001, E-006).
- **NICE 원문 확인(2026-11-15):** 통합인증 결과 항목에 `di`, `ci`, `ci2`, `mobile_no` 등이 있다(PROVIDERS §2.2). 따라서 DI 우선안은 기술적으로 가능하다. 계약상 DI/CI 제공 범위와 별도 신청 필요 여부는 **미확인**.

### Q-003. UNKNOWN 결제 재조회 주기와 관리자 개입 기준
- **권장안(설정값):**
  - CONFIRMING 중(v1.2 수정): confirm 호출 timeout 초기값 60초(A-031). 불명확하면 orderId 조회 → `IN_PROGRESS`이고 인증 후 10분 이내면 같은 멱등키로 confirm 재시도. 3분 보호 안에서 반복.
  - 토스 특성(원문): 인증 후 10분 안에 승인하지 않은 결제는 `EXPIRED`가 되므로, confirm이 토스에 도달하지 않은 UNKNOWN은 대략 인증 후 10분 이후 재조회로 실패 확정이 가능할 것으로 예상(만료 결제의 조회 응답 형식은 **미확인** — sandbox 확인).
  - UNKNOWN 전이 직후 재조회, 이후 +1분, +2분, +5분, +10분, +20분, +30분, 이후 30분 간격(최대 공연 시작 시각까지).
  - **관리자 경보:** UNKNOWN 진입 시 정보성 알림, UNKNOWN 10분 경과 시 경보, 30분 경과 시 `review_cases(PAYMENT_UNKNOWN_PROLONGED)` 생성 및 담당자 지정.
  - 회차 시작 24시간 이내 주문은 즉시 경보 단계로 상향.
- **근거:** PG 장애 대부분은 수 분 내 복구되며, 과도한 재조회는 PG rate limit에 걸릴 수 있다. 수치는 PG 조회 API 제한 확인 후 조정.
- **상태:** 미결정.

### Q-004. 활성 주문의 정확한 상태 범위
- **확정 부분:** 결제 중(`PAYMENT_CONFIRMING`), 결제 결과 UNKNOWN(`PAYMENT_UNKNOWN`)은 활성 주문(D-008).
- **권장안:** 활성 주문 = `PENDING`, `PAYMENT_CONFIRMING`, `PAYMENT_UNKNOWN`, `REVIEW_REQUIRED`. `PAID`, `CANCELED`, `EXPIRED`, `REFUNDED`는 비활성.
  - `PAID`를 비활성으로 두는 이유: 4석 한도 내에서 추가 구매(예: 2석 결제 후 2석 추가)를 허용하기 위함. 한도는 `purchase_quotas`가 별도로 보장.
  - `REVIEW_REQUIRED`를 활성으로 두는 이유: 금전·좌석이 미해결인 상태에서 새 주문을 허용하면 중복 결제·한도 회계가 복잡해진다. 단점은 운영자 처리 전까지 고객이 같은 회차를 새로 예매할 수 없다는 점.
- **대안:** `REVIEW_REQUIRED`를 비활성으로 두고 한도만 적용.
- **상태:** **확정(D-014, 2026-11-15).** `REVIEW_REQUIRED` 포함, `UNFULFILLED` 신설(비활성). partial unique 조건은 변경 없음.

### Q-005. 결제 보호 3분 내 PG 응답이 없을 때 복구 절차
- **권장 절차:**
  1. 3분 경과(`confirm_protected_until` 경과) → 결제 `UNKNOWN`, 주문 `PAYMENT_UNKNOWN`. hold는 `CONFIRMING` 유지. **결제 실패·좌석 해제 금지.**
  2. 재조회 작업(Q-003 주기)으로 PG 거래 조회:
     - 승인 확인 + 금액 일치 → 판매 확정(PAID, 티켓 발급).
     - 승인 없음/실패 확정 → 결제 `FAILED`. 점유 7분이 아직 남았으면 `PENDING` 복귀, 지났으면 hold `EXPIRED`·주문 `EXPIRED`·한도 복구.
     - PG가 "승인 대기(인증만 완료)"로 응답 → confirm을 **같은 PG 멱등 키로 재시도**하거나(PG가 멱등 confirm을 지원하는 경우) 승인 유효시간 경과 후 실패로 확정. 토스: 상태 `IN_PROGRESS`, 멱등키 지원·10분 승인 유효(원문). `IN_PROGRESS` 결제의 조회 가능 여부는 **미확인**.
     - PG 조회 자체 불가 → UNKNOWN 유지, 경보 단계 상향.
  3. 30분 경과 → `review_cases` 생성. 관리자는 `REQUERY` action으로 재조회하거나, PG 조회 API 장애가 지속되면 SUPER_ADMIN이 PG 관리자 페이지 증빙(거래 조회 결과)을 첨부해 `RESOLVE_AS_FAILED_WITH_EVIDENCE` / `RESOLVE_AS_APPROVED_WITH_EVIDENCE`를 실행한다. 증빙 기반 처리 후에도 PG 조회가 복구되면 자동 재검증해 불일치 시 새 review case를 연다.
  4. 공연 시작 시각까지 미해결이면 운영 매뉴얼의 현장 처리 절차(좌석 확보 유지, 현장 확인)를 따른다.
- **상태:** 미결정(증빙 기반 수동 처리 허용 여부와 권한 결정 필요).

### Q-006. 동일인 기준 동시 주문 및 구매 한도 잠금 전략
- **권장안(문서 채택 A-011):** `purchase_quotas(identity_subject_id, show_session_id)` 행을 `INSERT … ON CONFLICT DO NOTHING`으로 보장한 뒤 `SELECT … FOR UPDATE`로 잠그고, `counted_seats + n <= seat_limit` 확인 후 카운터를 갱신한다. DB `CHECK (counted_seats BETWEEN 0 AND seat_limit)`와 활성 주문 partial unique가 최종 방어선이다.
- **대안 비교:**
  - `pg_advisory_xact_lock(hash)` + 파생 COUNT: 별도 테이블 불필요하나 DB 제약으로 최종 방어가 안 되고, 잠금 키 충돌·누락을 검증하기 어렵다.
  - `SERIALIZABLE` 격리 + 재시도: 정합성은 강하지만 serialization failure 재시도가 잦고 다른 트랜잭션에도 영향을 준다.
- **근거:** 카운터 행 잠금은 명시적이며, CHECK 제약으로 구현 버그도 DB가 차단한다. 파생 COUNT와 카운터의 일치는 정기 정합성 검사(`QUOTA_MISMATCH` review case)로 감시한다.
- **상태:** 채택(승인 대기).

### Q-007. 환불 성공 후 구매 한도 복구와 좌석 재판매의 원자성
- **권장안:** 환불 완료 트랜잭션 하나에서 (1) 환불 `COMPLETED`, (2) 결제 `refunded_amount` 증가, (3) 해당 티켓 `VOID`, (4) 소유 확인 후 좌석 해제(`sold_order_item_id = NULL`, 상태는 재판매 정책에 따라 `AVAILABLE` 또는 `BLOCKED`), (5) `purchase_quotas.counted_seats` 감소, (6) 주문 상태 갱신, (7) 로그·outbox를 모두 수행한다. 커밋 전에는 좌석이 재판매되지 않고, 커밋 후에는 한도와 좌석이 동시에 반영된다.
- **결정 필요:** 환불 좌석을 즉시 `AVAILABLE`로 재판매할지, `BLOCKED`로 두고 운영자가 해제할지(Q-012).
- **상태:** 원자성 방식 채택(승인 대기), 재판매 정책 미결정.

### Q-008. 사업자 선정 전 추상화해야 할 인터페이스
- **IdentityProvider:** `startVerification(purpose, nonce)`, `handleCallback(rawRequest)`, `fetchVerifiedResult(transactionId)`(서버 측 재조회), `capabilities()`(DI/CI 제공 여부, 결과 유효시간, 팝업/리다이렉트 방식, 콜백 HTTP 메서드).
- **PaymentProvider:** `createCheckout(paymentRef, amount, methods, returnUrl)`, `confirm(paymentRef, providerPaymentKey, amount, idempotencyKey)`, `getPayment(paymentRef | providerPaymentId)`, `verifyWebhook(rawRequest)` / `parseWebhook`, `getRefunds(providerPaymentId)`, `capabilities()`(서버 승인형 여부, 승인 유효시간, confirm 멱등성, webhook 서명, 부분 취소, 지원 결제수단).
- **Mock adapter:** timeout, UNKNOWN, 지연 승인, 중복 승인, 금액 불일치, 순서 역전 webhook, 서명 위조, 인증 실패·재사용 등 장애 주입을 지원해야 한다.
- **상태:** 채택(승인 대기). v1.2에서 토스·NICE 원문 기준 최종안으로 갱신 — ARCHITECTURE §6.1~§6.2 참조. 업체 고유 값은 adapter 내부에서만 처리하고 도메인에는 정규화 결과만 전달.

### Q-009. 인증 결과 재사용 및 브라우저 바인딩 보안
- **권장안(문서 채택 A-009):**
  - 첫 방문 시 `__Host-` 접두사, HttpOnly, Secure, SameSite=Lax 바인딩 쿠키 발급. DB에는 hash만 저장.
  - 인증 시작 시 바인딩 hash와 단일 사용 nonce를 `identity_verifications`에 기록.
  - 콜백은 결과를 `VERIFIED`로만 기록하고, 같은 출처의 claim 요청(바인딩 쿠키 일치, claim 유효시간 권장 5분)에서만 세션을 발급하고 `CONSUMED`로 전이(1회성).
  - `(provider, provider_transaction_id)` UNIQUE로 동일 인증 거래의 재사용 차단.
  - claim 시 세션 토큰을 새로 발급(fixation 방지), 기존 같은 바인딩의 동일 purpose 세션은 폐기.
- **잔여 위험:** 바인딩 쿠키와 세션 쿠키가 함께 탈취되면 막을 수 없다(XSS 방어, HttpOnly에 의존).
- **상태:** 채택(승인 대기).

### Q-010. 4석 제한을 관리자 수동 판매 등 향후 채널에도 적용할지
- **권장안:** 모든 판매 채널이 동일한 `purchase_quotas`를 사용하는 것을 기본으로 한다. 관리자 수동 판매(Phase 1 범위 밖)가 도입되면 한도 초과는 SUPER_ADMIN의 명시적 override + 사유 + 감사 로그로만 허용한다.
- **근거:** 채널별로 한도를 달리하면 매크로·대리 구매 우회 경로가 생긴다.
- **상태:** 미결정(Phase 2 이전 결정).

### Q-011. 결제 시작 최소 잔여 점유 시간
- **권장안:** 남은 점유 시간이 60초 미만이면 결제 시작(`POST /orders/{id}/payments`)을 거부하고 취소 후 재예매를 안내한다. PG가 결제창 유효시간 지정을 지원하면 남은 점유 시간 이하로 설정한다.
- **근거:** 7분 경과 후 PG 인증을 마치고 돌아오면 confirm 전 검증에서 거부되어(결제 미발생) 사용자 경험이 나쁘다.
- **상태:** 미결정.

### Q-012. 환불 좌석 재판매 정책
- **권장안:** 기본값 `BLOCKED`(운영자가 확인 후 해제). 판매 재개 자동화는 운영 안정화 후 검토.
- **근거:** Phase 1은 수동 환불이며, 현장·좌석 상황 확인 없이 즉시 재판매하면 분쟁 위험이 있다. 다만 매출 기회 손실이 있으므로 사용자 결정 필요.
- **상태:** 미결정.

### Q-013. 접근 세션·세션 TTL 및 rate limit 수치
- **권장안:** 주문 확인서 접근 세션(`order_access_sessions`) = 해당 회차 종료 후 24시간까지(최대 30일). 관리자 세션 = 유휴 30분/절대 12시간. Rate limit은 IP·바인딩·인증 주체 단위로 설정(인증 시작 IP당 10회/10분 등은 초안 수치).
- **인증 세션 주문 생성 제한(D-015, 수치 권장):** BOOKING 세션당 주문 생성 3회, 인증 주체·회차당 시간당 주문 생성 5회. 초과 시 재인증 또는 대기. 이 제한은 남용 방지용이며 무결성 규칙이 아니므로 rate limit 저장소로 관리하고, 동시 요청 경합 시 소폭 초과를 허용한다(DB 컬럼 추가 없음).
- **저장소:** Phase 1은 PostgreSQL 기반 카운터(별도 인프라 불필요) 또는 관리형 Redis 중 선택. 서버리스 메모리 기반 rate limit은 금지. NICE 접근토큰 공유 캐시(A-028)도 같은 저장소 결정에 포함.
- **상태:** **저장소 확정(2026-11-24, A-045): PostgreSQL 카운터, 토큰 캐시는 별도 테이블.** 수치는 권장안을 설정값으로 시작. **주문 생성 수치·주문 확인 접근 세션 수명 확정(2026-11-25, A-053 ④⑤)**: 세션당 3회/30분, 주체·회차당 5회/1시간, 접근 세션 `min(회차 종료 + 24시간, 발급 + 30일)`.

### Q-014. Google Sheets 역반영
- **권장안:** Phase 1에서는 Sheets를 **읽기 전용 mirror**로 운영하고 역반영(운영 메모 → DB)을 구현하지 않는다. 운영 메모는 관리자 화면에서 입력(`orders.admin_memo`).
- **근거:** 역반영은 polling·충돌 해결·권한 검증이 필요하며 11/30 일정에 위험.
- **상태:** 미결정.

### Q-015. 관리자 MFA와 권한 매트릭스
- **권장안:** Phase 1에서 SUPER_ADMIN은 TOTP 기반 MFA 필수, STAFF는 권장. 권한 매트릭스는 API_SPEC §5.1 초안을 따른다.
- **상태:** 미결정.

### Q-016. 개인정보 저장 방식
- **권장안:** 전화번호·이름은 애플리케이션 레벨 암호화(키 관리: 호스팅 secret manager 또는 KMS), 조회는 인증 주체 기준으로 하므로 전화번호 검색 인덱스는 두지 않는다. Sheets에는 마스킹된 전화번호만 전송.
- **상태:** **암호화·키 관리 확정(2026-11-24, A-043).** 보관·파기 기간은 미확정(판매 개시 전 확정 필요, E-006).

### Q-017. 카카오페이 추가 시점
- **사실(원문):** 카카오페이는 전자결제 계약 이후 MID로 발급받은 테스트 키로만 테스트 가능(PROVIDERS §1.5).
- **권장안:** 토스 계약 후 테스트 가능해지면 sandbox 검증(SBX-*) 통과 시 추가. 개시 조건에는 포함하지 않는다.
- **상태:** 미결정.

### Q-018. "결제 가능 범위가 지나치게 제한"의 판정 기준(D-012)
- **권장안(사용자 결정 필요):** 다음 중 하나라도 충족하지 못하면 판매 연기를 검토한다 — (a) 9개 주요 카드사 중 과반(5개) 이상 라이브 사용 가능, (b) 토스페이·네이버페이 중 1개 이상 라이브 사용 가능, (c) 승인된 수단만 노출·미승인 수단 차단이 sandbox·라이브에서 검증됨.
- **근거:** 원문상 카드사 심사는 9개 주요 카드사 대상이며 각 사 정책에 따라 진행된다(PROVIDERS §1.9). 수치는 판단 기준 초안이다.
- **상태:** 미결정.

### Q-019. 스테이징에서 NICE 실인증 사용과 개인정보
- **사실(원문):** NICE 휴대폰 본인확인은 무료 테스트 건수가 없고 과금시작일부터 실제 인증 건수가 차감된다(PROVIDERS §2.3).
- **권장안:** 스테이징 NICE 연동 테스트는 팀 구성원 본인 인증으로만 수행, 건수 상한을 정하고, 스테이징 DB의 실명·전화번호는 테스트 종료 후 파기한다. 일반 개발·CI는 Mock만 사용.
- **상태:** 미결정.

### Q-020. NICE Outbound IP 등록을 위한 고정 출구 IP 확보
- **사실(원문):** 이용기관 서버의 Outbound IP를 등록해야 client_id/secret이 발급되며, AWS·Cloudflare 이용 시 별도 문의(PROVIDERS §2.2).
- **권장안:** 호스팅 선택 시 NICE 호출 경로의 고정 출구 IP 확보 방법(호스팅 상품 기능 또는 별도 고정 IP 프록시)을 필수 요건으로 확인하고 NICE에 사전 문의한다. 호스팅 상품의 고정 IP 지원 여부는 **미확인**.
- **상태:** 확인 필요(E-007). **NICE 일정의 선행 조건.**

### Q-021. 통합결제창에서 간편결제 노출 제어
- **사실(원문):** `flowMode: DEFAULT`에서 `cardCompany`는 표시 카드사를 제한하지만 `easyPay`는 무시된다(PROVIDERS §1.5). 통합결제창에서 계약된 간편결제를 숨길 수 있는지는 **미확인**.
- **권장안:** 카드는 DEFAULT + 승인 카드사 `cardCompany`, 토스페이·네이버페이는 DIRECT + `easyPay`로 서비스 화면에서 수단을 먼저 고르게 한다. 통합결제창이 허용 외 간편결제를 노출하면 승인 후 검증(A-030)으로 확정을 막고, 토스에 선택적 활성화를 문의한다.
- **상태:** 확인 필요(sandbox, 토스 문의).

### Q-022. 허용되지 않은 결제수단으로 승인된 결제의 기록 방식 (Step 2 구현 중 발견)
- **질문:** `DATABASE.md` §7.1은 `CHECK (method_type IN ('CARD','EASY_PAY'))`(D-005)를 요구한다. 반면 A-030/§11.6은 PG가 허용되지 않은 수단(가상계좌 등)이나 허용 목록 밖 카드사·간편결제사로 **승인했다고 보고하면 확정하지 않고 `role = EXCESS` + `review_cases(DISALLOWED_METHOD)`로 처리**하라고 한다. 이때 `payments` 행의 `method_type`(NOT NULL)에 넣을 값이 정의되어 있지 않다. 토스 대응표는 "허용 외 값은 `DISALLOWED`"라고만 한다.
- **선택지:** (a) `method_type` CHECK를 `CARD`/`EASY_PAY`/`OTHER`(또는 `DISALLOWED`)로 확장하고 `OTHER`는 항상 `role = EXCESS`로 제한하는 추가 CHECK, (b) `method_type`을 nullable로 하고 허용 외는 NULL + `review_cases.detail`에 원문 수단 기록, (c) 현행 CHECK 유지하고 허용 외 승인은 가장 가까운 값으로 강제 매핑(권장하지 않음: 사실 왜곡).
- **영향:** `payments_method_type_ck`, `easy_pay_provider`/`card_company` 허용 값 CHECK 여부(현재 없음), Step 6 결제 확정 경로, TEST PAY-17·PAY-26.
- **권장:** (a). 승인된 결제를 DB에 기록하지 못하는 경로를 없애는 것이 환불 추적에 필수다.
- **결정 담당:** 사용자. **상태:** **확정(2026-11-16, A-034).** `method_type`에 `OTHER` 추가, 승인된 허용 외 결제는 `role = EXCESS`로 기록하고 `review_cases(DISALLOWED_METHOD)`를 연다. 생성 시 값(사용자가 요청한 `CARD`/`EASY_PAY`)과 PG 승인 응답에서 확인된 값을 구분한다: `OTHER`는 `SUCCEEDED` + `EXCESS`에서만 허용되고 진행 중·실패·취소·`PRIMARY`는 DB가 거부한다. 요청 수단은 `review_cases.detail`에 남긴다. 구현: `DATABASE.md` §7.1, `payments_method_type_ck`·`payments_method_type_other_ck`.

### Q-023. `order_items` 삭제 차단 범위 (Step 2)
- **질문:** §5.2는 "생성 후 UPDATE·DELETE하지 않는다"고 하면서 DB 보호로는 UPDATE 차단 트리거만 언급한다. 현재 UPDATE는 트리거로, 다른 테이블이 참조하는 항목의 DELETE는 `ON DELETE RESTRICT`로 막히지만 **참조되지 않는 항목의 DELETE는 허용**된다(주문 생성 트랜잭션 롤백 외에는 필요 없음).
- **선택지:** (a) 현행 유지, (b) DELETE도 트리거로 차단(주문 생성 롤백은 트랜잭션 취소이므로 영향 없음. 단 향후 개인정보 파기·보관기간 작업이 항목을 지워야 하면 우회 절차 필요).
- **영향:** DATABASE §5.2, TEST ORD-17, Q-016(보관·파기).
- **결정 담당:** 사용자. **상태:** **확정(2026-11-16, A-036).** (b) 선택 — UPDATE와 DELETE 모두 차단. 향후 개인정보 파기·보관기간 만료는 이 원장을 임의 삭제하는 방식이 아니라 별도 정책·권한으로 다룬다(Q-016). 구현: `order_items_no_update`·`order_items_no_delete`.

### Q-024. 인증 세션과 원 인증 거래의 주체·용도 일치를 DB가 보장하지 않음 (Step 2)
- **질문:** `identity_sessions.identity_subject_id`/`purpose`가 연결된 `identity_verifications`와 같아야 한다는 규칙(§6.3 "claim 트랜잭션에서 검증")은 서비스 검증에만 의존한다. 규칙 12(주문↔인증 세션 주체 일치)는 DB가 보장하지만 이 한 단계 위는 아니다.
- **선택지:** (a) 현행(서비스 검증), (b) `identity_verifications`에 `UNIQUE (id, identity_subject_id, purpose)`를 두고 `identity_sessions (identity_verification_id, identity_subject_id, purpose)` 복합 FK 추가.
- **영향:** 제약 2개 추가(컬럼·테이블 추가 없음), Step 4 claim 트랜잭션, MIG-04 목록.
- **권장:** (b). 한도·활성 주문의 기준인 `identity_subject_id`가 잘못 연결되는 사고를 DB가 막는다. 설계 변경이므로 사용자 승인 필요.
- **결정 담당:** 사용자. **상태:** **확정(2026-11-16, A-035).** (b) 선택 — 복합 UNIQUE + 복합 FK로 DB가 강제. 인증 세션 1건당 원 인증 1건 규칙 유지. 구현: `identity_verifications_id_subject_purpose_uq`, `identity_sessions_verification_subject_purpose_fk`.

### Q-025. 주문번호 형식과 DB sequence (Step 2에서 보류)
- **질문:** §5.1은 `NZ-202611-000001` 예시와 "DB sequence 기반 생성"을 말하지만 월별 리셋 여부·자릿수·동시성(sequence는 롤백 시 번호가 비는 것을 허용) 정책이 없다.
- **선택지:** (a) 전역 단일 sequence + 월 표기만 포맷, (b) 월별 카운터 테이블(번호 연속, 잠금 필요), (c) 전역 sequence 번호 + 난수 검증 문자.
- **영향:** `orders.order_number`(UNIQUE는 구현됨), Step 5 주문 생성, 고객 문의 처리(번호 공개).
- **권장:** (a). 번호 결번을 허용하고 락 경합을 피한다.
- **결정 담당:** 사용자. **기한:** Step 5 착수 전. **상태:** **방향 승인(2026-11-16, D8)**: 전역 sequence 방식. **확정(2026-11-25, A-053 ②)**: `NZ-YYYYMM-NNNNNN`, 전역 sequence·초기화 없음, 월은 KST, 최소 6자리·자동 확장, 검증 문자 없음, 결번 허용. **구현(2026-11-26)**: `order_number_seq`(bigint, NO CYCLE), `next_order_number(at timestamptz DEFAULT now())`, CHECK `^NZ-[0-9]{6}-[0-9]{6,}$`(DATABASE §19.15).

### Q-026. `updated_at` 자동 갱신 방식 (Step 2)
- **질문:** 현재 `updated_at`은 Prisma Client(`@updatedAt`)만 갱신한다. Step 5 이후 잠금 쿼리를 raw SQL로 쓰면 서비스가 직접 갱신해야 하고 누락될 수 있다.
- **선택지:** (a) 현행 + 코드 리뷰 규칙, (b) 공용 `BEFORE UPDATE` 트리거로 `updated_at = now()` 강제(`order_items`는 해당 없음).
- **영향:** 모든 `updated_at` 보유 테이블(트리거 19개), Sheets outbox의 `aggregate_version`과는 별개.
- **권장:** (b)는 마이그레이션 1개로 해결되나 설계 문서에 없는 DB 객체 추가이므로 승인 후 도입.
- **결정 담당:** 사용자. **상태:** **확정(2026-11-16, D3).** (a) 현행 유지 — `created_at`은 DB 기본값, `updated_at`은 Prisma `@updatedAt`, raw SQL UPDATE는 `updated_at`을 명시 갱신, 일괄 트리거 없음. 이전 보고의 "`created_at`도 앱 시각" 설명은 실측으로 **Prisma Client 쓰기에 한해 사실**임을 확인했다(`DATABASE.md` §19.5, 테스트 DB-02). raw SQL이 생략하면 DB 시각(트랜잭션 시작 시각)이다.

### Q-027. 결제수단의 요청값과 PG 보고 원문의 보존 (Step 2 PR 전 검토) (채택·구현)
- **문제:** 현재 `payments.method_type`은 상태에 따라 다른 사실을 담는다. `READY`~`UNKNOWN`에서는 **사용자가 요청한 수단**, 승인 후에는 **PG가 보고한 수단**(허용 외면 `OTHER`)이다(A-034). 승인 때 덮어쓰므로 **요청값이 사라진다**(실측: `CARD` 요청 → `OTHER` 승인 후 행에 `CARD` 흔적 없음). PG가 보낸 **원본 수단 문자열**(토스 한글 `method`, 간편결제 코드)은 어디에도 저장되지 않는다(`confirm` 응답은 매핑된 필드만 남는다). 요청 수단은 허용 외 승인으로 `review_cases`가 열릴 때만 `detail`에 남고, **허용된 수단끼리의 불일치**(예: 카드로 요청했는데 통합결제창에서 간편결제를 선택)는 어디에도 남지 않는다. `easy_pay_provider`도 요청값과 보고값이 같은 컬럼이다.
- **왜 필요한가:** ① 환불 절차가 수단별로 다르다(D-007: PG 관리자 페이지 수동 환불). `OTHER`만으로는 가상계좌·휴대폰·계좌이체를 구분할 수 없다. ② Q-021(통합결제창의 간편결제 노출 제어 미확인)이 실제로 얼마나 일어나는지 측정하려면 요청과 보고를 비교해야 한다. ③ 분쟁 시 "무엇을 요청했고 무엇이 승인됐는가"의 증빙. ④ A-030은 결제 **시작 시점** 허용 목록을 기준으로 판정하므로 감사 재현에 요청 수단이 필요하다(허용 목록 스냅샷 자체는 저장하지 않는다).
- **A-030·A-034와의 일치:** 의미는 일치한다(변경 없음). 다만 A-034/Q-022가 "요청 수단은 `review_cases.detail`에 남긴다"고 한 보완책은 **review case가 생기는 경우에만** 성립한다.
- **선택지:**
  - (0) 현행 유지 — review case와 웹훅 `payload_redacted`에 의존. 컬럼 추가 없음. 허용된 수단 간 불일치·승인 원문은 보존되지 않음.
  - (1) **최소 2컬럼** — `requested_method_type`(`NOT NULL`, `CARD`|`EASY_PAY`, 생성 후 불변) + `provider_method_raw`(`varchar(100)` NULL, PG가 보고한 수단 원문 라벨 그대로, **판정에는 쓰지 않음**). CHECK: `method_type = 'OTHER'`이면 `provider_method_raw` 필수. `method_type`·`easy_pay_provider`·`card_company`는 현행 의미(정규화된 유효값)를 유지한다.
  - (2) (1) + `requested_easy_pay_provider` — DIRECT 흐름에서는 요청한 간편결제사가 바뀔 수 없으므로 근거가 약하다.
  - (3) (1) + 승인 응답 redacted JSON 스냅샷 — 개인정보·크기 위험, 비권장.
- **추천: (1).** 이유: 요청값 소실은 되돌릴 수 없는 정보 손실이고, `OTHER`의 원문은 환불 절차 선택에 직접 필요하다. 지금은 데이터가 없어 `NOT NULL` 컬럼을 backfill 없이 추가할 수 있다(병합 후에는 과거 요청값을 복원할 수 없다). 비용은 컬럼 2개 + CHECK 1~2개(+ 불변 트리거는 선택).
- **영향:** `payments` 컬럼·CHECK, 상수(`PAYMENT_REQUEST_METHOD_TYPE`), Step 6 adapter 매핑(`DISALLOWED` → `OTHER` + 원문), `confirmOrder` 등 테스트 픽스처, TEST PAY-17·PAY-27.
- **결정 담당:** 사용자. **상태:** **채택·구현(2026-11-17, A-039).** 선택지 (1) 채택. 구현 위치(2026-11-18 보강: 미승인 결제의 `method_type` = 요청값 CHECK `payments_unapproved_method_matches_request_ck` 추가): `prisma/schema.prisma` `Payment`, `integrity_constraints` §B(CHECK 3개)·§C(`payments_requested_method_no_change`), `src/server/db/payment-method.ts`, 테스트 `tests/contract/schema/ledger-claims.test.ts` A-039·`tests/unit/payment-method.test.ts`. **제한:** 결제 서비스 코드는 Step 6에서 만든다. 지금은 DB 제약과 순수 함수가 생성 시 요청값 기록·승인 시 불변을 보호한다.

### Q-028. 인증 세션 생성 시 원 인증의 상태·브라우저 바인딩 검증 (Step 2 PR 전 검토) (채택·구현)
- **문제:** A-035(Q-024)는 세션의 **주체·용도**를 원 인증과 맞춘다. 그러나 DB는 세션을 만들 때 원 인증의 **`status`**와 **`browser_binding_hash`**를 보지 않는다. 실측(2026-11-17, 현재 DB): 주체가 설정된 `PENDING`/`FAILED`/`EXPIRED`/`VERIFIED`/`CONSUMED` 인증 **모두** 세션 생성 가능, 세션을 만든 뒤 인증이 `VERIFIED`로 남음, 세션이 있는 인증을 `PENDING`/`FAILED`로 되돌리기, 세션 없는 `CONSUMED`, **다른 브라우저의 바인딩 해시를 가진 세션**, 이미 지난 `claim_expires_at` 모두 허용된다.
- **기존 생명주기와의 대조**(DATABASE §6.2, API_SPEC claim: "상태 `VERIFIED`, `claim_expires_at` 이전", 세션 발급과 `CONSUMED`는 한 트랜잭션):

| 인증 상태 | 주체 설정 | 세션 | 근거 |
|---|---|---|---|
| `PENDING` | 없음("검증 후 설정") — 설정되어 있어도 행 자체는 해롭지 않음 | **불가** | 아직 검증 전 |
| `VERIFIED` | 있음(CHECK) | claim 중에만. **같은 트랜잭션이 끝나면 `CONSUMED`여야 함** | claim 대상 |
| `CONSUMED` | 있음(CHECK) | **반드시 있음(1회성)** | 세션 발급 완료 |
| `FAILED` | 보통 없음. 있어도 모호 | **불가** | 검증 실패 |
| `EXPIRED` | `VERIFIED` 후 claim 기한 경과면 있음 | **불가** | 교환 기한 경과 |

- **제안(프로토타입으로 검증, 저장소에는 추가하지 않음):** ① 세션 복합 FK를 4컬럼으로 확장(`identity_verifications UNIQUE (id, identity_subject_id, purpose, browser_binding_hash)`) — 다른 브라우저의 claim을 DB가 거부. ② **지연(DEFERRABLE INITIALLY DEFERRED) constraint trigger 2개**: 세션이 있으면 원 인증은 최종 상태가 `CONSUMED`, `CONSUMED`이면 세션이 존재(양방향). 프로토타입 결과: 정상 8가지(`PENDING`→`VERIFIED`→세션→`CONSUMED`, `CONSUMED` 먼저·세션 나중, 이미 `VERIFIED`로 생성된 인증의 claim, `PENDING`→`FAILED`, `VERIFIED`→`EXPIRED`, 주체가 있는 `PENDING`/`FAILED` 행 단독, 세션의 `REVOKED`/`EXPIRED`)는 **모두 허용**, 나쁜 7가지(`PENDING`/`FAILED`/`EXPIRED`/`VERIFIED`로 남은 인증의 세션, 세션 있는 인증을 `FAILED`로, 세션 없는 `CONSUMED`, 다른 바인딩)는 **모두 거부**.
- **의도적으로 제안하지 않는 것:** `PENDING`/`FAILED`에 주체를 금지하는 CHECK(기존 절차에서 `FAILED`+주체 가능성이 문서에 불명확하고 이득이 작아 정상 절차를 막을 위험이 더 큼), `claim_expires_at` 시간 검사(NULL의 의미 미정, 서비스 책임 + 테스트가 적절).
- **선택지:** (0) 현행(서비스 검증) (1) 4컬럼 FK만 (2) **FK + 지연 trigger 2개(추천)**.
- **추천: (2).** 이유: 구매 한도·활성 주문의 기준 `identity_subject_id`와 브라우저 바인딩은 보안의 핵심이고(CLAUDE_HANDOFF §8 "다른 브라우저에서 인증 세션 재사용 금지"), 서비스 버그 하나로 `PENDING` 인증이 세션이 되는 경로를 DB가 닫는다. 정상 절차는 막지 않음을 프로토타입으로 확인했다.
- **영향:** 인증 FK·unique·trigger 추가(컬럼 추가 없음), Step 4 claim 트랜잭션(커밋 시점 오류 처리), MIG-13 확장.
- **결정 담당:** 사용자. **상태:** **채택·구현(2026-11-17, A-040).** 선택지 (2) 채택. 구현 위치: `init_schema`(4열 unique·FK), `integrity_constraints` §E(함수 3개, 지연 trigger 2개), 테스트 `ledger-claims.test.ts` A-040. **보존·삭제와의 충돌:** `orders.identity_session_id`가 RESTRICT이므로 주문을 만든 세션·인증은 영구 보존된다. 개인정보 컬럼은 UPDATE로 제거할 수 있다. 주문이 없는 claim의 삭제는 세션 → 인증 순서로 같은 트랜잭션에서 해야 한다(그 외는 COMMIT에서 거부). 보존 기간 정책은 Q-016에서 별도 결정한다.

### Q-029. 원장성 테이블의 보호 범위 (A-038 이후) (한정 채택·구현)
- **문제:** A-038은 `payments` DELETE만 막는다. 실측(2026-11-17)으로 다음은 **지금 삭제·수정할 수 있다**: `tickets`(DELETE·UPDATE), `refunds`(항목 없는 행 DELETE, UPDATE), `refund_items`·`seat_holds`(DELETE), `payment_status_logs`·`order_status_logs`(DELETE·UPDATE), `seat_status_logs`·`payment_webhook_events`(DELETE), **`admin_audit_logs`(DELETE·UPDATE — A-022 P0 감사 로그)**, 참조 없는 `orders`(DELETE). §1.1 원칙 3("금전·좌석·티켓·인증 이력은 보존")과 FK RESTRICT만으로는 보장되지 않는다.
- **분류 제안**(`ledger_reject_delete()`를 재사용할 수 있다):

| 구분 | 테이블 | 제안 |
|---|---|---|
| append-only(UPDATE·DELETE 차단) | `payment_status_logs`, `order_status_logs`, `seat_status_logs`, `admin_audit_logs` | 이력 변조 불가 |
| 원장(DELETE 차단) | `refunds`, `refund_items`, `tickets`, `orders`, `seat_holds` | 종료는 상태 전이로 |
| 보관기간으로 지워야 하는 것(차단하지 않음) | `idempotency_records`, `order_access_sessions`/`identity_sessions`/`admin_sessions`(만료 정리), `outbox_events`(SENT 정리), `payment_webhook_events`·`identity_verifications`(개인정보·보관기간 Q-016) | 삭제 주체·기간은 별도 정책 |

- **선택지:** (0) `payments`만(현행) (1) 위 분류 중 append-only + 원장 전부 (2) 감사 로그(`admin_audit_logs`)와 금전 원장(`refunds`, `refund_items`)만 우선.
- **추천: (2)를 이번에, 나머지는 해당 Step에서.** 이유: 감사 로그와 환불은 금전·운영 책임의 증거이고 이후 Step의 서비스 로직과 충돌하지 않는다. 상태 로그·티켓·hold는 Step 5·8에서 실제 쓰기 패턴(예: 환불 후 티켓 `VOID`, hold 상태 전이)을 확인한 뒤 확정하는 편이 안전하다. 어느 쪽이든 TRUNCATE와 소유자 권한은 Step 10 DB 역할 분리(S9)로 통제한다.
- **결정 담당:** 사용자. **상태:** **한정 범위로 채택·구현(2026-11-17, A-041).** `admin_audit_logs`·`payment_status_logs`·`refund_items`(UPDATE+DELETE)와 `refunds`(DELETE)만. `tickets`·`orders`·`seat_holds`·`order_status_logs`·`seat_status_logs`·`payment_webhook_events`는 보호하지 않았고 해당 Step에서 재결정한다. 구현 위치: `integrity_constraints` §D, 테스트 `ledger-claims.test.ts` A-041(벌크·실제 COMMIT 포함). **알려진 충돌:** 개인정보가 섞인 감사 로그의 파기·정정은 이제 DB 트리거 때문에 일반 DELETE/UPDATE로 할 수 없다. 보존 정책(Q-016)이 결정되면 별도 권한·절차(마이그레이션 또는 트리거 우회 역할)로 다룬다.

---

## 4. 외부 확인 필요 [외부 확인]

| ID | 항목 | 확인 내용 | 구현 영향 | 상태 |
|---|---|---|---|---|
| E-001 | 본인인증사 | **NICE아이디 확정(D-009).** 원문 확인: 통합인증 API(토큰 24시간, URL·transaction_id 10분, return_url GET/POST, 서버 결과 요청 + 암호화 결과 복호화), 결과 항목(name, mobile_no, ci, di 등), Outbound IP 등록, 무료 테스트 없음, 통신사 3사 심사 3~5영업일. **미확인:** 결과 요청 기한·재조회 가능 여부, 결과 요청 시 토큰 동일성, 세션 유지 제약, DI/CI 제공 조건 | IdentityProvider, Q-001, Q-002, Q-019, Q-020 | 부분 확인 |
| E-002 | PG사 | **토스페이먼츠 확정(D-009), 결제창 API 개별 연동(D-010).** 원문 확인: 서버 승인형·10분 승인 유효, orderId 조회(API 개별 연동 키), 멱등키, 웹훅 서명 헤더·보안 키·10초 응답·7회 재전송, 결제수단 파라미터, 키 접두사, 카드사 심사 요건. **미확인:** 일반 승인 권장 timeout, IN_PROGRESS·EXPIRED 조회 응답, 국내 결제 취소 시 웹훅 발송, easyPay 코드 값, 통합결제창 간편결제 노출 제어, 결제수단 선택적 활성화, 간편결제 라이브 심사 | PaymentProvider, A-001, A-030, A-031, Q-003, Q-005, Q-021 | 부분 확인 |
| E-003 | 공연장·좌석 | 공연장, 좌석 배치도, SVG 좌석 ID 규칙 | seed 데이터, 좌석 UI | 확인 필요 |
| E-004 | 가격·수수료 | 구역별 가격, 예매 수수료·할인 유무 | `total_amount = 항목 합계` 전제 | 확인 필요 |
| E-005 | 환불 규정 | 취소 가능 기간, 취소 수수료, 관련 소비자 보호 기준 | 환불 금액 계산, 약관 | 확인 필요 |
| E-006 | 개인정보·법률 | 개인정보처리방침, 위탁·제공 고지, 보관·파기 기간, DI/CI 처리 근거 | Q-002, Q-016 | 확인 필요 |
| E-007 | 호스팅·DB | 상업적 이용 가능한 플랜, 1분 주기 스케줄러 지원, 함수 최대 실행시간(confirm 60초 + 재시도 수용), 서울 리전, 커넥션 풀링 방식, **NICE 등록용 고정 Outbound IP(Q-020)** | 백그라운드 작업, NICE 연동 | 확인 필요 |
| E-008 | PG 심사 요건 | 원문 확인: 토스 심사 1~2일, 카드사 심사 최대 14일(요청 후 7~10일), 9개 주요 카드사, **실제 판매 사이트에서 상품·결제창(테스트 키 연동) 확인**. 미확인: 사업자등록·통신판매업 신고·약관 게시 등 세부 서류 | 공개 일정(심사용 공개 사이트 선행 배포) | 부분 확인 |
| E-009 | SMS 공급사 | Phase 2 | Phase 2 | 보류 |
| E-010 | QR 규격·스캔 앱 | Phase 2~3 | Phase 2~3 | 보류 |
| E-011 | Sheets 운영 컬럼·권한 | 실제 컬럼, 공유 범위 | Outbox payload | 확인 필요 |


### Q-030. 판매 종료(`CLOSED`) 공연의 공개 노출 (Step 3)
- **질문:** `shows.status = CLOSED`인 공연을 공개 목록·상세에 계속 보여 줄 것인가.
- **선택지:** (a) 숨김(목록 제외, 상세 404) (b) 목록·상세에 "판매 종료"로 표시 (c) 상세만 공개.
- **영향:** `src/server/catalog/public-catalog.ts`의 `PUBLIC_SHOW_STATUSES` 한 곳. 판매 상태 계산(`computeSalesStatus`)은 이미 `CLOSED` 공연의 회차를 `CLOSED`로 계산한다. 테스트 CAT-API-01.
- **결정 담당:** 사용자. **상태:** **미결정.** 구현은 임시 기본값 (a) 숨김 — 노출 범위를 좁히는 쪽. 확정 아님.

### Q-031. 공개 조회 API의 캐시·rate limit (Step 3)
- **질문:** API_SPEC §4.3이 허용한 "짧은 캐시"와 IP rate limit의 수치·저장소.
- **현황:** 일시 품절(`TEMPORARILY_UNAVAILABLE`)·임시 점유는 7분·3분 안에 바뀌므로 캐시가 길면 실제와 다른 상태가 보인다. 구현은 `Cache-Control: no-store`이고 rate limit은 없다(Q-013 저장소 미정).
- **결정 담당:** 사용자/개발. **상태:** **미결정**(Q-013과 함께).

### Q-032. `BLOCKED` 좌석만 남은 회차·좌석이 없는 회차의 표시 (Step 3, 1차 리뷰)
- **질문:** 예매 가능·임시 점유 좌석이 0이고 남은 좌석이 모두 `BLOCKED`(관리자 차단, Q-012 권장안의 환불 좌석)일 때, 또는 판매 좌석이 0석일 때 "매진"으로 표시할 것인가.
- **현황:** 현재 `SOLD_OUT`(매진). `BLOCKED`는 해제할 수 있는 상태라 영구 매진이 아닐 수 있다. 테스트 CAT-08·CAT-API-02가 **현재 동작만** 고정한다.
- **결정 담당:** 사용자. **상태:** **미결정.**

### Q-033. 판매 불가 사유의 표시 우선순위 (Step 3)
- **질문:** `NOT_PUBLIC` > `CANCELED` > `CLOSED` > `PAUSED` > `UPCOMING` > 좌석 상태(`ON_SALE`/`TEMPORARILY_UNAVAILABLE`/`SOLD_OUT`)의 순서를 승인할 것인가.
- **현황:** Step 3 조사의 제안으로 구현했다. 판매 가능 여부는 DATABASE §11.11과 정확히 같고(CAT-05), 순서는 "판매 불가일 때 어떤 문구를 보이는가"에만 영향을 준다. 확정된 것은 좌석 유무 3상태의 문구(예매 가능·일시 품절·매진, 2026-11-21)뿐이다.
- **결정 담당:** 사용자. **상태:** **승인 대기.**

### Q-034. 회차 종료 시각(`ends_at`)이 없을 때 주문 확인 접근 세션 만료 (Step 5)
- **질문:** A-053 ⑤ `min(공연 종료 시각 + 24시간, 발급 + 30일)`의 "종료 시각"은 `show_sessions.ends_at`인데 이 컬럼은 NULL을 허용한다.
- **현황(구현 기본값):** `COALESCE(ends_at, starts_at) + 24시간`(시작 시각으로 대체 — 접근 기간이 더 짧아지는 쪽). 회차 등록 시 `ends_at`을 필수로 하는 안도 있다.
- **선택지:** (a) 현행(시작 시각 대체), (b) `ends_at` 없으면 30일 상한만 적용, (c) 회차 `ends_at` 필수화(migration).
- **결정 담당:** 사용자. **상태:** **확정(2026-11-26, A-054 ①)** — (a) 시작 시각 + 24시간, 30일 상한.

### Q-035. 거절된 신규 주문 요청의 주문 생성 횟수 집계 (Step 5)
- **질문:** `order.create.*` 카운터는 주문 트랜잭션 안에서 증가하므로, 그 요청이 업무 거절(좌석 없음·한도 초과 등)·실패로 롤백되면 카운터 증가도 함께 롤백된다. 즉 **성공한 주문 생성만 센다**(D-015 "주문 생성 횟수" 문언과 일치). 동시 동일 요청의 중복 집계를 막기 위한 구조다(TEST CO-12, IDM-05).
- **영향:** 실패 요청만 반복하는 남용은 이 카운터로 막히지 않는다(바인딩·세션·인증 시작 제한, DB 부하는 lock/statement timeout이 한정).
- **선택지:** (a) 현행(성공만 집계), (b) 거절 시 별도 짧은 트랜잭션으로 카운터만 증가(동시 동일 요청 보호는 유지 가능하나 경로 복잡).
- **결정 담당:** 사용자. **상태:** **확정(2026-11-26, A-054 ②)** — (a) 성공만 집계. 실패 반복 남용 대비 제한은 실판매 전 선행 과제.

### Q-036. 멱등성 소유 주체 해시 방식 (Step 5)
- **질문:** DATABASE §5.8은 `owner_key_hash = HMAC(identity_subject_id ‖ browser_binding_hash)`라고 적는다. 두 입력은 이미 DB에 저장된 값(주체 ID, 바인딩의 SHA-256)이라 비밀 키를 써도 추가 보호가 없고, 키 교체 시 24시간 안의 재요청이 다른 소유 주체로 보이는 부작용이 있다.
- **현황(구현):** 도메인 분리 SHA-256(`nazir:idempotency-owner:` 접두). 소유 주체 구분·충돌 저항은 같다.
- **선택지:** (a) 현행 SHA-256 + 문서 정정, (b) HMAC(별도 키링 또는 기존 키링 용도 분리)로 변경.
- **결정 담당:** 사용자/개발. **상태:** **확정(2026-11-26, A-054 ③)** — (a) 도메인 분리 SHA-256, DATABASE §5.8 정정.

### Q-037. 주문 취소 시 주문 확인 접근 세션의 처리 (Step 5)
- **질문:** 취소·만료된 주문의 `order_access_sessions`는 현재 `ACTIVE`로 남는다(확인서 조회용 읽기 전용, §5.6). 같은 키 재요청은 그 토큰을 갱신한다(TEST CN-12).
- **선택지:** (a) 현행 유지(취소된 주문도 그 브라우저에서 상태 확인 가능), (b) 취소·만료 시 `REVOKED`.
- **권장:** (a). 조회만 가능하고 바인딩에 묶여 있어 위험 증가가 없고, 사용자가 취소 결과를 확인할 수 있다.
- **결정 담당:** 사용자. **상태:** **미결정(현행 a로 구현).**

### Q-038. 정기 만료 작업의 실행 주기와 `CRON_SECRET` 필수화 (Step 5)
- **질문:** ARCHITECTURE §8의 권장 주기는 1분이지만 확정되지 않았다(E-007). 작업은 `CRON_SECRET`이 없으면 503으로 실행을 거부할 뿐이며, staging/production 기동 검사는 아직 이를 요구하지 않는다.
- **현황:** 주문 생성 사전 정리가 막힌 좌석·본인 주문을 직접 정리하므로 작업이 늦어도 정합성은 유지된다. 작업 지연의 영향은 화면의 "점유 중" 표시가 길어지고 쿼터가 늦게 복구되는 것(사용자는 재시도로 해결)이다.
- **권장:** 1분(`* * * * *`). Vercel에서 분 단위 cron은 플랜 제약이 있다(Hobby는 일 단위만 — 공식 문서로 재확인 필요). 비용은 실행 횟수(월 약 43,200회)와 실행 시간(대상이 없으면 짧은 조회 1회)에 비례한다. staging/production 기동 검사에 `CRON_SECRET`(32자 이상) 필수화를 권장한다.
- **결정 담당:** 사용자(호스팅 플랜과 함께). **상태:** **미결정.** `vercel.json`은 추가하지 않았다.

---

---

## 5. 결정 기록 양식

새 결정은 아래 양식으로 추가한다.

```
### D-0XX / Q-0XX. 제목
- 질문:
- 선택지:
- 영향(문서/테이블/API/테스트):
- 결정 담당:
- 기한:
- 상태:
- 결정 내용 및 일자:
```

## 6. 변경 이력

| 버전 | 일자 | 변경 내용 |
|---|---|---|
| 1.1 | 2026-11-14 | 신규 작성. 사용자 확정 정책 D-001~D-008, 기술 검토 반영 채택안 A-001~A-023, 미결정 Q-001~Q-016, 외부 확인 E-001~E-011 기록 |
| 1.2 | 2026-11-15 | 확정 D-009~D-015(토스·NICE, 결제창 API 개별 연동, 1차 결제수단, 판매 개시 조건, NICE 지연 시 연기·Mock 판매 금지, 활성 주문 범위·UNFULFILLED, 인증 세션 규칙). 채택안 A-024~A-031(Provider 단계·fail-closed, 단계 DB 미저장, Mock 빌드 제거 비필수, 웹훅 처리, 거래별 문맥·Secret 분리, 쿼터 격리·잠금 후 판단, 결제수단 허용 목록, confirm timeout과 3분 보호). Q-001~Q-005·Q-013 갱신, Q-017~Q-021 신설, E-001·E-002·E-007·E-008 원문 확인 결과 반영. 이전 원문: `docs/archive/v1.1/DECISIONS.md` |
| 1.2.1 | 2026-11-16 | Step 2 구현 중 발견한 문서 충돌·공백 Q-022~Q-026 추가(확정·채택 항목은 변경 없음). 상세는 `DATABASE.md` §19.6~§19.7 |
| 1.2.2 | 2026-11-16 | Step 2 보완 결정 반영: A-032~A-037 신설(결제·주문 정합성, 주문↔쿼터 FK, `OTHER` 결제수단, 인증 세션 복합 FK, `order_items` DELETE 차단, migration 트랜잭션), D1~D8 확정(§2.1), Q-022~Q-024·Q-026 확정, Q-025 방향 승인. A-001~A-031, D-001~D-015는 변경 없음 |
| 1.2.3 | 2026-11-17 | Step 2 PR 전 마지막 검토: A-038(결제 원장 DELETE 불가, `SUCCEEDED` 승인 금액 필수) 추가, Q-027(결제수단 요청값·PG 원문 보존)·Q-028(인증 세션의 원 인증 상태·바인딩 검증)·Q-029(원장성 테이블 보호 범위) 신설 — 선택지·추천안만 기록하고 구현하지 않음. A-001~A-037, D-001~D-015는 변경 없음 |
| 1.2.4 | 2026-11-17 | Step 2 후속(사용자 지시): A-038 보강(`SUCCEEDED` ⇒ `approved_at`), A-039(결제수단 요청값 `requested_method_type`·PG 원문 `provider_method_raw`, Q-027 채택), A-040(인증 세션 4열 FK + 지연 constraint trigger 2개, Q-028 채택), A-041(원장성 테이블 4개 한정 보호, Q-029 한정 채택) 신설. Q-027~Q-029의 상태를 채택·구현으로 변경하고 구현 위치와 보존·개인정보 정책과의 충돌을 기록. A-001~A-037, D-001~D-015는 변경 없음 |
| 1.2.5 | 2026-11-18 | A-039 보강: CHECK `payments_unapproved_method_matches_request_ck` 추가(미승인 결제의 `method_type`은 요청 수단과 같아야 함). 다른 결정은 변경 없음 |
| 1.2.6 | 2026-11-18 | A-042 신설(PR #2 기술 리뷰 후속): 승인된 결제의 승인 증거 불변, 환불 핵심 필드 불변과 `SEAT` 환불 합계 검사, Prisma CLI 환경 가드. A-041의 refunds UPDATE 허용은 유지. 다른 결정은 변경 없음 |
| 1.2.7 | 2026-11-18 | A-042 ③ 보강: Prisma CLI 환경 가드가 `SHADOW_DATABASE_URL`도 검사하고 주 DB와 같은 DB를 거부. 다른 결정은 변경 없음 |
| 1.2.20 | 2026-11-26 | A-054 신설(Q-034~Q-036 확정, 주문 만료·사전 정리·정기 작업·취소 구현). Q-037(취소 시 접근 세션)·Q-038(작업 주기·`CRON_SECRET` 필수화) 신설 |
| 1.2.19 | 2026-11-26 | 주문 생성 API 구현 기록(A-053 ④⑤⑥). Q-034(`ends_at` 없는 회차의 접근 세션 만료)·Q-035(거절된 요청의 주문 생성 횟수 집계)·Q-036(멱등성 소유 주체 해시) 신설. 기존 결정은 변경 없음 |
| 1.2.18 | 2026-11-26 | Q-025 구현 기록, A-053 구현 상태 갱신(②). 1.2.17의 날짜 표기 정정(11-28 → 11-25). 결정 내용은 변경 없음 |
| 1.2.17 | 2026-11-25 | A-053 구현 상태 갱신(③ S2 트리거, ⑦ A-041 확장). 결정 내용은 변경 없음 |
| 1.2.16 | 2026-11-25 | A-053(Step 5 정책 결정: Git 기준, Q-025 주문번호 형식 확정, S2 DB 방어, 주문 생성 rate limit·접근 세션 수명 확정, 멱등성 24시간, A-041 확장, M8 Pool 설정) 신설. Q-013·Q-025 상태 갱신. 기존 결정은 변경 없음 |
| 1.2.15 | 2026-11-27 | A-052(LOOKUP 10분 확정, 복구 조건·창을 세션 생성 기준 5분으로 확정) 신설 |
| 1.2.14 | 2026-11-27 | A-051(Claim 5분 확정, claim·세션 API, 응답 유실 복구, M7 오류 매핑 일부) 신설 |
| 1.2.13 | 2026-11-26 | A-050(Mock 인증 화면·Callback·상태 전이) 신설 |
| 1.2.12 | 2026-11-26 | A-049(IdentityProvider 계약, Mock 환경 제한, 인증 시작 API 검사 순서·state·중복 처리, provider context 전용 키링) 신설 |
| 1.2.11 | 2026-11-25 | A-048(개인정보 선택적 파기 구조) 신설. A-043 구현 메모: DI HMAC 키 교체 절차·AES-256-GCM 형식 |
| 1.2.10 | 2026-11-25 | A-047(인증 시작 rate limit: IPv4 /32·IPv6 /64, IP 60/10분, 바인딩 5/10분) 신설, A-045 갱신 |
| 1.2.9 | 2026-11-24 | Step 4 착수 결정: A-043(Q-002 DI HMAC, Q-016 AES-256-GCM·키 분리, 보관 기간 미확정), A-044(바인딩·CSRF bootstrap), A-045(Q-013 PostgreSQL rate limit), A-046(H2 Vercel Deployment Protection). 다른 결정은 변경 없음 |
| 1.2.8 | 2026-11-22 | Step 3 구현 중 남은 미결정 사항 Q-030(`CLOSED` 공연 노출, 임시 기본값 숨김)·Q-031(공개 API 캐시·rate limit)·Q-032(`BLOCKED`만 남은 회차 표시)·Q-033(판매 불가 사유 우선순위) 기록. 확정된 결정은 변경 없음 |
