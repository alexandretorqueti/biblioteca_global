#!/usr/bin/env bash
# Deploy blue-green da Biblioteca Global.
#
# O script sobe a nova stack em portas próprias, aguarda API/Motor/Web,
# troca os upstreams do Nginx e só então remove a stack anterior. O MySQL é
# compartilhado e nunca é recriado por este fluxo.
set -euo pipefail

REPO_ROOT="${1:?informe a raiz do repositório}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
NGINX_CONTAINER="${NGINX_CONTAINER:-meu-servidor-nginx}"
NGINX_CONFIG="${NGINX_CONFIG:-/home/alexandre/containers/nginx/conf/default.conf}"
NGINX_TEMPLATE="$REPO_ROOT/infra/nginx/biblioteca-global.conf.template"
STATE_FILE="${BLUE_GREEN_STATE_FILE:-/home/alexandre/containers/biblioteca-global/blue-green-state}"
MYSQL_HOST_BLUEGREEN="${BLUE_GREEN_MYSQL_HOST:-host.docker.internal}"
MYSQL_PORT_BLUEGREEN="${BLUE_GREEN_MYSQL_PORT:-3308}"

mkdir -p "$(dirname "$STATE_FILE")"
cd "$REPO_ROOT"
set -a
. ./.env
set +a

wait_http() {
  local url="$1" tries="$2" label="$3" i code
  for i in $(seq 1 "$tries"); do
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || true)
    if [ "$code" != "000" ] && [ -n "$code" ]; then
      echo "[deploy-blue-green] $label OK (HTTP $code)"
      return 0
    fi
    sleep 3
  done
  echo "[deploy-blue-green] $label não respondeu após $tries tentativas" >&2
  return 1
}

slot_values() {
  case "$1" in
    blue)
      NEW_PROJECT="biblioteca-blue"; NEW_API_PORT=3003; NEW_MOTOR_PORT=3010; NEW_WEB_PORT=5174 ;;
    green)
      NEW_PROJECT="biblioteca-green"; NEW_API_PORT=3004; NEW_MOTOR_PORT=3011; NEW_WEB_PORT=5175 ;;
    *) echo "slot inválido: $1" >&2; return 2 ;;
  esac
}

read_active_slot() {
  if [ -s "$STATE_FILE" ]; then
    sed -n 's/^active=//p' "$STATE_FILE" | head -1
    return 0
  fi
  # Migração do deploy legado, que usava nomes fixos e as portas principais.
  if docker inspect biblioteca-global-api >/dev/null 2>&1 || docker inspect biblioteca-global-web >/dev/null 2>&1; then
    echo legacy
  else
    echo none
  fi
}

write_active_slot() {
  local slot="$1" tmp
  tmp="${STATE_FILE}.tmp.$$"
  {
    echo "active=$slot"
    echo "updated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

update_nginx() {
  local web_port="$1" api_port="$2"
  [ -f "$NGINX_TEMPLATE" ] || { echo "template Nginx ausente: $NGINX_TEMPLATE" >&2; return 1; }
  [ -f "$NGINX_CONFIG" ] || { echo "configuração Nginx ausente: $NGINX_CONFIG" >&2; return 1; }

  python3 - "$NGINX_CONFIG" "$NGINX_TEMPLATE" "$web_port" "$api_port" <<'PY'
import os
import sys
from pathlib import Path

config_path, template_path, web_port, api_port = sys.argv[1:]
config = Path(config_path)
template = Path(template_path).read_text(encoding="utf-8")
template = template.replace("__WEB_PORT__", web_port).replace("__API_PORT__", api_port)
current = config.read_text(encoding="utf-8")
start = "# BEGIN BIBLIOTECA-GLOBAL-BLUE-GREEN"
end = "# END BIBLIOTECA-GLOBAL-BLUE-GREEN"
block = template.strip() + "\n"
if start in current and end in current:
    before = current.split(start, 1)[0]
    after = current.split(end, 1)[1]
    updated = before + block + after.lstrip("\n")
else:
    updated = current.rstrip() + "\n\n" + block
tmp = config.with_name(config.name + f".tmp.{os.getpid()}")
tmp.write_text(updated, encoding="utf-8")
os.replace(tmp, config)
PY

  docker exec "$NGINX_CONTAINER" nginx -t
  docker exec "$NGINX_CONTAINER" nginx -s reload
}

active="$(read_active_slot)"
case "$active" in
  blue|legacy) target=green ;;
  green|none) target=blue ;;
  *) echo "estado blue-green inválido: $active" >&2; exit 1 ;;
