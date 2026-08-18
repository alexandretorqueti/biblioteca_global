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
#   1. Build das imagens api/web NO HOST bazzite (o código deste repo é
#      visível lá via /var/mnt/...; no sandbox não há Docker).
#   2. Recria os containers biblioteca-global-{api,web} preservando as envs
#      atuais (mesmo padrão do scripts/recriar-api.cjs). NÃO toca no MySQL.
#   3. Healthcheck (web /health + api respondendo). Se falhar, faz ROLLBACK
#      para as imagens anteriores e sai ≠ 0.
# ============================================================================
set -euo pipefail

# --- Config -----------------------------------------------------------------
HOST_ADDR="192.168.1.16"
SSH_USER="alexandre"
SSH_KEY="/root/.ssh/id_ed25519"
REPO_HOST="/var/mnt/42798d48-3976-4c4a-a73a-2d3f75b1cd99/home/alexandrebragatorqueti/projetos/agentes/bibliotecaglobal/project/biblioteca-global"
NET="biblioteca-global_default"
API="biblioteca-global-api"; API_HOST_PORT=3003; API_PORT=3001
WEB="biblioteca-global-web"; WEB_HOST_PORT=5174; WEB_PORT=80
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

# --- 2) Build das imagens no host -------------------------------------------
ssh_host bash -s -- "$TAG" "$REPO_HOST" <<'REMOTE'
set -eu
TAG="$1"; REPO="$2"
cd "$REPO"
echo "[deploy][host] build api..."
docker build -q -t "biblioteca-global-api:$TAG" -f apps/api/Dockerfile .
echo "[deploy][host] build web..."
docker build -q -t "biblioteca-global-web:$TAG" -f apps/web/Dockerfile .
REMOTE
echo "[deploy] imagens buildadas: biblioteca-global-{api,web}:$TAG"

# --- 3) Preserva imagens atuais (rollback) + envs (sem imprimir valores) ----
OLD_API_IMAGE=$(ssh_host "docker inspect $API --format '{{.Config.Image}}'" 2>/dev/null || echo "")
OLD_WEB_IMAGE=$(ssh_host "docker inspect $WEB --format '{{.Config.Image}}'" 2>/dev/null || echo "")
ssh_host bash -s -- "$API" "$WEB" <<'REMOTE'
set -u
umask 077
API="$1"; WEB="$2"
docker inspect "$API" --format '{{range .Config.Env}}{{println .}}{{end}}' > /tmp/.deploy-env-api 2>/dev/null || : > /tmp/.deploy-env-api
docker inspect "$WEB" --format '{{range .Config.Env}}{{println .}}{{end}}' > /tmp/.deploy-env-web 2>/dev/null || : > /tmp/.deploy-env-web
REMOTE

# --- 4) Recria api + web (MySQL intocado) ------------------------------------
ssh_host bash -s -- "$TAG" "$NET" "$API" "$API_HOST_PORT" "$API_PORT" "$WEB" "$WEB_HOST_PORT" "$WEB_PORT" <<'REMOTE'
set -eu
TAG="$1"; NET="$2"; API="$3"; API_HP="$4"; API_P="$5"; WEB="$6"; WEB_HP="$7"; WEB_P="$8"
docker rm -f "$API" "$WEB" >/dev/null 2>&1 || true
docker run -d --name "$API" --network "$NET" --network-alias api \
  --restart unless-stopped -p "$API_HP:$API_P" \
  --env-file /tmp/.deploy-env-api "biblioteca-global-api:$TAG" >/dev/null
docker run -d --name "$WEB" --network "$NET" \
  --restart unless-stopped -p "$WEB_HP:$WEB_P" \
  --env-file /tmp/.deploy-env-web "biblioteca-global-web:$TAG" >/dev/null
REMOTE
echo "[deploy] containers recriados com a tag $TAG"

# --- 5) Healthcheck ----------------------------------------------------------
# web: nginx /health; api: qualquer resposta HTTP (entrypoint roda migrations
# antes de servir — por isso mais tentativas).
if wait_http "http://$HOST_ADDR:$WEB_HOST_PORT/health" 20 "web" \
   && wait_http "http://$HOST_ADDR:$API_HOST_PORT/api/auth/me" 30 "api"; then
  ssh_host "rm -f /tmp/.deploy-env-api /tmp/.deploy-env-web" || true
  echo "[deploy] SUCESSO — biblioteca-global $TAG no ar (api :$API_HOST_PORT, web :$WEB_HOST_PORT)"
  exit 0
fi

# --- 6) Rollback --------------------------------------------------------------
echo "[deploy] FALHOU — revertendo para ${OLD_API_IMAGE:-?} / ${OLD_WEB_IMAGE:-?}" >&2
if [ -n "$OLD_API_IMAGE" ] && [ -n "$OLD_WEB_IMAGE" ]; then
  ssh_host bash -s -- "$OLD_API_IMAGE" "$OLD_WEB_IMAGE" "$NET" "$API" "$API_HOST_PORT" "$API_PORT" "$WEB" "$WEB_HOST_PORT" "$WEB_PORT" <<'REMOTE' || true
set -eu
OLD_API="$1"; OLD_WEB="$2"; NET="$3"; API="$4"; API_HP="$5"; API_P="$6"; WEB="$7"; WEB_HP="$8"; WEB_P="$9"
docker rm -f "$API" "$WEB" >/dev/null 2>&1 || true
docker run -d --name "$API" --network "$NET" --network-alias api \
  --restart unless-stopped -p "$API_HP:$API_P" \
  --env-file /tmp/.deploy-env-api "$OLD_API" >/dev/null
docker run -d --name "$WEB" --network "$NET" \
  --restart unless-stopped -p "$WEB_HP:$WEB_P" \
  --env-file /tmp/.deploy-env-web "$OLD_WEB" >/dev/null
REMOTE
  echo "[deploy] rollback executado (imagens anteriores restauradas)" >&2
fi
ssh_host "rm -f /tmp/.deploy-env-api /tmp/.deploy-env-web" || true
exit 1
