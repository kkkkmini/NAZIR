# NAZIR — CLAUDE CODE HANDOFF

> 문서 버전: 1.1 · 기준일: 2026-11-14 · Claude Code 전달 및 실행 지침
> 이전 버전 원문: `docs/archive/v1.0/CLAUDE_HANDOFF`

## 1. 프로젝트/역할

NAZIR은 뮤지컬/연극 티켓 예매 웹사이트다. 사용자는 기획과 제품 의사결정을 맡고, Claude Code는 저장소 조사·기술 검토·구현·테스트·디버깅을 맡는다. 목표 공개일은 2026-11-30이나 안전성 게이트를 통과하지 못하면 실제 판매를 연기한다.

저장소는 NAZIR 전용 `kkkkmini/NAZIR`이다. 기존 Preview AI 저장소와 혼동하거나 재사용하지 않는다.

## 2. 반드시 읽을 문서 (모두 `docs/`)

1. `DECISIONS.md` — 확정 정책·설계 채택안·미결정·외부 확인 (충돌 시 확정 정책 우선)
2. `DATABASE.md` — 테이블·상태·전이·트랜잭션·잠금의 정본
3. `API_SPEC.md`
4. `ARCHITECTURE.md`
5. `IMPLEMENTATION_PLAN.md`
6. `TEST_PLAN.md`
7. 본 문서 `CLAUDE_HANDOFF.md`

v1.0 원문은 `docs/archive/v1.0/`에 보존되어 있으며 참고용이다(구현 기준 아님).

## 3. 사용자 확정 정책 요약 [확정]

| ID | 정책 |
|---|---|
| D-001 | 좌석 변경 Phase 1 제외. 취소 후 재예매 |
| D-002 | 일반 점유 7분(연장 없음) |
| D-003 | 결제 승인 확인 단계 최대 3분 별도 보호. 3분 경과는 실패·해제 근거가 아님 |
| D-004 | 본인인증 Phase 1 필수, 좌석 선택 전 완료 |
| D-005 | 카드·PG 지원 간편결제. 가상계좌 제외 |
| D-006 | 동일 본인인증 식별자 기준, 동일 회차 최대 4석 |
| D-007 | PG 관리자 페이지 수동 환불, PG 결과 확인 후 DB 반영 |
| D-008 | 동일 회차 1인 활성 주문 1건(결제 중·UNKNOWN 포함) |

예매 흐름: **본인인증 → 인증 세션 → 공연·회차 → 좌석 → 점유·주문 → 결제 → PG 승인 검증 → 티켓**

## 4. 검토 이력

- **Step 0(완료):** v1.0 문서 독립 기술 검토. BLOCKER B1~B5, HIGH H1~H9, MEDIUM M1~M12, LOW L1~L8 보고.
- **Step 0.5(본 개정):** 검토 결과와 확정 정책을 v1.1 문서에 반영. 반영 위치는 `DECISIONS.md` §2(A-001~A-023).
- 다음: 사용자 승인 → 구현 전 결정(§9) → Step 1·2 착수.

## 5. 구현 시 특별히 지킬 설계 핵심

- **결제 확인 펜싱**: Tx1(검증 + `CONFIRMING` 커밋) → 트랜잭션 밖 PG confirm → Tx2(반영). 3분 경과 시 Tx3로 UNKNOWN, 좌석 보호 유지. (DATABASE §11.6, ARCHITECTURE §5)
- **PG 서버 승인형 전제**: confirm 전에는 결제가 확정되지 않아야 한다. PG 선정 시 필수 확인(E-002). 성립하지 않으면 결제 설계를 재검토하고 사용자에게 보고한다.
- **구매 한도**: `purchase_quotas` 행 잠금 + 카운터 + CHECK. COUNT 후 INSERT 금지. (DATABASE §5.7, §11.2)
- **활성 주문·진행 중 결제·좌석 점유·유효 티켓**: 각각 partial unique로 DB 최종 방어.
- **`order_items` 불변, hold 1:1**, 점유 만료는 주문 단위 `hold_expires_at`.
- **판매 좌석 소유권**: `session_seats.sold_order_item_id`. 환불 해제는 소유 항목일 때만.
- **환불**: 요청 기록 → PG 실행 → PG 재조회 검증 → 완료(티켓 VOID·좌석 해제·한도 복구 한 트랜잭션). `SEAT`/`PAYMENT_EXCESS` 구분.
- **인증·접근·Idempotency는 브라우저 바인딩과 소유 주체에 귀속**.
- **외부 복귀 경로는 쿠키 비의존**, nonce + provider 재조회 + 303.
- **전역 잠금 순서**: quota → orders → payments → refunds → session_seats(id 순) → seat_holds → tickets.
- **Prisma + raw SQL migration + 스키마 계약 테스트**(CI 필수).

