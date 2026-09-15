# Ashlar

로컬에서 도는 GitHub PR 리뷰 봇입니다. ChatGPT API나 Codex, Grok Build 토큰을 쓰지 않습니다.

PR이 오면 이 머신이 diff를 받고, 켜 둔 리뷰어가 **같은 스냅샷을 서로 다른 세션에서** 본 뒤, 설정한 순서로 false-positive만 검수해서 GitHub Review로 올립니다.

```
GitHub webhook
    → Ashlar (이 머신)
        → Local LLM (OpenAI 호환 API, 선택)
        → Chrome 브릿지 → 이미 로그인된 ChatGPT / Grok 탭
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
- **Webhook URL**: `https://<터널-호스트>/api/webhook`  
  `http://127.0.0.1` 은 GitHub가 못 칩니다. 터널 HTTPS여야 합니다.
- **Webhook secret**: 긴 임의 문자열. Ashlar Settings에 **같은 값**을 넣습니다.
- SSL verification: Enable

저장 전에 아래 권한 → 이벤트 순서로 맞춥니다. 이벤트 목록은 권한에 따라 나타나므로 **권한을 먼저** 고칩니다.

### Repository permissions

GitHub App 페이지의 **Permissions** (Repository permissions). Organization permissions는 전부 No access.

| UI 라벨 | Access | 왜 |
| --- | --- | --- |
| **Contents** | Read-only | PR 파일 / 정책 파일 스냅샷 |
| **Issues** | Read & write | `@ashlar-bot` 댓글 읽기 + 👀/👍/😕 리액션 |
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

```bash
GITHUB_APP_ID=123456
GITHUB_APP_CLIENT_ID=Iv23…
GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----..."
GITHUB_WEBHOOK_SECRET=...
```

램프가 `set (ui)` 또는 `set (env)` 이면 자격은 준비된 것입니다. Settings의 **Test GitHub API**가 `ok · <앱이름>` 이어야 스냅샷도 됩니다.

로컬에서 웹훅을 받으려면 터널을 앱 URL과 맞춥니다.

```bash
cloudflared tunnel --url http://127.0.0.1:8080
```

나온 `https://….trycloudflare.com/api/webhook` 을 GitHub App **Webhook URL**에 넣습니다. Ashlar와 터널을 둘 다 켜 둔 채로 확인합니다.

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
| `review_local` | 이 프로세스가 OpenAI SDK로 지정한 엔드포인트를 호출 |

둘 이상 켜면 **1라운드는 병렬**입니다. 두 모델 이상이 같은 파일·라인(또는 같은 제목)을 말하면 그대로 남깁니다. 한쪽만 말한 항목만 false-positive 파이프라인으로 갑니다.

### FP 순서

기본값: **Local LLM → ChatGPT → Grok**

Settings에서 Up/Down으로 바꿉니다. 앞 단계가 keep하면 뒤는 그 항목을 다시 보지 않습니다. drop하면 버립니다. 아무 말도 없으면 다음 검사기가 봅니다. 끝까지 남은 한쪽 지적은 버리지 않고 PR에 올립니다.

교차검증(서로가 서로를 전부 다시 보기)은 하지 않습니다. 토큰을 아끼려고 한 방향 순서입니다.

### Local LLM

OpenAI 호환이면 됩니다. Ollama 예:

```
base_url  http://127.0.0.1:11434/v1
model     llama3.1
api_key   (없으면 아무 문자열)
```

Playground의 **Ask local LLM**으로 연결부터 확인하세요.

---

## 3. Chrome 브릿지 (ChatGPT / Grok)

ChatGPT나 Grok을 켜 두면 Ashlar가 이 머신 Chrome에 이미 로그인된 탭을 씁니다. API 키가 아닙니다.

1. Settings → **Download extension**
2. Chrome `chrome://extensions` → 개발자 모드 → **압축해제된 확장 프로그램을 로드합니다** → `extension/` 폴더
3. ChatGPT / Grok에 그 프로필로 로그인
4. 확장 팝업에 Ashlar origin (`http://127.0.0.1:8080`)과 Settings에 보이는 브릿지 토큰을 붙여넣고 저장

램프가 `connected`이면 PR 웹훅이 들어올 때 확장이 잡을 가져갑니다. 잡은 탭을 닫고 다음 리뷰는 새 채팅에서 시작합니다.

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

- GitHub private key, 웹훅 시크릿, 로컬 LLM 키는 `.data/`에만 있습니다. 커밋하지 마세요 (`.gitignore`에 포함).
- Settings GET는 시크릿을 돌려주지 않습니다. 빈 칸 저장은 기존 값을 유지합니다.
- GitHub 자격 저장은 같은 origin POST만 받습니다. PEM이 아니면 거절합니다.
- PR 본문은 untrusted입니다. 정책 파일(`AGENTS.md`, `code_review.md`)은 **base** ref에서 읽습니다.
- Ashlar를 공개 웹에 올리지 마세요. 로컬(또는 당신이 통제하는 머신)용입니다.

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
| `GitHub snapshot failed` / `ENOTFOUND` | Node가 `api.github.com` 을 못 찾음 | Settings **Test GitHub API**. `curl -I https://api.github.com` 은 호스트 셸 기준이라 프로세스가 Docker면 다를 수 있음 |
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
