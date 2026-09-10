#!/bin/bash
# Testa o endpoint do Gemini com os cookies capturados

set -e

echo "🧪 Testando endpoint do Gemini..."
echo ""

# Ler dados do capture.json
CAPTURE_FILE="/tmp/webai-capture.json"

if [ ! -f "$CAPTURE_FILE" ]; then
    echo "❌ Arquivo $CAPTURE_FILE não encontrado"
    exit 1
fi

# Extrair cookies do Gemini
COOKIES=$(python3 -c "
import json
with open('$CAPTURE_FILE') as f:
    data = json.load(f)
    gemini = [x for x in data if x['provider'] == 'gemini'][0]
    print(gemini['cookies'])
")

# Extrair auth token
AUTH_TOKEN=$(python3 -c "
import json
with open('$CAPTURE_FILE') as f:
    data = json.load(f)
    gemini = [x for x in data if x['provider'] == 'gemini'][0]
    print(gemini.get('authToken', ''))
")

echo "🍪 Cookies: ${#COOKIES} bytes"
echo "🔑 Auth token: ${AUTH_TOKEN:0:30}..."
echo ""

# Fazer requisição
echo "📡 Fazendo requisição..."
RESPONSE=$(curl -s -X POST "https://gemini.google.com/_/BardChatBackendData/assistant.lamda.BardFrontendService/StreamGenerate" \
    -H "Cookie: $COOKIES" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -H "X-Same-Domain: 1" \
    --data-urlencode "at=$AUTH_TOKEN" \
    --data-urlencode 'fz=[["olá"],[""],[""]]' \
    -w "\n%{http_code}" \
    2>&1)

# Separar response body e status code
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

echo ""
echo "📊 Status HTTP: $HTTP_CODE"
echo ""
echo "📝 Response (primeiros 500 chars):"
echo "${BODY:0:500}"
echo ""

if [ "$HTTP_CODE" = "200" ]; then
    echo "✅ Requisição bem-sucedida!"
else
    echo "⚠️ Requisição retornou status $HTTP_CODE"
fi
