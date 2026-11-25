# NAZIR — PROVIDERS (외부 결제·본인인증 업체 연동 근거)

> 문서 버전: 1.2 · 기준일: 2026-11-15 · 확인일: 모든 항목 2026-11-15
> 목적: 토스페이먼츠(PG)·NICE아이디(휴대폰 본인인증) 연동에 필요한 사실을 **공식 출처 기준**으로 기록하고, 확인 수준을 구분한다.
> 관련 문서: `DECISIONS.md`(D-009~D-015, A-024~A-031, Q-017~Q-021), `ARCHITECTURE.md` §6, `API_SPEC.md` §3.4·§4.2·§4.6·§4.7·§4.9, `TEST_PLAN.md` PRV/SBX/NIC

## 0. 확인 수준 표기

| 표기 | 의미 |
|---|---|
| **[원문]** | 공식 문서 원문 페이지를 직접 내려받아 해당 문장을 확인함 |
| **[검색]** | 공식 도메인 검색 결과의 요약으로만 확인함(원문 미열람 또는 원문에서 해당 문장을 찾지 못함) |
| **[비공식]** | 대행사·블로그 등 비공식 자료 |
| **[미확인]** | 확인하지 못함. 추측으로 확정하지 않으며 sandbox·업체 문의로 확인 |
| **[정정]** | 이전 보고(W1 검색)와 원문이 달라 원문 기준으로 바로잡음 |

> **이 문서의 사실 기록은 구현 결정이 아니다.** 구현에 쓰이는 결정은 `DECISIONS.md`에 있으며, [미확인] 항목에 의존하는 동작은 adapter 설정값·feature flag로 두고 sandbox 확인 후 확정한다.

### 0.1 원문 접근 방법

2026-11-15 이 세션의 네트워크 정책에 공식 문서 호스트(`docs.tosspayments.com`, `auth-guide.niceid.co.kr`, `niceid.co.kr`, `www.niceid.co.kr`, `www.niceinfo.co.kr`)를 허용한 NAZIR 전용 환경을 추가해, HTTPS로 원문 HTML을 내려받아 텍스트로 변환해 확인했다. 그림(상태 흐름도 등)에 담긴 내용은 확인하지 못했다.

---

## 1. 토스페이먼츠

### 1.1 출처

| ID | 문서 | URL | 수준 |
|---|---|---|---|
| T1 | 결제 흐름 이해하기 | https://docs.tosspayments.com/guides/v2/get-started/payment-flow | 원문 |
| T2 | 카드/간편결제 통합결제창 연동하기 | https://docs.tosspayments.com/guides/v2/payment-window/integration | 원문 |
| T3 | 코어 API 레퍼런스 | https://docs.tosspayments.com/reference | 원문 |
| T4 | 결제창(구버전) JavaScript SDK | https://docs.tosspayments.com/sdk/v2/js/payment | 원문 |
| T5 | API 키 | https://docs.tosspayments.com/reference/using-api/api-keys | 원문 |
| T6 | 인증 및 기타 헤더(멱등키 포함) | https://docs.tosspayments.com/reference/using-api/authorization | 원문 |
| T7 | 웹훅 이벤트 | https://docs.tosspayments.com/reference/using-api/webhook-events | 원문 |
| T8 | 웹훅 연결하기 | https://docs.tosspayments.com/guides/v2/webhook | 원문 |
| T9 | 보안 체크리스트 | https://docs.tosspayments.com/reference/using-api/security-checklist | 원문 |
| T10 | 배포 체크리스트 | https://docs.tosspayments.com/guides/v2/deploy-checklist | 원문(키 접두사 부분) |
| T11 | 자주 묻는 질문 | https://docs.tosspayments.com/resources/faq | 원문 |
| T12 | 결제 취소 | https://docs.tosspayments.com/guides/v2/cancel-payment | 원문 |
| T13 | LLM Quick Reference | https://docs.tosspayments.com/guides/v2/get-started/llms-quick-reference | 원문(공식 요약 문서) |
| T14 | 멱등키(레퍼런스) | https://docs.tosspayments.com/reference/using-api/idempotency-key | 검색(원문 페이지 본문이 비어 T6로 대체 확인) |
| T15 | 타임아웃 용어 | https://docs.tosspayments.com/resources/glossary/timeout | 원문 |
| T16 | 카드사 심사 체크리스트(블로그) | https://www.tosspayments.com/blog/articles/53711 | 검색 |