esac
slot_values "$target"

echo "[deploy-blue-green] ativo=$active; subindo $target em $NEW_PROJECT"
echo "[deploy-blue-green] build das imagens api/web..."
docker compose -p "$NEW_PROJECT" -f "$COMPOSE_FILE" build api web

# A API usa o checkout do host como volume para o Motor. Materialize o dist
# produzido na imagem antes de iniciar a nova stack, como fazia o deploy
# legado, mas usando a imagem do slot novo.
NEW_API_IMAGE="$(docker compose -p "$NEW_PROJECT" -f "$COMPOSE_FILE" images -q api)"
[ -n "$NEW_API_IMAGE" ] || { echo "imagem da API do slot não encontrada" >&2; exit 1; }
MOTOR_DIST_CONTAINER="biblioteca-global-motor-dist-$$"
docker create --name "$MOTOR_DIST_CONTAINER" "$NEW_API_IMAGE" >/dev/null
rm -rf projects/gerenteagentes/motor-v2/dist
docker cp "$MOTOR_DIST_CONTAINER:/app/projects/gerenteagentes/motor-v2/dist" projects/gerenteagentes/motor-v2/
docker rm "$MOTOR_DIST_CONTAINER" >/dev/null
echo "[deploy-blue-green] dist do Motor materializado a partir da imagem $target"

echo "[deploy-blue-green] iniciando $NEW_PROJECT (MySQL compartilhado em $MYSQL_HOST_BLUEGREEN:$MYSQL_PORT_BLUEGREEN)..."
MYSQL_HOST="$MYSQL_HOST_BLUEGREEN" MYSQL_PORT="$MYSQL_PORT_BLUEGREEN" \
  API_HOST_PORT="$NEW_API_PORT" MOTOR_V2_HOST_PORT="$NEW_MOTOR_PORT" WEB_HOST_PORT="$NEW_WEB_PORT" \
  docker compose -p "$NEW_PROJECT" -f "$COMPOSE_FILE" up -d --no-deps api web

cleanup_new() {
  MYSQL_HOST="$MYSQL_HOST_BLUEGREEN" MYSQL_PORT="$MYSQL_PORT_BLUEGREEN" \
    API_HOST_PORT="$NEW_API_PORT" MOTOR_V2_HOST_PORT="$NEW_MOTOR_PORT" WEB_HOST_PORT="$NEW_WEB_PORT" \
    docker compose -p "$NEW_PROJECT" -f "$COMPOSE_FILE" down --remove-orphans || true
}
trap cleanup_new ERR

if ! wait_http "http://127.0.0.1:$NEW_WEB_PORT/health" 30 "web-$target" \
   || ! wait_http "http://127.0.0.1:$NEW_API_PORT/api/auth/me" 40 "api-$target" \
   || ! wait_http "http://127.0.0.1:$NEW_MOTOR_PORT/api/motor/health" 40 "motor-$target"; then
  echo "[deploy-blue-green] nova stack não ficou saudável; tráfego antigo preservado" >&2
  exit 1
fi

echo "[deploy-blue-green] trocando Nginx para $target"
update_nginx "$NEW_WEB_PORT" "$NEW_API_PORT"
trap - ERR

case "$active" in
  legacy)
    docker rm -f biblioteca-global-api biblioteca-global-web >/dev/null 2>&1 || true
    ;;
  blue|green)
    old_project="biblioteca-$active"
    docker compose -p "$old_project" -f "$COMPOSE_FILE" down --remove-orphans || true
    ;;
esac

write_active_slot "$target"
echo "[deploy-blue-green] SUCESSO — ativo=$target web=:$NEW_WEB_PORT api=:$NEW_API_PORT motor=:$NEW_MOTOR_PORT"
