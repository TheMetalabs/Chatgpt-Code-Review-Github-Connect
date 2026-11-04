# 리뷰어 정밀도 후속 제안 (#61 컨텍스트 tailoring 사후 평가)

> 상태: **P1 완료(배포됨) · P2/P3 백로그.** 근거는 아래 수렴 루프 누적 데이터.
> 관련: #61 (per-reviewer context tailoring: cross-file + policy), #62/#63 (로컬 레그 큐/중단·부분 살리기), #64 (테스트 경계·CI), **#66 (P1 구현, `a0acbf0e`).**

## 1. 목적

#61 이후 "리뷰어별 컨텍스트 tailoring"이 **의도대로 실제 이슈를 찾는지**, 그리고 **정밀도(오탐률)** 를
수렴 루프로 모은 실제 리뷰 결과로 평가하고, 정밀도를 끌어올릴 **구체적 후속안**을 우선순위와 함께
정리한다.

## 2. 누적 데이터 (2026-09-22 기준)

| PR | 성격 | 리뷰어 | diff | context | policy | 파인딩 | 검증 결과 |
|---|---|---|---|---|---|---|---|
| Chatgpt-Code-Review #63 | 인프라(로컬 레그) | chatgpt+local | 6,163 | 9,572 | **0** | 3 (P1×2,P2×1) | 정탐 1 / **오탐 2** |
| Chatgpt-Code-Review #64 | 테스트 전용 | ashlar | 소 | 소 | 0 | 2 (P2×2) | 유효(테스트 견고성) 2 |
| aicc-center #269 | **실도메인**(payroll) | chatgpt (local skip) | 38,697~111,565 | **66,908~189,396** | **6,465~32,764** | 8+ (대부분 P1) | 교차파일 정탐 다수 |

- context/policy 수치는 각 PR ops 코멘트의 `Prompt:` 계측에서 인용.
- #269 는 `24/24 code files with full diff, 24/24 with context` — 변경 파일 전부에 크로스파일 컨텍스트가 붙었다.

## 3. 판단: #61 은 "대상"에서 의도대로 작동한다