### 1.2 결제 흐름과 승인

| 사실 | 출처 | 수준 |
|---|---|---|
| 온라인 결제는 요청·인증·승인 3단계이며, 토스페이먼츠는 요청과 승인을 분리한다. 인증 성공 시 `paymentKey` 발급 후 성공 URL로 리다이렉트, 서버가 승인 API를 호출해야 결제가 마무리된다 | T1 | 원문 |
| 성공 URL 쿼리에 `paymentKey`, `orderId`, `amount`는 항상 돌아온다. 요청 전 서버에 `orderId`·`amount`를 저장하고 승인 전 대조해야 한다 | T1, T4 | 원문 |
| 승인 API: `POST /v1/payments/confirm`, 본문 `paymentKey`·`orderId`·`amount` | T3 | 원문 |
| **결제 인증이 유효한 10분 안에 승인 API를 호출하지 않으면 결제가 만료된다** | T3, T7 | 원문 |
| 결제창이 유효한 30분 안에 인증하지 않거나, 인증 후 10분 안에 승인하지 않으면 상태가 `EXPIRED` | T7 | 원문 |
| 결제 상태: `READY`(생성), `IN_PROGRESS`(인증 완료, 승인 전), `WAITING_FOR_DEPOSIT`(가상계좌), `DONE`(승인), `CANCELED`, `PARTIAL_CANCELED`, `ABORTED`(승인 실패), `EXPIRED` | T3 | 원문 |
| `orderId`: 영문 대소문자·숫자·`-` `_` `=`, **6자 이상 64자 이하**, 충분히 무작위한 고유값 | T3 | 원문 |
| `paymentKey` 최대 200자, 형식·길이가 바뀔 수 있으니 받은 값 그대로 저장. 외부 노출되어도 시크릿 키 없이는 API 호출 불가 | T1, T3 | 원문 |
| 구매자가 결제창을 닫으면 결제 상태가 바뀌지 않아 웹훅도 전송되지 않는다 | T7 | 원문 |
| 승인 호출 실패 시 즉시 실패 처리하지 말고 조회로 확인하라는 권고 | 검색 | 검색(원문에서 해당 문장 미확인) |

### 1.3 조회·취소

| 사실 | 출처 | 수준 |
|---|---|---|
| `GET /v1/payments/{paymentKey}` — 승인된 결제를 조회 | T3 | 원문 |
| `GET /v1/payments/orders/{orderId}` — 승인된 결제를 orderId로 조회. **주문서형·결제창형 시크릿 키(`test_gsk`/`live_gsk`)로는 호출 불가, API 개별 연동 시크릿 키(`test_sk`/`live_sk`) 필요** | T3 | 원문 |
| 결제 조회 응답의 `status`·`totalAmount`·`balanceAmount`, 취소 내역은 `cancels` 배열이며 각 취소 거래를 `transactionKey`로 구분 | T3, T12 | 원문 |
| `transactionKey`(결제 객체 최상위)는 DEPRECATED, `lastTransactionKey` 사용 | T3 | 원문 |
| 매입 전 취소는 즉시 환불, 매입 이후·부분 취소는 영업일 3~4일 소요 | T12 | 원문 |
| 결제 취소 API는 멱등키와 함께 사용 권장 | T3 | 원문 |
| `IN_PROGRESS`(승인 전) 결제를 조회 API가 어떤 형태로 반환하는지("승인된 결제를 조회"로 기술) | — | **미확인** |
| 만료(`EXPIRED`) 결제의 조회 응답 형식 | — | **미확인** |

### 1.4 키와 연동 방식

