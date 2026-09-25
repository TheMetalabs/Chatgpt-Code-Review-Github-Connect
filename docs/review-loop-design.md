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

- **봇은 자기 자신에게 명령하지 않는다(불변식):** 봇(App 로그인 `<slug>[bot]`, `ASHLAR_BOT_LOGIN`)이 쓴
  코멘트·인라인 지적·리포트·답글·ops 갱신은 문구와 무관하게 **절대 트리거가 아니다**(지적 본문이 `/review-loop apply`
  를 인용해 봇이 스스로 재트리거된 #72 사례). 유일한 예외는 루프 드라이버가 applied 라운드 뒤 의도적으로 다는
  **연속 요청 마커**(§3 CONTINUE, 새 이슈 코멘트, 같은 PR)뿐이다.
- **권한:** 루프는 코드를 write하므로 **호출자(mention 작성자)의 write 권한을 확인**. 없으면 거절.
- **기본 `suggest` 모드:** 수정안을 PR suggestion/초안 커밋으로 올려 사람이 1클릭 적용. auto-commit은 `apply`
  옵션에만. (근거: #66 오탐 2건·회귀 위험.)
- **동시성:** 한 PR 내부는 deliveryId 디둡으로 "루프 1개/PR"(재진입·중복 차단). 서로 다른 PR은 **병렬**(§6 병렬성).
- **fix 에이전트는 설정으로 지정**(§6b): 어느 provider가 어떤 방식으로 수정할지. 기본은 미설정(수정 안 함).

### 2b. 루프 세션 — PR 상태, GitHub에서 도출 (구현: `review-loop-session.ts`)

루프는 **잡 상태가 아니라 PR 상태**다. harbor 잡은 메모리에만 있어(재시작 시 소실) 세션 근거가 될 수 없다.
GitHub가 영속하는 이벤트(App의 기록·마커, 사람의 stop 코멘트, 리뷰)를 접어서 세션을 도출한다 — 모든 프로세스·재시작이
같은 답을 낸다.

- **시작 = App의 start 기록:** harbor가 **새** start 지시어(이슈·인라인 코멘트의 작성/편집, PR 본문 open/편집)의 리뷰를
  **승인(admit)** 할 때 App이 고정 기록 `<!-- ashlar-loop-start mode= by= at= -->` 를 한 번 남긴다(`at` = 지시어의 실제
  시각: 코멘트 작성 시각, 편집으로 들어온 지시어는 편집 시각, PR 본문은 PR `updated_at`). 세션은 마지막 종료 이후
  **첫 기록**에서 시작한다. 사람 코멘트·PR 본문의 **현재 텍스트는 start로 재생하지 않는다** — 편집으로 과거 시각의
  start를 심을 수 없다. 기록 게시가 실패했으면 그 리뷰의 루프 단계가 같은 기록을 (멱등으로) 보충한다.
  세션 안에서 start를 다시 걸어도 **앵커는 유지**되고 모드·시작자만 갱신된다 → 라운드 예산이 리셋되지 않는다.
- **종료 이벤트:** 사람의 stop 지시어, 봇의 ESCALATE 마커, 봇의 STOPPED 마커, 봇의 clean 리뷰(`total=0`, CONVERGED),
  봇의 not-clean 리뷰(구조화 지적 없이 clean pass가 아닌 리뷰 — incomplete·raw·raw-unverified·unverified-clean, 끝의
  마커로 판별 — 세션을 끝내고 `loop-error` 핸드오프를 **빚진다**, §3).
  같은 초의 동률은 head 이동 → 종료 → start 순(핸드오프와 같은 초의 start는 새 세션).
- **stale clean 리뷰는 종료가 아니다:** clean 리뷰는 루프가 **기다리는 head** 에 대해서만 CONVERGED다. 루프가 봇의
  연속 마커나 push(웹훅의 `updated_at`)로 이미 다른 head로 넘어간 뒤 도착한 옛 head의 clean 리뷰는, 그 head가 PR의
  live head가 아니면 무시한다. clean 리뷰 **직후** 다른 head의 연속 마커가 달렸다면(드라이버가 그 리뷰 도착 전에
  연속을 결정) 세션은 앵커·모드·시작자를 유지한 채 재개된다. live head의 clean 리뷰는 항상 종료이고, push는 끝난
  세션을 재개하지 않는다(수렴 후의 사람 push는 새 루프를 열지 않는다).
- **작성자 강제:** start 기록·마커·CONVERGED는 봇(App 로그인)만, 사람은 **편집되지 않은** 코멘트의 stop만(작성 시각).
  편집된 코멘트의 stop과 PR 본문 stop은 웹훅이 **편집 시각**에 처리하고, STOPPED 확인 코멘트가 그 정지를 **기록**한다
  (첫 줄은 고정 STOPPED 마커 그대로, 둘째 줄 `<!-- ashlar-loop-stop at= by= -->` — `at`은 정지 자체의 시각이지 확인
  코멘트의 시각이 아님). 기록 게시는 재스캔 후 재시도하고, 기록이 영속화되기 전(재시도 중·실패)에는 이 프로세스의 모든
  세션 조회가 그 정지를 반영한다 — 정지 뒤에 커밋되는 라운드는 없다. 같은 정지를 다시 받아도 기록은 한 번. 기록(= STOPPED 확인)은 그 정지가 세션을
  **끝냈을 때**, 또는 그 PR의 loop-start 리뷰가 진행 중이라 start 기록이 나중에 더 이른 시각으로 도착할 수 있을 때만 —
  아무것도 멈추지 않은 정지는 아무것도 게시하지 않는다. 같은 초의 사람 stop은 start 뒤로 정렬된다(정지가 이긴다).
  봇 산문·사람이 쓴 마커는 무시.
- **세션 범위 판정:** 세션 자신의 제어 코멘트(핸드오프·연속 마커)는 **start 기록의 코멘트 id 이후**인 것만 그 세션 것이다
  (초 단위 시각은 이전 세션의 핸드오프와 같은 초에 겹칠 수 있다). 라운드(리뷰)는 start 시각보다 **엄격히 이후**인 것만.
  방금 게시한 제어 코멘트(연속·핸드오프·start·stop 기록)는 목록 API에 아직 안 보여도 게시된 것으로 센다(프로세스 로컬 캐시,
  GitHub 클라이언트별) — 읽기 지연으로 중복 트리거가 생기지 않는다.
- **활성 세션의 모든 리뷰가 루프 라운드**다(명시 start, 연속 마커, push 연속, 세션 중 요청한 일반 리뷰).
- **push = 다음 라운드:** 활성 세션에서 사람이 push하면 드라이버가 연속 마커를 달아 새 head를 리뷰한다(봇 자신의 push는
  수정 라운드가 직접 연속 마커를 단다). 리뷰 중·수정 중 head가 움직이면 옛 라운드는 조용히 supersede되고, live head의
  리뷰를 (다시) 요청한다 — 연속 마커는 **(PR, head, 세션)마다 하나**(동시 호출은 한 번의 게시를 공유, 이후 호출은 기존
  마커를 찾아 게시하지 않음)라서 push 이벤트를 놓쳐도 루프가 멈추지 않고, 중복 트리거도 없다.
- **정지:** 사람의 `/review-loop stop` 은 세션을 끝내고, 진행 중인 루프 리뷰(지시어·연속 마커가 요청한 것)를 취소하며
  (사람이 따로 요청한 일반 리뷰는 게시되지만 세션이 끝났으므로 수정·연속은 없다), 고정 STOPPED 마커를 **한 번**
  남긴다(웹훅의 작성 시각을 주입해 목록 API 지연과 무관). 수정 중이면 커밋 직전 재확인에서 멈추고, 커밋 후였다면
  연속 요청을 하지 않는다.
- **apply 권한:** 세션 시작자(마지막 start 기록의 요청자)의 저장소 권한이 write/admin이어야 apply한다 — 라운드 시작 때와
  **커밋 직전에 다시** 확인한다. 조회 실패는 fail-closed(`loop-error`), 다른 사람이 수정 중에 start를 다시 걸면 그 라운드는
  무의미해져 조용히 끝난다(새 요청이 이어받음). suggest는 쓰지 않으므로 권한 확인이 없다.
- **연속 게시 실패:** 백오프 재시도 후에도 다음 리뷰를 요청하지 못하면 push된 head에 대한 `loop-error` 핸드오프로 끝난다
  (조용한 정지 없음). App 자신의 push도 같은 경로를 타서, 커밋 직후 프로세스가 죽어 연속 마커가 없으면 보충한다.
- **정지 사유 구분:** 세션이 끝나 라운드가 무의미해졌을 때의 조용한 사유는 끝난 방식(운영자 stop / 핸드오프 / 수렴)을
  그대로 말한다 — 핸드오프를 "operator stop"으로 부르지 않는다.

## 3. ⛔ 종료 신호는 고정·명시 리터럴 — 절대 LLM이 짓지 않는다 (핵심)

수렴 판정 `"didn't find any major issues"` 가 substring 매칭으로 안정적인 것처럼, **루프의 모든 종착 신호는
결정적 코드(루프 드라이버)가 내보내는 고정 문자열**이어야 한다. LLM이 매번 새로 문장을 지으면 매칭이 깨진다.

| 종착 상태 | 고정 마커(머신) | 고정 문구(사람) | 감지 |
|---|---|---|---|
| **CONVERGED** | `<!-- ashlar-findings total=0 ... -->` (리뷰 본문의 **마지막 줄**) | (지정 리뷰어의 clean verdict) | substring/마커 — ashlar 내부는 끝에 있는 마커만 센다 |
| **ESCALATE** | `<!-- ashlar-loop-escalate reason=<code> round=<N> -->` | `Ashlar review-loop halted — human review required` | substring/마커 |
| **STOPPED** | `<!-- ashlar-loop-stopped -->` | `Ashlar review-loop stopped by operator` | 마커 |
| **INCOMPLETE**(비수렴 — ESCALATE를 빚짐) | `<!-- ashlar-outcome incomplete -->` (리뷰 본문의 **마지막 줄**) | `Not a clean pass — …` | 끝에 있는 마커(봇 리뷰만) — `<!-- ashlar-findings` 접두사를 **절대** 포함하지 않는다 |
| **RAW / UNVERIFIED**(비수렴 — ESCALATE를 빚짐) | findings 마커에 `raw=1`(raw, `unverified=1`이면 raw-unverified) 또는 `total=0 … unverified=1`(unverified-clean) | raw 블록 헤더 / `Chat found no major issues, but local verification did not complete …` | 끝에 있는 마커(봇 리뷰만) |

`total=0` 이어도 `unverified=1` 이 붙은 마커는 CONVERGED가 아니다(verify-clean 로컬 검증 미완료) — [local-verify-clean.md §1](local-verify-clean.md).

**INCOMPLETE 마커(구현: `review-loop.ts` `INCOMPLETE_OUTCOME_MARKER`):** incomplete 리뷰(리뷰어가 돌지 않았거나 완전한
리뷰를 돌려주지 않음 — clean pass도 지적 개수도 아님)는 findings 마커 대신 고정 마커 `<!-- ashlar-outcome incomplete -->`
를 본문 마지막 줄로 단다. 이 마커는 `<!-- ashlar-findings` 접두사를 **절대 포함하지 않는다** — 외부 폴러
(`poll-ashlar-convergence.py` `parse_body_findings`)는 그 접두사를 본문 **어디서든** 읽고 `total=0`을 수렴으로 보기
때문이다(리뷰어 텍스트는 마커 무력화되어 이 접두사를 만들 수 없다). 핸드오프는 리뷰 게시 **뒤의** best-effort 단계라서,
게시와 핸드오프 사이에 프로세스가 죽거나 핸드오프 게시가 실패하면 신호가 사라질 수 있다. 그래서 루프 재구성
(`readLoopEvents` → `deriveLoopSession`)은 활성 세션의 incomplete 리뷰를 **세션 종료 + `loop-error` 핸드오프 의무**
(`owedHandoff`: 그 리뷰의 head와 결과, 끝난 세션의 앵커로 범위 지정)로 읽는다 — CONVERGED도, head를 기다리는 활성 세션도 아니다.
같은 핸드오프를 빚는 다른 not-clean 결과(raw / raw-unverified / unverified-clean)도 똑같다: 이들의 영속 기록은 이미 끝의
findings 마커 플래그(`raw=1`, `unverified=1`)이고, `notCleanOutcomeOf`(`review-loop.ts`)가 네 결과를 한 곳에서 판별한다 —
그렇지 않으면 핸드오프가 유실된 raw 리뷰 뒤의 push가 루프를 조용히 이어가고, suggest 모드에서는 이미 리뷰된 head를
기다리며 멈춘다.
그 리뷰 자신의 루프 단계가 핸드오프를 달고, 유실됐다면 PR의 **다음 루프 단계**(push, 다음 리뷰)가 영속 마커에서 복구해
결과를 밝힌 고정 detail로 **한 번** 단다(수정 라운드·연속 요청은 없다 — 루프는 거기서 끝났다). 의무는 그 head의 봇 핸드오프, 사람의
stop, 그 head(또는 live head)의 이후 clean 리뷰로 해소되고, 새 start는 새 세션을 연다. 루프가 이미 다른 head로 넘어간 뒤
도착한 옛 head의 not-clean 리뷰는 stale clean 리뷰와 똑같이 무시된다(§2b).
런타임도 지적 개수가 아니라 같은 게시 결과(`postedOutcome`)로 판정한다: 구조화 지적이 0건이어도 clean pass가 아닌 리뷰(raw / raw-unverified / unverified-clean / incomplete)는 활성 세션에서 고정 ESCALATE `loop-error` 하나로 넘기며, 조용히 멈추지 않는다.

연속(비종착) 제어 신호 — 루프가 다음 라운드로 넘어갈 때 드라이버가 방출:

| 신호 | 고정 마커(머신) | 고정 문구(사람) | 감지 |
|---|---|---|---|
| **CONTINUE** | `<!-- ashlar-loop-continue mode=<apply\|suggest> round=<N> pr=<PR> head=<40hex> -->` | `Ashlar review-loop continues — requesting the next review` | 마커(봇 작성분만) |

| **FIXING**(진행 신호) | `<!-- ashlar-loop-fixing round=<N> pr=<PR> head=<sha> -->` | `Ashlar review-loop — fix round in progress` | 마커(정보용 — 트리거·종료 아님) |

FIXING은 수정 요청 직전에 단다(수정은 바쁜 provider 큐에서 오래 기다릴 수 있다 — 드라이버가 "진행 중"과
"죽음"을 구분하게). 그 뒤에는 반드시 fix 리포트+연속 또는 핸드오프가 온다.

**수정 요청 감시(`fix-request-watch.ts`):** 로컬 LLM은 리뷰와 수정을 한 줄로 처리하므로 수정 요청은 큐에서 오래
기다릴 수 있다. 스트리밍 신호로 "대기(keepalive)"와 "생성(첫 출력)"을 구분해:
- 생성 deadline(`ASHLAR_FIX_TIMEOUT_MS`, 기본 60분)은 **첫 출력부터** 센다 — 대기 시간 제외(부하 중 거짓
  `fix-failed` 방지). 대기 상한은 별도(`ASHLAR_FIX_QUEUE_MAX_MS`, 기본 6시간), 신호 두절(liveness)도 중단.
- **관련성 검사는 하나**(head 이동 · 세션 종료 · 새 세션 · apply→suggest 강등)이고, 라운드 시작 직전, 대기 중 2분마다,
  생성 시작 순간, 재시도 전, 커밋 직전, 리포트 전에 같은 검사를 쓴다 — 해당하면 abort(대기열 자리 반환·생성 조기 차단)하고
  조용히 끝난다(superseded / stopped / newer request). 이렇게 무의미해진 라운드는 **재시도하지 않는다.**
- 수정 요청은 리뷰 경로와 같은 샘플링·예산(temperature 0.6 등)을 쓴다 — 없으면 추론 모델이 반복 루프로 상한까지
  생성하다 `length`로 끝난다.
- 서버 로그 `[review-loop] <job> step|fix-request|fix-result|continued|handoff` 로 활성 세션의 각 단계를
  추적한다(세션 밖 PR의 리뷰는 로그를 남기지 않는다).
- 커밋은 전송 수준에서 1회 재시도하고(모델 재요청 없음), 응답이 유실된 ref 갱신은 "이미 목표 커밋"으로 인식한다.
- apply는 head 저장소가 **이 저장소임이 확인될 때만** 쓴다(fork·삭제된 head 저장소 등 출처 불명은 거절).

CONTINUE 코멘트에는 멘션·지시어 산문이 없다. 봇이 작성한 이 마커만 다음 리뷰를 연다(head는 감사용이며, 리뷰는
그 시점 PR 최신 head를 본다). 0건 라운드는 명시 요청과 같이 clean 리뷰(`ashlar-findings total=0`)를 올려
CONVERGED를 남긴다(슬래시 형식·연속 마커도 동일).

**신뢰 경계(구현):** 봇 코멘트는 루프 자신의 판단(멱등성·세션·연속 요청)에 쓰이므로, 봇 코멘트에 들어가는 모든
비신뢰 텍스트(fix 에이전트 summary·경로·오류, 스레드 노트)는 마커 구분자를 무력화하고 @멘션을 무력화한다. 또한
ashlar 자신의 파서는 마커가 **코멘트 맨 앞**에 있을 때만 신호로 인정한다(드라이버가 방출하는 위치) — 본문 중간에
인용된 마커는 산문이다. 외부 substring 감지기는 그대로 호환된다(진짜 마커는 항상 맨 앞).

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
6. **지적마다 in-thread에 수정 SHA 답글**(요약 코멘트는 미처리로 읽힘). 구현: fix 응답의 `dispositions`
   (`F<n>`별 fixed/pushback/decline/defer + 한 문장)로, 게시된 인라인 지적 스레드마다 고정 형식 답글을 단다 —
   applied면 `Fixed … in <sha7> (round k): <note>` 또는 `Processed … (no per-finding note)`, no-change면
   pushback/decline/defer 사유. suggest는 답글 없음(아무것도 반영되지 않았으므로). 노트는 모델 텍스트라 마커
   무력화·@멘션 무력화·한 줄화한다. 수정 대상은 **게시된(published) 지적만** — 정밀도 정책이 거른 지적은 사람이
   본 적이 없으니 수정하지 않는다.
7. **0-UNADDRESSED 게이트** 후 다음 라운드. 반복.
8. **정지 조건 감지 시 §8 ESCALATE.**

불변식: `@ashlar review` 는 0-UNADDRESSED 일 때만 / 라운드당 in-flight 1개 / push 1개 / DIRTY SHA에 요청 금지.

**종료 계약(구현, `review-loop-runtime.server.ts`):** 루프 세션은 반드시 고정 신호 하나로 끝난다 —
CONVERGED(clean 리뷰 `total=0`), ESCALATE(reason 코드), STOPPED(운영자 정지). 조용한 정지·자유 문장 종료는 없다.
suggest 모드의 라운드는 고정 "suggestion" 리포트로 사람에게 넘기고, 사람이 적용·push하면 세션이 이어진다(§2b).

- **수정 라운드 예산** `ASHLAR_LOOP_ROUND_CAP`(기본 **5**): 리뷰 라운드 k(≤5) 뒤에 수정 라운드 k. 리뷰 라운드
  6은 5번째 수정의 **검증 리뷰** — clean이면 CONVERGED, 지적이 남으면 `round-cap` ESCALATE(추세와 무관한 하드 상한).
- applied 라운드는 **항상** 다음 리뷰를 요청한다(연속 마커). 예산 판정은 다음 리뷰에서 한다.
- 수정 라운드 실패는 라운드 안에서 재시도(`ASHLAR_FIX_ATTEMPTS`, 기본 2 — request/parse/scope/validation 실패) 후
  `fix-failed`. 재시도 지시문은 **고정 문장**(거절 코드만 포함)이고, 거절 사유(모델 출력·저장소 경로를 인용할 수 있음)는
  **JSON 인코딩된 비신뢰 데이터 필드**로만 되먹인다. 변경 없음은 `fix-declined`, 그 밖의 진행 불가는 `loop-error`.
- 조용한 종료는 셋뿐: **supersede**(리뷰 후 head가 움직임 — 새 head의 리뷰가 루프를 이어받음; 제안(suggest)도
  게시 전에 확인), **이 head에 이미 ESCALATE가 있음**(핸드오프를 넘어서 수정하지 않음), **같은 head의 다른 루프
  단계가 진행 중**(프로세스 내 head별 가드 — 같은 head에 수정 라운드가 둘 돌지 않음).
- **커밋 후 단계:** 브랜치가 이미 움직였으므로 이후 핸드오프는 **새 head**를 가리킨다. 연속 마커(제어 신호)를 먼저
  달고, 그다음 리포트(마지막 줄이 실제 결과를 말함)를 단다. 연속 요청 실패는 새 head에 대한 `loop-error`.
- 예산은 **권위적**이다: 검증 리뷰(N+1)에 지적이 남으면 추세 패턴과 무관하게 `round-cap`이고, 패턴(whack-a-mole·
  oscillation)은 Detail에 남는다. 패턴 사유는 예산 안에서만 발동한다.
- 라운드 이력은 봇 로그인으로 귀속 가능해야 한다: 현재 리뷰가 이력의 마지막 라운드로 보이지 않으면(API 지연 대비
  3·6·12초 백오프 재조회 후) 수정하지 않고 `loop-error` — 예산을 우회하는 "맹목 수정"을 막는다. 같은 head의 다른
  핸드오프가 게시 중이면 한 번 기다렸다가 다시 보고, 여전히 게시 중이면 **로그에 남는** 사유로 끝낸다(조용한 no-op 없음).
- 세션 경계·이력 순서는 **시각(epoch ms)으로** 비교한다(문자열 비교 금지: `…00Z` 가 `…00.500Z` 보다 사전순으로 뒤).

## 6. Fix 에이전트 (루프를 실제로 수렴시키는 엔진)

fix 주체는 **설정 가능**하다(§6b). 채팅 리뷰어(ChatGPT/Grok)도 **GitHub 플러그인/커넥터를 설치하면 탭에서 직접
커밋·push 가능**하다(초기 전제 "채팅은 커밋 불가"는 틀렸다). 따라서 fix 전달(push) 메커니즘은 3가지:

| 메커니즘 | 방식 | 장단점 |
|---|---|---|
| **A. 스크립트-apply (기본·권장)** | 채팅/로컬 응답을 **full-file 스키마**로 받아 코드가 파일을 덮어쓰고 git/gh로 push | LLM-free·결정적·**토큰↓·속도↑**. `diff` 금지(적용 취약). 큰 파일은 C로 폴백 |
| **B. 채팅탭 push (플러그인)** | GitHub 커넥터 붙은 채팅탭이 스스로 커밋·push | 탭 자율. **fix-트리거 프롬프트가 필요**하고, 결과가 비결정적이라 검증 게이트 필수 |
| **C. 코딩 에이전트** | 레포-write 코딩 에이전트(Codex/Claude류)가 도구로 수정 | 대형/구조적 수정에 강함. 토큰↑·느림 |

**신뢰성(판단):** A의 **추출·적용·push는 결정적·LLM-free로 신뢰 가능**하나(파싱은 기존 `extract-chat-json`+
`json-repair` 재사용, full-file은 적용 실패 0), **"항상 문제없이"는 불가** — 스키마는 *기계적 충실도*만 보장하고
*수정의 옳음*은 보장 못 한다. 그래서 **항상**: full-file 표현형 + 적용 후 결정적 체크(파싱·예상경로·truncation·
라인수 assert) + **§7 2단계 CI/테스트 게이트**(진짜 안전망) + 실패 시 폴백(다른 provider→C→ESCALATE).

**병렬성(필수):** 리뷰가 PR별 병렬로 도는 것처럼 **fix도 서로 다른 PR을 병렬로** 처리해야 한다. 채팅탭 방식(B)은
**PR별 fix 탭을 병렬로** 연다(리뷰어 탭과 동일한 bridge capacity 관리). **한 PR 내부는 동시성 1**(1커밋/라운드,
루프 1개/PR — 워킹트리 경합 방지). 스크립트-apply(A)는 PR별 워크트리로 병렬.

프롬프트에 반드시(어느 메커니즘이든):

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

## 6b. Fix 에이전트 설정 (설계 초기부터 설정 가능)

리뷰어 설정(`reviewChatgpt`/`reviewGrok`/`reviewLocal`)과 대칭으로, **fix 에이전트를 설정으로 고른다.** 초기부터
스캐폴드하여 phase 3에서 동작만 붙인다.

```
fixAgent: {
  provider: "chatgpt" | "grok" | "local" | "coding-agent",  // 누가 수정하나
  delivery: "script-apply" | "chat-push" | "coding-agent",  // 어떻게 push 하나 (§6 A/B/C)
  mode: "suggest" | "apply",          // suggest=제안/초안(사람 1클릭), apply=자동 push
  parallelPrs: number,                // 서로 다른 PR 동시 fix 상한 (리뷰 capacity와 공유)
}
```

- **기본값(안전 우선):** `provider` 없음(루프 미설정 시 fix 안 함) · `delivery: "script-apply"` ·
  `mode: "suggest"` · `parallelPrs`는 bridge capacity 내. → 명시적으로 켜야 자동 수정이 돈다.
- **provider→delivery 제약:** `chatgpt`/`grok`는 `script-apply`(응답 파싱) 또는 `chat-push`(플러그인). `local`은
  `script-apply`(grokbot `qwen_openai_edit.py` 재사용). `coding-agent`는 `coding-agent`.
- **권한:** 어떤 provider든 push하려면 §2의 write-권한 게이트를 통과해야 한다. `apply` 모드는 명시적으로만.

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
| `round-cap` | 수정 예산(기본 5) 소진 후 검증 리뷰에도 지적 | 추이·반복파일로 분류 후 방향 결정 |
| `fix-failed` | fix 에이전트 응답이 재시도 후에도 적용 불가(요청·파싱·범위·검증·커밋 실패) | 수동 수정 또는 원인 해결 후 재실행 |
| `fix-declined` | fix 에이전트가 모든 지적을 pushback/decline/defer(변경 없음) | 지적별 판정 — pushback 수용 시 스레드 resolve, 아니면 수동 수정 |
| `loop-error` | 수정 라운드 자체를 못 돌림(fork에 apply, 편집 가능 파일 없음, 스냅샷·이력 불가 등) | 원인 해결 후 재실행 |

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
