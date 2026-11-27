# NAZIR — SESSION HANDOFF

> 기준일: 2026-11-27  
> 새 GPT/Claude 세션이 작업을 이어받기 위한 실행용 인수인계 문서.

## 1. 먼저 읽을 것

1. docs/project/CURRENT_STATE.md — 브랜치별 기준점, 구현 단계, 미통합 상태, 미결정·위험.
2. docs/CLAUDE_HANDOFF.md — 공통 작업 프로토콜 및 금지 사항.
3. 현재 작업 브랜치의 정본 문서:
   - docs/DECISIONS.md
   - docs/DATABASE.md
   - docs/API_SPEC.md
   - docs/ARCHITECTURE.md
   - docs/IMPLEMENTATION_PLAN.md
   - docs/TEST_PLAN.md
   - docs/PROVIDERS.md
4. 프론트 화면/흐름 작업이면 docs/design/00_STATUS.md, 01_IA.md, 02_USER_FLOW.md, INTEGRATION_NOTES.md도 확인한다. 이 문서들은 작성 당시의 설계 기록일 수 있으므로 현재 코드 상태와 구분한다.

## 2. 현재 작업 기준

- 프론트·백엔드 통합 브랜치: claude/nazir-integration — 기준 커밋 1e71ef56c7d4058f0fd699a6ef330b0c62e582dd.
- 최신 백엔드 Step 5: claude/pensive-allen-5djvof — 보고된 HEAD 8b27bb345b86d0bba90da46c7ee9f8328ba6588f.
- Step 5는 통합 브랜치에 아직 반영되지 않았다.
- Step 6 결제는 미착수다. 결제 DB·API·아키텍처 설계가 이미 있으므로 먼저 해당 정본을 읽고 구현 범위를 확정한다.
- main은 e43d74a 기준이며, 별도 승인 없이 변경하지 않는다.

## 3. 다음 작업 순서

1. 작업 시작 직전 GitHub에서 대상 브랜치 HEAD와 working tree/미커밋 변경을 다시 확인한다. 이 문서의 커밋 SHA를 현재 HEAD라고 가정하지 않는다.
2. Step 5 백엔드 브랜치의 실제 파일·migration·테스트를 기준으로 Step 6 선행 조건을 검토한다. Step 5를 재구현하지 않는다.
3. Q-011, Q-037, Q-038 등 결제·운영에 영향을 주는 미결정을 정본에서 확인하고, 사용자 결정이 필요한 항목만 질문한다. 권장안을 확정 정책처럼 쓰지 않는다.
4. Step 6 작업 브랜치는 Step 5 백엔드 기준에서 분기하는 방안을 우선 검토한다. 통합 브랜치에서 Step 5가 이미 구현됐다고 가정해 작업하지 않는다.
5. 구현 전 영향 파일·DB migration·잠금/동시성 영향·테스트 계획을 제시하고, 승인된 범위만 구현한다.
6. 테스트·리뷰·문서 갱신 후 변경 파일, 실행 명령과 결과, 미실행 검증, 남은 위험을 보고한다.

## 4. 변경 금지 / 주의

- Step 5를 새로 구현하거나 별도 구현으로 대체하지 않는다.
- 사용자 승인 없이 정책을 확정하거나 DB/API 계약을 바꾸지 않는다.
- 사용자 승인 없이 main 병합, 다른 브랜치 병합, rebase, force push를 하지 않는다.
- 프론트 UI를 백엔드 구현에 맞춘다는 이유로 임의 변경하지 않는다.
- 실제 테스트를 실행하지 않고 통과했다고 보고하지 않는다.
- Neon/Vercel/Toss/NICE 실환경 검증을 문서상 테스트 결과만으로 완료 처리하지 않는다.
- Q-036의 도메인 분리 SHA-256 결정을 오래된 HMAC 문구로 되돌리지 않는다.
- 결제 UNKNOWN에서 좌석 보호를 해제하거나 재결제를 허용하지 않는다.

## 5. 상태 변경 시 기록 규칙

작업 종료 시 CURRENT_STATE.md와 이 문서를 필요한 범위에서 갱신한다.

- 브랜치명과 전체 HEAD SHA
- 완료된 Step 및 코드/테스트 근거
- 통합 여부와 미통합 커밋
- 확정 정책과 미결정 사항
- 다음 작업과 차단 요인
- 미실행 테스트·실환경 검증

이 문서는 상세 정책을 복사하는 곳이 아니다. 세부 근거는 기존 정본 문서에 남긴다.