| 사실 | 출처 | 수준 |
|---|---|---|
| 테스트 키 `test_`, 라이브 키 `live_` 접두사. 테스트·라이브를 섞거나 세트가 아닌 키를 쓰면 `INVALID_API_KEY` | T5, T10 | 원문 |
| 주문서형·결제창형 연동 키: `test_gck`/`live_gck`, `test_gsk`/`live_gsk` | T5 | 원문 |
| **API 개별 연동 키: `test_ck`/`live_ck`, `test_sk`/`live_sk`. 결제창(구버전) SDK·브랜드페이·자동결제에 사용. 보안 키는 API 개별 연동 키에만 발급되며 웹훅 서명 검증에도 쓰인다** | T5, T9 | 원문 |
| "통합결제창"의 이름이 "결제창(구버전)"으로 변경됨. `payment()`로 초기화, `requestPayment()` 호출 | T4 | 원문 |
| 결제창 연동 가이드는 API 개별 연동 키를 사용하며, 전자결제 계약 전에도 회원가입만으로 테스트 상점 키·테스트 결제내역·웹훅 기능을 사용할 수 있다 | T2 | 원문 |
| 시크릿 키는 Basic 인증에 사용, SDK에 넣으면 `INSECURE_KEY_USAGE` | T5, T11 | 원문 |
| "결제창(구버전)" 명칭의 향후 지원 정책(지원 종료 계획 여부) | — | **미확인** |

### 1.5 결제수단

| 사실 | 출처 | 수준 |
|---|---|---|
| `method: "CARD"`로 카드/간편결제 통합결제창 또는 카드·간편결제 자체창 사용 | T4 | 원문 |
| `flowMode`: `DEFAULT`(통합결제창, 기본값) / `DIRECT`(카드사·간편결제 자체창) | T4 | 원문 |
| `cardCompany`: DIRECT이면 해당 카드사 앱, **DEFAULT이면 통합결제창에 입력한 카드사만 표시**(파이프로 여러 개 지정) | T4 | 원문 |
| `easyPay`: DIRECT이면 해당 간편결제 앱, **DEFAULT이면 파라미터와 무관하게 기본 통합결제창** | T4 | 원문 |
| 가상계좌는 별도 결제수단 요청(Redirect/Promise)으로 제공 | T4 | 원문 |
| Promise 방식은 모바일 환경에서 사용 불가 | T4 | 원문 |
| 결제 응답 `method` 값은 카드·가상계좌·간편결제·휴대폰·계좌이체·문화상품권 등 한글 문자열 | T3 | 원문 |
| 토스페이·네이버페이는 개발 연동 체험 상점 및 MID 테스트 키로 연동 가능. 카카오페이는 계약 이후 MID로 발급받은 테스트 키로만. 페이코는 라이브 키로만 테스트 | T11 | 원문 |
| 간편결제 코드 값(토스페이·네이버페이의 `easyPay` 코드 문자열) | — | **미확인**(ENUM 코드 페이지 미열람) |
| DEFAULT 통합결제창에서 카드사 목록을 제한했을 때 간편결제 노출이 어떻게 되는지, 계약된 간편결제를 숨길 수 있는지 | — | **미확인** |
| 승인 전에 구매자가 선택한 결제수단(카드사·간편결제사)을 서버가 알 수 있는지 | — | **미확인** |
| 라이브에서 심사 미완료 카드사가 결제창에 표시되는지/결제가 실패하는지 | 검색 | 검색("심사 미완료 카드사는 결제 실패 가능") |

### 1.6 멱등키

| 사실 | 출처 | 수준 |
|---|---|---|
| 요청 헤더 `Idempotency-Key`, UUID 등 충분히 무작위한 값, 최대 300자. 네트워크·타임아웃으로 응답을 못 받았을 때 같은 요청을 안전하게 재전송 | T6 | 원문 |
| 모든 POST API에 사용 가능, GET은 무시. 첫 요청일로부터 15일 유효. 같은 키는 첫 응답을 반환 | T13 | 원문(공식 요약) |
| 첫 요청 처리 중 재요청은 409 `IDEMPOTENT_REQUEST_PROCESSING` | T14 | 검색 |

### 1.7 웹훅

