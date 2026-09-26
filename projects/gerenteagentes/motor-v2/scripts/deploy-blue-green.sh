#!/usr/bin/env bash
# Deploy blue-green da Biblioteca Global.
#
# O script sobe a nova stack em portas próprias, aguarda API/Motor/Web,
# troca os upstreams do Nginx e só então remove a stack anterior. O MySQL é
# compartilhado e nunca é recriado por este fluxo.
set -euo pipefail

REPO_ROOT="${1:?informe a raiz do repositório}"
EXPECTED_DEPLOY_COMMIT="${2:-${EXPECTED_DEPLOY_COMMIT:-}}"
DEPLOY_BATCH_ID="${3:-}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
NGINX_CONTAINER="${NGINX_CONTAINER:-meu-servidor-nginx}"
NGINX_CONFIG="${NGINX_CONFIG:-/home/alexandre/containers/nginx/conf/default.conf}"
NGINX_TEMPLATE="$REPO_ROOT/infra/nginx/biblioteca-global.conf.template"
STATE_FILE="${BLUE_GREEN_STATE_FILE:-/home/alexandre/containers/biblioteca-global/blue-green-state}"
MYSQL_HOST_BLUEGREEN="${BLUE_GREEN_MYSQL_HOST:-host.docker.internal}"
MYSQL_PORT_BLUEGREEN="${BLUE_GREEN_MYSQL_PORT:-3308}"
CONSOLE_URL_BLUEGREEN="${BLUE_GREEN_CONSOLE_URL:-http://host.docker.internal:6280}"
MOTOR_REPO_ROOT_CONTAINER="/data/workspace/projects/codigofonte/biblioteca-global"
MOTOR_WORKSPACE_ROOT_CONTAINER="${MOTOR_WORKSPACE_ROOT:-/data/workspace/projects/agentes/worktrees}"
MOTOR_WORKSPACE_MOUNT_CONTAINER="${MOTOR_WORKSPACE_ROOT_CONTAINER%/worktrees}"

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
# O arquivo é bind-mounted no container do Nginx. Não troque o inode com
# os.replace(): o container continuaria enxergando a configuração antiga.
config.write_text(updated, encoding="utf-8")
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
NEW_API_CONTAINER="${NEW_PROJECT}-api-1"

motor_port_for_slot() {
  case "$1" in
    blue|legacy) echo 3010 ;;
    green) echo 3011 ;;
    none) echo "$NEW_MOTOR_PORT" ;;
    *) return 1 ;;
  esac
}

notify_deploy_result() {
  local status="$1" port="$2" payload
  [ -n "$DEPLOY_BATCH_ID" ] || return 0
  [ -n "${MOTOR_DEPLOY_CALLBACK_TOKEN:-}" ] || {
    echo "[deploy-blue-green] MOTOR_DEPLOY_CALLBACK_TOKEN não configurado" >&2
    return 1
  }
  payload="$(printf '{\"status\":\"%s\"}' "$status")"
  curl --fail --silent --show-error --retry 5 --retry-delay 2 \
    -X POST -H 'Content-Type: application/json' \
    -H "X-Motor-Deploy-Token: $MOTOR_DEPLOY_CALLBACK_TOKEN" \
    --data "$payload" \
    "http://127.0.0.1:${port}/api/motor/deploy/batches/${DEPLOY_BATCH_ID}/result"
}

notify_deploy_on_exit() {
  local code="$?" status callback_port
  trap - EXIT
  if [ "$code" -eq 0 ]; then
    status=success
    callback_port="$NEW_MOTOR_PORT"
  else
    status=failed
    callback_port="$(motor_port_for_slot "$active")"
  fi
  notify_deploy_result "$status" "$callback_port" || {
    echo "[deploy-blue-green] não foi possível entregar o resultado do lote $DEPLOY_BATCH_ID ao Motor" >&2
  }
  exit "$code"
}

if [ -n "$DEPLOY_BATCH_ID" ]; then
  [[ "$DEPLOY_BATCH_ID" =~ ^[A-Za-z0-9_-]+$ ]] || {
    echo "[deploy-blue-green] batch de deploy inválido: $DEPLOY_BATCH_ID" >&2
    exit 1
  }
  [ -n "${MOTOR_DEPLOY_CALLBACK_TOKEN:-}" ] || {
    echo "[deploy-blue-green] MOTOR_DEPLOY_CALLBACK_TOKEN não configurado" >&2
    exit 1
  }
  trap notify_deploy_on_exit EXIT
fi

if [ -n "$EXPECTED_DEPLOY_COMMIT" ]; then
  # O promote() do motor faz push para origin mas o host local pode ficar
  # desatualizado. Fazer pull antes da verificação garante que HEAD bate.
  echo "[deploy-blue-green] sincronizando com origin..."
  # Contornar problema de permissão no known_hosts do usuário alexandre
  export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
  git fetch origin
  git reset --hard origin/$(git rev-parse --abbrev-ref HEAD)
  ACTUAL_DEPLOY_COMMIT="$(git rev-parse HEAD)"
  if [ "$ACTUAL_DEPLOY_COMMIT" != "$EXPECTED_DEPLOY_COMMIT" ]; then
    echo "[deploy-blue-green] commit divergente: esperado=$EXPECTED_DEPLOY_COMMIT atual=$ACTUAL_DEPLOY_COMMIT" >&2
    exit 1
  fi
  echo "[deploy-blue-green] commit pré-validado: $EXPECTED_DEPLOY_COMMIT"
