# NAZIR — CLAUDE CODE HANDOFF

> 문서 버전: 1.3 · 기준일: 2026-11-27 · Claude Code 전달 및 실행 지침  
> 이전 버전 원문: docs/archive/v1.0/CLAUDE_HANDOFF, docs/archive/v1.1/CLAUDE_HANDOFF.md

## 1. 프로젝트 및 역할

NAZIR은 뮤지컬 〈나지르〉 티켓 예매 웹사이트다. 사용자는 제품 기획과 최종 의사결정을 맡고, Claude Code는 저장소 조사·기술 검토·구현·테스트·디버깅을 수행한다. 공개 목표일은 일정 목표일 뿐이며 안전성 게이트를 통과하지 못하면 실제 판매를 연기한다.

저장소는 NAZIR 전용 kkkkmini/NAZIR다. 다른 프로젝트 저장소와 혼동하거나 재사용하지 않는다.

## 2. 세션 시작 시 필수 문서

**가장 먼저** docs/project/CURRENT_STATE.md와 docs/project/HANDOFF.md를 읽는다. 이 두 문서는 현재 상태와 다음 작업의 길잡이이며, 정책·DB·API의 상세 정본을 대체하지 않는다.

그다음 현재 작업 브랜치의 다음 정본을 읽는다.

1. docs/DECISIONS.md — 사용자 확정 정책·설계 채택안·미결정·외부 확인
2. docs/DATABASE.md — 테이블·상태·전이·트랜잭션·잠금의 정본
3. docs/API_SPEC.md — API 계약
4. docs/ARCHITECTURE.md — 모듈·외부 연동·결제 Tx 설계
5. docs/IMPLEMENTATION_PLAN.md — 단계별 구현 현황과 완료 기준
6. docs/TEST_PLAN.md — 테스트 시나리오·결과·Go/No-Go
7. docs/PROVIDERS.md — Toss·NICE 공식 근거 및 확인 수준
8. 본 문서 CLAUDE_HANDOFF.md — 작업 프로토콜과 금지 사항

프론트 UI/UX 작업은 docs/design/의 IA·User Flow·Integration Notes도 확인한다. 디자인 문서는 작성 당시의 설계 기록일 수 있으므로 현재 코드 구현과 구분한다.

**브랜치별 문서가 다르면 현재 작업 브랜치의 문서를 먼저 확인하고, 다른 브랜치의 문서를 섞어 정본처럼 취급하지 않는다.** 특히 Step 5 최신 백엔드 정본과 통합 브랜치 상태는 docs/project/CURRENT_STATE.md의 브랜치 표를 따른다.

## 3. 현재 개발 기준점 (2026-11-27)

| 영역 | 브랜치 | 기준점 | 상태 |
|---|---|---|---|
| main | main | e43d74a | Step 2 기준 |
| 프론트·백엔드 통합 | claude/nazir-integration | 0ae34c2 | 프론트 UI + Step 4. 통합 2단계(공통 셸·정책 경로) 로컬 미커밋, Step 5 미반영 |
| 최신 백엔드 | claude/pensive-allen-5djvof | 8b27bb345b86d0bba90da46c7ee9f8328ba6588f | Step 5 완료 보고 |
| 프론트 원본 | claude/amazing-noether-2z1zrh | 6d8ea32 | 프론트 UI 기준 |

통합 2단계(공통 셸·정책 경로 통일, 16개 파일)는 검증을 마쳤으나 커밋·push 승인 대기 중이다(내용: CURRENT_STATE.md §6). 다음 통합 작업은 Step 5 병합 사전 검토다. 백엔드 Step 5는 통합 브랜치에 아직 병합되지 않았다. Step 6 결제는 미착수다. 이 문서의 SHA를 작업 시작 시점의 최신 HEAD라고 가정하지 말고 GitHub에서 다시 확인한다. 위 브랜치 간 통합·병합 상태는 CURRENT_STATE.md를 기준으로 한다.

## 4. 사용자 확정 정책 [확정]

