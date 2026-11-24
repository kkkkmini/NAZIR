# Step 3 인수인계 (다음 세션: Step 4 시작용)

> 작성 2026-11-24. 정본은 `IMPLEMENTATION_PLAN.md`(단계·완료 조건), `TEST_PLAN.md`(테스트 ID·결과), `DECISIONS.md`(결정·미결정), `DATABASE.md` §19(구현 기록)다. 이 문서는 요약과 다음 할 일만 담는다. 내용이 다르면 정본을 따르고 이 문서를 고친다.

## 1. Step 3 최종 상태

| 영역 | 상태 | 요약 |
|---|---|---|
| A. 코드 구현 | **완료** | 공개 조회 API 4종, 공연·회차·좌석(읽기 전용) 페이지, 임시 격자 배치도, 판매·좌석 표시 상태, 정책·사업자 정보 페이지(입력 대기), DB 시각(DbClock)·세션 UTC·Neon Pooled/Direct 연결, 통합 리뷰 즉시 수정(M1·M2·L1·M4) |
| B. 자동화 테스트 | **완료** | §4. 실패 0. lint 경고 1(오류 0) |
| C. 실제 환경 검증 | **미완료** | 실제 Neon 미검증(H1), Vercel Preview 배포·접근 상태 이 세션에서 확인 불가(H2) |
| D. 운영 콘텐츠 | **미완료** | §6 전부 입력 대기 |

**판정:** 코드 기준 Step 3 완료. IMPLEMENTATION_PLAN의 Step 3 완료 기준 "DB 상태와 UI 일치"는 자동 테스트(CAT-API-*, CAT-UI-01, PAGE-*)로 충족했다. **실판매 준비 완료가 아니다** — C·D와 미결정 사항(§5)이 남아 있다.

## 2. 브랜치와 HEAD

- 브랜치: `claude/epic-ptolemy-vy178w` (원격에 push 완료, `main` 미병합, PR 없음)
- 이 문서를 담은 커밋이 최종 HEAD다. 직전 코드·문서 HEAD는 `7b40fe0`.

## 3. 커밋 (`main` = `e43d74a` 이후)

| SHA | 내용 |
|---|---|
| `586a729` | DbClock(DB 시각, epoch ms), 판매 상태(`sales-status.ts`, §11.11)·좌석 표시 상태(`seat-display.ts`, §11.1), 앱·seed 연결 세션 `TimeZone=UTC`(`pg-adapter.ts`, S11) |
| `421d66e` | Neon Pooled(`DATABASE_URL`, 앱)·Direct(`DATABASE_URL_UNPOOLED`, CLI·seed) 분리와 쌍 검증, 기동·`check:config` 공통 규칙, `npm run verify:db-session` |
| `1c3ebe2` | 공개 조회 API 4종, 좌석 배치도·상태 표시 컴포넌트, 좌석 정렬 수정(M2) |
| `a97f23b` | 공개 페이지(홈·공연·좌석·정책·사업자 정보), 데이터 로딩 분리(`src/app/_catalog/content.tsx`), 오류 경계 `retry`(M1), 페이지 테스트(M4) |
| `7b40fe0` | 문서(API_SPEC·DATABASE·TEST_PLAN·DECISIONS·IMPLEMENTATION_PLAN·README) |

## 4. 최종 테스트 결과

`7b40fe0` 트리(작업 트리 깨끗함)에서 2026-11-24 11:04 UTC에 새로 실행:

| 검사 | 결과 |
|---|---|
| `npm test` | 12 files / 295 passed |
| `npm run test:db` (로컬 PostgreSQL 16) | 14 files / 390 passed |
| lint / typecheck / `prisma validate` | 통과(lint 경고 1: `tests/contract/schema/catalog.test.ts` 쉼표 표현식, 기능 무관) |
| build(DB URL 없음) / `check:bundle` | 통과 |
| GitHub Actions CI | `421d66e`·`1c3ebe2`·`a97f23b` 성공. `7b40fe0` 이후는 최종 보고 시점 상태 참고 |

각 코드 커밋은 push 전에 그 커밋의 트리만 꺼내(`git archive`) typecheck·lint·unit·DB 테스트를 따로 실행해 통과했다. 실행하지 못한 것: 실제 Neon 대상 검증, Vercel Preview 접속(이 세션의 권한 정책상 차단).

## 5. 미해결 항목과 위험

| 항목 | 내용 | 처리 시점 |
|---|---|---|
| **H1** Neon 미검증 | 앱 시각 정확성은 연결 시작 파라미터 `-c TimeZone=UTC`에 의존. 로컬 PgBouncer 1.22(트랜잭션 모드)에서는 적용 확인, Neon은 미확인. 무시되면 시각이 조용히 9시간 어긋난다 | Preview/Test DB 연결 직후 `npm run verify:db-session` (비파괴). 운영 DB에서 실행하지 않는다 |
| **H2** 공개 Preview·rate limit 없음 | Preview 보호 꺼짐(사용자 설정), 공개 API·페이지는 `no-store`, rate limit 미구현. DB를 연결하면 누구나 반복 조회로 DB 부하·비용을 만들 수 있다 | DB 연결 **전에** 결정: Preview 보호, rate limit(Q-013), 짧은 캐시(Q-031) |
| **M3** `DATABASE_URL` 기동 필수 여부 | 현재 없어도 기동(PAGE-06이 현재 동작 고정), 대신 카탈로그 화면은 오류 | 사용자 결정 |
| M5 | 없는 공연·회차 페이지는 HTTP 200 + not-found 화면 + `noindex`(PPR). API는 404 | 결정 후 |
| M6 | 공개 API가 회차별 판매·점유·차단 좌석 수 노출 | 사용자 결정 |
| Q-030~Q-033 | `CLOSED` 공연 노출(임시: 숨김), 공개 API 캐시·rate limit, `BLOCKED`만 남은 회차 표시(현재 매진), 판매 불가 사유 우선순위 | 사용자 결정 |
| 디자인 브랜치 | `claude/amazing-noether-2z1zrh`에 프런트 예매 흐름 프로토타입(dev fixture 기반, Step 1 기준 분기, 72개 파일, 2026-11-22)이 있다. `src/app/page.tsx`·`layout.tsx`·`src/components/site` 등이 이 브랜치와 겹친다. 이 브랜치는 수정·병합하지 않았다 | Step 4 UI 착수 전 통합 방식 결정 |

