# 인수인계: 클라우드 세션 → 리뷰어 Dev (2026-09-24 23:40 KST)

#77은 클라우드 세션이 수렴과 머지까지 계속 맡습니다. 이 문서는 **#77을 뺀 나머지** 작업입니다.

클라우드 세션에서 올린 커밋과 코멘트는 모두 GitHub 계정 `blueverse-hh`로 올라갔습니다.

## 공통 진행 방식 (사용자 지시)

- 들어온 지적만 고쳐서 푸시하지 않습니다. 지금까지의 지적을 유형별로 모아서 근본 원인을 찾습니다.
- 그 원인에서 나올 수 있는 상태 조합을 표 기반 테스트 하나로 만들고, 표 전체가 통과하도록 한 번에 고친 뒤 한 번만 푸시합니다.
- 수정마다 수정 없이는 실패하는 회귀 테스트를 붙입니다.
- 모든 설정은 설정 화면에서 바꿀 수 있어야 합니다. 재시작이 필요한 env는 기능을 운영하는 수단이 될 수 없습니다(#77에서 fix agent 설정으로 반영 중).
- CI 버전인 Node 22에서 확인합니다. Chromium 테스트는 `CHROMIUM_PATH`를 지정해서 돌립니다.

## #80 GitHub 쓰기 계약 (`ai/feat/review-loop-gh-write-contract`)

- **head:** `b9524e1` (R4 수정), CI 통과
- **남은 R5 지적 3건 (미수정):**
  - 4094565992 (P1): 결과를 모르는 handoff의 가짜 기록 시각이 재시도가 끝난 뒤로 찍혀서, 그 사이에 시작된 새 루프를 끝내버림
  - 4094565998 (P1): `continueOn`과 `quietExit`이 결과를 모르는 continuation을 버림 → 루프가 조용히 멈춤
  - 4094566007 (P2): 실제 handoff 행이 목록에 보여도 ambiguity 기록이 안 지워짐
- **근본 원인:** 결과를 알 수 없는(unknown) 쓰기를 7개 호출 지점에서 제각각 처리합니다. R3–R5의 9건이 모두 같은 상태표의 빈 칸이었습니다.
- **계획 (PR 코멘트 5815812044):**
  - 모든 제어 댓글 쓰기를 `emitControl` 한 함수로 모읍니다.
  - 결과는 `posted | exists | unknown | rejected` 네 가지로 닫고, 호출자는 exhaustive switch로 처리하게 합니다.
  - 흩어진 기록을 `OwnWrites` 저널 하나로 합치고, POST 직전 시각을 저장합니다.
  - 세션을 읽을 때마다 저널을 실제 댓글과 대조합니다.
  - 테스트는 조합표 하나로 만듭니다: {start, continue, stop, handoff} × 쓰기 결과 × 목록 조회 상태 × 이후 사건
- **관련 이슈:** #79의 K1과 K6

## #81 verify-clean (`ai/feat/local-verify-clean`)

- **head:** `3b6314a` (R3 수정), CI 통과
- **남은 R4 지적 1건 (미수정):** P1, 인라인 앵커가 없는 본문 지적입니다(review 5305587326, `src/lib/harbor.server.ts:1077`).
  - 로컬 검증 결과를 파싱하지 못하면 그 원문을 게시 본문에서 뺍니다.
  - 그 원문에 실제 지적이 있어도 fix 단계에 전달되지 않습니다.
  - 고칠 방향: raw salvage 블록으로 보존하되 unverified로 표시합니다.
- **근본 원인 두 가지 (계획은 PR 코멘트 5815815086):**
  - **A. 리뷰 결과 상태가 닫혀 있지 않음:** 상태가 여러 플래그로 흩어져 있습니다.
    - 수정: `reviewOutcome` enum을 한 곳에서 계산하고, 본문, 마커, 수렴 판정은 모두 그 값에서만 만듭니다.
    - 테스트: chat 결과 × local 결과 조합표
  - **B. 보류 중인 로컬 레그의 정리가 종료 경로마다 빠짐:**
    - 수정: 모든 상태 전이를 `transitionJob` 하나로 모읍니다.
    - 테스트: 종료 경로 × 확인 항목 조합표
- **이번 세션에서 이미 반영한 것:**
  - 검증 안 된 clean 결과는 `unverified=1` 마커를 달고, "Didn't find any major issues" 문장을 쓰지 않습니다.
  - 연결된 브리지는 시간이 지나도 로컬을 해제하지 않습니다.
  - 오프라인 fallback 대기 시간은 브리지가 끊긴 시점부터 잽니다.
  - supersede된 잡의 샘플 누수를 정리합니다.
- **남은 것:** 여러 채팅 리뷰어가 섞였을 때의 결과 귀속 e2e

## #78 → 단건 리뷰어 지정 명령으로 대체 (결정됨)

- 플랜은 PR 코멘트 5815740591에 있습니다.
- **명령:** `@ashlar-bot review-chatgpt`, `review-grok`, `review-local`
- **동작:**
  - 지정은 그 댓글 한 건에만 적용합니다. `@ashlar-bot review`는 언제나 설정 화면의 기본값으로 돕니다.
  - 지정한 리뷰어가 설정에서 꺼져 있거나 연결이 안 돼 있어도 시도합니다.
  - 실패하면 지금의 에러 코멘트 경로로 알리고, 다른 리뷰어로 넘어가지 않습니다.
  - 명시 지정이 #81의 verify-clean보다 우선합니다.
  - `reviewProviders`를 잡 생성 시점에 고정하는 #78의 로직은 재사용합니다.
  - 레포별 스킵 env(`ASHLAR_LOCAL_REVIEW_SKIP_REPOS`)는 제거합니다.

## #79 재설계 (K1–K8)

- 계획과 근거 자료는 이 브랜치의 `handoff/pr74/`에 있습니다: `ANALYSIS.md`, `hunts-K1-K2.json`, `repro/`
- 스택 순서: ① GitHub 쓰기 계약(#80) → ② K1 `emitControl`과 `OwnWrites` → ③ K2 LoopRuntime → ④ K3 → ⑤ K5+K6 → ⑥ K7. K4와 K8은 별도 PR입니다.
- #80의 위 계획은 사실상 ②까지 포함합니다. #80에서 ②를 할지, #80은 계약까지만 하고 ②를 새 PR로 뺄지 먼저 정하세요.

## 참고

- **#80 flaky 후보:** R4 수정 중에 이 PR과 무관한 `src/lib/fix-request-watch.test.ts`("watchFixRequest: no lost checks (round 6, pre-review)")가 전체 실행에서 한 번 실패했습니다. 단독으로는 3회 모두 통과했습니다. 원인 확인이 필요합니다.
- **#77 상태 (참고용, 클라우드 세션이 진행 중):**
  - head `90b0331`, R8 지적 5건
  - 진행 중인 작업: conformance 표 테스트, `extension.e2e.mjs` flaky 원인 수정, 설정 화면에 fix agent 섹션 추가(env `ASHLAR_FIX_AGENT` 제거, 기본값 꺼짐)
