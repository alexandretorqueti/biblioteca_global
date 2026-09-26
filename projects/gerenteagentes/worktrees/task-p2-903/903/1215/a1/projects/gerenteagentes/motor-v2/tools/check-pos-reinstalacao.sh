#!/usr/bin/env bash
# =============================================================================
# check-pos-reinstalacao.sh — Checklist de ambiente pós-reinstalação do host
#
# Verifica tudo que a reinstalação do host (Bazzite) pode quebrar para o
# motor-v2 e a plataforma Biblioteca Global: binds, caminhos de repositório
# no banco, chave SSH de push, resolução de nomes, banco e estado do motor.
#
# Uso (no host):
#   bash <repo>/projects/gerenteagentes/motor-v2/tools/check-pos-reinstalacao.sh
#
# Itens inspirados nas falhas reais de 2026-09-03 (pós-reinstalação):
#   - repo_path no banco apontando para /run/media/... (bind antigo)
#   - chave SSH de push virou diretório vazio (Docker cria dir p/ bind ausente)
#   - host.docker.internal sem extra_hosts no compose usado no deploy
#   - OPENCLAW_CONSOLE_URL apontando para endereço inalcançável
# =============================================================================
set -u

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
API_CONTAINER="${API_CONTAINER:-biblioteca-global-api}"
MYSQL_CONTAINER="${MYSQL_CONTAINER:-biblioteca-global-mysql}"
MOTOR_PORT="${MOTOR_PORT:-3010}"

# shellcheck disable=SC1091
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  . "$REPO_ROOT/.env"
  set +a
fi

PASS_COUNT=0
FAIL_COUNT=0

ok() {
  echo "  [PASS] $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

bad() {
  echo "  [FAIL] $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

mysql_q() {
  docker exec "$MYSQL_CONTAINER" sh -c "mysql -uroot -p\$MYSQL_ROOT_PASSWORD -N -e \"$1\" 2>/dev/null"
}

echo "== 1. Binds / montagens =="
REPO_MOUNT="$(docker inspect "$API_CONTAINER" --format '{{range .Mounts}}{{.Source}}:{{.Destination}} {{end}}' 2>/dev/null)"
case " $REPO_MOUNT " in
  *" $REPO_ROOT:$REPO_ROOT "*) ok "bind do repositório montado ($REPO_ROOT)" ;;
  *) bad "bind do repositório ausente/divergente ($REPO_ROOT)" ;;
esac
if docker inspect "$API_CONTAINER" --format '{{range .Mounts}}{{.Destination}} {{end}}' 2>/dev/null | grep -q "/data/workspace/projects/agentes"; then
  ok "bind dos agentes montado (/data/workspace/projects/agentes)"
else
  bad "bind dos agentes ausente (/data/workspace/projects/agentes)"
fi

echo "== 2. Caminhos de repositório no banco (precisam existir DENTRO do container) =="
for TABELA in projeto_motor_config projetos_captados; do
  PATHS="$(mysql_q "SELECT DISTINCT repo_path FROM projeto_640.$TABELA")"
  while IFS= read -r p; do
    if [ -z "$p" ]; then continue; fi
    if docker exec "$API_CONTAINER" test -d "$p" 2>/dev/null; then
      ok "$TABELA: $p existe no container"
    else
      bad "$TABELA: $p NAO existe no container"
    fi
  done <<EOF2
$PATHS
EOF2
done

echo "== 3. Chave SSH de push do motor =="
KEY_IN_CONTAINER="/root/.ssh/github_id_ed25519"
if docker exec "$API_CONTAINER" test -f "$KEY_IN_CONTAINER" 2>/dev/null; then
  ok "chave montada como ARQUIVO em $KEY_IN_CONTAINER"
  AUTH="$(docker exec "$API_CONTAINER" ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -i "$KEY_IN_CONTAINER" -T git@github.com 2>&1 | head -1)"
  case "$AUTH" in
    *"successfully authenticated"*) ok "chave autentica no GitHub" ;;
    *) bad "chave NAO autentica no GitHub ($AUTH)" ;;
  esac
