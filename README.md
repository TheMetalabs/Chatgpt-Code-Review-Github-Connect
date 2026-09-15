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

[GitHub → Settings → Developer settings → GitHub Apps → New GitHub App](https://github.com/settings/apps/new)

**Webhook**

- URL: `https://<터널-호스트>/api/webhook` (로컬만 켜 두면 GitHub가 못 칩니다)
- Secret: 아무 긴 문자열. Settings에 같은 값을 넣습니다

**권한**

| Permission | Access |
| --- | --- |
| Pull requests | Read & write |
| Contents | Read-only |
| Issues | Read & write |
| Metadata | Read-only |

Issues Write는 웹훅을 읽었을 때 Codex처럼 👀 / 👍 / 😕 리액션을 달기 위한 것입니다.

**Subscribe to events**

- `Pull request`
- `Issue comment`
- `Pull request review comment`

저장 후 **App ID**와 **Generate a private key**로 받은 PEM을 받습니다. 앱을 리뷰할 저장소에 **Install** 합니다.

### Settings에 넣기

Ashlar → Settings → **GitHub App**

1. App ID
2. Webhook secret
3. Private key PEM
4. **Save GitHub credentials**

저장하면 시크릿은 이 머신 `.data/ashlar-secrets.json` (권한 0600)에만 남고, 화면 입력칸은 비워집니다. GET API로 키가 다시 내려오지 않습니다. 칸을 비워 두면 환경 변수 폴백입니다.

```bash
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----..."
GITHUB_WEBHOOK_SECRET=...
```

램프가 `set (ui)` 또는 `set (env)` 이면 준비된 것입니다.

로컬에서 웹훅을 받으려면 터널을 앱 URL과 맞춥니다.

```bash
# 예: cloudflared
cloudflared tunnel --url http://127.0.0.1:8080
```

나온 `https://….trycloudflare.com/api/webhook` 을 GitHub App Webhook URL에 넣습니다. Ashlar와 터널을 둘 다 켜 둔 채로 PR을 올립니다.

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
2. GitHub App 램프 세 개가 set인지
3. 쓸 리뷰어 토글과 브릿지/로컬 LLM이 준비됐는지
4. 앱이 설치된 저장소에 PR을 열거나 푸시

Inbox에 `hmac ok` 202가 보여야 합니다. Jobs가 `awaiting_chat`이면 브릿지가  comms 중이고, `posted`면 GitHub Reviews에 코멘트가 올라간 것입니다.

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

| 증상 | 볼 곳 |
| --- | --- |
| 웹훅 503 `webhook secret unset` | Settings에 웹훅 시크릿을 저장했거나 env가 있는지 |
| 403 HMAC mismatch | GitHub App secret과 Settings 값이 같은지. 터널 HTTPS인지 |
| Jobs가 안 생김 | Inbox skip 이유. draft/fork/중복 delivery |
| `awaiting_chat`에서 멈춤 | 확장 origin·토큰, ChatGPT/Grok 로그인, 쿼타 |
| 로컬 LLM만 켜고 skipped | model / base_url, Playground Ask local LLM |
| 코멘트가 안 달림 | Pull requests write 권한, App install, `posted` vs `dlq` |

```bash
npm test
npm run typecheck
```

데모만 보려면 Home에서 **Sync #412 (post)** 테이프를 돌리면 됩니다.
