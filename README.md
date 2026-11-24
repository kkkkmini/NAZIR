# NAZIR

뮤지컬·연극 티켓 예매 웹사이트. 설계 문서는 [`docs/`](docs/) — 시작점은 [`docs/CLAUDE_HANDOFF.md`](docs/CLAUDE_HANDOFF.md), 결정 사항은 [`docs/DECISIONS.md`](docs/DECISIONS.md).

## 요구 사항

- Node.js 22 이상
- PostgreSQL 15 이상(프로젝트 기준 16). `UNIQUE NULLS NOT DISTINCT`가 15+ 기능이다
- Docker(로컬 PostgreSQL용, 선택)

## 로컬 실행

```bash
npm ci
cp .env.example .env.local   # 기본값: local 환경, Mock 결제·인증
npm run dev                  # http://localhost:3000
```

상태 확인: `GET http://localhost:3000/api/v1/health` (비밀값 없는 실행 환경·Provider 단계 정보)

## Database (Step 2)

PostgreSQL이 유일한 정본이다. 스키마는 Prisma + raw SQL migration이며 설계는 [`docs/DATABASE.md`](docs/DATABASE.md), 구현 기록은 §19에 있다.

```bash
docker compose up -d db                 # PostgreSQL 16 (로컬 전용 계정 nazir/nazir)
cp .env.example .env.local              # DATABASE_URL(개발 DB), TEST_DATABASE_URL(테스트 서버)
npm ci                                  # postinstall 이 prisma generate 를 실행한다
npm run db:migrate:deploy               # migration 적용. 공유 환경에서도 이 명령만 사용한다
npm run db:seed                         # 임시 개발 데이터(local/test 환경에서만 실행)
```

- **개발 DB와 테스트 DB는 이름으로 분리한다.** 이름이 `_test`로 끝나는 DB는 `NAZIR_RUNTIME_ENV=test`에서만 쓸 수 있고, 반대로 `test` 환경은 `_test` DB만 쓸 수 있다. 서버 기동·seed가 위반 시 거부하고, **Prisma CLI도 `prisma.config.ts`에서 명령 실행 전에 같은 규칙을 검사한다**(`DATABASE_URL`·`DATABASE_URL_UNPOOLED`·`SHADOW_DATABASE_URL`이 있을 때만, Shadow가 메인 DB와 같은 DB면 거부. `NAZIR_RUNTIME_ENV`가 없으면 production으로 간주되어 `_test` DB가 거부되므로 `.env.local`에 `NAZIR_RUNTIME_ENV=local`을 둔다).
- **연결 주소 3종 (Neon 대응):**

  | 환경변수 | 쓰는 곳 | 비고 |
  |---|---|---|
  | `DATABASE_URL` | 앱 런타임(`getPrisma()`) | Neon에서는 **Pooled** 주소(`-pooler` 호스트) |
  | `DATABASE_URL_UNPOOLED` | Prisma CLI(`migrate` 등)·seed | Neon **Direct** 주소. 없으면 `DATABASE_URL`을 쓴다(로컬은 `DATABASE_URL`만으로 충분) |
  | `SHADOW_DATABASE_URL` | `prisma migrate dev`·`diff` | 메인 DB와 다른 DB여야 한다 |

  둘 다 있으면 **둘 다** 환경 규칙을 통과하고 **같은 DB**(Neon의 `-pooler` 유무는 같은 DB로 인식)를 가리켜야 한다. 아니면 서버 기동·CLI·seed·`npm run check:config`가 거부한다. 앱은 `DATABASE_URL`로만 연결하므로 `DATABASE_URL_UNPOOLED`만 있으면 서버 기동을 거부한다(CLI·seed는 `DATABASE_URL_UNPOOLED`만으로 실행 가능). 앱 연결과 seed 연결은 세션 `TimeZone=UTC`로 시작한다(`docs/DATABASE.md` §19.12). 실제 주소·비밀번호는 저장소에 적지 않는다.
- **`prisma db push`와 `prisma migrate reset`을 공유 환경에서 쓰지 않는다.** 새 migration은 `prisma migrate dev --create-only`로 만들고 SQL을 직접 검토한다(raw SQL 객체 DROP 금지 MIG-06, **파일 전체를 `BEGIN; … COMMIT;`으로 감쌈** MIG-09). 실패 시 복구 절차는 `docs/DATABASE.md` §19.9.
- seed는 `[DEV SEED]` 임시 공연·좌석·가격이다. 실제 운영 데이터가 아니며 `NAZIR_RUNTIME_ENV`가 없거나 `local`·`test`가 아니면 실행을 거부한다.

## 공개 조회 화면·API (Step 3)

```bash
npm run db:migrate:deploy && npm run db:seed   # 개발 DB에 임시 공연·회차·좌석
npm run build && npm run start                  # 또는 npm run dev
```

- 화면: `/`(공개 공연이 하나면 그 공연 소개, 여러 개면 목록), `/shows/{slug}`, `/shows/{slug}/sessions/{sessionId}`(읽기 전용 좌석 현황, 임시 격자 배치도), `/terms`·`/privacy`·`/refund-policy`·`/business-info`(본문·사업자 정보는 **입력 대기**).
- API: `GET /api/v1/shows`, `/api/v1/shows/{showId}`, `/api/v1/shows/{showId}/sessions`, `/api/v1/sessions/{sessionId}/seats` — 형식은 `docs/API_SPEC.md` §4.3.
- 좌석 선택·예매는 Step 4(본인인증)·Step 5(주문) 이후에 열린다.
- 배포한 DB에서 세션 설정 확인(비파괴): `npm run verify:db-session` — 앱과 같은 연결 설정으로 TimeZone=UTC, 트랜잭션·`FOR UPDATE`, 잠금 경합, COMMIT 시점 지연 제약을 확인한다.

## 검사

```bash
npm run check          # lint + typecheck + 단위 테스트(DB 불필요)
npm run test:db        # 스키마 계약 테스트 MIG-01~08 (실제 PostgreSQL 필요, TEST_DATABASE_URL)
npm run build          # 운영 빌드
npm run check:bundle   # 빌드 결과에 비밀키·Mock 코드가 없는지 검사
npm run check:config   # 현재 환경변수가 기동 규칙을 통과하는지 검사
```

## 운영 안전장치

서버는 시작할 때 설정을 검사하고, 위반하면 **기동하지 않고 종료**합니다(`src/instrumentation.ts`).

- `NAZIR_RUNTIME_ENV`가 없거나 알 수 없는 값이면 `production`으로 간주합니다.
- `production`에서는 Mock 결제·Mock 인증, 토스 `test_` 키를 사용할 수 없습니다.
- 토스 `live_` 키는 `production`에서만 사용할 수 있습니다.
- 비밀값(토스 시크릿·보안 키, NICE client 정보)은 서버 환경변수로만 주입하고 저장소에 커밋하지 않습니다.