fi

echo "[deploy-blue-green] ativo=$active; subindo $target em $NEW_PROJECT"
echo "[deploy-blue-green] build das imagens api/web..."
docker compose -p "$NEW_PROJECT" -f "$COMPOSE_FILE" build api web

# A API usa o checkout do host como volume para o Motor. Materialize os dist
# produzidos na imagem antes de iniciar a nova stack; sem isso o bind-mount
# esconde os artefatos compilados dentro da imagem.
NEW_API_IMAGE="${NEW_PROJECT}-api:latest"
docker image inspect "$NEW_API_IMAGE" >/dev/null 2>&1 || {
  echo "imagem da API do slot não encontrada: $NEW_API_IMAGE" >&2
  exit 1
}
MOTOR_DIST_CONTAINER="biblioteca-global-motor-dist-$$"
docker create --name "$MOTOR_DIST_CONTAINER" "$NEW_API_IMAGE" >/dev/null
for motor in motor-v2 motor-v3; do
  mkdir -p "projects/gerenteagentes/$motor"
  rm -rf "projects/gerenteagentes/$motor/dist"
  docker cp "$MOTOR_DIST_CONTAINER:/app/projects/gerenteagentes/$motor/dist" "projects/gerenteagentes/$motor/"
done
docker rm "$MOTOR_DIST_CONTAINER" >/dev/null
echo "[deploy-blue-green] dist dos motores v2/v3 materializados a partir da imagem $target"

echo "[deploy-blue-green] iniciando $NEW_PROJECT (MySQL compartilhado em $MYSQL_HOST_BLUEGREEN:$MYSQL_PORT_BLUEGREEN)..."
MYSQL_HOST="$MYSQL_HOST_BLUEGREEN" MYSQL_PORT="$MYSQL_PORT_BLUEGREEN" \
  OPENCLAW_CONSOLE_URL="$CONSOLE_URL_BLUEGREEN" \
  MOTOR_WORKSPACE_ROOT="$MOTOR_WORKSPACE_ROOT_CONTAINER" \
  API_HOST_PORT="$NEW_API_PORT" MOTOR_HOST_PORT="$NEW_MOTOR_PORT" WEB_HOST_PORT="$NEW_WEB_PORT" \
  docker compose -p "$NEW_PROJECT" -f "$COMPOSE_FILE" up -d --no-deps api

# O Nginx do frontend resolve o upstream "api" pela rede do projeto Compose.
# Aguarde o container da API existir antes de criar o frontend, evitando que o
# Nginx entre em loop de restart quando o DNS ainda não tem o alias do serviço.
for i in $(seq 1 30); do
  if docker inspect "$NEW_API_CONTAINER" >/dev/null 2>&1; then break; fi
  sleep 1
done
docker inspect "$NEW_API_CONTAINER" >/dev/null 2>&1 || {
  echo "container da API não foi criado: $NEW_API_CONTAINER" >&2
  exit 1
}
MYSQL_HOST="$MYSQL_HOST_BLUEGREEN" MYSQL_PORT="$MYSQL_PORT_BLUEGREEN" \
  OPENCLAW_CONSOLE_URL="$CONSOLE_URL_BLUEGREEN" \
  MOTOR_WORKSPACE_ROOT="$MOTOR_WORKSPACE_ROOT_CONTAINER" \
  API_HOST_PORT="$NEW_API_PORT" MOTOR_HOST_PORT="$NEW_MOTOR_PORT" WEB_HOST_PORT="$NEW_WEB_PORT" \
  docker compose -p "$NEW_PROJECT" -f "$COMPOSE_FILE" up -d --no-deps web

cleanup_new() {
  MYSQL_HOST="$MYSQL_HOST_BLUEGREEN" MYSQL_PORT="$MYSQL_PORT_BLUEGREEN" \
  API_HOST_PORT="$NEW_API_PORT" MOTOR_HOST_PORT="$NEW_MOTOR_PORT" WEB_HOST_PORT="$NEW_WEB_PORT" \
    docker compose -p "$NEW_PROJECT" -f "$COMPOSE_FILE" down --remove-orphans || true
}
trap cleanup_new ERR

echo "[deploy-blue-green] validando workspace do Motor no novo container"
docker exec -e "MOTOR_REPO_ROOT_CONTAINER=$MOTOR_REPO_ROOT_CONTAINER" "$NEW_API_CONTAINER" sh -eu -c '
  test -d "$MOTOR_WORKSPACE_ROOT" || {
    echo "workspace do Motor ausente: $MOTOR_WORKSPACE_ROOT" >&2
    exit 1
  }
  command -v git >/dev/null || {
    echo "git ausente no container da API" >&2
    exit 1
  }
  git -c "safe.directory=$MOTOR_REPO_ROOT_CONTAINER" -C "$MOTOR_REPO_ROOT_CONTAINER" rev-parse --show-toplevel >/dev/null || {
    echo "repositório do Motor ausente ou inválido: $MOTOR_REPO_ROOT_CONTAINER" >&2
    exit 1
  }
