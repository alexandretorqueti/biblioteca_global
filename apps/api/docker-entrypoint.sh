#!/bin/sh
set -eu

# Configura git (necessário para o motor-v2 fazer commits)
git config --global user.email "motor-v2@globaltecnologia.local"
git config --global user.name "Motor v2"

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
