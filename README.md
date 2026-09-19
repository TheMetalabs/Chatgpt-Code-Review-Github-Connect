# Ashlar

로컬에서 도는 GitHub PR 리뷰 봇입니다. ChatGPT API나 Codex, Grok Build 토큰을 쓰지 않습니다.

PR이 오면 이 머신이 diff를 받고, 켜 둔 리뷰어가 **같은 스냅샷을 서로 다른 세션에서** 본 뒤, 설정한 순서로 false-positive만 검수해서 GitHub Review로 올립니다.

```
GitHub webhook
    → Ashlar (이 머신)
        → Chrome 브릿지 → 이미 로그인된 ChatGPT / Grok 탭
        → Local LLM (폴백: 브릿지/쿼타가 안 되면. 로컬만 켜면 즉시)
    → 순서대로 FP 검수 (기본: Local → ChatGPT → Grok)
    → GitHub PR 코멘트
```

---

## 필요한 것

- Node.js 20+
- Chrome (ChatGPT / Grok을 쓸 때)
- GitHub App (실제 PR에 달 때)
- 로컬 웹훅을 GitHub가 칠 수 있게 Cloudflare Tunnel 또는 ngrok 같은 터널

데모 테이프만 돌려보려면 GitHub App과 확장은 나중에 해도 됩니다.

---

## 실행

```bash
npm install
npm run dev
```

브라우저에서 `http://127.0.0.1:8080` 을 엽니다.

| 화면 | 하는 일 |
| --- | --- |
| Home | 데모 테이프. 실제 GitHub 없이 파이프라인 확인 |
| Inbox | 웹훅 로그 |
| Jobs | 리뷰 작업. 브릿지가 안 잡으면 여기 JSON 붙여넣기 |
| Playground | 샘플 diff로 ChatGPT / Grok / Local LLM 시험 |
| Settings | GitHub App, 리뷰 토글, FP 순서, 로컬 LLM, 브릿지 |

---

## 1. GitHub App

OAuth App, Fine-grained PAT, 저장소 Webhooks 페이지는 쓰지 않습니다. **GitHub App 하나**만 만듭니다.

