# PR #74 수렴 작업 핸드오프 (클라우드 세션 → 리뷰어 Dev)

- 보낸 쪽: 클라우드 세션 `session_01XrQnTkidbHfB53kJktuci9` ("로컬 리베이스 검증 #76·#77")
- 받는 쪽: 리뷰어 Dev (`session_01AYavS6vJ7NtG8WzRZvzctL`, Mac Studio)
- 기준 시각: 2026-09-24 09:25Z (18:25 KST)
- 이 파일과 데이터: 브랜치 `claude/local-rebase-validation-xs4l78`의 `handoff/pr74/`
  (`git fetch origin claude/local-rebase-validation-xs4l78`)

**이 클라우드 세션은 #74, #76, #77 브랜치에 아무것도 푸시하지 않았고, 코멘트도 달지 않았습니다.**
핸드오프 이후에는 PR 구독과 체크인을 해제하고, 이 PR들에서 손을 뗍니다.

---

## 1. 현재 상태 (한눈에)

| 항목 | 상태 |
|---|---|
| #74 head | `0b0a2cd` (round 6), 변경 없음 |
| #74 CI `verify` | **빨간불**. Node 22에서 lib subtest 64개 cancelled. 원인과 수정은 §2 |
| Round 7 Ashlar 리뷰 | `job-muf987dm-2411`: 08:12Z에 jay-1233의 `/review`로 트리거됨. 이 요청이 이전 job `job-muf51f0g-1942`를 superseded 처리함. 08:37Z에 ChatGPT가 JSON을 돌려줌(**findings 5건**). local LLM은 아직 queued/generating이라 **아직 게시되지 않음** |
| 근본원인 분석 | round 1–6의 finding **57건**을 **8개 근본원인 클래스(K1–K8)**로 분류 완료(§3). K1·K2는 전수 탐색과 재현 확인까지 완료했고, 워크플로우는 그 시점에서 중단함. **→ `ANALYSIS.md`** |
| #76/#77 리베이스 | 로컬 검증만 완료했고 푸시는 안 함(§4) |

## 2. #74 CI 빨간불: 원인과 수정 (커밋 `86fd8c9`, 푸시 안 함)

- **증상**: `verify` 잡의 `npm test`가 Node 22에서 lib 테스트 606개 중 64개를 cancelled 처리.
  에러 메시지는 `Promise resolution is still pending but the event loop has already resolved`.
  대상은 `fix-request-watch.test.ts` 12개와 `review-loop-runtime.server.test.ts` 52개.
- **원인**: `src/lib/fix-request-watch.ts`의 watcher `setInterval`이 `unref()` 되어 있음.
  대기 중인 작업이 watcher뿐인 프로세스(Node 22 테스트 러너)에서는 이벤트 루프가 먼저 비어 버려,
  요청이 진행 중인데도 테스트가 취소됨.
  Node 24(맥의 버전으로 추정)의 테스트 러너는 이벤트 루프를 붙잡아 두기 때문에 드러나지 않았음.
  round 5(921101b)부터 이미 이 상태였음.
- **수정**: interval의 `unref()` 한 줄을 제거하고 이유를 주석으로 남김.
  interval은 모든 settle 경로에서 clear되고, 운영 환경에서는 provider 소켓이 어차피 이벤트 루프를 붙잡으므로
  `unref`로 얻는 이득이 없음. probe의 bound timer는 `finally`에서 clear되므로 `unref`를 유지함.
- **검증 (Node 22 = CI와 동일)**: `npm test` 전부 통과. 내역은 review-regressions 335, scripts 203,
  lib 606(cancelled 0), e2e 95. `test:lib`, `typecheck`, `build:dev`, 해당 파일 eslint도 통과.
- **로컬 재현 방법**: `/opt/node22/bin/node --experimental-strip-types --test src/lib/fix-request-watch.test.ts`
  (수정 전 cancelled 12, 수정 후 0)
- **권장**: 플레이북의 "한 라운드에 한 번 push" 규칙에 따라, round-7 수정 커밋과 같은 push에 태우기.
  커밋 `86fd8c9`는 `claude/local-rebase-validation-xs4l78` 히스토리에 포함되어 있으므로
  `git cherry-pick 86fd8c9`로 가져가면 됨.

```diff
     }, cfg.tickMs);
-    (handle.timer as { unref?: () => void }).unref?.();
+    // Deliberately NOT unref'd: an in-flight request is real work, and the interval is cleared on
+    // every settle. Unref'd, a process whose only pending work is this watcher (Node 22's test
+    // runner) drains its event loop and abandons the request mid-flight.
```

> 로컬 검증은 반드시 **Node 22**로 해야 함. 맥의 Node에서는 이 cancelled가 보이지 않음.

