# Ashlar Review-Loop (자동 수정 수렴 루프) — 설계 계획

> 상태: **설계 제안(구현 전 합의용).** 근거: `ez-approve-ai` 의 정본 스킬
> `.agents/skills/codex-review-loop-to-convergence`(2레포·70 PR·1,384 지적 캘리브레이션)와
> 이 레포의 기존 수렴 폴러(`grokbot-automation` `poll-ashlar-convergence.py`), 그리고 P1(#66) 수동
> 루프 6라운드 실경험.
> 관련 기능: `#61` 컨텍스트 tailoring, `#66` full-file 컨텍스트.

## 0. 한 줄 요약

**명시적 트리거(`/review-loop`)로만 켜지는, 값싼 라운드를 반복하되 막히면 고정·명시 문구로 정지·핸드오프하는,
사람이 게이트하는 바운드 루프.** "0까지 자동 수정·머지"가 아니라 "고신뢰 지적을 수정하고, 못 뚫으면 근본원인/설계
판단을 사람·에이전트에게 넘긴다."

## 1. 목적 / 비목적

- **목적:** 리뷰 지적을 사전 설정 에이전트가 수정하고 재검증하는 루프를 **필요한 PR에서만** 돌려, 반복 수동
  작업(제가 #66에서 손으로 한 6라운드)을 자동화한다.
- **비목적:**
  - 전역 on/off (필요 없는 레포·PR까지 적용됨) — **금지**.
  - 완전 자율 "수렴까지 자동 커밋+머지" — **금지**(오탐 추격·회귀·비수렴 위험).
  - 프롬프트 의미·제출·스키마 병합 변경 — 기존 리뷰 경로는 그대로 재사용.

## 2. 트리거 (명시적, 고정)

기존 mention-ingress에 문구만 추가한다(`ASHLAR_MENTION` 파서).

| 트리거 | 동작 |
|---|---|
| `/review` · `@ashlar-bot review` | 기존 **1회 리뷰** (변경 없음) |
| `/review-loop` · `@ashlar-bot review-loop` | **수정 루프**(기본 `suggest` 모드) |
| `/review-loop apply` | 자동 커밋·push 모드(고위험, 명시할 때만) |
| `/review-loop stop` | 정지 스위치 |

- **권한:** 루프는 코드를 write하므로 **호출자(mention 작성자)의 write 권한을 확인**. 없으면 거절.
- **기본 `suggest` 모드:** 수정안을 PR suggestion/초안 커밋으로 올려 사람이 1클릭 적용. auto-commit은 `apply`
  옵션에만. (근거: #66 오탐 2건·회귀 위험.)
- **동시성 1/PR:** deliveryId 디둡 확장으로 "루프 1개/PR". 재진입·중복 트리거 차단.

## 3. ⛔ 종료 신호는 고정·명시 리터럴 — 절대 LLM이 짓지 않는다 (핵심)

수렴 판정 `"didn't find any major issues"` 가 substring 매칭으로 안정적인 것처럼, **루프의 모든 종착 신호는
결정적 코드(루프 드라이버)가 내보내는 고정 문자열**이어야 한다. LLM이 매번 새로 문장을 지으면 매칭이 깨진다.

| 종착 상태 | 고정 마커(머신) | 고정 문구(사람) | 감지 |
|---|---|---|---|
| **CONVERGED** | `<!-- ashlar-findings total=0 ... -->` | (지정 리뷰어의 clean verdict) | substring/마커 |
| **ESCALATE** | `<!-- ashlar-loop-escalate reason=<code> round=<N> -->` | `Ashlar review-loop halted — human review required` | substring/마커 |
| **STOPPED** | `<!-- ashlar-loop-stopped -->` | `Ashlar review-loop stopped by operator` | 마커 |

원칙(스킬의 교훈):
- **마커·문구는 드라이버가 방출**한다. reason/round 같은 구조 데이터는 **머신 마커의 속성**으로, 사람용 문구는
  **불변 리터럴**로. LLM 생성물은 신뢰하지 않는다.
- **substring 매칭**으로 감지(뒤에 텍스트가 붙어도 됨). 반응(👀/🚀)이나 리뷰/인라인 코멘트 **개수로 감지 금지**.
- `cc_digest.py` 가 `ashlar-loop-escalate` 를 집어 "에이전트/사람 주의"로 SLA escalate.

## 4. Round-zero 게이트 — "이 PR이 루프를 받을 자격이 있나"

트리거가 켜져도, 먼저 자격을 판정한다(스킬: 전체 rounds의 절반이 아무것도 못 벌었음).

- **루프 없음(자체 sweep + 섀도우 후 CI로):** 전 경로가 docs/config, tests-only, 또는 **비핵심 코드 <~1,000줄·
  ~10파일**.
- **정상 루프:** service/guard/controller, migration, money/tenant/permission/document-state 를 건드리는 diff.
- **Diff 크기 게이트(비수렴 1순위):**
  - `>~1,500줄` → split 제안, 강행 시 reinforced.
  - `>~5,000줄/멀티도메인` → **루프는 수렴하지 않음**(44k=108라운드 후 close). 즉시 `ESCALATE reason=diff-too-large`,
    의존순서 스택 split을 유일 경로로 제시. 루프 진입 금지.
- PR 본문 첫 줄에 `Review gate: none | loop | loop-reinforced` + 사유 기록.

## 5. 루프 본체 (한 패스 = 한 라운드)

1. **Pre-request 게이트:** DIRTY 아님, 마지막 리뷰 이후 새 커밋 있음, **0-UNADDRESSED**, 직전 라운드가 드레인됨.
2. **1회 리뷰 요청**(라운드당 정확히 1개). 재요청은 "push + SHA 답글 + 0-UNADDRESSED" 후에만.
3. **백그라운드 폴러로 대기**(기존 `poll-ashlar-convergence.py` 재사용). 재요청 스팸 금지.
4. **fix 에이전트에 넘겨 수정**(프롬프트는 §6). 라운드 = **커밋 1개**.
5. **라운드 검증**(§7 CI Quick / touched-file). push **1회**.
6. **지적마다 in-thread에 수정 SHA 답글**(요약 코멘트는 미처리로 읽힘).
7. **0-UNADDRESSED 게이트** 후 다음 라운드. 반복.
8. **정지 조건 감지 시 §8 ESCALATE.**

불변식: `@ashlar review` 는 0-UNADDRESSED 일 때만 / 라운드당 in-flight 1개 / push 1개 / DIRTY SHA에 요청 금지.

## 6. Fix 에이전트 프롬프트 레시피 (루프를 실제로 수렴시키는 엔진)

fix 주체는 **레포 write 권한이 있는 코딩 에이전트**(Codex/Claude류) — 채팅 리뷰어(ChatGPT/Grok)는 커밋 불가.
프롬프트에 반드시:

1. **내용 기준 4분류(태그 무시):** Fix / Push-back(증거로 반박) / Decline(근거+추적) / Defer(이슈#+코드마커).
   → 오탐을 못 반박하고 다 고치면 가짜 지적 만족시키려 진짜 버그를 심는다.
2. **(최고 수율) 플래그 파일 통째 재감사 + call-site 센서스:** 봇은 파일당 1결함/패스만 흘린다(재-라운드 지적의
   45~90%가 같은 파일). "라인만 고치지 말고, 파일+형제 전체에서 **같은 결함 클래스 전부 + 가드가 보호하는 연산의
   모든 진입점(센서스 표)**을 한 커밋에." 이게 없으면 "좁은 수정 = 딱 한 라운드 더" 함정.
3. **N번째 같은-클래스 → 가드 추가 말고 상태 제거(근본원인):** 가드는 나쁜 상태를 생존시키고, 근본수정은 도달
   불가로 만든다.
4. **모든 bound/clamp에 "무엇을 제한하나 + 조건이 안 터지면 뭐가 되나" 기록.** 스코프 착오 방지.
5. **Defer/Decline은 load-bearing**(이슈# 인용 + 코드 마커). 맨입은 ≥7회 재지적됨.
6. **TDD**(실패 테스트 먼저), **커밋 1개/라운드**, **in-thread SHA 답글**.

## 7. 2단계 검증 (비용 최적화 — 정본 스킬의 핵심 추가)

concurrency-1 local 때문에 라운드마다 비싼 검증은 불가능하다. 정본처럼 분리한다.

| 단계 | 언제 | 무엇 |
|---|---|---|
| **CI Quick** | 매 push(매 라운드) | 영향 유닛만 바운드. 라운드 회귀만 잡음. 싸다 |
| **Final CI + live-smoke** | **CONVERGED + 0-UNADDRESSED 후 1회** | 전체 스위트·DB·E2E. 데이터계층 수정은 live-smoke |

수렴과 머지-준비는 **분리된 상태**. **Green CI ≠ 수렴**(유닛은 버그가 사는 계층을 mock).

## 8. ESCALATE 핸드오프 — 정지 + 사유분류 + 지시 + 재확인

**정지 신호는 §3의 고정 마커/문구.** 페이로드:

```
<!-- ashlar-loop-escalate reason=<code> round=<N> pr=<PR> head=<sha> -->
Ashlar review-loop halted — human review required (round N/M)

상태(아래로 재확인):
- 지적수 추이 R1..RN (증가/정체/감소), 반복 플래그 파일(2~3R), Reviewed-commit⊂HEAD?, 0-미처리, DIRTY, CI
- diff 규모, 결정 원장(decline/defer/pushback)
정지 사유: <reason>
권고 조치: <아래 매핑>
재확인(narrative 신뢰 금지): gh pr view <PR> --json reviews,comments,headRefOid,mergeable
                              audit-unaddressed.py <PR> --head <sha>
```

**사유 → 지시 매핑** (사용자 예시 포함):

| reason | 감지 신호 | 지시 |
|---|---|---|
| `whack-a-mole` | 같은 파일 2~3R 반복 | 파일 통째 재감사 + call-site 센서스 한 커밋에 (**놓친 형제 근본원인**) |
| `guard-accretion` | 같은 race/class 가드 N번째 | 상태를 제거해 도달 불가로 (**상태 근본원인**) |
| `oscillation` | 지적수 비감소, 수정이 새 지적 유발 | 개별 패치 중단, **근본원인 또는 설계 변경** 방향 결정 |
| `wrong-scope` | 맞는 수정·틀린 범위 반복 | 진짜 근본(예: O(N²) 실제 원인) 찾아 거기서 |
| `re-flag-deferred` | 봇이 defer/pushback 재litigate | 오탐/설계 판단 — deferral load-bearing화 또는 방향 결정 |
| `diff-too-large` | >5k/멀티도메인 | 수렴 불가 — 의존순서 스택 split, 루프 재개 금지 (**설계 변경**) |
| `round-cap` | 상한 도달, 신호 불명확 | 추이·반복파일로 분류 후 방향 결정 |

**핵심 주의:** 상태값은 힌트일 뿐. 받는 에이전트는 컴팩션/세션교체로 요약이 stale일 수 있으니 **반드시 API에서
round/findings/gates를 재도출**하고 착수. 그래서 재확인 명령을 페이로드에 박아둔다.

## 9. 멀티 리뷰어 수렴 (chatgpt/grok/local)

정본 `review_rules.py` 의 두 스코프를 그대로:
- **0-UNADDRESSED 게이트는 리뷰어 무관** — 어느 리뷰어의 지적이든 미처리면 차단(한 리뷰어에 핀 고정 시 다른
  리뷰어 라운드에 허수 0 보고).
- **CONVERGED 판정은 지정 리뷰어의 verdict** 로.

## 10. docs-only 재사용 면제

clean은 sticky 아님(clean 후 push→재리뷰). 하지만 post-clean 재통합이 **CLAUDE.md/docs만** 건드렸음을 git
객체로 증명하면 전체 루프·Final CI 재실행 없이 기존 증거 재사용(정본 `claude_reuse/merge/consumers.py`). 사소한
changelog/docs 재통합에 루프 재시작 방지.

## 11. 안전장치

- **동시성 머지순서:** 수렴 PR이 먼저 머지(그 사이 base 이동으로 DIRTY 방지). `merge-queue.py` 재사용.
- **정지 스위치:** `/review-loop stop` / PR close.
- **권한:** write 권한자만 트리거. `apply` 모드는 명시적일 때만. 배포 트리거 레포엔 금지(코멘트가 배포를 유발).
- **BEHIND ≠ 머지 사유:** DIRTY 일 때만 base 통합.

## 12. 재사용 자산

- 기존: `poll-ashlar-convergence.py`, `watch-pr.sh`, `cc_digest.py`, `merge-queue.py`, `reviewer_verdict.py`.
- 정본에서 포팅: `review_rules.py`(리뷰어-무관 게이트), 2단계 CI(`final_ci.py` 개념), `run-touched-jest` 상당물.
- 선행 사례: `/autofix-pr`(Claude web) — request→fix→push→reply 자동, **모호/구조적 코멘트는 사람에게 먼저 물음**
  (= ESCALATE). 그 한계(green≠수렴, 충돌 안 보임)는 그대로 회피.

## 13. 단계별 구현 순서

1. **트리거 + 마커/문구**(§2, §3) — 고정 리터럴 방출·감지. 가장 작고 먼저.
2. **정지 감지 + ESCALATE 핸드오프**(§8) — stuck 신호 분류 + 고정 문구 방출. 루프 없이도 수동 루프에 붙일 수 있음.
3. **fix 에이전트 프롬프트**(§6) + suggest 모드.
4. **2단계 검증**(§7), **멀티리뷰어 게이트**(§9).
5. **docs-only 재사용**(§10), **동시성**(§11).

## 14. 리스크

- fix 품질(진짜 vs 오탐)·비수렴은 **§8 ESCALATE로 사람에게 위임**하는 것이 근본 해법. 루프는 쉬운 것만.
- 자율 커밋은 회귀 위험 → `suggest` 기본.
- 단일 레포·소표본 계측이므로, 적용 후 같은 수렴-루프 계측으로 재평가.
