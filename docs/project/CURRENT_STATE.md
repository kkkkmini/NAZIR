# NAZIR — CURRENT STATE

> 기준일: 2026-11-27  
> 세션이 바뀌어도 프로젝트의 실제 구현 위치와 미통합 상태를 혼동하지 않기 위한 공통 현황판.  
> **이 문서는 상태 요약이며 정책·DB·API·아키텍처의 정본이 아니다.** 세부 규칙은 아래 연결된 원본 문서를 따른다.

## 1. 현재 기준점

| 영역 | 브랜치 | 기준 커밋 | 상태 |
|---|---|---|---|
| main | main | e43d74a | Step 2 기준 |
| 프론트·백엔드 통합 | claude/nazir-integration | 0ae34c2 (통합 1단계 merge 1e71ef5 + 문서 커밋 3개) | 프론트 UI + 백엔드 Step 4 통합. 통합 2단계(공통 셸·정책 경로) 로컬 미커밋. Step 5 미반영 |
| 최신 백엔드 | claude/pensive-allen-5djvof | 8b27bb345b86d0bba90da46c7ee9f8328ba6588f | Step 5 주문 생애주기 구현 완료 보고 |
| 프론트 디자인·예매 UI 원본 | claude/amazing-noether-2z1zrh | 6d8ea32 | 통합 브랜치에 반영된 프론트 기준점 |

**중요:** 위 커밋은 서로 다른 브랜치의 기준점이다. 통합된 하나의 코드 상태로 간주하지 않는다. 특히 Step 5는 백엔드 브랜치에 있고 통합 브랜치에는 아직 없다.

- 통합 브랜치 기준 커밋 1e71ef5는 GitHub에서 확인했다. 2026-11-27 문서 커밋 3개(23ef982·e87bfb6·0ae34c2)를 로컬에 fast-forward로 반영해 로컬·원격 HEAD가 0ae34c2로 일치한다.
- 백엔드 Step 5 커밋 8b27bb3의 커밋 객체와 문서는 확인했다. 해당 브랜치의 HEAD가 이 커밋이라는 점은 2026-11-26 백엔드 복원 보고서 기준이며, 이 문서 작성 시점에 ref HEAD를 별도로 재조회한 것은 아니다.
- main은 별도 승인 없이 변경하지 않는다.

## 2. 개발 단계 현황

| Step | 기능 | 현재 상태 |
|---|---|---|
| 0–0.5 | 기존 문서 조사·기술 검토 | 완료 |
| 1–2 | 기반·PostgreSQL 스키마 | 구현 완료로 기록됨. main 기준 및 브랜치 반영 상태는 별도 확인 |
| 3 | 공연·회차·좌석 조회 | 코드 구현 완료 |
| 4 | 본인인증·인증 세션 | Mock 기준 기능 완료. NICE 실연동 전 |
| 5 | 주문 생성·좌석 점유·만료·취소·재예약 | 백엔드 전용 브랜치에서 코드 구현 완료 보고. 통합 브랜치 미반영 |
| 6 | 결제·Toss·Webhook·티켓 발급 | 미착수 |
| 7 | 주문 목록·모바일 확인서 | 미착수 |
| 8 | 관리자·환불·운영 복구 | 미착수 |
| 9 | Outbox·Sheets·정합성 검사 | 미착수 |
| 10 | NICE·PG 실연동 및 운영 검증 | 미착수 |

Step 3~5의 “구현 완료”는 코드·테스트 보고 기준이며, 운영환경에서 검증 완료를 뜻하지 않는다.

## 3. Step 5 복원 요약

백엔드 Step 5는 다음 다섯 단위를 포함한다.

1. 예약 트랜잭션 실행기, READ COMMITTED, 잠금·타임아웃·제한 재시도.
2. 좌석·Hold 무결성 DB 방어.
3. 주문번호 NZ-YYYYMM-NNNNNN, PostgreSQL 전역 Sequence.
4. 주문 생성 API, 원자적 다중 좌석 점유, 구매 한도, Idempotency, 주문 접근 세션.
5. expireOrder, 주문 생성 전 사전 정리, 정기 만료 API, 취소·재예약.