## 3. 근본원인 분석: 두더지 잡기가 계속되는 이유

데이터 파일:
- `findings.json` / `findings.md`: round 1–6의 finding 57건. inline 46, body 11, P1 21, P2 36.
  finding마다 jay-1233의 disposition이 붙어 있음.
  disposition 분포: fixed 44, 검증 후 변경 없음 7, 검증+보강 4, by-design 1(R4-6), deferred 1(R6-4).
- `root-cause-classes.json`: 서로 다른 관점의 분석 2개(실패 메커니즘 / 위반된 불변식)를 병합한 결과.
  클래스마다 finding id, 근본원인, 핫스팟(file:function), 구조적 수정 방향이 있음.

라운드마다 finding 6–11건이 계속 나오는 이유는 **같은 불변식을 호출 지점마다 손으로 다시 구현하고 있기 때문**임.
point patch 하나는 해당 인스턴스만 막고, 같은 클래스의 다음 인스턴스가 다음 라운드에 나옴.

| 클래스 | 무엇이 반복되나 | 근본원인 | 구조적 수정 방향 |
|---|---|---|---|
| **K1** 제어 신호 exactly-once 방출 (12건, R2–R6) | redelivery·재실행·lost response 때문에 handoff/continuation/STOPPED/start/FIXING/보고가 중복 게시되거나 누락됨 | 멱등 emit primitive가 없음. key를 6곳에서 제각각 만들고, emitter마다 "이미 게시됨?" 판정·읽기 실패 정책·재시도가 다름 | `emitControl(ref, {kind, effectKey, body, readFailure})` 하나로 통일. typed key, in-flight join, 앱 자신의 쓰기를 기록하는 journal(read-your-writes), 종류별 파서로 동등성 확인 |
| **K2** PR별 직렬 제어면 없음 (8건) | start/stop/push/step/escalate가 fire-and-forget으로 동시에 돌고, busy sentinel을 결과값처럼 반환함 | 모듈 레벨 Set/Map 5종에 각각 다른 key를 쓰고, "busy"가 결과가 되어 버림 | 주입형 `LoopRuntime` + PR별 직렬 실행기 `withPr(ref, fn)`. 제어 결정과 쓰기는 도착 순서대로 짧은 critical section에서 처리하고, start는 webhook 수신 시점에 기록 |
| **K3** 시간 기반 세션 fold (8건, R3–R6) | 초 단위 시각, 소급된 시각, 서로 다른 시계가 섞여 동점 규칙이 계속 추가되고 서로 충돌함 | 세션 id를 가진, 앱이 작성한 전순서 전이 로그가 없음. CONVERGED·push는 기록되지 않고 나중에 추론됨 | 모든 전이를 앱이 작성한 레코드로 남기고 `session=<start-record comment id>`를 붙임. fold는 시간이 아니라 세션 id와 comment id 순서로 함. CONVERGED도 레코드로 남김 |
| **K4** 신뢰할 수 없는 텍스트가 제어 채널에 섞임 (7건) | 모델/레포/에러 텍스트로 마커를 위조하거나 @멘션하거나 프롬프트를 주입할 수 있음 | 사람이 읽는 보고와 기계용 제어 레코드가 한 comment에 있음. 파서는 느슨한 prefix 매칭이고, 외부 검출기는 substring 매칭 | 제어 comment는 canonical 렌더링만 담는 전용 comment로 분리하고, `parseControlComment`로 재렌더링해 바이트 동등을 확인. `Untrusted` 브랜드 타입을 도입하고 출구는 2개(comment용 렌더, prompt용 JSON)로 제한 |
| **K5** 가드된 쓰기 경계 없음 (9건) | 긴 step이 시작 시점의 사실(head, session, mode, starter, 권한, sameRepo)을 믿고 쓰기를 함. checkpoint마다 다시 확인하는 항목이 다름 | 모든 쓰기가 통과하는 guarded-effect 추상화가 없음. unknown 값을 기본값으로 강제 변환함(`Boolean(fork)`, `?? 'none'`) | `RoundEpoch`를 캡처하고 모든 쓰기를 `guardedEffect(epoch, kind, fn)`로 통과시킴. 쓰기 직전에 한 predicate로 재검증하고, tri-state에서 unknown이면 거부 |
| **K6** 종료 계약이 return 지점마다 흩어짐 (6건) | `runPostReviewLoop`의 출구 약 30개가 각각 `{ran:false, reason:string}`을 반환하고, silent 여부는 문자열 집합과 정규식으로 판정함 | 닫힌 outcome 타입과, 종료 방출을 책임지는 settle 하나가 없음. 에러에 타입이 없음 | `StepOutcome` discriminated union을 두고 `settle(outcome)` 하나가 K1 emitter로 방출함. 방출 실패는 loop-error로 처리하고, 절대 silent하지 않게 함 |
| **K7** 예산을 리뷰 히스토리에서 추론함 (3건) | round cap이 재구성된 리뷰 head 수에 좌우됨. suggest 모드나 같은 head의 반복은 예산을 소모하지 않음 | 제한 대상(fix round)이 아니라 대리 지표(review)를 셈 | 앱 자신의 FIXING 레코드를 ledger로 삼아 (session, head)당 1회를 셈. cap = 기록된 fix round 수. classifyStuck은 보조 정보로 강등 |
| **K8** fix request 수명주기를 수작업으로 조립함 (3건, R3·R6) | sync throw, hung probe, 늦은 응답, abort를 무시하는 transport 등 에지마다 finding이 나옴 | flag·interval·Promise executor를 손으로 엮음. transport 계약(abort 준수, activity 보고)이 선언되지 않음 | `AbortSignal.any`/`AbortSignal.timeout` 기반 async 함수로 재작성. `try/finally`로 settle을 보장하고, transport capability `{abortable, reportsActivity}`를 선언·테스트함 |

