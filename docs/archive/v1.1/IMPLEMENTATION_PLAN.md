# NAZIR — IMPLEMENTATION PLAN

> 문서 버전: 1.1 · 기준일: 2026-11-14 · 공개 목표 2026-11-30
> 일정은 목표이며 안전성 검증에 종속된다. P0 실패 시 실제 판매를 연기한다.
> 관련 문서: `DATABASE.md`, `API_SPEC.md`, `ARCHITECTURE.md`, `TEST_PLAN.md`, `DECISIONS.md`, `CLAUDE_HANDOFF.md`
> 이전 버전 원문: `docs/archive/v1.0/IMPLEMENTATION_PLAN`

## 1. 개발 원칙

- 작은 단위로 구현하고 각 단계 실행·테스트 후 진행한다.
- NAZIR 전용 저장소(`kkkkmini/NAZIR`)를 사용한다. Preview AI 저장소 재사용 금지.
- DB가 정본, Sheets는 비동기 mirror.
- PG/인증사 미선정 시 adapter interface와 mock만 구현하고 production 흐름은 비활성화한다(feature flag).
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
│  ├─ jobs/ (hold-expiry, payment-requery, ready-cleanup, refund-verify, webhook-retry, outbox, consistency, reconciliation)
│  ├─ providers/ (identity/{interface,mock}, payment/{interface,mock})
│  ├─ lib/ (clock, db, crypto/hmac, cookies, csrf, rate-limit, errors)
│  └─ components/
├─ prisma/ (schema.prisma, migrations/ — raw SQL 포함)
├─ tests/ (unit, integration, concurrency, contract/schema, e2e, security, load)
├─ docs/ (DATABASE.md, API_SPEC.md, ARCHITECTURE.md, IMPLEMENTATION_PLAN.md, TEST_PLAN.md, CLAUDE_HANDOFF.md, DECISIONS.md, archive/)
└─ README.md
```

실제 구조는 Next.js 권장 방식에 맞게 조정하되 도메인 경계를 유지한다.

## 4. 단계별 실행

| Step | 작업 | 완료 기준 | 선행 결정 |
|---|---|---|---|
| 0 | 문서/저장소 조사, 독립 기술 검토 | BLOCKER/HIGH 보고 | 완료 |
| 0.5 | 검토 반영 문서 개정(v1.1), `DECISIONS.md` | 6개 문서 + DECISIONS 교차 일치, **사용자 승인** | 진행 중 |
| 1 | Next.js/TS 기반, lint/typecheck/test/build, env schema, CI, Clock 인터페이스, 오류 체계 | clean clone에서 README대로 실행, CI 통과 | 없음(병행 가능) |
| 2 | Prisma schema + raw SQL migration(제약 전체), seed(임시 좌석), **스키마 계약 테스트** | 빈 PostgreSQL migration 성공, MIG-* 통과 | Q-004(활성 주문 범위), E-002 서버 승인형 전제 승인 |
| 3 | 공연/회차/좌석 조회, 판매 가능 조건, 임시 seat map | DB 상태와 UI 일치 | E-003은 실제 좌석 투입 시 |
| 4 | identity: 바인딩·CSRF bootstrap, 인증 시작·콜백·claim, 인증 세션(BOOKING/LOOKUP), subject HMAC, mock IdentityProvider | IDV-* 통과(mock) | Q-001(TTL 설정값), Q-002(식별값 — mock은 설정 가능하게) |
| 5 | booking: 주문 생성(한도 잠금·활성 주문·다중 점유), `expireOrder`, 취소 후 재예매, 소유 주체 Idempotency, 접근 세션, rate limit | SEAT-*, ORD-*, QTA-* 통과 | Q-011, Q-013(설정값) |
| 6 | payments: 결제 시작(수단 제한), 복귀 bridge, Tx1/confirm/Tx2/Tx3, 판매 확정·티켓, 재조회 작업, webhook 수신·재처리, mock PaymentProvider 장애 주입 | PAY-*, WH-* 통과 | Q-003(설정값) |
| 7 | 모바일 확인서, 주문 목록(LOOKUP), 접근 권한 매트릭스 | 타인 주문 조회 불가, IDV-11~13, ORD-09~11 | 없음 |
| 8 | admin: 로그인·세션·권한·감사 로그, 주문/좌석/결제 조회, 좌석 차단, review case action, 환불 요청·PG 실행 기록·검증·완료 | ADM-*, REF-* 통과, DB 직접 수정 없이 복구 | Q-005, Q-012, Q-015 |
| 9 | Outbox worker/Sheets upsert/retry/dead-letter(P1), 정합성 검사, 대사 | OUT-*, OPS-* 통과 | Q-014, E-011 |
| 10 | 실제 PG/인증사 sandbox 연동, 통합·보안·부하·배포·백업 리허설, 운영 리허설 | P0 전부 통과 + Go 승인 | E-001, E-002, E-007, E-008 |

## 5. 일정과 게이트 [권장 — 사용자 확정 아님]

오늘(2026-11-14) 기준 공개 목표까지 16일이다. 외부 의존성이 일정의 최대 위험이다.

| 일자(권장) | 게이트 | 미충족 시 |
|---|---|---|
| 11/15~16 | 문서 v1.1 승인, Q-004 결정, PG 서버 승인형 전제 승인 | Step 2 착수 불가(Step 1은 병행) |
| 11/18 | PG사·본인인증사 계약 진행 상태 확인(E-001, E-002, E-008) | mock 개발 계속, 실판매 연기 가능성 사용자 보고 |
| 11/20 | 공연장·좌석 배치·가격 자료 수령(E-003, E-004), 호스팅 상품 확정(E-007) | 실제 좌석 seed 불가 → 판매 연기 검토 |
| 11/24 | mock 기준 P0 기능 완성, P0 테스트 통과 | 범위 축소 또는 연기 |
| 11/26 | 실제 PG/인증 sandbox 검증 완료 | **실판매 No-Go**(TEST_PLAN §15) |
| 11/27~28 | 운영 리허설(UNKNOWN 복구, 수동 환불, review case), 백업·복구 리허설 | No-Go |
| 11/29 | Go/No-Go 판단 | — |

11/30은 목표일이지 보장된 납기가 아니다. 계약·심사·좌석 자료·실환경 검증이 늦어지면 mock 기반 개발은 계속하되 실제 판매는 보류한다. 기능 범위보다 안전성을 우선한다.

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
- P0 실패를 무시하고 공개

## 8. Definition of Done

기능은 코드 작성만으로 완료가 아니다. 타입 검사, lint, 관련 테스트(성공·실패·경합 경로), 스키마 계약 테스트, 보안 검토, 문서 반영까지 완료해야 한다. 전체 Go/No-Go는 `TEST_PLAN.md` §15 기준.

## 9. 변경 이력

| 버전 | 일자 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-11-13 | 개발 전달 기준안. 원문: `docs/archive/v1.0/IMPLEMENTATION_PLAN` |
| 1.1 | 2026-11-14 | 파일명 `IMPLEMENTATION_PLAN.md`로 정정. P0/P1 재정의(환불 기록·검증, 감사 로그, review case, outbox 생성을 P0로), Step 0.5 문서 개정 단계와 단계별 선행 결정 추가, 인증 선행·한도·결제 펜싱 단계 반영, 좌석 변경 제거, 일정 게이트(권장) 추가, 금지 사항 확장 |
