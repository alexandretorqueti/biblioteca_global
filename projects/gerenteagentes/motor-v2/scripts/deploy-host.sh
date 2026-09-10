#!/usr/bin/env bash
# Executado no ServerIA por SSH destacado. Não depende do container da API,
# que é recriado pelo próprio deploy.
set -euo pipefail

REPO_ROOT="${1:?informe a raiz do repositório}"
API="biblioteca-global-api"
WEB="biblioteca-global-web"
LOCK_FILE="${DEPLOY_LOCK_FILE:-/tmp/biblioteca-global-deploy.lock}"

# O deploy recria o container que contém o Motor. O lock precisa estar no
# host, fora do container, para sobreviver à recriação e serializar também
# disparos vindos de instâncias diferentes do Motor.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[deploy-host] outro deploy já está em andamento (lock: $LOCK_FILE)" >&2
  exit 75
fi

cd "$REPO_ROOT"
set -a
. ./.env
set +a

# A API usa o repositório do host como bind-mount. Portanto o Motor executado
# pelo entrypoint lê `motor-v2/dist`, não o artefato produzido dentro da imagem.
# Gere o JavaScript antes de recriar o container para que alterações no `src`
# sejam efetivamente publicadas.
if docker inspect "$API" >/dev/null 2>&1; then
  docker exec "$API" sh -lc \
    "cd '$REPO_ROOT' && ./node_modules/.bin/tsc --build projects/gerenteagentes/motor-v2/tsconfig.json --force"
else
  echo "[deploy-host] não há container da API para compilar o Motor" >&2
  exit 1
fi

OLD_API_IMAGE=$(docker inspect "$API" --format '{{.Image}}' 2>/dev/null || true)
OLD_WEB_IMAGE=$(docker inspect "$WEB" --format '{{.Image}}' 2>/dev/null || true)

rollback() {
  echo "[deploy-host] falhou; restaurando imagens anteriores" >&2
  # Verifica se as imagens antigas ainda existem antes de tentar restaurar
  local can_restore=true
  if [[ -n "$OLD_API_IMAGE" ]] && ! docker image inspect "$OLD_API_IMAGE" >/dev/null 2>&1; then
    echo "[deploy-host] imagem antiga da API não existe mais, não é possível restaurar" >&2
    can_restore=false
  fi
  if [[ -n "$OLD_WEB_IMAGE" ]] && ! docker image inspect "$OLD_WEB_IMAGE" >/dev/null 2>&1; then
    echo "[deploy-host] imagem antiga do Web não existe mais, não é possível restaurar" >&2
    can_restore=false
  fi
  if [[ "$can_restore" == "true" && -n "$OLD_API_IMAGE" && -n "$OLD_WEB_IMAGE" ]]; then
    docker tag "$OLD_API_IMAGE" biblioteca-global-api:latest
    docker tag "$OLD_WEB_IMAGE" biblioteca-global-web:latest
    # Remove containers órfãos antes de recriar
    docker compose -f docker-compose.yml down --remove-orphans || true
    docker compose -f docker-compose.yml up -d --no-deps --force-recreate api web || true
  else
    echo "[deploy-host] rollback parcial: pelo menos uma imagem antiga não existe mais" >&2
    # Tenta pelo menos subir os containers com as imagens atuais
    docker compose -f docker-compose.yml down --remove-orphans || true
    docker compose -f docker-compose.yml up -d --no-deps --force-recreate api web || true
  fi
}
trap rollback ERR

# Remove containers órfãos antes do deploy para evitar conflito de nomes
docker compose -f docker-compose.yml down --remove-orphans 2>/dev/null || true
docker compose -f docker-compose.yml config --quiet
docker compose -f docker-compose.yml build api web
docker compose -f docker-compose.yml up -d --no-deps --force-recreate api web

for _ in $(seq 1 30); do
  curl -fsS --max-time 5 http://127.0.0.1:5174/health >/dev/null && \
    curl -sS --max-time 5 -o /dev/null http://127.0.0.1:3003/api/auth/me && exit 0
  sleep 3
done

echo "[deploy-host] API ou Web não responderam após o deploy" >&2
exit 1