| 사실 | 출처 | 수준 |
|---|---|---|
| 웹훅 헤더: `tosspayments-webhook-transmission-time`, `…-transmission-retried-count`, `…-transmission-id`, **`tosspayments-webhook-signature`** | T7 | 원문 |
| 서명 검증: `{WEBHOOK_PAYLOAD}:{transmission-time}`을 **보안 키**로 HMAC SHA-256, 헤더의 `v1:` 뒤 값(쉼표로 여러 개 가능)을 base64 디코딩해 하나라도 일치하면 유효 | T7 | 원문 |
| 모든 웹훅 이벤트가 서명 헤더를 포함하며, 결제 웹훅은 결제 조회 API로도 재확인할 것 | T13 | 원문(공식 요약) |
| **[정정]** W1 검색 보고의 "일반 결제 웹훅에는 서명 헤더가 없다"는 현행 원문과 다르다. 원문 기준으로 서명 헤더가 있다. 단, 실제 `PAYMENT_STATUS_CHANGED` 수신 시 헤더 존재 여부는 sandbox에서 확인한다 | T7, T13 | 원문 / 수신 확인 미확인 |
| 서명은 발신자만 보장하며, 금액·상태는 결제 조회 API 교차 확인이 기본 방어선. `orderId`·`totalAmount`·`mId`·`status`를 대조 | T9 | 원문 |
| 중복 처리는 본문 `eventId`로(본문에 `eventId`가 없는 웹훅도 있음). `transmission-id`는 발송마다 새로 발급되므로 중복 처리에 쓰지 말 것 | T7, T9 | 원문 |
| 10초 이내 200 응답. 미응답 시 최대 7회(최초 전송으로부터 3일 19시간) 재전송, 실패 시 이메일 | T8 | 원문 |
| `PAYMENT_STATUS_CHANGED` 본문: `eventType`, `createdAt`, `data`(Payment 객체) | T7 | 원문 |
| `CANCEL_STATUS_CHANGED`는 비동기 승인 해외 간편결제 전용이며 국내 결제에는 발송되지 않음 | T7 | 원문 |
| 국내 카드 결제의 취소(전체·부분) 시 `PAYMENT_STATUS_CHANGED`가 발송되는지 | — | **미확인**(상태 흐름 그림 미판독) |
| 웹훅 헤더 길이는 바뀔 수 있으니 헤더당 1KB 이상 허용 | T7 | 원문 |

### 1.8 타임아웃

| 사실 | 출처 | 수준 |
|---|---|---|
| 거래 조회·정산 조회는 최대 60초 소요, 타임아웃 최소 60초. 자동결제 승인 최대 60초 | T3 | 원문 |
| **일반 결제 승인 API의 권장 Read Timeout 60초** | 검색 | **검색만**(원문에서 일반 결제 승인에 대한 수치 미확인) |
| 라이브 환경에서 비정상적으로 많은 요청은 429 | T3 | 원문 |

### 1.9 계약·심사·라이브 개시 (기술 연동과 별개)

| 사실 | 출처 | 수준 |
|---|---|---|
| 라이브 키·MID는 전자결제 신청(계약) 이후 발급 | T11 | 원문 |
| 토스페이먼츠 심사 1~2일, 카드사 심사 최대 14일 | T11 | 원문 |
| 카드사 심사 요청 후 7~10일 후 완료되면 라이브 결제 가능, 심사 현황은 상점관리자 > 이용정보 | T11 | 원문 |
| 라이브 카드 결제에는 9개 주요 카드사(신한·삼성·현대·롯데·KB국민·NH농협·하나·비씨·우리) 심사 필요 | T11 | 원문 |
| **카드사 심사는 실제 판매가 이뤄지는 사이트에서 상품 형태·결제창 동작을 확인하며, 테스트키로 결제창을 연동해 둔 것을 확인** | T11 | 원문 |
| 계약된 결제수단은 상점관리자 > 계약·운영 > 이용정보 > MID > 결제·부가서비스 탭에서 확인, 미계약 수단은 고객센터 문의 | T11 | 원문 |
| 카드사 심사 "계약 완료 후 최대 10~14영업일" | T16 | 검색 |
| 결제수단(카드사·간편결제)별 선택적 활성화를 상점이 직접 설정할 수 있는지 | — | **미확인**(상점관리자·고객센터 확인) |
| 간편결제(토스페이·네이버페이) 라이브 사용에 별도 심사가 필요한지와 소요 기간 | — | **미확인** |

### 1.10 연동 체크리스트(토스)