## 6. 기술 방향

Next.js + TypeScript + React, PostgreSQL(15+ 권장), Prisma + raw SQL migration, 모듈형 모놀리스, DB Source of Truth, Outbox 기반 Sheets mirror, PG/본인인증 provider adapter + 장애 주입 mock.

호스팅/PG/인증사 미확정 항목은 공식 자료와 계약 상태를 확인해 결정한다. 업체가 미정이면 mock adapter만 구현하고 production flow는 비활성화한다. 확인되지 않은 업체·플랜 기능을 사실로 단정하지 않는다.

## 7. 작업 프로토콜

`Inspect → Plan → Implement → Test → Review → Report → Document`

작업 전 변경 범위, 영향, 위험, 테스트 계획을 제시한다. 작업 후 변경 파일, 실행 명령/결과, 실패/미실행 테스트, migration 영향, 보안/동시성 영향, 남은 위험을 보고한다. 테스트를 약화하거나 실패를 숨기지 않는다. 코드와 문서가 달라지면 같은 작업에서 문서를 갱신한다. 커밋·푸시는 사용자 승인 후 지정 브랜치에만 한다.

## 8. 절대 금지

- 브라우저 redirect·클라이언트 플래그만으로 결제 또는 본인인증 성공 확정
- 클라이언트 금액·좌석 상태·returnUrl 신뢰
- 클라이언트 timer로 hold 만료 판정
- 3분 보호 경과만으로 결제 실패 처리 또는 좌석 해제
- UNKNOWN에서 PG 조회 전 재결제 허용 또는 좌석 재판매
- PG·인증사 호출을 DB 트랜잭션 안에서 실행
- 구매 한도를 잠금 없는 COUNT 후 INSERT로 구현
- 좌석 변경 목적의 `order_items` UPDATE
- 다른 브라우저에서 인증 세션·인증 결과 재사용 허용
- DB 직접 수정으로 운영 복구
- SQLite로 PostgreSQL 동시성 테스트 대체
- Sheets를 정본으로 사용
- 로그에 토큰·카드정보·인증 원문·동일인 식별값·불필요한 개인정보 저장
- 공유 환경 `prisma db push`
- P0 실패를 무시하고 공개
- `DECISIONS.md`의 미결정 사항을 임의 확정

## 9. 실행 순서

1. 문서/저장소 조사 및 독립 검토 (완료)
2. 문서 v1.1 개정 및 사용자 승인 (진행 중)
3. 프로젝트 기반(Step 1) — 승인 후 즉시 가능
4. PostgreSQL schema/migration + 계약 테스트(Step 2)
5. 공연/회차/좌석 조회
6. 본인인증·인증 세션·바인딩
7. 주문/한도/점유/취소/Idempotency
8. 결제/펜싱/UNKNOWN/Webhook/티켓
9. 예매 확인/조회
10. 관리자/감사/review case/환불
11. Sheets Outbox worker, 정합성 검사, 대사
12. 실환경 연동·통합 테스트·보안·부하·배포·리허설

각 단계의 완료 기준은 `IMPLEMENTATION_PLAN.md` §4, 안전성 테스트는 `TEST_PLAN.md`, Go/No-Go는 `TEST_PLAN.md` §15를 따른다.

### 9.1 Step 2(schema) 착수 전 필요한 사용자 결정

- v1.1 문서 및 설계 채택안(A-001~A-023) 승인
- Q-004: 활성 주문에 `REVIEW_REQUIRED` 포함 여부
- A-001: PG 서버 승인형 전제 승인(업체 확인은 E-002에서 병행)

나머지 미결정은 설정값으로 구현하며 구현 중 결정해도 된다(`DECISIONS.md` §3).

## 10. 미결정 사항

`DECISIONS.md` §3(Q-001~Q-016), §4(E-001~E-011)에 질문·선택지·영향·결정 담당·상태를 기록한다. 새 미결정이 생기면 같은 양식으로 추가하고 사용자에게 보고한다.

## 11. 변경 이력

| 버전 | 일자 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-11-13 | 최초 전달 지침. 원문: `docs/archive/v1.0/CLAUDE_HANDOFF` |
| 1.1 | 2026-11-14 | 파일명 `CLAUDE_HANDOFF.md`로 정정, `DECISIONS.md` 추가 및 읽기 순서 조정, 확정 정책 요약, 검토 이력, 설계 핵심, 금지 사항 확장, 실행 순서에 문서 개정 단계 추가, Step 2 착수 전 결정 항목 명시 |
