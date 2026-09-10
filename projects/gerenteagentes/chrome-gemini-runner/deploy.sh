#!/bin/bash
# Script para build e deploy do WebAI Provider no host
# Executar no host: ./deploy.sh

set -e

echo "🚀 Buildando e deployando WebAI Provider..."

# Diretório de instalação
INSTALL_DIR="/home/alexandre/docker/webai-provider"

cd "$INSTALL_DIR"

echo "🐳 Buildando imagem Docker..."
docker compose build --no-cache

echo "🚀 Subindo container..."
docker compose up -d

echo "⏳ Aguardando container ficar ready..."
sleep 5

echo "🏥 Verificando health..."
if curl -f http://localhost:3100/health; then
    echo "✅ WebAI Provider deployado com sucesso!"
else
    echo "❌ Container não está respondendo. Verifique os logs:"
    docker compose logs
    exit 1
fi
