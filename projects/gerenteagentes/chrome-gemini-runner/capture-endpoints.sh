#!/bin/bash
# Script para capturar endpoints das IAs web
# Inicia o Chrome, abre as páginas e executa a captura

set -e

echo "🚀 Iniciando script de captura de endpoints..."
echo ""

# Remover lock do perfil se existir
LOCK_FILE="/tmp/webai-chrome-profile/SingletonLock"
if [ -f "$LOCK_FILE" ]; then
    echo "🔓 Removendo lock do perfil..."
    rm -f "$LOCK_FILE"
fi

# Matar processos Chrome existentes
echo "🧹 Limpando processos Chrome..."
pkill -9 chromium 2>/dev/null || true
pkill -9 chrome 2>/dev/null || true
sleep 2

# Iniciar Chrome com remote debugging
echo "🌐 Iniciando Chrome com remote debugging (porta 9222)..."
DISPLAY=:99 chromium \
    --no-sandbox \
    --disable-setuid-sandbox \
    --disable-dev-shm-usage \
    --disable-gpu \
    --remote-debugging-port=9222 \
    --user-data-dir=/tmp/webai-chrome-profile \
    --no-first-run \
    --no-default-browser-check \
    --disable-extensions \
    --disable-software-rasterizer \
    https://gemini.google.com/ \
    https://chat.openai.com/ \
    https://claude.ai/ \
    &

CHROME_PID=$!
echo "✅ Chrome iniciado (PID: $CHROME_PID)"
echo ""

# Aguardar o Chrome carregar
echo "⏳ Aguardando o Chrome carregar (15 segundos)..."
sleep 15

# Verificar se o Chrome está rodando
if ! ps -p $CHROME_PID > /dev/null; then
    echo "❌ Erro: Chrome não está rodando!"
    exit 1
fi

echo "✅ Chrome está rodando"
echo ""

# Executar script de captura
echo "🔍 Executando captura..."
echo ""
cd /app
node dist/CaptureFromRunningChrome.js

# Manter o Chrome aberto para inspeção manual
echo ""
echo "✅ Captura concluída!"
echo ""
echo "🌐 Chrome está rodando com as seguintes páginas:"
echo "   - Gemini: https://gemini.google.com/"
echo "   - ChatGPT: https://chat.openai.com/"
echo "   - Claude: https://claude.ai/"
echo ""
echo "🔌 Remote debugging disponível em: http://127.0.0.1:9222"
echo ""
echo "💡 Para inspecionar manualmente via VNC:"
echo "   http://192.168.1.8:6080/vnc.html"
echo ""
echo "📁 Arquivos gerados:"
echo "   - /tmp/webai-capture.json (dados capturados)"
echo "   - /tmp/webai-curl-commands.sh (comandos curl)"
echo ""
echo "Pressione Ctrl+C para fechar o Chrome e sair"
echo ""

# Aguardar o usuário pressionar Ctrl+C
wait $CHROME_PID