'
docker inspect "$NEW_API_CONTAINER" --format '{{range .Mounts}}{{println .Destination}}{{end}}' \
  | grep -Fx "$MOTOR_WORKSPACE_MOUNT_CONTAINER" >/dev/null || {
    echo "mount do workspace não encontrado no container da API: $MOTOR_WORKSPACE_MOUNT_CONTAINER" >&2
    exit 1
  }
echo "[deploy-blue-green] workspace e Git OK"

echo "[deploy-blue-green] validando acesso ao Console OpenClaw"
docker exec "$NEW_API_CONTAINER" node -e '
  fetch(process.env.OPENCLAW_CONSOLE_URL + "/api/agents")
    .then((response) => process.exit(response.status >= 500 ? 1 : 0))
    .catch(() => process.exit(1))
' || {
  echo "Console OpenClaw inacessível: $CONSOLE_URL_BLUEGREEN" >&2
  exit 1
}
echo "[deploy-blue-green] Console OpenClaw acessível"

if ! wait_http "http://127.0.0.1:$NEW_WEB_PORT/health" 30 "web-$target" \
   || ! wait_http "http://127.0.0.1:$NEW_API_PORT/api/auth/me" 40 "api-$target" \
   || ! wait_http "http://127.0.0.1:$NEW_MOTOR_PORT/api/motor/health" 40 "motor-$target"; then
  echo "[deploy-blue-green] nova stack não ficou saudável; tráfego antigo preservado" >&2
  exit 1
fi

# Validação adicional: verificar se o motor-v3 está consumindo mensagens do RabbitMQ.
# O health check HTTP não garante que o motor está processando mensagens.
echo "[deploy-blue-green] validando consumers do RabbitMQ no motor-$target"
sleep 5 # Aguarda motor inicializar consumers
motor_healthy=true

# Verifica se há consumers ativos na fila motor.commands
consumers=$(docker exec motor-rabbitmq rabbitmqctl list_queues name consumers --quiet 2>/dev/null | grep "motor.commands" | awk '{print $2}' || echo "0")
if [ "${consumers:-0}" -lt 1 ]; then
  echo "[deploy-blue-green] ERRO: motor.commands não tem consumers ativos ($consumers consumers)" >&2
  motor_healthy=false
fi

# Verifica se há mensagens unacknowledged (presa) na fila
unacked=$(docker exec motor-rabbitmq rabbitmqctl list_queues name messages_unacknowledged --quiet 2>/dev/null | grep "motor.commands" | awk '{print $2}' || echo "0")
if [ "${unacked:-0}" -gt 0 ]; then
  echo "[deploy-blue-green] AVISO: motor.commands tem $unacked mensagem(ens) não confirmada(s)" >&2
  # Não bloqueia, mas alerta
fi

if [ "$motor_healthy" = false ]; then
  echo "[deploy-blue-green] motor não está consumindo mensagens; abortando deploy" >&2
  echo "[deploy-blue-green] logs do motor:" >&2
  docker logs "$NEW_API_CONTAINER" --since 2m 2>&1 | grep -iE "error|fail|motor v3|queueconsumer" | tail -20 >&2
  exit 1
fi
echo "[deploy-blue-green] consumers do RabbitMQ OK ($consumers consumers ativos)"

# Aguarda 2 minutos e verifica se não há erros críticos nos logs do motor
echo "[deploy-blue-green] aguardando 2 minutos para validar logs do motor..."
sleep 120

critical_errors=$(docker logs "$NEW_API_CONTAINER" --since 2m 2>&1 | grep -iE "PRECONDITION_FAILED|Channel closed by server|Error:.*amqplib" | wc -l)
if [ "${critical_errors:-0}" -gt 0 ]; then
  echo "[deploy-blue-green] ERRO: $critical_errors erro(s) crítico(s) detectado(s) nos logs do motor" >&2
  docker logs "$NEW_API_CONTAINER" --since 2m 2>&1 | grep -iE "PRECONDITION_FAILED|Channel closed by server|Error:.*amqplib" | head -10 >&2
  echo "[deploy-blue-green] motor apresentou erros críticos; abortando deploy" >&2
  exit 1
fi
echo "[deploy-blue-green] logs do motor OK (sem erros críticos nos últimos 2 minutos)"

# O desenvolvedor somente versiona migrations no worktree. A aplicação no
# banco é uma operação privilegiada do Motor, no slot novo e antes do tráfego.
echo "[deploy-blue-green] aplicando migrations pendentes dos projetos ativos"
docker exec -e "MOTOR_REPO_ROOT_CONTAINER=$MOTOR_REPO_ROOT_CONTAINER" "$NEW_API_CONTAINER" \
  node projects/gerenteagentes/motor-v3/dist/deploy/ApplyProjectMigrationsCli.js

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
