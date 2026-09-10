#!/bin/bash
# Verifica os resultados da captura de rede

echo "🔍 Verificando resultados da captura..."
echo ""

# Verificar log do interceptor
if [ -f /tmp/interceptor.log ]; then
    echo "📋 Log do interceptor:"
    cat /tmp/interceptor.log
    echo ""
else
    echo "❌ Log do interceptor não encontrado"
    exit 1
fi

# Verificar arquivo de captura
if [ -f /tmp/webai-network-capture.json ]; then
    echo "✅ Arquivo de captura encontrado!"
    echo ""
    echo "📊 Conteúdo:"
    cat /tmp/webai-network-capture.json | python3 -m json.tool 2>/dev/null || cat /tmp/webai-network-capture.json
    echo ""
    
    # Gerar comando curl
    echo "📋 Comando curl para teste:"
    echo ""
    python3 << 'PYTHON_SCRIPT'
import json

with open('/tmp/webai-network-capture.json') as f:
    data = json.load(f)

for req in data:
    if req.get('method') == 'POST' and req.get('postData'):
        print(f'curl -X POST "{req["url"]}" \\')
        
        # Headers
        for key, value in req.get('headers', {}).items():
            if key.lower() not in ['content-length', 'host', 'content-type']:
                print(f'  -H "{key}: {value}" \\')
        
        # Content-Type
        content_type = req.get('headers', {}).get('content-type', 'application/x-www-form-urlencoded')
        print(f'  -H "Content-Type: {content_type}" \\')
        
        # Post data
        post_data = req.get('postData', '')
        print(f"  --data '{post_data}' \\")
        print('  -v')
        print()
PYTHON_SCRIPT
else
    echo "⚠️ Arquivo de captura não encontrado"
    echo "💡 O interceptor pode ainda estar rodando ou nenhuma requisição foi capturada"
fi