- [ ] 회원가입 및 API 개별 연동 테스트 키 확보(계약 전 가능, T2)
- [ ] 전자결제 계약 신청, MID 발급
- [ ] 카드사 심사용 **공개 판매 사이트**(테스트 키 결제창 연동 상태) 준비(T11)
- [ ] 결제창(구버전) SDK + `method: CARD` 기반 카드/토스페이/네이버페이 연동, `easyPay` 코드 확인
- [ ] 성공/실패 URL 처리, 승인 전 orderId·amount 대조
- [ ] 승인 API + Idempotency-Key, 10분 승인 유효시간 준수
- [ ] paymentKey·orderId 조회 경로, IN_PROGRESS/EXPIRED 응답 형식 sandbox 확인
- [ ] 웹훅 URL 등록, 서명 검증(보안 키), eventId 중복 처리, 10초 내 200
- [ ] 취소 내역(`cancels[].transactionKey`) 기반 환불 검증
- [ ] 라이브 키는 운영 서버에만 주입, 키 접두사 기동 검사
- [ ] 결제수단 선택적 활성화 가능 여부 문의(D-012)

---

## 2. NICE아이디 (휴대폰 본인확인)

### 2.1 출처

| ID | 문서 | URL | 수준 |
|---|---|---|---|
| N1 | 통합인증 서비스 가이드 v1.0.0 | https://auth-guide.niceid.co.kr/ | 원문 |
| N2 | 도입문의 절차 | https://www.niceid.co.kr/serv_qstn.nc | 원문 |
| N3 | 휴대폰 본인확인 상품 | https://niceid.co.kr/product/mobile | 원문 |
| N4 | NICE API 소개(niceinfo) | https://www.niceinfo.co.kr/business/NICEAPI.nice | 원문 |
| N5 | NICE아이디 사업 소개 | https://www.niceinfo.co.kr/business/NICEiD_2.nice | 검색 |
| N6 | Chrome 80 쿠키 정책 공지 | https://www.niceid.co.kr/front/contactus/popNoticeChrome.jsp | 검색 |
| N7 | KISA 본인확인 점검 자료 | identity.kisa.or.kr(첨부 파일) | 검색 |
| N8 | 대행사 CI/DI 제공 신청서 | codemshop.com(첨부 파일) | 비공식 |

### 2.2 통합인증 API 흐름

| 사실 | 출처 | 수준 |
|---|---|---|
| API: `POST /ido/intc/v1.0/auth/token`(접근토큰), `POST /ido/intc/v1.0/auth/url`(인증 URL), `POST /ido/intc/v1.0/auth/result`(인증 결과). 도메인 `auth.niceid.co.kr` | N1 | 원문 |
| **이용기관 서버의 Outbound IP를 NICE 담당자에게 전달해 권한 등록해야 하며, 등록 완료 후 `client_id`·`client_secret`이 이메일로 전달됨. IP는 호스트 IP 또는 네트워크 대역 3자리 prefix로 등록, AWS·Cloudflare 이용 시 별도 문의** | N1 | 원문 |
| 이용기관 서버에서 `auth.niceid.co.kr`, `nice.checkplus.co.kr` 등에 대한 Outbound 방화벽 허용 필요 | N1 | 원문 |
| 접근토큰: Basic(`client_id:client_secret` Base64URL, 패딩 없음), **24시간 유효**, 응답에 `access_token`·`iterators`·`ticket` 포함 | N1 | 원문 |
| 인증 URL 요청: `request_no`(20~50자, 필수), `return_url`(≤250자, 필수), `close_url`, `svc_types`(휴대폰 `M` 등), `method_type`(GET/POST, 기본 GET). 응답 `transaction_id`·인증 URL은 **10분간 유효** | N1 | 원문 |
| 인증 완료 시 `return_url`로 `web_transaction_id` 전달(GET이면 query, POST이면 body). 받지 못하면 인증 미완료 | N1 | 원문 |
| 인증 결과 요청에는 `web_transaction_id`와 인증 URL 요청 때 받은 `request_no`·`transaction_id`가 필요 | N1 | 원문 |
| 결과는 암호화되어 오며, 무결성 키·대칭키·IV로 검증·복호화. 키는 **접근토큰 응답의 `ticket`·`iterators`와 인증 URL 응답의 `transaction_id`**를 입력으로 PBKDF2(HMAC-SHA256, 512bit)로 유도, 앞 32byte 대칭키, 48번째부터 32byte 무결성 키. 복호화는 AES-GCM 예제 | N1 | 원문 |
| 결과 요청을 인증 URL 요청 때와 **같은 접근토큰**으로 해야 하는지 | — | **미확인**(가이드는 "결과 요청 헤더의 access_token을 참고하여 암호화"라고만 기술) |
| 결과 항목: `name`, `birthdate`, `gender`, `national_info`, `ci`, `ci2`, `di`, `mobile_co`, `mobile_no`, `age_code` 등 | N1 | 원문 |
| 결과 요청 가능 기한(인증 완료 후 몇 분까지 결과를 받을 수 있는지) | — | **미확인**(transaction_id 10분 유효만 확인) |
| 인증 결과를 서비스 세션으로 일정 시간(30분) 유지하는 데 대한 NICE 측 제약 | — | **미확인**(관련 기술 없음) |
| 같은 인증 결과(`web_transaction_id`)를 두 번 조회할 수 있는지 | — | **미확인** |
| 테스트 대상 도메인은 `https://auth.niceid.co.kr`(운영과 동일 도메인 기재) | N1 | 원문 |
| 구 본인확인 모듈은 `EncodeData` 등 다른 파라미터 체계 | N6 | 검색 |