else
  bad "chave ausente ou montada como DIRETÓRIO (bind inexistente vira diretório)"
fi

echo "== 4. Rede / nomes =="
if docker exec "$API_CONTAINER" getent hosts host.docker.internal >/dev/null 2>&1; then
  ok "host.docker.internal resolve no container"
else
  bad "host.docker.internal NAO resolve (falta extra_hosts no compose usado)"
fi
CONSOLE_URL="${OPENCLAW_CONSOLE_URL:-}"
if [ -z "$CONSOLE_URL" ]; then
  bad "OPENCLAW_CONSOLE_URL vazia no .env"
else
  CONSOLE_HOST="$(echo "$CONSOLE_URL" | sed -e 's#^http://##' -e 's#/.*$##' -e 's#:[0-9]*$##')"
  if docker exec "$API_CONTAINER" getent hosts "$CONSOLE_HOST" >/dev/null 2>&1; then
    RC=0
    RESP="$(docker exec "$API_CONTAINER" sh -c "wget -O/dev/null --timeout=5 '$CONSOLE_URL' 2>&1")" || RC=$?
    RESP_ONELINE="$(echo "$RESP" | tr '\n' ' ')"
    if [ "$RC" = "0" ]; then
      ok "OPENCLAW_CONSOLE_URL responde ($CONSOLE_URL)"
    elif echo "$RESP_ONELINE" | grep -q "HTTP/1"; then
      ok "OPENCLAW_CONSOLE_URL responde com erro HTTP, mas alcancavel ($CONSOLE_URL)"
    else
      bad "OPENCLAW_CONSOLE_URL inalcançavel ($RESP_ONELINE)"
    fi
  else
    bad "OPENCLAW_CONSOLE_URL nao resolve ($CONSOLE_URL)"
  fi
fi

echo "== 5. Banco =="
if mysql_q "SELECT 1" | grep -q 1; then ok "MySQL responde"; else bad "MySQL NAO responde"; fi
if mysql_q "SELECT 1 FROM core.projetos LIMIT 1" | grep -q 1; then ok "core.projetos acessível"; else bad "core.projetos INACESSÍVEL"; fi
for T in tarefas subtarefas projetos_captados projeto_motor_config tarefa_chats execution_resources; do
  if mysql_q "SELECT 1 FROM projeto_640.$T LIMIT 1" | grep -q 1; then
    ok "projeto_640.$T existe"
  else
    bad "projeto_640.$T INACESSÍVEL"
  fi
done

echo "== 6. Motor =="
if docker exec "$API_CONTAINER" sh -c "wget -qO- --timeout=5 http://127.0.0.1:$MOTOR_PORT/api/motor/health" 2>/dev/null | grep -q '"ok":true'; then
  ok "motor health OK"
else
  bad "motor health FALHOU"
fi
BLOQUEADAS="$(mysql_q "SELECT COUNT(*) FROM projeto_640.tarefas WHERE status='blocked'" | tr -d '[:space:]')"
if [ "$BLOQUEADAS" = "0" ]; then ok "nenhuma tarefa bloqueada"; else bad "$BLOQUEADAS tarefa(s) bloqueada(s) (recover.js unblock)"; fi
ORFAOS="$(mysql_q "SELECT COUNT(*) FROM projeto_640.tarefas t WHERE t.status IN ('analyzing','running') AND NOT EXISTS (SELECT 1 FROM projeto_640.execution_resources r WHERE (r.owner_id = CAST(t.id AS CHAR) OR r.owner_id = t.external_id) AND r.expires_at > NOW())" | tr -d '[:space:]')"
if [ "$ORFAOS" = "0" ]; then ok "nenhuma tarefa órfã em execução"; else bad "$ORFAOS tarefa(s) órfã(s) (reconciliador retoma ao expirar o lease)"; fi

echo ""
echo "== Resultado: $PASS_COUNT ok, $FAIL_COUNT falha(s) =="
if [ "$FAIL_COUNT" = "0" ]; then exit 0; else exit 1; fi
