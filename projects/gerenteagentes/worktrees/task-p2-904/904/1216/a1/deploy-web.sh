#!/bin/bash
# Deploy do web a partir do workspace do agente
# Uso: ./deploy-web.sh [agent|host]
# - agent: build a partir do workspace do agente (padrão)
# - host: build a partir da cópia do host

set -e

MODE=${1:-agent}
HOST="192.168.1.16"
KEY="/root/.ssh/id_ed25519"

# Caminho do workspace do agente no host
AGENT_PATH="/var/mnt/42798d48-3976-4c4a-a73a-2d3f75b1cd99/home/alexandrebragatorqueti/projetos/agentes/bibliotecaglobal/project/biblioteca-global"
# Caminho da cópia do host
HOST_PATH="/home/alexandre/projetos/biblioteca-global"

if [ "$MODE" = "agent" ]; then
  BUILD_PATH="$AGENT_PATH"
  echo "📦 Build a partir do workspace do agente"
elif [ "$MODE" = "host" ]; then
  BUILD_PATH="$HOST_PATH"
  echo "📦 Build a partir da cópia do host"
else
  echo "❌ Modo inválido: $MODE (use 'agent' ou 'host')"
  exit 1
fi

echo "🔨 Buildando imagem..."
ssh -o BatchMode=yes -i $KEY alexandre@$HOST "cd $BUILD_PATH && docker build --no-cache -t biblioteca-global-web -f apps/web/Dockerfile . 2>&1 | tail -10"

echo "🔄 Recriando container..."
ssh -o BatchMode=yes -i $KEY alexandre@$HOST "docker stop biblioteca-global-web && docker rm biblioteca-global-web && docker run -d --name biblioteca-global-web --network biblioteca-global_default --restart unless-stopped -p 5174:80 -e API_URL=http://api:3001 biblioteca-global-web"

echo "✅ Deploy concluído!"
ssh -o BatchMode=yes -i $KEY alexandre@$HOST "docker ps --filter 'name=biblioteca-global-web' --format '{{.Names}} {{.Status}}'"
