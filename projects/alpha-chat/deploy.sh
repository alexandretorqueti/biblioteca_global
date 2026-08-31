#!/bin/bash
# Deploy do Alpha Chat para Cloudflare Pages (alpha-biblioteca)
# Uso: ./deploy-alpha.sh
#
# Este script deve ser executado no host bazzite (ou via SSH)
# Requer: wrangler autenticado (wrangler login)

set -e

REPO_PATH="/run/media/alexandre/12T/codigofonte/biblioteca-global"
PROJECT_NAME="alpha-biblioteca"
BRANCH="main"

echo "🚀 Deploy do Alpha Chat para Cloudflare Pages"
echo "   Projeto: $PROJECT_NAME"
echo "   Branch: $BRANCH"
echo ""

cd "$REPO_PATH"

echo "📦 Build do Alpha..."
npm run build --workspace @biblioteca-global/alpha-chat

echo ""
echo "🌎 Deploy para Cloudflare..."
npx wrangler pages deploy projects/alpha-chat/dist --project-name "$PROJECT_NAME" --branch "$BRANCH"

echo ""
echo "✅ Deploy concluído!"
echo "   URL: https://$PROJECT_NAME.pages.dev/"