개인 계정: [github.com/settings/apps/new](https://github.com/settings/apps/new)

조직: `https://github.com/organizations/<org>/settings/apps/new`

### Identifying and authorizing users

비워 둡니다. Callback URL, Expire user authorization tokens, Request user authorization 전부 **Ashlar에 필요 없습니다.** (설치 토큰만 씁니다.)

### Webhook

- **Active**: 켜기
- **Webhook URL**: `https://<your-tunnel-host>/api/webhook`  
  실제 도메인은 이 저장소에 적지 마세요. `http://127.0.0.1` 은 GitHub가 못 칩니다. 터널 HTTPS여야 합니다.
- **Webhook secret**: 긴 임의 문자열. Ashlar Settings에 **같은 값**을 넣습니다.
- SSL verification: Enable

저장 전에 아래 권한 → 이벤트 순서로 맞춥니다. 이벤트 목록은 권한에 따라 나타나므로 **권한을 먼저** 고칩니다.

### Repository permissions

GitHub App 페이지의 **Permissions** (Repository permissions). Organization permissions는 전부 No access.

| UI 라벨 | Access | 왜 |
| --- | --- | --- |
| **Contents** | Read-only | PR 파일 / 정책 파일 스냅샷 |
| **Issues** | Read & write | `@ashlar-bot` 댓글 읽기, 👀/👍/😕 리액션, 브릿지 단절 등 운영 상태 코멘트 |
| **Metadata** | Read-only | 자동. 끌 수 없음 |
| **Pull requests** | Read & write | diff, 리뷰 게시 |

그 외 Administration, Checks, Commit statuses, Discussions, Actions 등은 **No access**.

Issues를 Read-only로 두면 리액션이 403입니다. Pull requests Write가 없으면 리뷰 코멘트를 못 올립니다.

### Subscribe to events

Permissions와 **다른 섹션**입니다. 권한을 줬다고 웹훅이 오는 게 아닙니다. 여기 체크한 이벤트만 GitHub가 `POST /api/webhook` 합니다.

**켤 것 (이 세 개만):**

| UI 체크박스 | GitHub `X-GitHub-Event` | Ashlar가 하는 일 |
| --- | --- | --- |
| **Issue comment** | `issue_comment` | PR 대화의 `@ashlar-bot` / `/review` 멘션 |
| **Pull request** | `pull_request` | PR opened / synchronize / ready_for_review |
| **Pull request review comment** | `pull_request_review_comment` | 인라인 리뷰 코멘트 팔로업 |

**켜면 안 되는 것 (이름이 비슷해서 실수하기 쉬움):**

| UI 체크박스 | 이벤트 | 켜면 |
| --- | --- | --- |
| **Issues** | `issues` | 이슈 열림/닫힘. PR 멘션이 **아닙니다.** `@ashlar-bot` 이 안 옵니다. |
| **Pull request review** | `pull_request_review` | 리뷰 Submit. Ashlar는 ignore |
| **Pull request review thread** | `pull_request_review_thread` | 스레드 resolve. 필요 없음 |
| Push, Workflow run, … | 기타 | Inbox만  clutter |

한 줄로: **Issues ≠ Issue comment.** Issues만 켜 두면 ping/installation은 202여도 `@ashlar-bot` 댓글이 절대 안 들어옵니다. 앱 설정 화면에서 체크박스가 `Issue comment` 인지 글자를 확인하세요.

권한을 바꾼 뒤에야 목록에 `Issue comment`가 보입니다. Issues 권한이 No access면 이 체크박스가 없습니다.

### 만들고 나서 받을 값

Create GitHub App 후:

1. **App ID** — 숫자. JWT `iss` 폴백
2. **Client ID** — `Iv23…`. 있으면 JWT `iss`로 이걸 씁니다. Client secret은 **쓰지 않습니다.**
3. **Generate a private key** — `.pem` 파일. 한 번만 내려받음
4. Webhook secret — 위에서 넣은 그 문자열 (GitHub는 다시 보여 주지 않음. 모르면 새로 돌리고 Ashlar에도 다시 저장)

### Install

같은 앱 페이지 **Install App** → 조직 또는 계정.

- 리뷰할 저장소를 **All repositories** 또는 해당 레포만
- 권한/이벤트를 **나중에 바꾸면** 설치 화면에 **Review request / Accept new permissions** 가 뜹니다. 수락하기 전까지 예전 권한으로 동작합니다. 앱 JSON만 고치고 설치를 안 받으면 Inbox는 그대로입니다.

### Settings에 넣기

Ashlar → Settings → **GitHub App** → **Save GitHub credentials**

1. App ID
2. Client ID (`Iv23…`, 있으면)
3. Webhook secret
4. Private key PEM

저장하면 시크릿은 이 머신 `.data/ashlar-secrets.json` (권한 0600)에만 남고, 화면은 마스크됩니다. GET API로 키가 다시 내려오지 않습니다. 칸을 비워 두면 환경 변수 폴백입니다.

리뷰어 토글·로컬 LLM URL/모델/키는 **Save settings** 후 이 머신 gitignore `.env` (`ASHLAR_REVIEW_LOCAL`, `ASHLAR_LOCAL_LLM_*`)와 `.data/ashlar-settings.json`에 남습니다. Chrome 브릿지 토큰은 첫 기동 때 `.env`의 `ASHLAR_BRIDGE_TOKEN`에 저장되고 PM2 재시작 후에도 같습니다. **Rotate token** 만 새로 만듭니다. 이전에 쓰이던 `.data/ashlar-bot-settings.json`도 읽습니다. PM2 재시작은 `.env`를 다시 읽습니다. **Reset demo tape** 는 Inbox 잡만 지웁니다. `.env`는 커밋하지 마세요.

터널 호스트와 자격은 **`.env`에만** 둡니다. `.env`는 gitignore입니다. `.env.example`을 복사하세요.

```bash
cp .env.example .env
```

```
ASHLAR_PUBLIC_HOST=<your-tunnel-host>
ASHLAR_ALLOWED_HOSTS=
GITHUB_APP_ID=
GITHUB_APP_CLIENT_ID=
GITHUB_WEBHOOK_SECRET=
GITHUB_APP_PRIVATE_KEY=
```

실 도메인·App ID·시크릿을 README나 소스에 적지 마세요.

램프가 `set (ui)` 또는 `set (env)` 이면 자격은 준비된 것입니다. Settings의 **Test GitHub API**가 `ok · <앱이름>` 이어야 스냅샷도 됩니다.

로컬에서 웹훅을 받으려면 터널을 `ASHLAR_PUBLIC_HOST`와 맞춥니다.

```bash
cloudflared tunnel --url http://127.0.0.1:8080
```

나온 호스트를 `.env`의 `ASHLAR_PUBLIC_HOST`에 넣고, GitHub App Webhook URL은 `https://<그-호스트>/api/webhook` 입니다. Ashlar와 터널을 둘 다 켜 둔 채로 확인합니다.

### 웹훅이 도는지

1. GitHub App → **Advanced → Recent deliveries** (또는 앱 페이지 Recent deliveries)
2. `ping` 이 200/202
3. 설치된 레포 PR에 `@ashlar-bot review` 댓글
4. deliveries에 `issue_comment` 가 **보여야** 함. `issues` 나 `pull_request_review` 만 있으면 이벤트 구독이 틀린 것
5. Ashlar Inbox: `hmac ok` 202, 멘션이면 Jobs 생성. 댓글에 👀 가 붙으면 읽은 것

재시작하면 Inbox는 메모리라 비워집니다. 멘션은 재시작 **후에** 다시 다세요.

---

## 2. 리뷰어 토글

Settings에서 최대 3개를 켭니다. 하나만 끌 수는 없습니다.

| 토글 | 어떻게 도는지 |
| --- | --- |
| `review_chatgpt` | Chrome이 `chatgpt.com` 임시 채팅에 프롬프트만 넣고 Send |
| `review_grok` | Chrome이 `grok.com` 새 채팅에 넣고 Send |
| `review_local` | 켜면 ChatGPT/Grok과 **같이 경주**. ping 실패면 즉시 스킵 |

ChatGPT / Grok / Local은 Settings에서 켠 것만 병렬로 돕니다. 표현이 달라도 LLM으로 합치지 않습니다. 각 리뷰어 JSON을 **스키마로 합쳐** 인라인 코멘트를 답니다. 아직 답을 쓰는 리뷰어만 기다리고, 벽시계 타임아웃으로 자르지 않습니다.

프롬프트는 **웹 검색 / DeepSearch / URL fetch / 툴 호출을 금지**합니다. 지시문은 짧게 두고, 세 첨부로 붙입니다: `ashlar-diff.patch`(base…head diff), `ashlar-snapshot.md`(변경 hunk를 감싸는 head 코드 + 호출 헬퍼 정의, 라인 번호 포함), `ashlar-policy.md`(리포 리뷰 규칙). 없는 맥락은 `assumptions`에만 적습니다.

### 합산

LLM merge / false-positive 라운드는 없습니다. 끝난 리뷰어 JSON만 스키마로 합칩니다. 같은 파일·라인이면 하나로, 아니면 둘 다 올립니다.

### 첨부 & 예산 (env)

리뷰 입력은 세 첨부로 구성되며, 크기 예산은 env로 조절합니다(기본값):

| env | 기본 | 대상 |
| --- | --- | --- |
| `ASHLAR_PROMPT_DIFF_MAX_CHARS` | 300000 | `ashlar-diff.patch` — 초과 시 낮은 등급 파일부터 통째로 제외(hunk 중간 절단 없음) |
| `ASHLAR_PROMPT_CONTEXT_MAX_CHARS` | 200000 | `ashlar-snapshot.md` — hunk 컨텍스트 총량 |
| `ASHLAR_PROMPT_POLICY_MAX_CHARS` | 32768 | `ashlar-policy.md` — 리뷰 규칙 절 |
| `ASHLAR_CONTEXT_PAD_LINES` | 20 | 경계 탐지 실패 시 hunk 앞뒤 여유 줄 |

롤백 플래그: `ASHLAR_CONTEXT_MODE=head` 는 스냅샷을 예전(파일 앞부분) 방식으로 되돌리고, `ASHLAR_POLICY_ATTACH=0` 은 정책 첨부를 끕니다.

판정은 이진(지적 있음 / `Didn't find any major issues.`)으로 유지됩니다. 커버리지(어떤 변경 파일을 실제로 검토했는지)는 판정을 바꾸지 않고 «review posted» ops 코멘트와 clean 본문의 HTML 코멘트로만 노출됩니다. 정책은 base sha에서 읽어 PR이 자기 리뷰 규칙을 바꾸지 못하게 합니다.

### Local LLM

OpenAI 호환이면 됩니다. Ollama 예:

```
base_url  http://127.0.0.1:11434/v1
model     llama3.1
api_key   (없으면 아무 문자열)
```

Playground의 **Ask local LLM**으로 연결부터 확인하세요.

로컬 레그만 SDK/HTTP 전송이라 **멀티턴 툴 루프**를 돕니다. ChatGPT/Grok은 브라우저 탭이라 계속 1회성입니다.
루프는 파일을 읽고(`file_read`), 다른 변경 파일 diff를 보고(`file_read_diff`), 검색(`code_search`)한 뒤
지적을 근거와 함께 확정합니다. **다른 리뷰어를 막거나 교차 검수하지 않습니다** — 실패하면 기존처럼
`Skipped local` 로 끝나고, 마지막 스키마 합산은 그대로입니다. 이미 도착한 챗봇 결과는 턴 경계에서
«반복 금지» 데이터로 주입하고, 안 왔으면 기다리지 않습니다.

| 설정 / env | 기본 | 뜻 |
| --- | --- | --- |
| `localReviewMode` / `ASHLAR_LOCAL_REVIEW_MODE` | `auto` | `auto` = PR 크기로 자동 선택, `single` = 1회성(롤백), `multiturn` = 툴 루프 |
| `localReviewSingleTurnMaxTokens` / `ASHLAR_LOCAL_REVIEW_SINGLE_TURN_MAX_TOKENS` | 30000 | `auto`에서 이 토큰 이하 프롬프트는 단일턴 유지, 초과는 멀티턴 |
| `localReviewMaxTokens` / `ASHLAR_LOCAL_REVIEW_MAX_TOKENS` | 32768 | 생성 토큰 예산. **필수** — 없으면 서버 기본(~8K)에 추론이 다 차 JSON 전에 잘립니다 |
| `ASHLAR_LOCAL_REVIEW_TEMPERATURE` / `_TOP_P` / `_TOP_K` / `_PRESENCE_PENALTY` | 0.6 / 0.95 / 20 / 1.0 | 비-greedy 샘플링. greedy(0)는 추론 모델을 반복 루프에 빠뜨립니다 |
| `ASHLAR_LOCAL_REVIEW_GROUP_MAX_CHARS` | 40000 | 그룹당 파일 묶음 크기 상한(피크 KV 캐시 메모리 경계) |
| `ASHLAR_LOCAL_REVIEW_MAX_FILES_PER_GROUP` | 6 | 그룹당 최대 파일 수 |
| `ASHLAR_LOCAL_REVIEW_TOOL_ITERS` | 8 | 그룹당 최대 툴 라운드. 초과하면 툴을 빼고 최종 JSON 강제 |
| `ASHLAR_LOCAL_REVIEW_CTX_CAP_TOKENS` | 24000 | 프롬프트가 이 토큰을 넘으면 다음 턴에 최종 JSON 강제 |

기본 `auto`는 작은 PR(프롬프트 ≤ 30K 토큰)은 **단일턴**으로 빠르게 전체를 보고, 큰 PR은 **멀티턴**으로
돌립니다. 단일턴은 한 완성 창에 다 담기고 재현율이 높으며, 큰 PR은 단일 호출 KV 캐시가 치솟으니
그룹으로 나눠 피크 메모리를 낮춥니다. 멀티턴의 변경 파일은 크기로 묶어 **순차** 검토합니다(공유 머신에서
동시 생성 1개로 메모리 경계 유지). thinking은 켜 둡니다(끄면 리뷰가 고무도장이 됩니다). 강제 롤백은
`ASHLAR_LOCAL_REVIEW_MODE=single`.

---

## 3. Chrome 브릿지 (ChatGPT / Grok)

ChatGPT나 Grok을 켜 두면 Ashlar가 이 머신 Chrome에 이미 로그인된 탭을 씁니다. API 키가 아닙니다.

1. Settings → **Download extension**
2. Chrome `chrome://extensions` → 개발자 모드 → **압축해제된 확장 프로그램을 로드합니다** → `extension/` 폴더
3. ChatGPT / Grok에 그 프로필로 로그인
4. 확장 팝업에 Ashlar origin (`http://127.0.0.1:8080`)과 Settings에 보이는 브릿지 토큰을 붙여넣고 저장

램프가 `connected`이면 PR 웹훅이 들어올 때 확장이 잡을 가져갑니다. 잡은 탭을 닫고 다음 리뷰는 새 채팅에서 시작합니다.

### 압축해제 확장 프로그램 업데이트 helper

확장 팝업의 **Update & Reload**를 쓰려면 로컬 helper를 별도로 실행합니다. helper는 임의의 Chrome 확장을 신뢰하지 않으며, 현재 Ashlar 확장의 정확한 ID로 고정해야 합니다.

1. `chrome://extensions`에서 **Ashlar Chat Bridge**의 확장 프로그램 ID를 확인합니다.
2. 같은 ID를 환경 변수로 지정해 helper를 시작합니다.

```bash
ASHLAR_EXTENSION_UPDATER_EXTENSION_ID=<32-character-extension-id> npm run extension:update-helper
```

포트를 바꾸려면 helper의 `ASHLAR_EXTENSION_UPDATE_PORT`와 팝업의 **Local updater port**를 같은 값으로 설정합니다. helper는 `127.0.0.1`에만 바인딩되며, 설정된 Ashlar 확장 ID가 아닌 다른 `chrome-extension://` origin의 status/update/rollback 요청은 거절합니다.

업데이트/롤백 중 팝업을 닫아도 maintenance lock을 시간 만료로 풀지 않습니다. helper가 operation ID와 완료 상태를 저장하므로, 팝업을 다시 열면 기존 작업이 완료됐는지 확인한 뒤 reload를 이어가거나, mutation이 중단됐음이 확인된 경우에만 lock을 해제합니다.

쿼타가 떨어지면 되는 쪽만 쓰고, 둘 다 안 되면 ChatGPT는 약 5시간, Grok(SuperGrok 채팅)은 약 일주일 주기로 다시 시도합니다.

확장이 없거나 실패하면 Jobs 화면에서 JSON을 직접 붙여 넣을 수 있습니다.

---

## 4. 실제 PR 한 번

1. `npm run dev` 와 터널이 켜져 있는지
2. GitHub App 램프가 set인지, Test GitHub API가 ok인지
3. 쓸 리뷰어 토글과 브릿지/로컬 LLM이 준비됐는지
4. 앱이 설치된 저장소에 PR을 열거나 `@ashlar-bot review`

Inbox에 `hmac ok` 202가 보여야 합니다. 멘션 댓글에 👀, 끝나면 👍, 스냅샷/게시 실패면 😕.

Jobs가 `awaiting_chat`이면 브릿지가 통신 중이고, `posted`면 GitHub Reviews에 코멘트가 올라간 것입니다.

PR 본문이나 리뷰 코멘트에 `@ashlar-bot` 또는 `/review` 를 쓰면 멘션 리뷰가 돕니다. 문구는 Settings `mentions`에서 바꿉니다.

포크 PR과 드래프트는 기본 skip입니다. Settings `skip_forks` / `skip_drafts`로 바꿉니다.

---

## 보안

이 저장소는 퍼블릭입니다. **커밋하지 마세요:**

- 터널 / 실서비스 호스트명
- GitHub App ID, Client ID, Client secret
- webhook secret, private key PEM, 설치 토큰
- `.data/`, `.env`, Inbox·Jobs 덤프 (실제 org/repo·delivery id)

자격 증명은 이 머신 Settings 저장(`.data/ashlar-secrets.json`, gitignore) 또는 환경 변수만 씁니다.

- Settings GET는 시크릿을 돌려주지 않습니다. 빈 칸 저장은 기존 값을 유지합니다.
- GitHub 자격 저장은 같은 origin POST만 받습니다. PEM이 아니면 거절합니다.
- PR 본문은 untrusted입니다. 정책 파일(`AGENTS.md`, `code_review.md`)은 **base** ref에서 읽습니다.
- Ashlar를 불특정 공개 웹에 올리지 마세요. 로컬(또는 당신이 통제하는 머신)용입니다.

---

## 자주 막히는 곳

| 증상 | 원인 | 볼 곳 |
| --- | --- | --- |
| 웹훅 503 `webhook secret unset` | 시크릿 미저장 | Settings Webhook secret → Save |
| 403 HMAC mismatch | App secret ≠ Settings 값 | GitHub App secret을 다시 돌리고 양쪽 저장. 터널이 HTTPS인지 |
| ping/installation만 202, `@ashlar-bot` 무반응 | **Issues** 만 구독함 | Subscribe to events에서 **Issue comment** 체크. Issues 체크와 다름 |
| Recent deliveries에 `issue_comment` 자체가 없음 | 이벤트 미구독 또는 권한 미수락 | Issue comment + Issues Read. 조직 설치 **Accept new permissions** |
| Inbox는 202, Jobs `not a mention` | Codex 등 다른 봇 댓글 | 본인이 `@ashlar-bot` 또는 `/review` 를 단 댓글인지 |
| Inbox `ignored event` `pull_request_review` | 리뷰 Submit 이벤트 | 정상. **Pull request review** 구독은 끄세요 |
| `GitHub snapshot failed` / `ENOTFOUND` | Node 시스템 DNS가 `api.github.com` 을 못 찾음 | Settings **Test GitHub API**. Ashlar는 실패 시 1.1.1.1/8.8.8.8 DoH로 IP를 받아 SNI로 붙습니다. 그래도 실패면 프로세스에 HTTPS 자체가 막힌 것 |
| Test GitHub API 401/404 | JWT iss / 키 / 설치 | App ID 또는 Client ID, PEM, Install App, Accept new permissions |
| 👀 가 안 붙음 | Issues Write 없음 또는 토큰 실패 | Issues **Read & write** + Accept new permissions. 리액션은 토큰이 난 뒤에만 붙음 |
| Jobs가 안 생김 | skip | Inbox skip 이유: draft / fork / 중복 delivery / not a mention |
| `awaiting_chat`에서 멈춤 | 브릿지 | 확장 origin·토큰, ChatGPT/Grok 로그인, 쿼타. 재시작 후 브릿지 재연결 |
| 로컬 LLM만 켜고 skipped | 엔드포인트 | model / base_url, Playground Ask local LLM |
| 코멘트가 안 달림 | 게시 권한 | Pull requests **write**, App install 범위, Job `posted` vs `dlq` |

```bash
npm test
npm run typecheck
```

데모만 보려면 Home에서 **Sync #412 (post)** 테이프를 돌리면 됩니다.
