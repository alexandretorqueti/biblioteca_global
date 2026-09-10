#!/usr/bin/env python3
"""
Analisa o timing das requisições para encontrar a resposta real da pergunta
"""

import json
import urllib.parse

with open('/tmp/webai-direct-capture.json') as f:
    data = json.load(f)

print("🔍 Análise de timing para encontrar a resposta real...\n")

# Baseado no log do DirectCapture:
# "💬 Fazendo pergunta..." foi logado
# "✅ Pergunta enviada" foi logado
# "⏳ Aguardando resposta (30 segundos)..." foi logado
# Depois várias requisições foram capturadas

# A resposta real deve estar nas requisições capturadas após a pergunta ser enviada
# Vou procurar por requisições que têm uma resposta substancial e foram capturadas depois

print("📋 REQUISIÇÕES CAPTURADAS APÓS A PERGUNTA (provavelmente contêm a resposta):\n")

# As requisições após #31 são as mais prováveis (baseado no log)
for i in range(30, len(data)):
    req = data[i]
    url = req['url']
    rpc_id = url.split('rpcids=')[1].split('&')[0] if 'rpcids=' in url else 'unknown'
    
    response_size = len(req.get('response', {}).get('body', ''))
    
    print(f"#{i+1:2d} RPC: {rpc_id:10s} | Response: {response_size:5d} bytes")
    
    # Mostrar detalhes se a resposta for grande
    if response_size > 500:
        body = req['response']['body']
        print(f"   📝 Response preview: {body[:300]}")
        
        # Verificar se contém palavras-chave
        if any(word in body.lower() for word in ['brasília', 'capital', 'brasil', 'distrito']):
            print(f"   🎯 CONTÉM PALAVRAS-CHAVE!")
    
    if req.get('postData'):
        payload = urllib.parse.unquote(req['postData'])
        if payload.startswith('f.req='):
            f_req = payload[6:]
            if '&' in f_req:
                f_req = f_req.split('&')[0]
            
            try:
                decoded = json.loads(f_req)
                payload_str = json.dumps(decoded, ensure_ascii=False)
                if len(payload_str) > 150:
                    print(f"   📤 Payload: {payload_str[:300]}")
            except:
                pass
    
    print()

# Procurar especificamente por respostas que contêm texto de resposta real
print("\n" + "="*80)
print("\n🎯 PROCURANDO POR RESPOSTAS COM TEXTO REAL (não metadata)...\n")

for i, req in enumerate(data):
    url = req['url']
    rpc_id = url.split('rpcids=')[1].split('&')[0] if 'rpcids=' in url else 'unknown'
    
    if req.get('response') and req['response'].get('body'):
        body = req['response']['body']
        
        # Procurar por padrões que indicam resposta real
        # Geralmente contém texto corrido, não apenas metadata
        if len(body) > 1000:
            # Verificar se contém texto substantivo (não apenas JSON metadata)
            # Respostas reais geralmente têm frases completas
            
            # Procurar por frases comuns em respostas
            if any(phrase in body.lower() for phrase in [
                'a capital do brasil', 'brasília é a capital', 'distrito federal',
                'capital federal', 'planalto central', 'fundada em'
            ]):
                print(f"🎯 POSSÍVEL RESPOSTA REAL! Requisição #{i+1} (RPC: {rpc_id})")
                print(f"   Response size: {len(body)} bytes")
                print(f"   Body: {body[:1000]}")
                print()

# Se não encontrou, mostrar as maiores responses
print("\n" + "="*80)
print("\n📝 TOP 5 MAIORES RESPONSES:\n")

sorted_responses = sorted(
    [(i, req) for i, req in enumerate(data) if req.get('response') and req['response'].get('body')],
    key=lambda x: len(x[1]['response']['body']),
    reverse=True
)[:5]

for i, req in sorted_responses:
    url = req['url']
    rpc_id = url.split('rpcids=')[1].split('&')[0] if 'rpcids=' in url else 'unknown'
    body = req['response']['body']
    
    print(f"#{i+1:2d} RPC: {rpc_id:10s} | Response: {len(body):5d} bytes")
    print(f"   Preview: {body[:500]}")
    print()
