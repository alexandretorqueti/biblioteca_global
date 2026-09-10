#!/bin/bash
# Testa o endpoint do Gemini com uma mensagem real

set -e

echo "🧪 Testando endpoint do Gemini com mensagem real..."
echo ""

# Ler dados do capture.json
CAPTURE_FILE="/tmp/webai-network-capture.json"

if [ ! -f "$CAPTURE_FILE" ]; then
    echo "❌ Arquivo $CAPTURE_FILE não encontrado"
    exit 1
fi

# Extrair URL base (sem parâmetros dinâmicos)
URL_BASE="https://gemini.google.com/_/BardChatUi/data/batchexecute"

# Extrair cookies
COOKIES=$(python3 -c "
import json
with open('/tmp/webai-capture.json') as f:
    data = json.load(f)
    gemini = [x for x in data if x['provider'] == 'gemini'][0]
    print(gemini['cookies'])
")

# Extrair auth token
AUTH_TOKEN=$(python3 -c "
import json
with open('/tmp/webai-capture.json') as f:
    data = json.load(f)
    gemini = [x for x in data if x['provider'] == 'gemini'][0]
    print(gemini.get('authToken', ''))
")

# Parâmetros da URL (extraídos da captura)
SOURCE_PATH="%2Fapp"
BL="boq_assistant-bard-web-server_20260907.07_p0"
F_SID="-3521393219512368475"
HL="pt"
REQ_ID="3373599"

# RPC ID (VxUbXb é o ID do método "sendMessage")
RPC_ID="VxUbXb"

# Mensagem de teste
MESSAGE="olá, tudo bem?"

# Codificar mensagem para o payload
# Formato: [[["RPC_ID","[\"mensagem\"]",null,"generic"]]]
PAYLOAD=$(python3 -c "
import json
import urllib.parse

rpc_id = '$RPC_ID'
message = '$MESSAGE'

# Criar payload
payload_data = [[[rpc_id, json.dumps([message]), None, 'generic']]]
payload_json = json.dumps(payload_data)

# URL encode
print('f.req=' + urllib.parse.quote(payload_json))
")

# Adicionar auth token
FULL_PAYLOAD="${PAYLOAD}&at=${AUTH_TOKEN}&"

echo "📡 URL: $URL_BASE"
echo "🔑 Auth token: ${AUTH_TOKEN:***"
echo "💬 Mensagem: $MESSAGE"
echo ""
echo "📦 Payload:"
echo "$FULL_PAYLOAD" | head -c 200
echo "..."
echo ""

# Fazer requisição
echo "📤 Enviando requisição..."
RESPONSE=$(curl -s -X POST "${URL_BASE}?rpcids=${RPC_ID}&source-path=${SOURCE_PATH}&bl=${BL}&f.sid=${F_SID}&hl=${HL}&_reqid=${REQ_ID}&rt=c" \
    -H "Cookie: $COOKIES" \
    -H "Content-Type: application/x-www-form-urlencoded;charset=UTF-8" \
    -H "X-Same-Domain: 1" \
    -H "Referer: https://gemini.google.com/" \
    -H "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36" \
    --data "$FULL_PAYLOAD" \
    -w "\n%{http_code}" \
    2>&1)

# Separar response body e status code
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

echo ""
echo "📊 Status HTTP: $HTTP_CODE"
echo ""
echo "📝 Response (primeiros 1000 chars):"
echo "${BODY:0:1000}"
echo ""

if [ "$HTTP_CODE" = "200" ]; then
    echo "✅ Requisição bem-sucedida!"
    echo ""
    echo "💡 Agora implemente o GeminiDirectProvider.ts com esses dados"
else
    echo "⚠️ Requisição retornou status $HTTP_CODE"
fi