| ID | 정책 |
|---|---|
| D-001 | 좌석 변경 Phase 1 제외. 기존 주문 취소 후 새로 예매 |
| D-002 | 일반 좌석 점유 7분, 연장 없음 |
| D-003 | 결제 승인 확인 단계 최대 3분 별도 보호. 3분 경과만으로 실패·해제 금지 |
| D-004 | 본인인증 필수, 좌석 선택 전에 완료 |
| D-005 | 카드 및 PG 지원 간편결제. 가상계좌 제외 |
| D-006 | 동일 본인인증 주체·동일 회차 최대 4석 |
| D-007 | PG 관리자 페이지 수동 환불, PG 결과 확인 후 DB 반영 |
| D-008 | 동일 회차 동일 주체 활성 주문 1건. 결제 중·UNKNOWN 포함 |
| D-009 | PG 토스페이먼츠, 본인인증 NICE아이디. Provider Adapter로 격리 |
| D-010 | 토스 결제창 API 개별 연동 |
| D-011 | 1차 결제수단 카드·토스페이·네이버페이. 페이코·가상계좌 제외, 카카오페이 추후 검토 |
| D-012 | 승인된 결제수단만 노출. 결제 가능 범위가 지나치게 제한되면 판매 연기 |
| D-013 | NICE 승인 전 실판매 금지. Mock 인증으로 실판매 금지 |
| D-014 | 활성 주문은 PENDING·PAYMENT_CONFIRMING·PAYMENT_UNKNOWN·REVIEW_REQUIRED |
| D-015 | BOOKING 인증 세션 발급 후 고정 30분, sliding 없음. 같은 브라우저 재사용. 주문 생성 시 잔여 10분 이상 |

예매 흐름: 본인인증 → 인증 세션 → 공연·회차 → 좌석 → 점유·주문 → 결제 → PG 승인 검증 → 티켓.

정책의 세부 해석 및 변경 이력은 반드시 DECISIONS.md를 따른다. 표의 요약만으로 정책을 확장하거나 바꾸지 않는다.

## 5. 구현·보안 핵심

- PostgreSQL이 유일한 Source of Truth다. Google Sheets는 비동기 mirror다.
- 서버가 가격·좌석·주문·결제·인증 상태를 결정한다. 클라이언트 입력·타이머·redirect를 신뢰하지 않는다.
- Step 5 주문·좌석·Hold·쿼터 로직을 재구현하지 않는다. 최신 백엔드 브랜치의 구현과 문서를 검토해 확장한다.
- 전역 DB 잠금 순서: purchase_quotas → orders → payments → refunds → session_seats(ID 오름차순) → seat_holds → tickets.
- 예약/결제 트랜잭션은 READ COMMITTED. 만료·보호 시간은 DB 시각을 기준으로 판정한다.
- 외부 PG·인증사 네트워크 호출은 DB 트랜잭션 밖에서 수행한다.
- 결제는 Tx1(검증·CONFIRMING 보호 커밋) → 외부 PG confirm → Tx2(승인 결과·좌석 SOLD·Hold CONVERTED·티켓 발급 원자 반영) 구조를 따른다.
- 응답 불명확 시 UNKNOWN으로 보호를 유지한다. 3분 경과만으로 실패·좌석 해제·재결제를 허용하지 않고 PG 재조회로 해소한다.
- Webhook은 서명 검증·중복 확인 후 저장하고 신속히 응답한다. Webhook 본문만으로 결제 성공을 확정하지 않는다. 비동기 PG 조회 결과를 DB 상태와 대조한다.
- Tx2 승인 증거 필드는 DB 불변 제약을 고려해 하나의 UPDATE 문장에서 함께 기록한다.
- Q-036 멱등성 소유 주체 해시는 A-054의 도메인 분리 SHA-256이다. 과거 문서의 HMAC 표현을 근거로 되돌리지 않는다.
- Provider 고유 데이터는 Adapter 안에서 정규화한다. MOCK은 local/test 전용이며 운영에서 Mock·테스트 키로 기동하지 않는다.
- NICE 승인 및 실제 연동 검증 전에는 실판매하지 않는다.

## 6. 작업 프로토콜

작업 흐름은 다음을 따른다.

Inspect → Plan → Implement → Test → Review → Report → Document

1. 시작 전 현재 브랜치·HEAD·작업 트리·기존 변경 사항을 확인한다.
2. 관련 정본 문서와 기존 구현을 조사한다. 이미 있는 기능을 다시 만들지 않는다.
3. 영향 파일, 변경 범위, DB migration, API/UI 영향, 동시성·보안 위험, 테스트 계획을 먼저 제시한다.
4. 사용자가 승인한 범위만 구현한다.
5. 테스트를 실행하고 실제 실행한 명령과 결과를 기록한다. 실행하지 않은 테스트를 통과로 보고하지 않는다.
6. 코드와 문서가 달라지면 같은 작업에서 관련 정본 문서를 갱신한다.
7. 완료 보고에는 변경 파일, 테스트 결과, 실패·미실행 검증, migration 영향, 남은 위험을 포함한다.

