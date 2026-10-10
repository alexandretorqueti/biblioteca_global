#!/bin/sh
set -eu

# Usa o bind-mount do host (código-fonte vivo) em vez do /app da imagem Docker.
# Sem isso, alterações no motor ou na API só entram em produção após rebuild da imagem.
# Ordem de preferência: $REPO_PATH (compose), bind atual (/home/alexandre/codigofonte),
# bind antigo (12T) e, por último, /app (imagem Docker).
SOURCE_DIR=""
for candidato in "${REPO_PATH:-}" \
  "/home/alexandre/codigofonte/biblioteca-global" \
  "/data/workspace/projects/codigofonte/biblioteca-global"; do
  if [ -n "$candidato" ] && [ -f "$candidato/package.json" ]; then
    SOURCE_DIR="$candidato"
    break
  fi
done
if [ -n "$SOURCE_DIR" ]; then
  cd "$SOURCE_DIR"
  echo "[entrypoint] Working directory: $SOURCE_DIR (bind-mount)"
else
  SOURCE_DIR="/app"
  echo "[entrypoint] Bind-mount não encontrado, usando /app (imagem Docker)"
fi

# Configura git (necessário para o motor fazer commits)
git config --global user.email "motor@globaltecnologia.local"
git config --global user.name "Motor v2"
git config --global --add safe.directory "$SOURCE_DIR"
git config --global --add safe.directory /data/workspace/projects/codigofonte/biblioteca-global
git config --global --add safe.directory /run/media/alexandre/12T/codigofonte/GerenteAgentes
SSH_DIRECTORY="${ENTRYPOINT_SSH_DIRECTORY:-/root/.ssh}"
KNOWN_HOSTS="$SSH_DIRECTORY/known_hosts"
mkdir -p "$SSH_DIRECTORY"
# A API faz deploy por SSH no próprio ServerIA. A chave pública do host fica
# versionada no repositório montado, para sobreviver à recriação do container;
# não aceite uma chave nova silenciosamente nesse caminho de deploy.
SERVERIA_KNOWN_HOSTS="$SOURCE_DIR/apps/api/serveria_known_hosts"
if [ -f "$SERVERIA_KNOWN_HOSTS" ]; then
  install -m 600 "$SERVERIA_KNOWN_HOSTS" "$KNOWN_HOSTS"
else
  : > "$KNOWN_HOSTS"
  chmod 600 "$KNOWN_HOSTS"
  echo "[entrypoint] serveria_known_hosts ausente; deploy SSH será bloqueado pelo preflight" >&2
fi

# A disponibilidade de DNS/rede pode atrasar após o boot do host. A chave do
# GitHub não deve atrasar a API, mas também não pode falhar silenciosamente:
# tenta por cerca de dois minutos e preserva uma entrada já existente.
prepare_github_known_hosts() {
  max_attempts=7
  attempt=1
  delay=2

  while [ "$attempt" -le "$max_attempts" ]; do
    if ssh-keygen -F github.com -f "$KNOWN_HOSTS" >/dev/null 2>&1; then
      echo "[entrypoint] github.com já está configurado em known_hosts"
      return 0
    fi

    keyscan_output=$(mktemp)
    if ssh-keyscan -T 5 github.com > "$keyscan_output" && [ -s "$keyscan_output" ]; then
      if ssh-keygen -F github.com -f "$KNOWN_HOSTS" >/dev/null 2>&1; then
        echo "[entrypoint] github.com já foi configurado em known_hosts"
      else
        cat "$keyscan_output" >> "$KNOWN_HOSTS"
        echo "[entrypoint] github.com adicionado a known_hosts"
      fi
      rm -f "$keyscan_output"
      return 0
    fi
    rm -f "$keyscan_output"

    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "[entrypoint] esgotadas as tentativas para configurar github.com em known_hosts" >&2
      return 1
    fi

    echo "[entrypoint] ssh-keyscan github.com falhou (tentativa $attempt/$max_attempts); nova tentativa em ${delay}s" >&2
    sleep "$delay"
    delay=$((delay * 2))
    if [ "$delay" -gt 30 ]; then
      delay=30
    fi
    attempt=$((attempt + 1))
  done
}

prepare_github_known_hosts &

attempt=0
until npm run db:migrate; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "MySQL indisponível após 30 tentativas" >&2
    exit 1
  fi
  sleep 2
done

# O catálogo do Motor vive em projeto_640. Migra e popula defaults canônicos
# antes de iniciar o Motor/API; não depende de alguém abrir a tela Prompts.
# Retry: protege contra falhas transitórias (ex.: lock-wait InnoDB durante
# blue-green deploy). Espelho do padrão db:migrate global acima.
attempt=0
until npm run db:migrate:gerenteagentes; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "[entrypoint] db:migrate:gerenteagentes indisponível após 30 tentativas" >&2
    exit 1
  fi
  echo "[entrypoint] db:migrate:gerenteagentes falhou (tentativa $attempt/30); nova tentativa em 2s" >&2
  sleep 2
done

# Bootstrap: seed de prompts canônicos. Depende do banco disponível (mesmo
# perfil de falha transitória que a migration). Protegido com o mesmo padrão
# de retry; falha definitiva encerra o entrypoint para recuperação pelo Docker.
attempt=0
until npm run db:bootstrap:gerenteagentes; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "[entrypoint] db:bootstrap:gerenteagentes indisponível após 30 tentativas" >&2
    exit 1
  fi
  echo "[entrypoint] db:bootstrap:gerenteagentes falhou (tentativa $attempt/30); nova tentativa em 2s" >&2
  sleep 2