### 2.3 계약·개시 (기술 연동과 별개)

| 사실 | 출처 | 수준 |
|---|---|---|
| 절차: 도입문의(온라인 b2b.niceid.co.kr 또는 대표번호) → 컨설턴트 안내(영업일 1~2일) → 서류 제출(대표자 인감 날인 필수, 원본 별도 발송) → 이용료 결제 → 연동 개발 → 이용 개시 | N2 | 원문 |
| URL이 확정되지 않아도 도입 상담·견적 가능 | N2 | 원문 |
| **휴대폰 본인확인은 통신사 3사 승인심사 영업일 3~5일** | N2 | 원문 |
| 서비스 유형에 따라 신청 후 최소 1일~최대 5일 안에 이용 가능 | N2 | 원문 |
| **별도의 무료 테스트 인증건수는 제공되지 않으며, 신청서상 과금시작일부터 인증건수가 차감** | N2 | 원문 |
| 개발 가이드·연동 모듈·key 값은 컨설턴트가 제공 | N2 | 원문 |
| CI/DI 제공에 별도 신청서가 필요한지 | N8 | 비공식 → **미확인** |
| [정정] W1에서 언급한 "NICE API 플랫폼 APP 등록 → 승인 후 테스트 거래"는 niceinfo의 NICE API 플랫폼(N4) 설명이며, NICE아이디 휴대폰 본인확인 도입 절차(N2)와 별개일 수 있다 | N2, N4 | 원문 비교 |
| W1 검색의 "연동·시스템 등록 최대 1영업일, 연동 평균 3~4시간"은 현재 원문(N2)에서 찾지 못함 | — | 검색만 |

### 2.4 보안 권고

| 사실 | 출처 | 수준 |
|---|---|---|
| `client_id`·`client_secret`은 민감 정보, 공개 저장소에 업로드 금지 | N1 | 원문 |
| 결과 정보(이름·생년·CI/DI 등) 위변조 방지, 복호화 키 비노출, 복호화 값 검증 | N7 | 검색 |

### 2.5 연동 체크리스트(NICE)

- [ ] 도입문의 → 견적 → 서류(인감) → 이용료 → 과금시작일 협의
- [ ] **운영·스테이징 서버 Outbound IP 확정 및 등록**(호스팅 결정과 연동, AWS 계열은 별도 문의)
- [ ] client_id/secret 수령 → Secret 관리 체계에 저장
- [ ] 통신사 3사 승인심사(영업일 3~5일)
- [ ] 토큰 발급·캐시(24시간), URL 요청(`svc_types: M`, `method_type`), 결과 요청·복호화·무결성 검증
- [ ] DI/CI 제공 범위·신청 필요 여부 확인
- [ ] 결과 요청 토큰 동일성, 결과 조회 기한·재조회 가능 여부 확인
- [ ] 테스트는 과금되는 실제 인증으로만 가능 → 테스트 인원·횟수 계획, 스테이징 개인정보 처리 규칙(Q-019)

