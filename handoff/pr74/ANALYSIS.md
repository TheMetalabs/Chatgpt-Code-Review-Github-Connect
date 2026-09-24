# PR #74 근본원인 분석: 중간 결과 (워크플로우 중단 시점)

- 기준: #74 head `0b0a2cd` + CI 수정 `86fd8c9` (로컬 브랜치 fix74)
- 기준 시각: 2026-09-24 09:40Z
- 먼저 읽을 문서: `HANDOFF.md` (현재 상태, CI 수정, 클래스 K1–K8 요약, #76/#77)

## 0. 어디까지 했나

| 단계 | 상태 |
|---|---|
| round 1–6 finding 수집(57건)과 disposition 연결 | ✅ `findings.json` / `findings.md` |
| 근본원인 클래스 분류: 두 관점(메커니즘/불변식)을 병합해 K1–K8 | ✅ `root-cause-classes.json` |
| K1·K2 전수 탐색: 현재 코드에 남은 인스턴스와 구조적 수정안 | ✅ `hunts-K1-K2.json` |
| K1·K2 재현 테스트를 **직접 실행해 확인**(Node 22) | ✅ K1 14/14, K2 6/6 통과 = 버그 재현됨 (§1) |
| K3–K8 전수 탐색 | ❌ K3·K4는 진행 중 중단, K5–K8은 시작 전 |
| 수정안 적대적 검증(다른 불변식을 깨는지) / 통합 계획 | ❌ 실행 안 됨 |
| round 7 finding 반영 | ❌ 아직 게시되지 않음(ChatGPT 5건, local LLM 대기) |

재현 테스트를 돌리는 방법: `repro/k1-repro.test.ts`와 `repro/k2-repro.test.ts`를 `src/lib/`에 복사한 뒤 아래를 실행.
```
/opt/node22/bin/node --experimental-strip-types --test --test-force-exit src/lib/k1-repro.test.ts src/lib/k2-repro.test.ts
```
- 이 테스트들은 **현재의 버그 동작을 단언**함. 따라서 통과 = 재현됨.
- 수정 후에는 단언을 뒤집어 회귀 테스트로 쓰면 됨.
- k2의 I6은 일부러 멈춘 step을 남기기 때문에 `--test-force-exit`이 필요함.
- `k2-harbor-repro.e2e.mjs`와 `app-fixture.patch`(harbor 경로 I8/I9)는 **실행 확인 안 함**.

## 1. 결론

1. **수렴하지 않는 이유는 개별 버그가 아니라 "루프 제어면(control plane)"이 없기 때문이다.**
   아래 5개 불변식이 각각 호출 지점마다 손으로 재구현되어 있음.
   point fix 하나는 그 인스턴스만 막고, 같은 클래스의 다음 인스턴스가 다음 라운드에 나옴.
   이 5개 클래스(K1/K2/K3/K5/K6)가 57건 중 43건을 차지함.
   - 제어 신호를 정확히 한 번 게시하고, 앱이 방금 쓴 것을 바로 읽을 수 있어야 함(read-your-writes): K1
   - PR 단위로 직렬화하고, 제어 이벤트를 도착 순서대로 처리해야 함: K2
   - 세션 id를 가진 전이 레코드가 있어야 함: K3
   - 모든 쓰기 직전에 하나의 가드로 재검증해야 함: K5
   - 닫힌 outcome 타입과, 종료 방출을 책임지는 settle 하나가 있어야 함: K6
2. **리뷰가 아직 지적하지 않은 실제 버그가 K1·K2에서만 20건 이상 있고, 재현으로 확인됨.**
   point fix로 가면 round 8, 9에서도 계속 나옴.
3. **transport 층에 main에도 있는 기존 원인이 있음.**
   `github.server.ts` `ghHttps`(l.244–260)는 어떤 오류 뒤에든(요청 전송 후 20 s 타임아웃 포함) **같은 메서드와 본문을 다른 호스트로 재전송**함.
   모든 API 호출이 `gh()`를 거쳐 여기를 지나므로, POST(리뷰·comment·git data)가 `createIssueComment` 한 번 안에서 중복될 수 있음.
   emitter 쪽의 어떤 스캔이나 캐시로도 막을 수 없음.
   → GET과 "요청을 쓰기 전"의 오류(DNS/connect)만 재시도하도록 바꿔야 함. 작고 독립적인 수정임.

## 2. K1: 제어 신호 exactly-once 방출 + 자기 쓰기 가시성 (인스턴스 13: NEW 11, 기존 잔여 2)

| # | 위치 | 문제 | 재현 |
|---|---|---|---|
| 1 | engine `maybeEscalateInner` l.300 | round-cap handoff POST가 try 밖에 있어 1회만 시도됨. 응답 유실 + list lag이면 catch-all(runtime l.842)이 **두 번째 handoff(loop-error)**를 게시 | I1, I1b |
| 2 | engine `escalateNow` l.356 (+ runtime escalate, continueLoopOnPush) | 종료 handoff(fix-failed/fix-declined/loop-error)가 **1회만 시도**됨. 502 한 번이면 handoff 없이 세션이 active로 남아 **조용히 멈춤** | I2 |
| 3 | runtime `stopLoop`/`sessionOf` l.1046 | STOPPED 레코드 POST가 성공하면 pending stop을 즉시 지움. list에 아직 안 보이는 순간에는 stop이 어디에도 없어서, 진행 중인 apply가 **stop 뒤에 커밋함** | I7 |
| 4 | engine `readLoopEvents`/`readLoopSession` | 방금 게시한 handoff가 fold에 반영되지 않아, 같은 head의 두 번째 리뷰가 **terminal handoff 뒤에 fix를 다시 돌리고 커밋까지 함** | I8, I8b |
| 5 | runtime `ensureContinuation` l.478 | 응답 유실 + lag(또는 list 실패를 '없음'으로 처리)이면 **continuation이 중복**되어 리뷰가 두 번 트리거됨 | I5, I5b |
| 6 | runtime `ensureStopRecord` l.987 / `startLoop` l.937 | 같은 패턴으로 STOPPED 2개, start record 2개 | I6, I6b |
| 7 | runtime 보고 게시 l.833/838 | suggestion/no-change 보고의 응답이 유실되면 catch-all이 loop-error handoff를 게시함. push를 기다려야 할 **suggest 세션이 종료됨** | I3 |
| 8 | runtime FIXING l.764 | (session, head) 단위의 fix round key가 없음. 같은 head를 순차로 다시 돌리면 FIXING·provider 요청·보고가 2번씩 나가고 **예산도 소모되지 않음**(K7과 겹침) | I4 |
| 9 | harbor `finishJob` l.1125 | 방금 게시한 리뷰(**clean 포함**)를 루프에 넘기지 않음. 수렴 직후 사람이 push하면 lag 때문에 **수렴한 세션이 다시 열림** | I10 |
| 10 | runtime CURRENT_ROUND_MISSING poll l.635 | 자기가 게시한 리뷰를 list에서 3/6/12 s 동안 기다림. lag이 21 s를 넘으면 loop-error로 종료됨. inline comment는 기다리지 않아 files가 `[]`가 됨 | (R3-13 잔여) |
| 11 | runtime start self-heal l.602 | postedRecently는 key만 저장해서 fold가 레코드를 볼 수 없음. poll 한도를 넘으면 **조용한 NO_SESSION**이 되어 첫 라운드를 건너뜀 | I9 (R6-10 잔여) |
| 12 | github.server `ghHttps` l.244 | §1-3: transport가 POST를 재전송함 | (코드 확인) |
| 13 | runtime `continueOn` l.582 | 세션 읽기가 실패하면 `.catch(()=>null)`로 continuation을 건너뜀. 놓친 push가 있으면 **세션이 영원히 대기함** | — |

**구조적 수정안** (크기 large, 위험 medium):
- 새 DI 모듈 `review-loop-control.ts`에 다음 4개를 둠:
  1. typed `ControlKey {kind, pr(lowercased), session, head?, by?, at?, mode?}`와 `controlKey()`. 흩어져 있던 6종의 key 문자열을 대체함.
  2. `OwnWrites` journal: 앱이 쓴 것을 GitHub이 반환한 row(id, user.login, 시각) 그대로 PR별로 저장함. stop의 write-ahead intent와 "결과 불명" 마커도 함께 저장함.
  3. `withOwnWrites(gh, journal)` overlay: list 결과에 journal row를 id 기준으로 합침. 기존 파서와 fold가 **같은 authorship·session 규칙으로** 앱 자신의 쓰기를 보게 되므로, 각자 lag을 처리할 필요가 없어짐.
  4. `emitControl(...)`: 모든 kind가 같은 알고리즘(join → 스캔 → POST → 재시도 → reconcile)을 쓰고, typed `EmitResult {posted|exists|failed(rejected|unknown|unreadable)}`를 반환하며 throw하지 않음.
- start, stop, continue, handoff(두 경로), FIXING, report를 모두 `emitControl`로 게시함.
- harbor는 게시한 리뷰(clean 포함)를 journal에 넣고 step에 넘김. claim 해제는 정규식 대신 `EmitResult`로 판정함.
- `createIssueComment`/`createPullReview`는 서버 진실(id, login, 시각)을 반환하고 `.status`를 가진 에러를 던짐. `ghHttps`는 POST를 재전송하지 않음.
- **삭제되는 point patch**:
  - postedByClient / rememberPosted / postedRecently, handoffKey
  - `continuing` map, 3개의 재시도 루프와 3개의 "읽기 실패 = 없음" 정책
  - pendingStops* / setPendingStop, inFlightStop
  - start self-heal poll(R6-10), harbor의 `/failed|in flight/` 정규식(R6-3 일부)
  - 관련 finding: R2-4, R3-4, R4-4, R4-8, R5-5, R5-7, R6-5, R6-9, R6-10, R3-13(fallback으로 축소)
- **테스트**:
  - 모든 ControlKind × 장애 매트릭스(frozen list, list 오류, POST 4xx/5xx, 응답 유실) 표 기반 계약 테스트
  - read-your-writes 속성 테스트: 게시 직전 시점에 고정한 list로 fold해도 결과가 같아야 함
  - choke-point 가드 테스트: `review-loop-*.ts`에서 `createIssueComment(`는 control 모듈에서만 호출됨
  - `ghHttps`의 POST 비재전송 테스트
- 알려진 잔여 non-goal: 프로세스 재시작을 넘는 중복, 응답이 유실된 row가 계속 보이지 않는 경우.

## 3. K2: PR별 직렬 제어면 없음 (인스턴스 11: NEW 9, 기존 잔여 2)

| # | 위치 | 문제 | 재현 |
|---|---|---|---|
| 1 | harbor `applyLoopControl` l.1359 | stop이 pending이 되기 전에 `await installationToken()`과 `await productionDeps()`를 거침. 토큰 fetch가 실패하면 stop이 어디에도 기록되지 않음. redelivery는 duplicate로 무시되어 **stop 후 커밋**이 일어남 | (harbor, 미실행) |
| 2 | runtime self-heal startLoop vs stopLoop l.599 | admission 시점 start 기록이 실패하고 step의 self-heal POST가 진행 중일 때 들어온 edit-stop은 잊혀짐. 그 결과 apply가 커밋함 | I1 |
| 3 | harbor `playGithub`/`recordLoopStart` l.622 | start가 **admission 시점에만** 기록됨. 그 전에 다른 리뷰 요청에 superseded되면 사용자가 요청한 루프가 **조용히 시작되지 않음** | — |
| 4 | harbor stop sweep l.1380 | stop 시각과 start 시각을 비교하지 않고 live start job을 모두 취소함. 오래된 stop이 redelivery되면 새 세션이 **조용히 멈춤** | — |
| 5 | runtime `continueLoopOnPush` l.882 | 세션을 읽은 뒤 POST하기 전에 들어온 stop과 순서가 맞춰지지 않아 **STOPPED 뒤에 CONTINUE**가 게시됨 | I2 |
| 6 | runtime `afterCommit` l.813 | 같은 패턴으로 STOPPED 뒤에 continuation과 "Loop continues" 보고가 게시됨 | I4 |
| 7 | runtime `sessionOf`/commit l.452 | pending stop을 호출 시점에 캡처하므로, list 읽기 도중 들어온 stop을 놓침. 이후 blob/tree/commit/ref 갱신이 **stop 뒤에** 일어남 | I3 |
| 8 | runtime `inFlightSteps` l.572 | busy가 결과값으로 반환됨. suggest→apply 업그레이드가 **조용히 버려지고**, key도 lowercased가 아님 | I5 |
| 9 | 모듈 레벨 상태 l.165 외 | guard는 프로세스 전역이고 캐시는 client별이라 격리 모델이 섞여 있음. 멈춘 step 하나가 다른 테스트와 다른 client를 막음 | I6 |
| 10 | runtime `continueLoopOnPush` l.886 | ESCALATE_IN_FLIGHT를 네 번째 방식으로 매핑함. harbor 정규식이 이를 실패로 오판해 거짓 알람을 냄 | — |
| 11 | github-payload l.180 | 제어 전용 delivery가 kind 'review'로 흐름. 앱 continuation도 `loop.kind='start'`로 태깅되어, startInFlight가 봇 job까지 셈 → **두 번째 STOPPED**가 게시됨 | — |

**구조적 수정안** (크기 large):
- 주입형 `createLoopRuntime(deps)`: 운영에서는 프로세스당 1개, 테스트에서는 케이스마다 새로 만듦.
- 모든 루프 프로세스 상태를 소유함: K1 journal, delivery claim, PR별 `Lane`(lowercased key).
- Lane의 구성:
  1. 동기, 도착 순서의 제어 로그(start intent·stop·push)
  2. 짧은 critical section용 비재진입 직렬 실행기 `withPr(ref, fn)`
  3. AbortController를 가진 step 슬롯 1개
- `receive(control)`는 동기이고, 어떤 await보다 먼저 로그에 append함.
- 모든 제어 결정과 쓰기(start 기록, STOPPED, push continuation, step의 pre-fix 게이트와 handoff, commit section)는 withPr section 안에서 실행됨.
- 모든 fold는 "durable history + lane log"를 **fold 시점에** 읽음.
- `updateBranchRef` 직전과 continuation POST 직전에 로그를 동기적으로 재확인함.
- busy sentinel 대신 차례를 기다림. 같은 PR의 새 step은 이전 step의 provider 요청을 abort함.
- stop은 이벤트 시각 기준으로 정렬하고, 자기 시각 이전의 intent와 job만 취소함.
- github-payload에 `kind: 'control'`을 추가하고, 앱 continuation의 태그를 `kind: 'continue'`로 바꿈.
- **삭제되는 point patch**:
  - STEP_IN_FLIGHT, ESCALATE_IN_FLIGHT, HANDOFF_IN_FLIGHT, 1회 backoff들
  - inFlightEscalate, `continuing`, pendingStops, inFlightStop
  - startInFlight 프록시와 harbor live-job 스캔
  - loopControlClaims와 정규식, self-heal poll, productionGh memo
  - 관련 finding: R1-6, R1-8, R2-6, R3-8, R5-1, R5-7, R6-1, R6-3, R6-10, R3-15, R6-11
- **위험**:
  - 재진입 `withPr`로 인한 deadlock: AsyncLocalStorage 가드로 방지
  - section 안에 몇 시간짜리 provider 요청이나 sleep 재시도가 들어가면 안 됨
  - harbor ingest와 admission이 바뀜
- **테스트**:
  - gated fake GitHub + 결정적 스케줄러로 interleaving을 열거하는 선형화 속성 테스트
  - k2 재현 테스트를 뒤집은 회귀 테스트
  - harbor fixture 테스트
  - payload의 control 분류 테스트

## 4. K3–K8 (클래스 수준만, 전수 탐색 안 함)
근본원인과 수정 방향은 `HANDOFF.md` §3 표와 `root-cause-classes.json` 참고.
- K3(세션 id가 붙은 전이 레코드, id 순서 fold)와 K5/K6(guardedEffect, StepOutcome+settle)은 K1·K2 위에 올라가는 층임.
- K4(제어/산문 분리, Untrusted 타입), K7(자기 FIXING ledger로 예산 계산), K8(AbortSignal 기반 watcher 재작성)은 비교적 독립적임.
- K8 관련: `86fd8c9`로 watcher interval을 ref 상태로 되돌렸음. 그래서 **멈춘 요청을 남기는 테스트는 이제 cancelled가 아니라 hang이 됨**(k2 I6처럼). K8 재작성 때 함께 정리할 것.

## 5. 진행 방향 (결정 필요)

K1·K2만으로도 수정 규모가 크고(runtime, engine, harbor, github.server 횡단), K3/K5/K6이 그 위에 얹힘.
#74는 이미 +3.9k줄임. 수렴 플레이북 기준으로 1.5k줄을 넘으면 분할을 제안하고, 5k줄을 넘으면 수렴하지 않음.

- **A. #74 안에서 재설계**: round 8에서 제어면을 통째로 교체함.
  - 근본원인은 한 번에 해결됨.
  - 대신 diff가 5k줄을 넘기 쉽고, 전체를 다시 리뷰해야 하므로 수렴 위험이 가장 큼.
- **B. #74는 범위를 고정하고, 제어면은 의존 순서 스택으로 분리**:
  - 루프 기능은 `ASHLAR_FIX_AGENT`와 `settings.fixAgent`로 **기본 off**임.
  - #74에는 CI 수정, transport 비재전송(§1-3), 종료 신호 누락(K1 #2) 같은 작고 독립적인 것만 넣음.
  - 나머지 클래스는 **이슈 번호를 단 deferral**로 disposition함. 플레이북에 따르면 "tracked issue #를 인용한 deferral은 유지됨".
  - 그 위에 스택을 쌓음: ① `ghHttps` → ② K1 control 모듈 → ③ K2 LoopRuntime → ④ K3 전이 레코드 → ⑤ K5+K6 가드와 settle → ⑥ K7 ledger. K4와 K8은 별도 PR.
  - #76/#77은 이 스택과 충돌하므로 순서 재조정이 필요함.
- **권장: B.**
  - 근본원인 수정은 A와 똑같이 하되, 리뷰 단위를 작게 쪼개야 각 PR이 수렴함.
  - 단, B에서 #74를 머지하면 재현된 버그가 있는 코드가 main에 들어감(기본 off라서 운영 영향은 없음). 이것을 받아들일지는 사용자 결정임.

## 6. 파일
- `hunts-K1-K2.json`: K1·K2 인스턴스 전체(시나리오 원문)와 수정안(changes, removes, tests, risk) 원문
- `repro/`: 재현 테스트. k1과 k2는 실행 확인함. harbor e2e는 미실행
- `findings.json` / `findings.md`, `root-cause-classes.json`: `HANDOFF.md` 참고