## 7. Git 작업 규칙

- 사용자 승인 없이 commit/push하지 않는다. 사전에 승인된 작업 체크포인트에서만 승인 범위 내 기능 단위 commit/push를 수행한다.
- “좋아” 또는 구현 승인만으로 main 병합 승인을 의미하지 않는다.
- main 병합, 다른 브랜치 병합, rebase, force push는 별도 명시 승인 전 금지한다.
- 작업은 지정된 브랜치에서만 한다. 다른 브랜치의 작업물을 가져올 때는 변경 파일·migration·테스트·문서를 함께 비교한다.
- 원본 프론트·백엔드 브랜치를 보존한다.
- 브랜치 HEAD가 예상과 다르면 작업을 멈추고 차이를 보고한다.

## 8. 절대 금지

- 브라우저 redirect·클라이언트 플래그만으로 결제 또는 본인인증 성공 확정
- 클라이언트 금액·좌석 상태·returnUrl 신뢰
- 클라이언트 timer로 Hold 만료 판정
- 3분 보호 경과만으로 결제 실패 처리 또는 좌석 해제
- UNKNOWN에서 PG 조회 전 재결제 허용 또는 좌석 재판매
- PG·인증사 호출을 DB 트랜잭션 안에서 실행
- 구매 한도를 잠금 없는 COUNT 후 INSERT로 구현
- 좌석 변경 목적의 order_items UPDATE
- 다른 브라우저에서 인증 세션·인증 결과 재사용 허용
- DB 직접 수정으로 운영 복구
- SQLite로 PostgreSQL 동시성 테스트 대체
- Sheets를 정본으로 사용
- 로그에 토큰·카드정보·인증 원문·동일인 식별값·불필요한 개인정보 저장
- 공유 환경에서 prisma db push 또는 prisma migrate reset 실행
- P0 실패를 무시하고 공개
- DECISIONS.md의 미결정 사항을 임의 확정
- Mock 인증·결제를 실제 판매에 사용하거나 운영 환경에서 Mock·테스트 키로 기동
- Toss 시크릿·보안 키, NICE client 정보를 저장소·DB·클라이언트 번들·로그에 저장
- Webhook 본문만으로 결제 성공 확정
- PROVIDERS.md에서 [미확인]인 업체 동작을 확정 사실로 가정

## 9. 미결정 및 실판매 전 위험

다음은 임의로 확정하지 않는다. 최신 상태·권장안은 현재 작업 브랜치의 DECISIONS.md와 CURRENT_STATE.md에서 확인한다.

- Q-011: 결제 시작 최소 잔여 Hold 시간. 60초는 권장안이며 사용자 확정 전 미결정.
- Q-035: 실패 요청 반복 남용 방지 제한은 별도 미구현, 실판매 전 선행 과제.
- Q-037: 취소·만료 주문 접근 세션 정책 미결정(현행은 읽기 전용 접근 유지).
- Q-038: 정기 만료 작업 주기와 CRON_SECRET 필수화 미결정. 이전 대화 합의와 정본 문서 차이 확인 필요.
- Neon Pooler·Vercel 인스턴스·실제 함수 실행 시간·IP 헤더 등 운영 수치와 Preview 검증 미완료.
- Toss Sandbox 및 NICE 실연동은 실제 연결·계약 상태를 확인하기 전 완료로 표시하지 않는다.

## 10. 변경 이력

| 버전 | 일자 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-11-13 | 최초 전달 지침. 원문: docs/archive/v1.0/CLAUDE_HANDOFF |
| 1.1 | 2026-11-14 | DECISIONS·확정 정책·설계 핵심·금지 사항·실행 순서 보강 |
| 1.2 | 2026-11-15~16 | PROVIDERS, D-009~D-015, Provider·Webhook·비밀값·쿼터 원칙 반영 |
| 1.3 | 2026-11-27 | CURRENT_STATE·HANDOFF를 세션 진입점으로 추가, 브랜치별 Step 5 미통합 상태, Step 6 진입 원칙, 최신 미결정·Git 작업 규칙 반영 |