### 2.6 NICE 실제 연동 준비 체크리스트 (2026-11-27)

근거는 §2.2~§2.4의 원문(N1 통합인증 가이드, N2 도입 절차)뿐이다. **공식 계약서·이용기관 전용 개발 가이드는 아직 받지 않았다.** 아래 "확인된 사실"은 공개 가이드 기준이며, 계약 후 받는 자료와 다르면 그것을 따른다. 코드에서는 `NiceIdentityProvider`가 시작·완료 모두 `ProviderUnavailableError`로 실패한다(A-049, A-050).

| # | 항목 | 확인된 사실(출처) | 미확정 | 우리 구현에 미치는 영향 / 받아야 할 자료 |
|---|---|---|---|---|
| 1 | DI 제공 | 결과 항목에 `di`, `ci`, `ci2` 존재(N1) | 계약상 DI 제공 여부·별도 신청서 필요 여부(N8 비공식), DI 형식·길이 | DI 없으면 인증 실패(A-043, 대체 없음) → **계약서·신청서에서 DI 제공 명시 필요** |
| 2 | Outbound IP 등록 | 서버 Outbound IP를 NICE에 등록해야 키 발급, 호스트 IP 또는 3자리 대역 prefix, AWS·Cloudflare는 별도 문의(N1) | Vercel 서버리스의 고정 출구 IP 확보 방법(Q-020), 스테이징 IP 별도 등록 여부 | **호스팅의 고정 IP(Static IP/프록시) 확정 → NICE에 제출할 IP 목록** |
| 3 | client_id/secret | 등록 후 이메일로 전달, 공개 금지(N1, N2) | 운영·테스트 키 구분 여부, 키 교체 절차 | `NICE_CLIENT_ID`·`NICE_CLIENT_SECRET`, `NICE_ALLOWED_CLIENT_IDS`(기동 검사, A-024)에 등록 |
| 4 | 토큰 발급·캐시·갱신 | `POST /ido/intc/v1.0/auth/token`, Basic(`client_id:client_secret` base64url, 패딩 없음), 24시간 유효, 응답 `access_token`·`iterators`·`ticket`(N1) | 만료 전 재발급 허용·이전 토큰 동시 유효 여부, 발급 횟수 제한, 폐기 API | 공유 토큰 캐시(별도 테이블·별도 암호화, A-028/A-045) 설계 필요. 결과 복호화에 `ticket`·`iterators`가 쓰이므로 **인증 시작 때 쓴 토큰을 결과 시점까지 보관**해야 할 가능성 |
| 5 | request_no | 20~50자, 필수(N1) | 허용 문자, 고유성 범위·기간, 재사용 규칙 | verification id에서 결정적으로 만들 계획(adapter 내부). 문자 규칙 확인 필요 |
| 6 | 인증 시작 필드 | `request_no`, `return_url`(≤250자), `close_url`, `svc_types`(휴대폰 `M`), `method_type`(GET/POST, 기본 GET); 응답 `transaction_id`·인증 URL 10분 유효(N1) | 그 밖의 필수/선택 필드, 오류 코드 목록, 인증 URL을 여는 방식(팝업·전체 이동·모바일 앱) | 현재 계약 `startVerification → launch.url`(A-049)에 맞음. 10분 TTL은 이미 반영 |
| 7 | Callback 방식 | `method_type`으로 GET(query) 또는 POST(body)에 `web_transaction_id` 전달(N1) | 어느 방식을 쓸지(우리 선택), POST면 cross-site POST라 Lax 쿠키 미전송(이미 쿠키 미사용 설계, A-018) | 현재 GET만 구현, POST는 405. **GET 선택 시 그대로, POST 선택 시 핸들러 추가** |
| 8 | return_url·state 보존 | return_url은 서버가 정함(≤250자) | 우리가 붙인 query(`state`)가 복귀 때 보존되는지 | **보존되지 않으면** 현재 callback(state hash로 거래 조회)이 동작하지 않는다 → `web_transaction_id`·`transaction_id`로 거래를 찾는 방식으로 바꿔야 함(A-050 구조 변경). sandbox가 없으므로 **NICE 담당자 서면 확인 필요** |
| 9 | 결과 조회·기한 | `POST /ido/intc/v1.0/auth/result`, `web_transaction_id` + `request_no` + `transaction_id` 필요(N1) | 인증 완료 후 몇 분까지 요청 가능한지 | 거래 TTL 10분 안에서만 결과 요청. 기한이 더 짧으면 TTL 조정 |
| 10 | 같은 결과 재조회 | — | 두 번 요청할 수 있는지 | 불가하면 아래 11과 함께 구조 변경 |
| 11 | 동시 callback 중복 조회 | — | 동시 요청 허용·두 번째 요청 결과 | 현재 구조는 동시 callback에서 provider 결과 확인이 **여러 번** 일어날 수 있다(A-050 ⑤). 재조회 불가면 결과 요청 전에 "조회 중" 표시를 DB에 남기는 단계 추가 필요(상태 머신 변경 → 사용자 결정) |
| 12 | 이름·전화 형식 | 항목 이름 `name`, `mobile_no`, `mobile_co`(N1) | 문자 인코딩, 길이, 전화번호 형식(하이픈·국가코드), 외국인 이름 | 현재 정규화: 이름 1~100자, 전화 `^01[0-9]{8,9}$`(A-050). 형식이 다르면 adapter에서 변환 규칙 확정 |
| 13 | 결과 복호화 | PBKDF2(HMAC-SHA256, 512bit) 입력 `ticket`·`iterators`·`transaction_id`, 앞 32B 대칭키, 48번째부터 32B 무결성 키, AES-GCM 예제(N1) | 정확한 입력 결합 순서·인코딩, IV 위치, 무결성 검증 대상(암호문/평문)·알고리즘, 응답 필드 이름, 결과 요청 시 토큰 동일성 | 공식 예제 코드·테스트 벡터 없이는 구현하지 않는다. **복호화 테스트 벡터(입력·기대 출력) 필요** |