백엔드 보고서 및 Step 5 브랜치 문서에 기록된 테스트 결과:
- Unit 497 passed.
- PostgreSQL DB tests 716 passed.
- EX 16, PC 9, JOB 7, CN 18 테스트 그룹 통과(각 3~5회 반복 보고).
- Unhandled Errors 0, Connection Leaks 0.
- Lint, typecheck, Prisma validate, build, bundle check, diff check 통과 보고.

**검증 범위 주의:** 위는 2026-11-26 백엔드 세션의 실행 보고 및 TEST_PLAN.md 기록이다. 이 현황판 작성 시점에 테스트를 다시 실행한 것은 아니다. Neon Pooler 및 Vercel Preview/Production 실환경 검증도 완료된 것으로 간주하지 않는다.

## 4. Step 5 이후 핵심 미결정·위험

| 항목 | 현재 기록 | 취급 |
|---|---|---|
| Q-011 | 결제 시작 시 최소 잔여 Hold 시간. 60초는 권장안 | 사용자 확정 전 임의 확정 금지 |
| Q-035 | 성공한 주문만 주문 생성 rate limit에 포함. 실패 요청 반복 남용 방어는 별도 미구현 | 실판매 전 선행 과제 |
| Q-037 | 취소·만료 주문의 접근 세션은 현행 유지(읽기 전용)로 구현, 최종 정책 미결정 | 사용자 결정 필요 |
| Q-038 | Cron 주기 및 staging/production의 CRON_SECRET 필수화 미결정. vercel.json 미추가로 기록 | 이전 대화 합의와 저장소 정본의 차이를 재확인·문서화 |
| M8 / DB Pool | Neon Pooler·Vercel 인스턴스 한도에 맞춘 운영 수치 미확정 | 실환경 확인 전 Production 준비 완료 금지 |
| A-047 | Vercel Preview의 실제 전달 IP 헤더 검증 및 만료 카운터 정리 스케줄 미완료로 기록 | Preview 실측 필요 |
| 외부 연동 | NICE 계약·DI 제공 범위, Toss Sandbox 키·실제 연결 상태 미확인 | 확인 전 실연동 완료로 표시 금지 |

## 5. Step 6 결제 구현 시 반드시 보존할 기준

정본은 docs/DECISIONS.md, docs/DATABASE.md, docs/API_SPEC.md, docs/ARCHITECTURE.md, docs/PROVIDERS.md, docs/TEST_PLAN.md다. 백엔드 Step 5 브랜치의 최신 내용을 확인한 후 구현한다.

- Step 5 주문·좌석·Hold·쿼터 로직을 다시 만들지 않는다. 기존 서비스를 기반으로 확장한다.
- 전역 DB 잠금 순서: purchase_quotas → orders → payments → refunds → session_seats(ID 오름차순) → seat_holds → tickets.
- 외부 PG 호출은 DB 트랜잭션 밖에서 한다. 트랜잭션은 READ COMMITTED, 만료 판단은 DB 시각 기준.
- Tx1에서 주문·결제·Hold를 확인/보호하고 COMMIT → 트랜잭션 밖 Toss confirm → Tx2에서 승인 결과·좌석 판매·티켓 발급을 원자적으로 반영.
- 응답 불명확 시 좌석 보호를 유지한다. 3분 경과만으로 실패 처리·좌석 해제·재결제를 허용하지 않는다. UNKNOWN은 PG 재조회로 해소한다.
- Webhook 본문만으로 결제 성공을 확정하지 않는다. 서명·중복 확인 후 저장하고, PG 조회 결과를 기존 상태 반영 규칙과 대조한다.
- 승인 증거 컬럼은 DB 불변 제약을 따른다. Tx2에서 승인 증거 필드를 한 UPDATE 문장으로 함께 기록해야 한다.
- Idempotency 소유 주체 해시는 A-054의 도메인 분리 SHA-256 기준이다. 이전 문서의 오래된 HMAC 표현을 근거로 되돌리지 않는다.
- Mock은 local/test 전용. NICE 미승인 상태에서 실판매 금지.

