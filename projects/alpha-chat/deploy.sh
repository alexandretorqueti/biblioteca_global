#!/bin/bash
# Deploy do Alpha Chat para Cloudflare Pages (alpha-biblioteca)
# Uso: ./deploy.sh
#
# Este script pode ser executado de qualquer máquina com Node.js/npm
# O token é lido automaticamente do repositório central de secrets

set -e

# === Configuração ===
REPO_PATH="/data/workspace/projects/codigofonte/biblioteca-global"
PROJECT_NAME="alpha-biblioteca"
BRANCH="main"
ACCOUNT_ID="18a324c1eb5c661113310d978ffb152b"
SECRETS_PATH="/data/workspace/projects/agentes/devops/secrets/cloudflare/README.md"

# === Token Cloudflare ===
# Tenta ler do repositório central de secrets
if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
    if [ -f "$SECRETS_PATH" ]; then
        CLOUDFLARE_API_TOKEN=$(grep "cfut_" "$SECRETS_PATH" | grep -o 'cfut_[a-zA-Z0-9]*' | head -1)
        if [ -n "$CLOUDFLARE_API_TOKEN" ]; then
            echo "🔑 Token lido do repositório central de secrets"
        fi
    fi
fi

if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
    echo "❌ Erro: CLOUDFLARE_API_TOKEN não configurado"
    echo ""
    echo "Configure o token de uma das formas:"
    echo "  1. export CLOUDFLARE_API_TOKEN='***'"
    echo "  2. Certifique-se de que o arquivo existe: $SECRETS_PATH"
    echo ""
    echo "Para criar um token: https://dash.cloudflare.com/profile/api-tokens"
    echo "Permissões necessárias: Cloudflare Pages → Edit"
    exit 1
fi

export CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"

echo "🚀 Deploy do Alpha Chat para Cloudflare Pages"
echo "   Projeto: $PROJECT_NAME"
echo "   Branch: $BRANCH"
echo "   Account: $ACCOUNT_ID"
echo ""

cd "$REPO_PATH"

echo "📦 Build do Alpha..."
npm run build --workspace @biblioteca-global/alpha-chat

echo ""
echo "🌎 Deploy para Cloudflare..."
npx wrangler pages deploy \
    projects/alpha-chat/dist \
    --project-name "$PROJECT_NAME" \
    --branch "$BRANCH" \
    --commit-dirty=true

echo ""
echo "✅ Deploy concluído!"
echo "   URL: https://$PROJECT_NAME.pages.dev/"
