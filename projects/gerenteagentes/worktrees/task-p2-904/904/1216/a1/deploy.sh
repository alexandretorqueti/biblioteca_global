#!/usr/bin/env bash
# Wrapper manual: sincroniza o checkout do host e delega o deploy blue-green.
set -euo pipefail

HOST_ADDR="${DEPLOY_HOST_ADDR:-192.168.1.8}"
SSH_USER="alexandre"
SSH_KEY="/root/.ssh/id_ed25519"
REPO_HOST="${DEPLOY_REPO_HOST:-/home/alexandre/codigofonte/biblioteca-global}"
BASE_BRANCH="${DEPLOY_BASE_BRANCH:-base-desenvolvimento}"
DEPLOY_SCRIPT="projects/gerenteagentes/motor-v2/scripts/deploy-blue-green.sh"

ssh_host() {
  ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
      -o ConnectTimeout=10 "$SSH_USER@$HOST_ADDR" "$@"
}

echo "[deploy] $(date -u '+%F %T') UTC — biblioteca-global blue-green"
ssh_host 'echo ok' >/dev/null
echo "[deploy] acesso ao host $HOST_ADDR OK"

ssh_host bash -s -- "$REPO_HOST" "$BASE_BRANCH" "$DEPLOY_SCRIPT" <<'REMOTE'
set -eu
REPO="$1"; BASE_BRANCH="$2"; DEPLOY_SCRIPT="$3"
export HOME=/home/alexandre
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o UserKnownHostsFile=/home/alexandre/.ssh/known_hosts -o StrictHostKeyChecking=accept-new}"
cd "$REPO"
set -a
. ./.env
set +a
echo "[deploy][host] sincronizando checkout com origin/$BASE_BRANCH..."
if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  echo "[deploy][host] checkout possui alterações locais; deploy abortado" >&2
  git status --short >&2
  exit 1
fi
git fetch origin "$BASE_BRANCH"
git checkout "$BASE_BRANCH"
git reset --hard "origin/$BASE_BRANCH"
docker compose -f docker-compose.yml config --quiet
bash "$REPO/$DEPLOY_SCRIPT" "$REPO"
REMOTE

echo "[deploy] SUCESSO — blue-green concluído"