## 6. 프론트·백엔드 통합 상태

통합 브랜치에는 프론트 UI와 Step 4 백엔드가 반영되어 있다. 백엔드 Step 5는 별도 브랜치에 존재한다.

**통합 2단계(공통 셸·정책 경로, 2026-11-27, 로컬 미커밋 16개 파일):**
- 정책 경로를 백엔드 라우트(`/terms`·`/privacy`·`/refund-policy`·`/business-info`)로 통일. `/policies/{terms,privacy,refund}`는 삭제하고 `next.config.ts`에서 307 리다이렉트. `/policies/support`(고객 문의)는 대응 백엔드 화면이 없어 유지.
- 공통 셸 `src/components/site/site-shell.tsx`(프론트 헤더·푸터, 화이트). 백엔드 `SiteChrome.tsx` 삭제, 정책·사업자 정보·404·오류 화면을 셸 안에 표시. 사업자 정보 원본은 `src/components/site/business-info.ts` 하나.
- 예매 화면 UI 변경 없음(A3-4 환불 규정 링크 주소만 변경).
- 검증(2026-11-27, 이 세션에서 실행, 로컬 컨테이너): `npm run check`(lint 오류 0·경고 1 기존, typecheck, unit 425 passed), `test:db` 506 passed(로컬 격리 PostgreSQL `nazir_test`), `build`, `check:bundle` 통과. 로컬 서버 브라우저 E2E: 예매·조회 흐름 18단계(데스크톱·모바일), 정책·404·오류 화면, 리다이렉트, staging 모드에서 [DEV]·Mock API 미노출. Preview·실환경 검증 아님.
- 커밋·push는 사용자 승인 대기.

통합 시에는 코드만 cherry-pick/merge하지 말고 다음을 함께 대조한다.
- DB migrations 및 Prisma schema
- 주문·좌석·Hold 서비스와 트랜잭션 헬퍼
- API 경로·요청/응답 계약과 프론트 adapter/loader
- 환경변수·Provider 설정
- 테스트 및 문서
- 좌석 배치도 등 중복 구현(Site shell·정책 페이지 중복은 통합 2단계에서 정리, 미커밋)

통합 전에는 Step 5를 통합 브랜치에 이미 반영했다고 말하지 않는다. main 병합·rebase·force push는 별도 사용자 승인 없이 수행하지 않는다.

## 7. 정본 문서 안내

| 목적 | 정본 |
|---|---|
| 사용자 정책·채택안·미결정 | docs/DECISIONS.md |
| DB 구조·상태·트랜잭션·잠금 | docs/DATABASE.md |
| API 계약 | docs/API_SPEC.md |
| 모듈·Tx1/Tx2/Tx3·Provider 구조 | docs/ARCHITECTURE.md |
| 단계별 구현 현황·다음 Step | docs/IMPLEMENTATION_PLAN.md |
| 테스트 시나리오·결과 기록 | docs/TEST_PLAN.md |
| NICE·Toss 공식 근거 및 확인 수준 | docs/PROVIDERS.md |
| 프론트 IA·사용자 흐름·디자인 기록 | docs/design/ |

각 브랜치의 문서는 그 브랜치의 구현 상태를 반영한다. 브랜치 간 내용 차이를 확인하지 않고 한쪽 문서를 다른 쪽의 정본으로 간주하지 않는다.

## 8. 마지막 확인 한계

다음은 이 현황판 작성 시점에 완료로 단정하지 않는다.
- 전체 테스트 재실행 및 두 브랜치 병합 후 빌드
- Neon Pooler 실제 연결·잠금·지연 trigger 검증
- Vercel Preview 보호·환경변수 범위·IP 헤더·함수 실행 시간 검증
- Toss Sandbox 실제 결제와 NICE 실연동
- 최신 화면의 브라우저 E2E 재검증

상태가 바뀌면 날짜·브랜치·커밋·실행 근거를 함께 갱신한다.
