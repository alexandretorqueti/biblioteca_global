#!/usr/bin/env bash
# ============================================================================
# deploy.sh — Biblioteca Global
#
# Executado AUTOMATICAMENTE pelo motor GerenteAgentes no fim de cada tarefa
# deste repo (todas as subtarefas verificadas): o motor roda `bash deploy.sh`
# na raiz do repo, timeout de 15 min. exit 0 → tarefa `deployada`;
# exit ≠ 0 → tarefa `finalizada` (o trabalho validado não é desfeito).
#
# O que faz:
#   1. Build das imagens api/web no ServerIA (o Docker roda no host, não no
#      container do agente).
#   2. Recria somente biblioteca-global-{api,web} pelo Docker Compose, sempre
#      com --no-deps. O MySQL também atende ao motor e é intocável neste fluxo.
#   3. Healthcheck (web /health + api respondendo). Se falhar, faz ROLLBACK
#      para as imagens anteriores e sai ≠ 0.
# ============================================================================
set -euo pipefail

# --- Config -----------------------------------------------------------------
HOST_ADDR="${DEPLOY_HOST_ADDR:-192.168.1.8}"
SSH_USER="alexandre"
SSH_KEY="/root/.ssh/id_ed25519"
REPO_HOST="${DEPLOY_REPO_HOST:-/home/alexandre/codigofonte/biblioteca-global}"
API="biblioteca-global-api"; API_HOST_PORT=3003; API_PORT=3001
MOTOR_HOST_PORT=3010
WEB="biblioteca-global-web"; WEB_HOST_PORT=5174; WEB_PORT=80
COMPOSE_FILE="docker-compose.yml"
BASE_BRANCH="${DEPLOY_BASE_BRANCH:-base-desenvolvimento}"
TAG="deploy-$(date -u +%Y%m%d-%H%M%S)"

ssh_host() {
  ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
      -o ConnectTimeout=10 "$SSH_USER@$HOST_ADDR" "$@"
}

# Aguenta resposta HTTP qualquer (até 401) = serviço de pé.
# Obs.: curl imprime "000" E sai não-zero quando não conecta — usar `|| true`
# (não `|| echo 000`, que concatenava "000000" e passava o healthcheck falso).
wait_http() {
  local url="$1" tries="$2" label="$3" i code
  for i in $(seq 1 "$tries"); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || true)
    [ -n "$code" ] || code=000
    if [ "$code" != "000" ]; then
      echo "[deploy] $label OK (HTTP $code)"
      return 0
    fi
    sleep 3
  done
  echo "[deploy] $label não respondeu após $tries tentativas" >&2
  return 1
}

echo "[deploy] $(date -u '+%F %T') UTC — biblioteca-global, tag $TAG"

# --- 1) Acesso ao host ------------------------------------------------------
ssh_host 'echo ok' >/dev/null
echo "[deploy] acesso ao host $HOST_ADDR OK"

# --- 2) Build e recriação pelo Compose no host -------------------------------
OLD_API_IMAGE=$(ssh_host "docker inspect $API --format '{{.Image}}'" 2>/dev/null || echo "")
OLD_WEB_IMAGE=$(ssh_host "docker inspect $WEB --format '{{.Image}}'" 2>/dev/null || echo "")

DEPLOY_RECREATE_OK=1
if ! ssh_host bash -s -- "$REPO_HOST" "$COMPOSE_FILE" "$BASE_BRANCH" <<'REMOTE'
set -eu
REPO="$1"; COMPOSE_FILE="$2"; BASE_BRANCH="$3"
cd "$REPO"
set -a
. ./.env
set +a
echo "[deploy][host] sincronizando checkout com origin/$BASE_BRANCH..."
if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  echo "[deploy][host] checkout possui alterações locais; deploy abortado para não sobrescrevê-las" >&2
  git status --short >&2
  exit 1
