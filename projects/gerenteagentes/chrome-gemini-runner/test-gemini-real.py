#!/usr/bin/env python3
"""
Testa o endpoint do Gemini com uma mensagem real via HTTP direto
"""

import json
import urllib.parse
import urllib.request
import ssl

# Ler dados capturados
with open('/tmp/webai-capture.json') as f:
    capture_data = json.load(f)

gemini_data = [x for x in capture_data if x['provider'] == 'gemini'][0]
cookies = gemini_data['cookies']
auth_token = gemini_data.get('authToken', '')

# URL base
url_base = "https://gemini.google.com/_/BardChatUi/data/batchexecute"

# Parâmetros da URL (extraídos da captura)
params = {
    'rpcids': 'VxUbXb',
    'source-path': '/app',
    'bl': 'boq_assistant-bard-web-server_20260907.07_p0',
    'f.sid': '-3521393219512368475',
    'hl': 'pt',
    '_reqid': '3373599',
    'rt': 'c'
}

# Mensagem de teste
message = "olá, tudo bem?"

# Criar payload
# Formato: [[["RPC_ID","[\"mensagem\"]",null,"generic"]]]
payload_data = [[["VxUbXb", json.dumps([message]), None, "generic"]]]
payload_json = json.dumps(payload_data)

# URL encode
payload = f"f.req={urllib.parse.quote(payload_json)}&at={auth_token}&"

print("🧪 Testando endpoint do Gemini com mensagem real...")
print("")
print(f"📡 URL: {url_base}")
print(f"🔑 Auth token: {auth_token[:50]}...")
print(f"💬 Mensagem: {message}")
print("")
print(f"📦 Payload (primeiros 200 chars):")
print(payload[:200] + "...")
print("")

# Headers
headers = {
    'Cookie': cookies,
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    'X-Same-Domain': '1',
    'Referer': 'https://gemini.google.com/',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
}

# Construir URL completa
query_string = urllib.parse.urlencode(params)
full_url = f"{url_base}?{query_string}"

# Criar request
req = urllib.request.Request(
    full_url,
    data=payload.encode('utf-8'),
    headers=headers,
    method='POST'
)

# Desabilitar verificação SSL (para teste)
context = ssl._create_unverified_context()

print("📤 Enviando requisição...")
print("")

try:
    with urllib.request.urlopen(req, context=context, timeout=30) as response:
        status = response.status
        body = response.read().decode('utf-8')
        
        print(f"📊 Status HTTP: {status}")
        print("")
        print(f"📝 Response (primeiros 1000 chars):")
        print(body[:1000])
        print("")
        
        if status == 200:
            print("✅ Requisição bem-sucedida!")
            print("")
            print("💡 Endpoint funciona! Agora implemente o GeminiDirectProvider.ts")
        else:
            print(f"⚠️ Requisição retornou status {status}")
            
except urllib.error.HTTPError as e:
    print(f"❌ HTTP Error: {e.code}")
    print(f"   {e.reason}")
    print("")
    print("Response:")
    print(e.read().decode('utf-8')[:1000])
    
except Exception as e:
    print(f"❌ Erro: {e}")
