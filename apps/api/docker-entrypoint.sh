#!/bin/sh
set -eu

# Configura git (necessário para o motor-v2 fazer commits)
git config --global user.email "motor-v2@globaltecnologia.local"
git config --global user.name "Motor v2"

# Inicia motor-v2 em background (se MOTOR_VERSION=v2)
if [ "${MOTOR_VERSION:-v1}" = "v2" ]; then
  echo "[entrypoint] Iniciando motor-v2 em background..."
  node projects/gerenteagentes/motor-v2/dist/start.js &
  MOTOR_PID=$!
  echo "[entrypoint] Motor-v2 PID: $MOTOR_PID"
fi

attempt=0
until npm run db:migrate; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "MySQL indisponível após 30 tentativas" >&2
    exit 1
  fi
  sleep 2
done

npm run db:seed
cd apps/api
exec node -r @swc-node/register src/main.ts