**실도메인 멀티파일 PR(#269)에서는 명확히 성공.** 컨텍스트가 diff의 1.7~2배로 붙고 policy도 6K~33K 붙으며,
결과 파인딩이 **교차파일 불변식 위반**을 정확히 짚는다. 예:

- `instructor-task-confirm.service.ts` 의 재제출 마감 검사가 `submit()` 에만 있고 normal Confirm 경로엔
  없어 마감 지난 REJECTED 건이 통과 — confirm/review 두 파일을 함께 봐야 나오는 지적.
- `SUBSTITUTE` 결과 게이트가 `confirm()/preloadConfirmAuth()` 에만 있고 새 `submit()` 경로엔 없음 —
  confirm.service + review.service + DTO 세 파일 교차.
- rowless `void()` 가 `assertSessionEligible()` 를 안 불러 미래/취소 세션에 VOID 기록 — 같은 파일의
  `approve()` 에만 있던 가드를 대조해 발견.

이 세 건은 **단일 파일만 보면 나올 수 없는** 지적으로, #61 의 크로스파일 컨텍스트가 실제로 값을 만든 증거다.

**반면 소형 인프라 PR(#63)에서는 정밀도가 낮았고, 오탐 2건 모두 컨텍스트 공백이 직접 원인이었다.**

| #63 오탐 | 원인(리뷰어 자체 진술) | 놓친 컨텍스트 |
|---|---|---|
| cancel-publishes-partial (P1) | "downstream이 성공으로 받는다"고 추정 | **호출자** `harbor.server.ts` 의 `awaiting_chat` 상태 가드 |
| investigated_safe 미강제 (P1) | "mergeGroupResults is not shown in the snapshot" | **같은 파일의 미변경 헬퍼** `mergeGroupResults` |

즉 #61 의 크로스파일 해석은 **변경 코드가 import 하는 정의**는 당겨오지만, ①**같은 파일의 미변경 영역**과
②**변경된 export를 부르는 호출자**는 컨텍스트에 넣지 않는다. 소형 PR은 policy도 0이라 근거가 더 얇았다.

> 사용자 원칙(리콜 우선, 오탐은 고치며 걸러냄)에 비추면 이 오탐들은 허용 범위지만, 원인이 **구조적 컨텍스트
> 공백**이라 아래 두 가지로 값싸게 줄일 수 있다.

## 4. 후속 제안 (우선순위)

### ✅ P1. 변경 파일의 **전체 본문**을 컨텍스트에 첨부 — **완료 (#66 `a0acbf0e`, 배포됨)**
- **근거:** #63 investigated_safe 오탐 — 리뷰어가 같은 파일의 `mergeGroupResults` 를 못 봄.
- **구현:** `chat-prompt.ts` `buildHunkContext` + `context-slice.ts` `fullFileContext`. 변경 파일의 head
  전체 본문을 라인번호 gutter 포함으로 첨부. `ASHLAR_CONTEXT_FULL_FILES=0` 로 opt-out.
- **예산 처리(2단계):**
  - **fast path** — 변경 파일 전체 본문 합이 예산(기본 20만 자) 안에 들면 **전부 통째로** 첨부. 실사용 PR
    대부분이 여기에 해당하며, 이 경로가 정확·최적이다.
  - **constrained path** — 합이 예산을 넘는 초대형 PR에서만 진입. hunk 창으로 degrade하는 **best-effort**
    이며, 최악이라도 **P1 이전(hunk 창)과 동일** — 더 나빠지지 않는다.
- **검증:** ashlar 수렴 루프 **6라운드**로 강화. 각 라운드가 constrained path의 예산 배분 엣지를 짚었고
  최종적으로 fast path + 공정 배분 + no-drop 재시도 + fixpoint 업그레이드로 정리. 전체 테스트 858 통과, CI 초록.
- **알려진 한계(수용):** constrained path(변경 총량 20만 자↑ 또는 파일 100개↑의 초대형 PR)에서 한 파일의
  **주변 코드**만 덜 보일 수 있음. diff·변경 라인은 항상 온전. 크래시·오작동·오리뷰 없음. best-effort로 문서화.
- **관측:** P1은 "변경 라인 밖" 지적을 늘려 인라인 앵커 실패(본문 표시) 비율을 올린다. 이는 GitHub이 diff
  라인에만 인라인 코멘트를 허용하기 때문(트레이드오프). 별도 모니터링 대상 — 이 문서엔 항목화하지 않음.

### P2. 변경된 **export의 직접 호출자**를 크로스파일 컨텍스트에 포함 (역-import 1홉)
- **근거:** #63 cancel 오탐 — 리프 함수 계약 변경을 판단하며 호출자의 가드를 못 봄.
- **내용:** #61 `import-resolve.ts` 는 의존(정의)을 따라가는데, 변경된 export 심볼에 한해 **역방향 1홉**
  (그 심볼을 부르는 파일들)을 추가로 첨부.
- **비용:** 심볼 참조 검색 1회/변경 export. 홉 수·파일 수 상한으로 fan-out 제한.
- **적용부:** `import-resolve.ts`(역방향 인덱스) + `context-slice.ts`(첨부).
- **위험:** 중간(컨텍스트 증가·검색 비용) → 상한과 예산으로 제한, 대형 PR은 자동 degrade.

### P3. policy 추출 점검 (관측: ashlar 레포에서 policy 0)
- **근거:** #63 policy 0 vs #269 policy 6K~33K. ashlar 레포에 정책 문서가 없어서인지, 추출기가 특정
  레이아웃만 인식하는지 확인.
- **내용:** policy 소스 탐색 경로/우선순위를 로그로 남겨 "정책 없음"과 "추출 실패"를 구분.
- **위험:** 낮음(가시성).

## 5. 비목표 / 주의

- 프롬프트 **의미**·제출·수렴·스키마 병합은 변경하지 않는다(#61/#62 경계 유지, `BOUNDARY.md`).
- ~~정밀도는 리콜을 희생하지 않는 선에서만 올린다~~ → 2026-11-04 변경: Settings "Finding precision"(기본 켜짐)에서
  근거가 증명되지 않은 파인딩은 게시하지 않는다(§8). `findingGate=off` 이면 이전 계약(변경 코드 파인딩은 버리지 않음).
- 단일 레포·소표본이므로, 적용 후 같은 수렴-루프 계측(context/policy/파인딩·오탐)으로 재평가한다.

## 6. 다음 단계

1. ~~P1(전체 본문 첨부) 구현~~ → **완료 (#66, 배포됨).**
2. **P2(역-import 호출자 첨부)** — P1 효과를 같은 수렴-루프 계측으로 측정한 뒤 착수.
3. **P3(policy 추출 점검)** — 저비용, 가시성 개선. 언제든.
4. 계측 유지: 각 수렴 루프의 `context/policy/findings/오탐`을 이 문서 표에 계속 누적.
3. P2(역-import) 는 P1 효과 측정 후 착수.

## 7. 2026-11 리뷰 입력 컨텍스트 보강 (오탐 감소 작업 A)

오탐 측정(2026-11-03..04, 판정 18건 중 17건 오탐)의 원인 중 "리뷰어가 근거를 못 본" 부분을 입력 쪽에서 막는다.
판정·게이트(finding-gate)와 게시 쪽은 별도 작업이다.

- **PR 설명:** 모든 트리거에서 스냅샷의 실제 PR 본문(`SamplePr.body`)을 `UNTRUSTED_PR_DESCRIPTION` 블록(6,000자,
  마커 무력화, HTML 주석 제거, 데이터 표시)으로 보낸다. 이전엔 코멘트 트리거의 "PR body" 블록이 코멘트 자체였고
  (`/review`), 로컬 루프는 800자에서 잘랐다.
- **모듈 문서:** 정책 체인에 `CLAUDE.md` 를 `AGENTS.md` 옆에 추가(BASE 읽기 유지). PR이 고친 정책 문서는 두 번
  읽는다: BASE 본문은 `SamplePr.basePolicyFiles`(정책 권위), HEAD 본문은 다른 변경 파일처럼 `files`(픽스 에이전트도
  PR의 본문을 편집 — 이전엔 변경된 AGENTS.md 의 BASE 본문이 편집 대상이었다). 변경된 문서·설정·테스트(rank 1-3)는
  스냅샷의 `CHANGED_NON_CODE_FILES` 섹션(PR 작성 데이터, 정책 아님)으로 첨부. 로컬 루프의 각 그룹도 PR 전체의 문서를 본다.
- **정책 예산 공정 배분(P3 관련):** 가까운 모듈 문서부터 변경 영역별 라운드로빈, 루트는 마지막, 파일별 공정 몫
  (`extractReviewPolicy`: 리뷰 규칙 섹션 우선, 그다음 파일 머리) 후 남는 예산을 가까운 순으로 재배분. 동일 본문
  CLAUDE.md/AGENTS.md 는 한 번만.
- **P2(호출자) 일부 구현:** 변경된 export 함수/메서드/클래스의 호출 위치를 스냅샷이 이미 가진 HEAD 텍스트(변경
  파일 + 참조 모듈)에서 찾아 `CALL_SITES` 섹션으로 첨부(심볼 12개·심볼당 3곳·12K, 운영 코드 먼저, 네트워크 없음).
  저장소 전체 역-import 인덱스는 여전히 백로그.
- **리뷰어 지시:** 인용으로 증명된 결함만, 미검증·조건부·추정 금지, 문서화된 의도 설계는 결함 아님, 동시성은 독립
  커밋 경로 2개 인용, P0/P1은 닫힌 실패 경로만, 문서·i18n·스타일·로그 문구·테스트 조언은 파인딩 아님, 자기 결론이
  "안전"인 파인딩 삭제, diff 관련 주장은 diff로 확인. 로컬 루프의 "미검증 의존성을 evidence에 적고 보고하라"
  지시는 삭제.

## 8. 2026-11 판정 게이트·게시 규칙·회귀 평가 (오탐 감소 작업 B–E)

Settings "Finding precision"(`findingGate`, `findingP1ClosedPath`, `findingNotes`, `findingDedupePrior`,
`postLatestHeadOnly`; 모두 Settings 화면에서 조작, `settings-rules.ts` 검증)으로 켜고 끈다.

- **판정 게이트(`src/lib/finding-gate.ts`, 결정적):** 모든 리뷰어 레그가 `poster.gateLiveSubmission` 에서 통과.
  이전 파인딩 반복·자기 철회·diff가 반박하는 주장·같은 응답의 coverage/investigated_safe가 반박·미검증 전제 인정·
  제목 자체가 가능성("may/might/could")·HEAD에 없는 인용은 버린다. 문서/i18n/스타일/로그 문구/테스트 조언은
  "Notes (not findings)" 로(집계·인라인·REQUEST_CHANGES 없음), 닫힌 경로 없는 P0/P1은 P2로. 텍스트는 바꾸지 않는다.
- **게시:** 게시 직전 HEAD 재확인(이동했으면 게시 안 함), push 가 옛 HEAD 리뷰를 취소, 같은 HEAD 재리뷰가 새 파인딩
  없으면 게시 안 함, 이전 파인딩만 남으면 clean(total=0) 리뷰 대신 건너뜀. `/review-loop` 단계는 이전 파인딩과
  대조하지 않는다(루프는 고쳐지지 않은 파인딩을 새 HEAD에서 다시 봐야 한다).
- **회귀 평가(E):** `npm run eval:precision [fixture]` — 같은 케이스를 게이트 off(=기존 게시)와 기본 Settings로 돌려
  label 세트별 valid 유지/손실, 오탐 유지/제거, 제거율, 케이스별 action·사유를 출력. 커밋된 픽스처는 합성
  (`tests/review/fixtures/finding-precision/synthetic.json`, 테스트가 오탐 제거율 ≥80%·valid 손실 0 을 고정).
  비공개 레포 데이터셋은 레포 밖에서 경로/`ASHLAR_EVAL_FIXTURES` 로만 읽고 결과·본문을 커밋하지 않는다.
- **남은 갭(모델 refute 패스 또는 입력 컨텍스트로):** 문서화된 의도 설계(아웃박스 재시도용 throw, forward-only
  마이그레이션)가 다른 모듈 문서에만 적힌 경우, 단일 트랜잭션 안의 가짜 경쟁, 사실 오류(코드가 이미 처리하는데
  "처리 안 함"), "risking/without verifying" 식의 범위 밖 추측. `findingGate=refute` 는 아직 `rules` 와 같다.

