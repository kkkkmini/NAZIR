# 프런트 ↔ 백엔드 통합 준비 기록

> 프런트 브랜치 `claude/amazing-noether-2z1zrh` 기준. 백엔드 브랜치는 병합·복사하지 않고 문서로만 대조한다.
> 통합 브랜치 `claude/nazir-integration` 기준 갱신 2026-11-27(통합 2단계 반영, 미커밋).
> 최종 확인 2026-11-24: 백엔드 Step 3 `claude/epic-ptolemy-vy178w` HEAD `b584b4b`(`docs/STEP3_HANDOFF.md`). Step 4 브랜치는 원격에 없음.

## 1. 데이터 경계

`API(또는 [DEV] fixture) → server loader(src/server/*/get-*.ts) → adapter → view model(src/server/*/…-types.ts) → 화면`

- API 응답 계약 타입: `src/server/api-contract/{catalog,identity}.ts` (문서 기준, 화면에서 직접 쓰지 않음)
- adapter: `src/server/booking/catalog-adapter.ts`(회차), `src/server/seats/seat-adapter.ts`(좌석). 테스트 `tests/unit/api-adapters.test.ts`
- [DEV] fixture는 view model을 바로 만든다(실제 응답을 가장하지 않음). 운영은 loader가 `not-ready`/`not-connected`.

## 2. API 계약 현황

| 영역 | 확인 완료 | 확인 필요 | 백엔드 미구현 |
|---|---|---|---|
| 공연·회차 | `GET /shows`, `/shows/{showId}`, `/shows/{showId}/sessions` 응답(§4.3 Step 3 기록). `Session.status` 7종, `sellable` = `ON_SALE`일 때만 | 공연 식별: API는 UUID `showId`, 페이지는 `slug`(백엔드 `/shows/[slug]`). A1·A3-1은 단일 공연이라 아직 식별자 없음. 회차별 오픈 시각 없음(공연 `salesOpensAt`만). `pagination` 의미(Step 3 L). 판매 불가 사유 우선순위·라벨(Q-033: 판매 중지/판매 일시 중지), `CLOSED` 노출(Q-030), `BLOCKED`만 남은 회차 표시(Q-032) | — |
| A1 콘텐츠 | 제목·설명·포스터·공연장·가격 범위 | 출연진·창작진·러닝타임·관람 등급 등은 API에 없음(R-D) | — |
| 좌석 | `GET /sessions/{id}/seats`: `Seat{id,key,section,row,number,label(null 가능),price,status}`, `seatMap{version,assetUrl}` | `label`이 null일 때 표기 규칙. 좌석 상태 라벨: 프런트 "예매 진행 중" vs 백엔드 "결제 진행 중"(HELD, 확정 여부 확인). 회차별 좌석 수 노출(M6) | — |
| 구매 한도 | 문서 형식 `GET /sessions/{id}/my-quota` | — | 전체(Step 5) |
| 인증 | 문서(§3.1~3.4, §4.1~4.2): bootstrap, start{purpose}, callback→303 `/identity/complete?vid=`, claim{purpose,expiresAt,displayName} | `launch` 형식, `GET /identity-session` 응답 형식, 실패 시 취소·만료 구분 코드, 실패 시 purpose 전달 여부 | 전체(Step 4 착수 전) |
| 주문·결제 | 문서 §4.4~4.8 | 목록·상세 항목 필드(A4-2·A4-3 제안: `order-list-types.ts`), `canPay/canCancel`, 확인서 항목(V-6) | 전체(Step 5~7) |
| 오류 | 공통 본문 `{error:{code,message,details}}`, 코드 카탈로그(§2.1) | 화면별 문구 매핑 | — |

## 3. 프런트 미완료

- API 연결 대기: A1(공연 정보), A3-1(회차), A3-3 조회 — loader에서 adapter 호출로 바꾸기만 하면 됨(공연 식별자 결정 후)
- 백엔드 대기: A3-2·A4-1·A7(Step 4), A3-3 확보·A3-4·A3-5(Step 5·6), A4-2·A4-3(Step 7)
- 매핑 대기: 인증 오류 코드 → A7 문구, 주문 오류 코드 → A3-3·A3-4 문구

## 4. 통합 시 주의(겹치는 파일·라우트)

| 프런트 | 백엔드 Step 3 | 처리 결정 필요 |
|---|---|---|
| `src/app/page.tsx`(A1), `layout.tsx`, `globals.css` | 홈(공연 1개/여러 개 분기), `layout.tsx` | **해결(통합 1단계 `1e71ef5`):** 프런트 A1·화이트 레이아웃 유지, 백엔드 홈 데이터 로딩은 `src/app/_catalog/content.tsx`에 보존(API 연결 단계에서 사용) |
| `/policies/{terms,privacy,refund,support}` | `/terms`, `/privacy`, `/refund-policy`, `/business-info` | **해결(통합 2단계, 미커밋):** 백엔드 경로 사용, `/policies/{terms,privacy,refund}` 삭제 후 `next.config.ts` 임시 리다이렉트(307). `/policies/support`(고객 문의)는 백엔드 대응 화면이 없어 유지(U4 결정 시 경로 재검토). 푸터·A3-4 환불 규정 링크 교체 |
| `src/components/site/*`(header/footer) | `SiteChrome.tsx`, `PolicyPage.tsx`, `business-info.ts` | **해결(통합 2단계, 미커밋):** 공통 셸 `site-shell.tsx`(프런트 헤더·푸터, 화이트). `SiteChrome.tsx` 삭제, `PolicyPage`·사업자 정보·404·오류 화면은 셸 안에서 화이트로 표시. 사업자 정보는 `business-info.ts` 하나만 사용. `/shows`·`/identity/mock`은 라우트 layout으로 셸 적용, `/shows`의 판매 준비 중 안내(기존 PreLaunchNotice 조건·문구) 유지 |
| `/booking?…`(A3-1), `/booking/seats?session=`(A3-3) | `/shows/[slug]`, `/shows/[slug]/sessions/[sessionId]`(읽기 전용) | 예매 경로 체계 |
| `src/components/seats/*` | `src/components/seat-map/*` | 배치도 컴포넌트 하나로 |
| `src/server/dev/*`, `devPreviewEnabled` | `error.tsx`, `not-found.tsx`, DbClock | 프런트 브랜치는 Step 1 기준 — main(Step 2) 미병합 |
