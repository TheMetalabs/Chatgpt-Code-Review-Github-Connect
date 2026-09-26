#!/usr/bin/env bash
# Deploy the Ashlar server (pm2 app "ashlar") from the live checkout — the ONLY supported way.
#
#   scripts/deploy-server.sh                      deploy origin/main (checkout main, fast-forward)
#   scripts/deploy-server.sh --from-ref <ref>     predeploy a PR head (e.g. origin/ai/fix/x), detached
#   scripts/deploy-server.sh --revert             same as the default: back to origin/main
#   scripts/deploy-server.sh --check              run the gates only, change nothing
#
# Gates (docs/review-loop-runbook.md): no PR at FIXING (npm run loop:fixing exit 0), no live harbor
# job and the Chrome worker reports activeJobs 0. They run before AND right before the restart; any
# failure exits non-zero before the checkout or pm2 is touched (a hand-built `a && b; c` chain once
# restarted mid-round). Env: ASHLAR_LOOP_REPOS (repos the loop runs on), ASHLAR_HARBOR_URL,
# ASHLAR_PM2_CONFIG, ASHLAR_DEPLOY_WAIT_S (how long to wait for idle, default 1800).
set -euo pipefail

HARBOR=${ASHLAR_HARBOR_URL:-http://127.0.0.1:18080/api/harbor}
PM2_CONFIG=${ASHLAR_PM2_CONFIG:-/Users/ai/work/tools/ashlar.pm2.config.cjs}
REPOS=${ASHLAR_LOOP_REPOS:-TheMetalabs/aicc-center,TheMetalabs/Chatgpt-Code-Review-Github-Connect}
WAIT_S=${ASHLAR_DEPLOY_WAIT_S:-1800}
ref=origin/main; check_only=0

while [ $# -gt 0 ]; do
  case "$1" in
    --from-ref) ref=${2:?--from-ref needs a ref}; shift 2 ;;
    --revert) ref=origin/main; shift ;;
    --check) check_only=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "deploy-server: unknown argument $1" >&2; exit 64 ;;
  esac
done

cd "$(dirname "$0")/.."

# 0 live harbor jobs and a worker with activeJobs 0; prints why not.
idle() {
  curl -fsS -m 10 "$HARBOR" | python3 -c '
import json, sys
d = json.load(sys.stdin)
live = [j["id"] for j in d.get("jobs") or [] if j.get("status") not in ("posted","cancelled","failed","skipped","completed")]
w = (d.get("bridge") or {}).get("workerStatus") or {}
active = w.get("activeJobs")
if live or (active not in (None, 0)):
    print(f"busy: live jobs {live} worker activeJobs {active}"); sys.exit(1)'
}

gates() {
  ASHLAR_LOOP_REPOS="$REPOS" npm run -s loop:fixing
  local deadline=$((SECONDS + WAIT_S))
  until idle; do
    [ $SECONDS -lt $deadline ] || { echo "deploy-server: not idle within ${WAIT_S}s" >&2; exit 3; }
    sleep 30
  done
}

git fetch -q origin
git rev-parse --verify -q "$ref^{commit}" >/dev/null || { echo "deploy-server: unknown ref $ref" >&2; exit 64; }
gates
[ "$check_only" = 1 ] && { echo "deploy-server: gates pass"; exit 0; }
# Right before the restart: the state may have changed while waiting for idle.
ASHLAR_LOOP_REPOS="$REPOS" npm run -s loop:fixing
idle

git checkout -q -- package-lock.json src/routeTree.gen.ts 2>/dev/null || true
if [ "$ref" = origin/main ]; then
  git checkout -q main
  git merge -q --ff-only origin/main
else
  git checkout -q --detach "$ref"
fi
# env -i: an inherited XPC_FLAGS breaks DNS in the pm2 child.
env -i PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin HOME="$HOME" USER="$USER" \
  pm2 restart "$PM2_CONFIG" --only ashlar --update-env >/dev/null
for _ in $(seq 1 60); do curl -fsS -m 5 "$HARBOR" >/dev/null 2>&1 && break; sleep 3; done
echo "deploy-server: deployed $(git rev-parse --short HEAD) ($ref)"