미분류: R3-5.

**주의**: 위 방향은 분석 단계의 제안임. 클래스별 전수 탐색과 적대적 검증 결과(실제 남아 있는 인스턴스, 수정안이 다른 불변식을 깨는지)는 아직 나오지 않았음.
워크플로우는 K1·K2까지 진행한 시점에서 중단함. 중간 결과와 진행 방향 제안은 **`ANALYSIS.md`**에 있음.
K1/K2/K3/K5/K6은 서로 맞물려 있음: emitter, 직렬 실행기, 전이 레코드, 가드, settle.
그래서 한 번에 설계해야 두더지 잡기가 끝남.
범위가 크므로, 한 커밋으로 갈지 #74를 쪼갤지는 사용자 결정이 필요할 수 있음(플레이북: 1.5k줄 초과 시 분할 제안).

## 4. #76/#77 리베이스 검증 (로컬만, 푸시 안 함)

- 현재 #76(`e45bb19`)과 #77(`1cd2005`)은 round 5(`921101b`) 위에 있고, round 6(`0b0a2cd`)보다 뒤처져 있음.
- `claude/local-rebase-validation-xs4l78`의 스택(이 핸드오프 커밋 **아래**)은 다음과 같음:
  - `86fd8c9` CI 수정(= #74 head + 1)
  - `52c094d` #76
  - `f0a0584`, `22678cd`, `d42ea50`, `a9e890f` #77 (**스택의 tip은 `a9e890f`**)
- #76은 충돌 없이 올라감.
- #77의 충돌은 2곳:
  1. `package.json` 테스트 목록: round 6의 `loop-control-claims.test.ts`와 #77의 `bridge-fix.server.test.ts`를 **둘 다** 남겨야 함.
  2. `review-loop-runtime.server.ts`의 `stopLoop`: **round 6 본문을 유지**하고, #77의 변경인
     `productionDeps(settings, { owner: stop.owner, repo: stop.repo, pr: stop.pr })`만 적용해야 함.
     #77 쪽을 택하면 round 6의 stop 처리(`startInFlight` 경합, stop 단위 single-flight)가 **조용히 되돌아감**.
     그래서 자동화(워크플로우) 리베이스를 할 때 가장 위험한 지점이 여기임.
- 검증은 Node 22로 함.
  - #76 층: typecheck, `npm test` 통과(335/203/616/95).
  - #77 스택: typecheck, `npm test` 통과(359/203/641/95), `build:dev` 통과.
  - lint: 리베이스 전과 동일한 191개. 모두 `extension/*.js`와 브라우저 e2e 파일에 원래 있던 것.
- "워크플로우로 리베이스해도 되는가" 분석은 사용자 요청으로 중단함.
  판단 근거는 위 두 충돌과, #74가 수렴 중이라는 점임.
  #74에 round 7 이후 커밋이 더 올라갈 것이므로, **#74가 수렴한 뒤 한 번만 리베이스**하는 편이 비용이 적음.

## 5. 이 클라우드 세션의 이후 동작

- #74 PR 구독과 1시간 체크인 트리거는 **해제함**(두 세션이 동시에 push하는 것을 방지).
- 근본원인 분석 워크플로우(`wf_8f800740-d0c`)는 사용자 요청으로 K1·K2까지만 진행하고 중단함. 결과는 `ANALYSIS.md`에 있음.
- 스크래치 데이터 원본(`reviews.json`, review threads REST 덤프 등)은 컨테이너에만 있음. 필요하면 GitHub에서 다시 받으면 됨.