fi
git fetch origin "$BASE_BRANCH"
git checkout "$BASE_BRANCH"
git reset --hard "origin/$BASE_BRANCH"
# O Motor é executado a partir do volume do host. Remova somente o artefato
# compilado dele e gere-o a partir do commit agora sincronizado; a imagem Docker
# sozinha não basta porque o bind mount sobrepõe /app no container da API.
rm -rf projects/gerenteagentes/motor-v2/dist
echo "[deploy][host] compilando motor-v2 a partir de origin/$BASE_BRANCH..."
npx tsc --build --force projects/gerenteagentes/motor-v2/tsconfig.json
echo "[deploy][host] validando configuração do Compose..."
docker compose -f "$COMPOSE_FILE" config --quiet
MYSQL_ID_BEFORE=$(docker inspect -f '{{.Id}}' biblioteca-global-mysql)
MYSQL_HEALTH=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' biblioteca-global-mysql)
if [ "$MYSQL_HEALTH" != "healthy" ] && [ "$MYSQL_HEALTH" != "running" ]; then
  echo "[deploy][host] MySQL indisponível antes do deploy: $MYSQL_HEALTH" >&2
  exit 1
fi
echo "[deploy][host] build das imagens api/web..."
docker compose -f "$COMPOSE_FILE" build api web
echo "[deploy][host] recriando somente api/web pelo Compose (--no-deps)..."
docker compose -f "$COMPOSE_FILE" up -d --no-deps --force-recreate api web
MYSQL_ID_AFTER=$(docker inspect -f '{{.Id}}' biblioteca-global-mysql)
[ "$MYSQL_ID_BEFORE" = "$MYSQL_ID_AFTER" ] || {
  echo "[deploy][host] identidade do MySQL mudou durante o deploy" >&2
  exit 1
}
REMOTE
then
  DEPLOY_RECREATE_OK=0
  echo "[deploy] falha durante build/recriação dos containers" >&2
else
  echo "[deploy] imagens buildadas e containers recriados pelo Compose"
fi

# --- 3) Healthcheck ----------------------------------------------------------
# web: nginx /health; api: qualquer resposta HTTP; motor: health próprio.
# O entrypoint roda migrations antes de servir — por isso mais tentativas.
if [ "$DEPLOY_RECREATE_OK" -eq 1 ] \
   && wait_http "http://$HOST_ADDR:$WEB_HOST_PORT/health" 20 "web" \
   && wait_http "http://$HOST_ADDR:$API_HOST_PORT/api/auth/me" 30 "api" \
   && wait_http "http://$HOST_ADDR:$MOTOR_HOST_PORT/api/motor/health" 30 "motor"; then
  ssh_host "rm -f /tmp/.deploy-env-api /tmp/.deploy-env-web" || true
  echo "[deploy] SUCESSO — biblioteca-global $TAG no ar (api :$API_HOST_PORT, web :$WEB_HOST_PORT)"
  exit 0
fi

# --- 4) Rollback --------------------------------------------------------------
echo "[deploy] FALHOU — revertendo para ${OLD_API_IMAGE:-?} / ${OLD_WEB_IMAGE:-?}" >&2
if [ -n "$OLD_API_IMAGE" ] && [ -n "$OLD_WEB_IMAGE" ]; then
  ssh_host bash -s -- "$OLD_API_IMAGE" "$OLD_WEB_IMAGE" "$REPO_HOST" "$COMPOSE_FILE" <<'REMOTE' || true
set -eu
OLD_API="$1"; OLD_WEB="$2"; REPO="$3"; COMPOSE_FILE="$4"
cd "$REPO"
set -a
. ./.env
set +a
docker tag "$OLD_API" biblioteca-global-api:latest
docker tag "$OLD_WEB" biblioteca-global-web:latest
docker compose -f "$COMPOSE_FILE" up -d --no-deps --force-recreate api web
REMOTE
  echo "[deploy] rollback executado (imagens anteriores restauradas)" >&2
fi
exit 1
