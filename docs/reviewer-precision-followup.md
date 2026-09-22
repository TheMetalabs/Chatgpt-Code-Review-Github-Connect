# 리뷰어 정밀도 후속 제안 (#61 컨텍스트 tailoring 사후 평가)

> 상태: **제안(proposal)** — 구현 전 합의용. 근거는 아래 수렴 루프 누적 데이터.
> 관련: #61 (per-reviewer context tailoring: cross-file + policy), #62/#63 (로컬 레그 큐/중단·부분 살리기), #64 (테스트 경계·CI).

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

### P1. 변경 파일의 **전체 본문**을 컨텍스트에 첨부 (diff hunk만이 아니라)
- **근거:** #63 investigated_safe 오탐 — 리뷰어가 같은 파일의 `mergeGroupResults` 를 못 봄.
- **내용:** 각 변경 파일의 현재 head 전체 본문을 컨텍스트에 포함(현재는 diff hunk + 크로스파일 정의 위주).
- **예산:** 대형 PR(#269: context 189K)에서 토큰 폭증 위험 → **버짓 내에서만** 첨부하고 초과 시 hunk+정의로
  degrade. 오탐이 난 소형 PR은 버짓이 넉넉해 정확히 이 경우를 커버한다.
- **적용부:** `context-slice.ts` / `chat-prompt.ts` (변경 파일 본문 슬라이스), 로컬은 이미 `readFileAtHead`
  로 on-demand 가능하나 **같은 파일 미변경 영역**은 스냅샷에 있으니 첨부 우선.
- **위험:** 낮음(추가 컨텍스트). 예산 초과 degrade 경로만 테스트.

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
- 정밀도는 리콜을 희생하지 않는 선에서만 올린다 — 오탐 감소가 목표지 파인딩 억제가 아니다.
- 단일 레포·소표본이므로, 적용 후 같은 수렴-루프 계측(context/policy/파인딩·오탐)으로 재평가한다.

## 6. 다음 단계

1. 본 제안 합의 → P1(전체 본문 첨부) 먼저 구현 + 예산 degrade 테스트.
2. 계측 유지: 각 수렴 루프의 `context/policy/findings/오탐`을 이 문서 표에 계속 누적.
3. P2(역-import) 는 P1 효과 측정 후 착수.
