#!/bin/sh
set -eu

# Usa o bind-mount do host (código-fonte vivo) em vez do /app da imagem Docker.
# Sem isso, alterações no motor-v2 ou na API só entram em produção após rebuild da imagem.
# Ordem de preferência: $REPO_PATH (compose), bind atual (/home/alexandre/codigofonte),
# bind antigo (12T) e, por último, /app (imagem Docker).
SOURCE_DIR=""
for candidato in "${REPO_PATH:-}" \
  "/home/alexandre/codigofonte/biblioteca-global" \
  "/run/media/alexandre/12T/codigofonte/biblioteca-global"; do
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

# Configura git (necessário para o motor-v2 fazer commits)
git config --global user.email "motor-v2@globaltecnologia.local"
git config --global user.name "Motor v2"
git config --global --add safe.directory "$SOURCE_DIR"
git config --global --add safe.directory /run/media/alexandre/12T/codigofonte/biblioteca-global
git config --global --add safe.directory /run/media/alexandre/12T/codigofonte/GerenteAgentes
mkdir -p /root/.ssh
# A API faz deploy por SSH no próprio ServerIA. A chave pública do host fica
# versionada no repositório montado, para sobreviver à recriação do container;
# não aceite uma chave nova silenciosamente nesse caminho de deploy.
SERVERIA_KNOWN_HOSTS="$SOURCE_DIR/apps/api/serveria_known_hosts"
if [ -f "$SERVERIA_KNOWN_HOSTS" ]; then
  install -m 600 "$SERVERIA_KNOWN_HOSTS" /root/.ssh/known_hosts
else
  : > /root/.ssh/known_hosts
  chmod 600 /root/.ssh/known_hosts
  echo "[entrypoint] serveria_known_hosts ausente; deploy SSH será bloqueado pelo preflight" >&2
fi
ssh-keyscan github.com >> /root/.ssh/known_hosts 2>/dev/null || true

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
npm run db:migrate:gerenteagentes
npm run db:bootstrap:gerenteagentes

# Seed temporariamente desabilitado - migrations já aplicadas
# npm run db:seed

# Inicia motor-v2 ou motor-v3 em background (dependendo da versão) — depois do migrate para garantir DNS
if [ "${MOTOR_VERSION:-v1}" = "v2" ]; then
  echo "[entrypoint] Iniciando motor-v2 em background..."
  node projects/gerenteagentes/motor-v2/dist/start.js &
  MOTOR_PID=$!
  echo "[entrypoint] Motor-v2 PID: $MOTOR_PID"
  sleep 2
elif [ "${MOTOR_VERSION:-v1}" = "v3" ]; then
  if ! command -v git >/dev/null 2>&1; then
    echo "[entrypoint] Motor-v3 bloqueado: imagem sem executável git" >&2
    exit 1
  fi
  export MOTOR_MYSQL_HOST="${MOTOR_MYSQL_HOST:-${MYSQL_HOST:-host.docker.internal}}"
  export MOTOR_MYSQL_PORT="${MOTOR_MYSQL_PORT:-${MYSQL_PORT:-3308}}"
  export MOTOR_MYSQL_DATABASE="${MOTOR_MYSQL_DATABASE:-projeto_640}"
  export MOTOR_MYSQL_USER="${MOTOR_MYSQL_USER:-${MYSQL_USER:-biblioteca}}"
  export MOTOR_MYSQL_PASSWORD="${MOTOR_MYSQL_PASSWORD:-${MYSQL_PASSWORD:-}}"
  export MOTOR_WORKTREE_ROOT="${MOTOR_WORKTREE_ROOT:-/data/workspace/projects/agentes/gerenteagentes/worktrees}"
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
  echo "[entrypoint] Iniciando motor-v3 em background..."
  node projects/gerenteagentes/motor-v3/dist/start.js &
  MOTOR_PID=$!
  echo "[entrypoint] Motor-v3 PID: $MOTOR_PID"
  sleep 2
fi

cd apps/api
exec node -r @swc-node/register src/main.ts
