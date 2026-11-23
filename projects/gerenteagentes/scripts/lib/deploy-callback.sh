#!/usr/bin/env bash
# Callback de resultado de deploy para o Motor (blue-green).
#
# O motor pode estar ouvindo em qualquer uma das duas portas do host
# (3010 blue / 3011 green) e a liderança pode trocar durante o deploy.
# A entrega é best-effort: rounds limitados, alternando as duas portas com
# backoff curto, tempo por tentativa limitado — nunca impede a gravação do
# marcador local nem prolonga o deploy indefinidamente.
#
# Exige no ambiente de quem usa: DEPLOY_BATCH_ID e
# MOTOR_DEPLOY_CALLBACK_TOKEN (validados internamente).

MOTOR_DEPLOY_CALLBACK_PORTS="${MOTOR_DEPLOY_CALLBACK_PORTS:-3010 3011}"
MOTOR_DEPLOY_CALLBACK_ROUNDS="${MOTOR_DEPLOY_CALLBACK_ROUNDS:-5}"
MOTOR_DEPLOY_CALLBACK_RETRY_DELAY_SECONDS="${MOTOR_DEPLOY_CALLBACK_RETRY_DELAY_SECONDS:-1}"
MOTOR_DEPLOY_CALLBACK_CONNECT_TIMEOUT_SECONDS="${MOTOR_DEPLOY_CALLBACK_CONNECT_TIMEOUT_SECONDS:-2}"
MOTOR_DEPLOY_CALLBACK_TIMEOUT_SECONDS="${MOTOR_DEPLOY_CALLBACK_TIMEOUT_SECONDS:-15}"

# notify_motor_deploy_result <success|failed> [log_prefix] [porta_preferida]
# Retorna 0 em 2xx; 1 após esgotar os rounds em todas as portas.
notify_motor_deploy_result() {
  local status="$1" log_prefix="${2:-[deploy-callback]}" preferred="${3:-}"
  [ -n "${DEPLOY_BATCH_ID:-}" ] || return 0
  [ -n "${MOTOR_DEPLOY_CALLBACK_TOKEN:-}" ] || {
    echo "$log_prefix MOTOR_DEPLOY_CALLBACK_TOKEN não configurado" >&2
    return 1
  }
  local payload
  payload="$(printf '{"status":"%s"}' "$status")"
  # Ordem por round: porta preferida primeiro (se informada), depois as demais.
  local ports="" port
  if [ -n "$preferred" ]; then ports="$preferred"; fi
  for port in $MOTOR_DEPLOY_CALLBACK_PORTS; do
    if [ "$port" != "$preferred" ]; then ports="$ports $port"; fi
  done
  local round code
  for (( round = 1; round <= MOTOR_DEPLOY_CALLBACK_ROUNDS; round++ )); do
    for port in $ports; do
      # --fail: 4xx/5xx resultam em exit != 0; 503 é tratado como retryable aqui.
      code=$(curl -sS -o /dev/null -w '%{http_code}' --fail \
        --connect-timeout "${MOTOR_DEPLOY_CALLBACK_CONNECT_TIMEOUT_SECONDS:-2}" \
        --max-time "${MOTOR_DEPLOY_CALLBACK_TIMEOUT_SECONDS:-15}" \
        -X POST -H 'Content-Type: application/json' \
        -H "X-Motor-Deploy-Token: $MOTOR_DEPLOY_CALLBACK_TOKEN" \
        --data "$payload" \
        "http://127.0.0.1:${port}/api/motor/deploy/batches/${DEPLOY_BATCH_ID}/result" 2>/dev/null) || code="${code:-000}"
      case "$code" in
        2??)
          echo "$log_prefix callback do lote $DEPLOY_BATCH_ID aceito (HTTP $code, porta $port, round $round)"
          return 0
          ;;
      esac
      echo "$log_prefix callback round $round porta $port: HTTP $code" >&2
    done
    if (( round < MOTOR_DEPLOY_CALLBACK_ROUNDS )); then
      sleep "$MOTOR_DEPLOY_CALLBACK_RETRY_DELAY_SECONDS"
    fi
  done
  echo "$log_prefix não foi possível entregar o resultado do lote $DEPLOY_BATCH_ID ao Motor após $MOTOR_DEPLOY_CALLBACK_ROUNDS rounds nas portas $ports" >&2
  return 1
}