## 6. 실제 환경·운영 데이터 입력 대기

추측으로 채우지 않았다. 모두 사용자 제공 필요.

- 실제 공연·회차 정보, 공연장 좌석 배치도(SVG)와 좌석 ID 규칙(E-003), 좌석별 가격·수수료(E-004)
- 사업자 정보 8개 항목(`src/components/site/business-info.ts`, 현재 전부 `null` → "입력 대기")
- 이용약관, 개인정보처리방침(E-006), 취소·환불 규정(E-005), 고객 문의 채널(U4), 카드사 심사 요건(E-008)
- Preview용 Neon DB: 이름이 `_test`로 끝나야 함(`neondb` 거부), `DATABASE_URL`=Pooled·`DATABASE_URL_UNPOOLED`=Direct 같은 DB, `NAZIR_RUNTIME_ENV=test`, Production 범위에 넣지 않기. migration은 Vercel 빌드가 하지 않으므로 Direct 주소로 `npm run db:migrate:deploy`를 별도 실행

## 7. Step 4 시작 전 알아야 할 기술 결정

- **범위**(IMPLEMENTATION_PLAN Step 4): 바인딩·CSRF bootstrap, 인증 시작·콜백·claim, 인증 세션(고정 30분·잔여 10분·주문 생성 제한, D-015), subject HMAC, Mock IdentityProvider, NICE adapter 골격. 완료 기준 IDV-*·NIC-01~04(Mock).
- **선행 결정:** Q-002(동일인 식별값, 설정값으로 구현), **Q-016·E-006 개인정보 보관·파기·암호화**(IMPLEMENTATION_PLAN §4.1 Q-028 행: "Step 4 시작 전 사용자 결정 필요"), Q-013 rate limit 저장소(인증 시작은 건당 과금이라 P0).
- **DB 규칙(이미 구현):** claim 트랜잭션은 인증 `VERIFIED→CONSUMED`와 세션 INSERT를 한 트랜잭션에서 어느 순서로든 쓸 수 있고, 불일치는 **COMMIT에서** `23514`로 나온다(A-040, IMPLEMENTATION_PLAN §4.1).
- **시간:** 모든 만료 판단은 DB 시각. 트랜잭션 안에서는 `new DbClock(tx)`(트랜잭션 시작 시각 하나), 요청 단위는 `getAppClock()`. 앱 코드에서 `SET TIME ZONE` 금지.
- **연결:** 앱은 `getPrisma()`(Pooled)만. 인증·주문 쓰기도 같은 클라이언트의 interactive transaction(명시적 READ COMMITTED).
- **Provider:** Mock 인증은 local·test에서만 기동(staging·production은 기동 검사가 거부, D-013). NICE 미확인 동작은 설정값으로(PROVIDERS.md).
- **응답·오류:** `AppError`/`toErrorResponse`(`src/server/lib/errors.ts`), 공개 필드 허용 목록 방식(`src/server/catalog/http.ts` 참고).

## 8. Step 5 전에 해결할 선행 과제

- **M7 오류 매핑(S7):** interactive `$transaction`의 COMMIT 시점 제약 오류는 `DriverAdapterError` 그대로(`cause.originalCode`, `cause.constraint`), 문장 시점 오류는 `PrismaClientKnownRequestError.meta.driverAdapterError.cause`. 트리거 오류 `23001`은 `P2003`으로 위장된다. 두 형태 모두 `DB_CONSTRAINT` 이름으로 도메인 오류에 매핑하고, 매핑 테스트를 먼저 만든다(DATABASE §19.11).
- **M8 연결 풀·트랜잭션:** `buildPgPoolConfig`가 풀 크기를 정하지 않아 `pg` 기본값(10)이 서버리스 인스턴스마다 적용된다. 인스턴스 수 × 풀 크기가 Neon pooler 한도 안인지 정하고 `max`를 설정한다. 주문 생성은 한 트랜잭션에서 `DbClock(tx)`·`FOR UPDATE`·§13.2 잠금 순서. Pooled 연결에서의 동작은 H1 검증 결과로 확인한다.
- **기존 이월:** S2(`SOLD` 좌석의 live hold DB 방어 재검토), S10(partial unique `ON CONFLICT` predicate), Q-025(주문번호 형식) — IMPLEMENTATION_PLAN §4.1.
- **rate limit 기반(Q-013):** Step 4·5의 P0 요구이고 H2 해소에도 필요하다.

## 9. 다음 세션 첫 작업

1. `git fetch` 후 이 브랜치의 HEAD와 CI 상태 확인.
2. 사용자에게 Step 4 선행 결정(Q-016·E-006, Q-002, Q-013)과 H2 대응을 확인.
3. Step 4 첫 단위: 브라우저 바인딩 쿠키와 CSRF bootstrap(`GET /api/v1/bootstrap`, API_SPEC §3.1·§3.3·§4.1)과 그 테스트.
