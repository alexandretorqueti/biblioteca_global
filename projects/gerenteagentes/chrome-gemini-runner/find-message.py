#!/usr/bin/env python3
"""
Procura especificamente pela requisição que contém a mensagem "qual é a capital do Brasil?"
"""

import json
import urllib.parse

with open('/tmp/webai-direct-capture.json') as f:
    data = json.load(f)

print(f"🔍 Procurando pela mensagem 'qual é a capital do Brasil?'...\n")

# Procurar em todas as requisições
for i, req in enumerate(data):
    url = req['url']
    rpc_id = url.split('rpcids=')[1].split('&')[0] if 'rpcids=' in url else 'unknown'
    
    # Verificar postData
    if req.get('postData'):
        payload_decoded = urllib.parse.unquote(req['postData'])
        
        # Procurar pela mensagem em diferentes formatos
        if ('capital' in payload_decoded.lower() and 'brasil' in payload_decoded.lower()) or \
           'qual' in payload_decoded.lower() and 'capital' in payload_decoded.lower():
            print(f"🎯 ENCONTRADA! Requisição #{i+1} (RPC: {rpc_id})")
            print(f"   URL: {url}")
            print(f"   Payload completo:")
            print(payload_decoded)
            print()
            
            # Tentar decodificar
            if payload_decoded.startswith('f.req='):
                f_req = payload_decoded[6:]
                if '&' in f_req:
                    f_req = f_req.split('&')[0]
                
                try:
                    decoded = json.loads(f_req)
                    print(f"   📦 JSON decodificado:")
                    print(json.dumps(decoded, indent=2, ensure_ascii=False))
                except Exception as e:
                    print(f"   ⚠️ Erro ao decodificar: {e}")
            
            print("\n" + "="*80 + "\n")
    
    # Verificar response body
    if req.get('response') and req['response'].get('body'):
        body = req['response']['body']
        if 'capital' in body.lower() and 'brasil' in body.lower():
            print(f"📝 RESPOSTA ENCONTRADA! Requisição #{i+1} (RPC: {rpc_id})")
            print(f"   URL: {url}")
            print(f"   Response body (primeiros 1000 chars):")
            print(body[:1000])
            print("\n" + "="*80 + "\n")

# Mostrar requisições enviadas APÓS "Fazendo pergunta..."
print("\n📋 REQUISIÇÕES ENVIADAS APÓS A PERGUNTA (provavelmente contêm a mensagem):\n")

# A pergunta foi feita após o log "💬 Fazendo pergunta..."
# Vou procurar requisições que não são de inicialização
for i, req in enumerate(data):
    url = req['url']
    rpc_id = url.split('rpcids=')[1].split('&')[0] if 'rpcids=' in url else 'unknown'
    
    # Ignorar RPCs de inicialização conhecidos
    if rpc_id in ['otAQ7b', 'sJBwce', 'aPya6c', 'cYRIkd', 'GPRiHf', 'maGuAc', 'I4z33b', 'MyzX6c', 'PCck7e']:
        continue
    
    if req.get('postData'):
        payload = urllib.parse.unquote(req['postData'])
        if payload.startswith('f.req='):
            f_req = payload[6:]
            if '&' in f_req:
                f_req = f_req.split('&')[0]
            
            try:
                decoded = json.loads(f_req)
                # Mostrar apenas se tiver um formato diferente
                if len(json.dumps(decoded)) > 150:  # Ignorar payloads muito pequenos
                    print(f"{i+1}. RPC: {rpc_id}")
                    print(f"   Payload: {json.dumps(decoded, ensure_ascii=False)[:500]}")
                    
                    if req.get('response') and req['response'].get('body'):
                        body = req['response']['body']
                        if len(body) > 200:  # Mostrar apenas responses substanciais
                            print(f"   Response: {len(body)} bytes - {body[:200]}...")
                    
                    print()
            except:
                pass
