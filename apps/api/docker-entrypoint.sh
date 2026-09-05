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
mkdir -p /root/.ssh && ssh-keyscan github.com >> /root/.ssh/known_hosts 2>/dev/null || true

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

# Inicia motor-v2 em background (se MOTOR_VERSION=v2) — depois do migrate para garantir DNS
if [ "${MOTOR_VERSION:-v1}" = "v2" ]; then
  echo "[entrypoint] Iniciando motor-v2 em background..."
  node projects/gerenteagentes/motor-v2/dist/start.js &
  MOTOR_PID=$!
  echo "[entrypoint] Motor-v2 PID: $MOTOR_PID"
  sleep 2
fi

cd apps/api
exec node -r @swc-node/register src/main.ts
