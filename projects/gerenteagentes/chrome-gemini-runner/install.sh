#!/bin/bash
# Script de instalação do WebAI Provider no host
# Executar no host: ./install.sh

set -e

echo "🚀 Instalando WebAI Provider..."

# Diretório de instalação
INSTALL_DIR="/home/alexandre/docker/webai-provider"
SOURCE_DIR="/data/workspace/projects/agentes/gerenteagentes/chrome-gemini-runner"

echo "📁 Criando diretório de instalação..."
mkdir -p "$INSTALL_DIR"

echo "📋 Copiando arquivos..."
# Copia apenas os arquivos necessários (do container para o host via SSH)
# Este script deve ser executado no host, então ajusta os caminhos
if [ -d "$SOURCE_DIR" ]; then
    cp -r "$SOURCE_DIR"/* "$INSTALL_DIR"/
else
    echo "❌ Diretório fonte não encontrado: $SOURCE_DIR"
    echo "   Execute este script a partir do host com os arquivos disponíveis"
    exit 1
fi

cd "$INSTALL_DIR"

echo "🐳 Buildando imagem Docker..."
docker build -t webai-provider .

echo "🔗 Conectando às redes..."
# Cria as redes se não existirem
docker network create openclaw_default 2>/dev/null || true
docker network create ai_network 2>/dev/null || true

echo "🚀 Subindo container..."
docker-compose up -d

echo "⏳ Aguardando container ficar healthy..."
sleep 5

echo "🏥 Verificando health..."
if curl -f http://localhost:3100/health; then
    echo "✅ WebAI Provider instalado com sucesso!"
    echo ""
    echo "📍 Acesso:"
    echo "   - Health: http://localhost:3100/health"
    echo "   - API: http://localhost:3100/v1/chat/completions"
    echo "   - Models: http://localhost:3100/v1/models"
    echo ""
    echo "🔗 Acesso pelo OpenClaw (via rede Docker):"
    echo "   - http://webai-provider:3100/v1"
    echo ""
    echo "📝 Próximos passos:"
    echo "   1. Adicionar provider 'webai' no openclaw.json"
    echo "   2. Reiniciar OpenClaw Gateway"
    echo "   3. Testar tarefa com provider=webai, model=gemini"
else
    echo "❌ Container não está respondendo. Verifique os logs:"
    docker logs webai-provider
    exit 1
fi
