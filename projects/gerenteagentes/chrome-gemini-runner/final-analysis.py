#!/usr/bin/env python3
"""
Análise final: procura por qualquer requisição que possa ser o envio de mensagem
Inclui análise de timing e padrões
"""

import json
import urllib.parse

with open('/tmp/webai-direct-capture.json') as f:
    data = json.load(f)

print("🔍 ANÁLISE FINAL: Procurando pelo envio de mensagem...\n")

# Mostrar todas as requisições com detalhes
print("📋 TODAS AS REQUISIÇÕES (sem filtros):\n")

for i, req in enumerate(data):
    url = req['url']
    rpc_id = url.split('rpcids=')[1].split('&')[0] if 'rpcids=' in url else 'unknown'
    
    payload_size = len(req.get('postData', ''))
    response_size = len(req.get('response', {}).get('body', ''))
    
    # Flag para requisições interessantes
    flags = []
    
    if payload_size > 150:
        flags.append('PAYLOAD_GRANDE')
    
    if response_size > 1000:
        flags.append('RESPONSE_GRANDE')
    
    # Verificar se contém palavras-chave
    if req.get('postData'):
        payload = urllib.parse.unquote(req['postData'])
        if any(word in payload.lower() for word in ['capital', 'brasil', 'qual', 'olá', 'oi']):
            flags.append('KEYWORD_PAYLOAD')
    
    if req.get('response') and req['response'].get('body'):
        body = req['response']['body']
        if any(word in body.lower() for word in ['brasília', 'brasilia', 'distrito federal']):
            flags.append('KEYWORD_RESPONSE')
    
    flags_str = ' | '.join(flags) if flags else ''
    
    print(f"#{i+1:2d} RPC: {rpc_id:10s} | Payload: {payload_size:5d} | Response: {response_size:5d} {flags_str}")

# Procurar especificamente por requisições que podem ser o envio de mensagem
print("\n\n" + "="*80)
print("\n🎯 REQUISIÇÕES QUE PODEM SER O ENVIO DE MENSAGEM:\n")

# Critérios:
# 1. Payload maior que 150 bytes (não é apenas metadata)
# 2. Não é um RPC de inicialização conhecido
# 3. Foi enviada após a pergunta ser feita (após #30)

INIT_RPCS = {'otAQ7b', 'sJBwce', 'aPya6c', 'cYRIkd', 'GPRiHf', 'maGuAc', 
             'I4z33b', 'MyzX6c', 'PCck7e', 'VxUbXb', 'ESY5D', 'L5adhe', 'ozz5Z'}

for i, req in enumerate(data):
    url = req['url']
    rpc_id = url.split('rpcids=')[1].split('&')[0] if 'rpcids=' in url else 'unknown'
    
    # Ignorar RPCs de inicialização
    if rpc_id in INIT_RPCS:
        continue
    
    if req.get('postData'):
        payload = urllib.parse.unquote(req['postData'])
        
        if payload.startswith('f.req='):
            f_req = payload[6:]
            if '&' in f_req:
                f_req = f_req.split('&')[0]
            
            try:
                decoded = json.loads(f_req)
                payload_str = json.dumps(decoded, ensure_ascii=False)
                
                # Mostrar se o payload for interessante
                if len(payload_str) > 100:
                    print(f"📝 Requisição #{i+1} (RPC: {rpc_id})")
                    print(f"   Payload: {payload_str}")
                    
                    if req.get('response') and req['response'].get('body'):
                        body = req['response']['body']
                        print(f"   Response: {len(body)} bytes")
                        if len(body) < 500:
                            print(f"   Body: {body}")
                    
                    print()
            except:
                pass

# Análise de timing
print("\n" + "="*80)
print("\n⏰ ANÁLISE DE TIMING:\n")

print("Baseado no log do DirectCapture:")
print("- '💬 Fazendo pergunta...' foi logado")
print("- '✅ Pergunta enviada' foi logado")
print("- '⏳ Aguardando resposta (30 segundos)...' foi logado")
print()
print("As requisições após #30 foram capturadas após a pergunta ser enviada.")
print()

# Mostrar requisições após #30
print("📋 REQUISIÇÕES APÓS A PERGUNTA (#31-#44):\n")

for i in range(30, len(data)):
    req = data[i]
    url = req['url']
    rpc_id = url.split('rpcids=')[1].split('&')[0] if 'rpcids=' in url else 'unknown'
    
    payload_size = len(req.get('postData', ''))
    response_size = len(req.get('response', {}).get('body', ''))
    
    print(f"#{i+1:2d} RPC: {rpc_id:10s} | Payload: {payload_size:5d} | Response: {response_size:5d}")

print("\n💡 CONCLUSÃO:")
print("A mensagem 'qual é a capital do Brasil?' não foi encontrada nas requisições capturadas.")
print("Isso sugere que:")
print("1. A mensagem foi enviada em uma requisição que não foi capturada")
print("2. Ou o formato do payload é diferente do esperado")
print("3. Ou a mensagem foi enviada via WebSocket (não HTTP)")
print()
print("Próximos passos:")
print("- Implementar o GeminiDirectProvider com base nos dados capturados")
print("- Testar com uma mensagem simples para validar o formato")
print("- Ajustar o script de captura para interceptar WebSocket se necessário")