done

# Seed temporariamente desabilitado - migrations já aplicadas
# npm run db:seed

# Inicia motor-v3 em background — depois do migrate para garantir DNS
if [ "${MOTOR_VERSION:-v3}" = "v3" ]; then
  if ! command -v git >/dev/null 2>&1; then
    echo "[entrypoint] Motor-v3 bloqueado: imagem sem executável git" >&2
    exit 1
  fi
  export MOTOR_MYSQL_HOST="${MOTOR_MYSQL_HOST:-${MYSQL_HOST:-host.docker.internal}}"
  export MOTOR_MYSQL_PORT="${MOTOR_MYSQL_PORT:-${MYSQL_PORT:-3308}}"
  export MOTOR_MYSQL_DATABASE="${MOTOR_MYSQL_DATABASE:-projeto_640}"
  export MOTOR_MYSQL_USER="${MOTOR_MYSQL_USER:-${MYSQL_USER:-biblioteca}}"
  export MOTOR_MYSQL_PASSWORD="${MOTOR_MYSQL_PASSWORD:-${MYSQL_PASSWORD:-}}"
  export MOTOR_WORKTREE_ROOT="${MOTOR_WORKTREE_ROOT:-/data/workspace/projects/codigofonte/biblioteca-global/.motor-v3-worktrees}"
  mkdir -p "$MOTOR_WORKTREE_ROOT"
  if [ ! -w "$MOTOR_WORKTREE_ROOT" ]; then
    echo "[entrypoint] Motor-v3 bloqueado: MOTOR_WORKTREE_ROOT sem permissão de escrita: $MOTOR_WORKTREE_ROOT" >&2
    exit 1
  fi
  git config --global user.email "motor-v3@globaltecnologia.local"
  git config --global user.name "Motor v3"
  git config --global --add safe.directory /data/workspace/projects/codigofonte/biblioteca-global
  echo "[entrypoint] Validando/bootstrap do catálogo motor-v3..."
  npm --prefix projects/gerenteagentes/motor-v3 run db:bootstrap-runtime

  # No modo v3 este shell precisa continuar como PID 1.  A API e o Motor são
  # processos independentes; fazer exec da API aqui deixaria uma janela em que
  # uma falha do Motor sinaliza o shell (que não tem trap) e a API segue viva.
  # HUP é reservado para a notificação interna de que o Motor encerrou.
  ENTRYPOINT_PID=$$
  API_PID=""
  MOTOR_PID=""

  stop_child() {
    child_pid="$1"
    if [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null; then
      kill -TERM "$child_pid" 2>/dev/null || true
    fi
  }

  wait_child() {
    child_pid="$1"
    if [ -n "$child_pid" ]; then
      wait "$child_pid" 2>/dev/null || true
    fi
  }

  shutdown_after_motor_failure() {
    trap - HUP TERM INT
    echo "[entrypoint] Motor-v3 encerrou; encerrando API e container para recuperação pelo Docker" >&2
    stop_child "$API_PID"
    stop_child "$MOTOR_PID"
    wait_child "$API_PID"
    wait_child "$MOTOR_PID"
    exit 1
  }

  shutdown_after_signal() {
    signal_name="$1"
    trap - HUP TERM INT
    echo "[entrypoint] Recebido $signal_name; encerrando API e Motor-v3" >&2
    stop_child "$API_PID"
    stop_child "$MOTOR_PID"
    wait_child "$API_PID"
    wait_child "$MOTOR_PID"
    if [ "$signal_name" = "INT" ]; then
      exit 130
    fi
    exit 143
  }

  trap 'shutdown_after_motor_failure' HUP
  trap 'shutdown_after_signal TERM' TERM
  trap 'shutdown_after_signal INT' INT

  echo "[entrypoint] Iniciando motor-v3 em background..."
  (
    motor_child_pid=""

    forward_signal_to_motor() {
      trap - HUP TERM INT
      if [ -n "$motor_child_pid" ] && kill -0 "$motor_child_pid" 2>/dev/null; then
        kill -TERM "$motor_child_pid" 2>/dev/null || true
      fi
      wait "$motor_child_pid" 2>/dev/null || true
      exit 0
    }

    trap 'forward_signal_to_motor' HUP TERM INT
    node projects/gerenteagentes/motor-v3/dist/start.js &
    motor_child_pid=$!
    if wait "$motor_child_pid"; then
      status=0
    else
      status=$?
    fi
    echo "[entrypoint] Motor-v3 encerrou inesperadamente (status=$status); encerrando API para recuperação pelo Docker" >&2
    kill -HUP "$ENTRYPOINT_PID" 2>/dev/null || true
    exit "$status"
  ) &
  MOTOR_PID=$!
  echo "[entrypoint] Motor-v3 PID: $MOTOR_PID"
  sleep 2
fi

cd apps/api
if [ "${MOTOR_VERSION:-v1}" = "v3" ]; then
  node -r @swc-node/register src/main.ts &
  API_PID=$!
  echo "[entrypoint] API PID: $API_PID"

  # Se a API sair por qualquer motivo, não deixe o Motor-v3 órfão.
  if wait "$API_PID"; then
    api_status=0
  else
    api_status=$?
  fi
  trap - HUP TERM INT
  stop_child "$MOTOR_PID"
  wait_child "$MOTOR_PID"
  exit "$api_status"
fi

exec node -r @swc-node/register src/main.ts