**받아야 할 자료(외부):**
1. NICE 이용 계약서와 DI 제공(필요하면 CI/DI 신청서) 확인서
2. 이용기관용 통합인증 개발 가이드 최신판, 결과 복호화 예제 코드와 **테스트 벡터**
3. `client_id`·`client_secret`(운영/스테이징 구분 여부 포함) — 등록할 Outbound IP를 먼저 제출
4. 서면 답변: return_url query 보존 여부, 결과 요청 기한, 재조회·동시 조회 가능 여부, 토큰 동일성 요건, 토큰 재발급 규칙, request_no 문자 규칙, 오류 코드 목록
5. 과금 시작일과 실인증 테스트 계획(지정 인원·횟수, Q-019)
6. 호스팅 측: 고정 출구 IP 방법(Vercel Static IP 등)과 비용(Q-020)

**구현 착수 조건:** 1·2·4의 #8, #10, #11, #13이 확인되기 전에는 실제 요청 코드를 작성하지 않는다.

---

## 3. 이전 보고(W1) 대비 정정 요약

| 항목 | W1(검색) | 원문 확인 결과 |
|---|---|---|
| 토스 일반 결제 웹훅 서명 | 없음 | **있음**(`tosspayments-webhook-signature`, 보안 키 HMAC) — 수신 시 실제 존재 여부는 sandbox 확인 |
| 토스 결제 승인 Read timeout 60초 | 공식 권장 | 원문은 거래·정산 조회·자동결제 승인에 대해서만 60초 명시, 일반 승인은 **검색만** |
| NICE 테스트 환경 | APP 승인 후 테스트 거래 | 휴대폰 본인확인은 **무료 테스트 건수 없음**, 과금 시작 후 실제 인증으로 테스트 |
| NICE 결과 획득 방식 | 제품에 따라 다름 | 통합인증 v1.0은 서버 결과 요청 API + 암호화 결과 복호화(둘 다) |
| NICE 사전 요건 | 언급 없음 | **Outbound IP 등록 필수** |

## 4. 변경 이력

| 버전 | 일자 | 변경 내용 |
|---|---|---|
| 1.2 | 2026-11-15 | 신규 작성. 토스페이먼츠·NICE아이디 공식 문서 원문 확인 결과, 확인 수준 구분, 계약·심사 정보, 연동 체크리스트, W1 대비 정정 |
