#!/usr/bin/env python3
"""
Procura pela requisição que envia a mensagem do usuário para o Gemini
"""

import json
import urllib.parse

with open('/tmp/webai-direct-capture.json') as f:
    data = json.load(f)

print("🔍 Procurando pela requisição que envia a mensagem do usuário...\n")

# RPCs conhecidos de inicialização (ignorar)
INIT_RPCS = {
    'otAQ7b', 'sJBwce', 'aPya6c', 'cYRIkd', 'GPRiHf', 'maGuAc', 
    'I4z33b', 'MyzX6c', 'PCck7e', 'VxUbXb'
}

# Procurar requisições que podem ser a mensagem do usuário
for i, req in enumerate(data):
    url = req['url']
    rpc_id = url.split('rpcids=')[1].split('&')[0] if 'rpcids=' in url else 'unknown'
    
    # Ignorar RPCs de inicialização
    if rpc_id in INIT_RPCS:
        continue
    
    if req.get('postData'):
        payload = urllib.parse.unquote(req['postData'])
        
        # Procurar padrões que indicam mensagem do usuário
        # Geralmente contém strings como "me", "user", ou a mensagem real
        if any(pattern in payload.lower() for pattern in ['"me"', '"user"', 'capital', 'brasil', 'qual']):
            print(f"🎯 POSSÍVEL MENSAGEM! Requisição #{i+1} (RPC: {rpc_id})")
            print(f"   URL: {url[:150]}...")
            print(f"   Payload:")
            
            if payload.startswith('f.req='):
                f_req = payload[6:]
                if '&' in f_req:
                    f_req = f_req.split('&')[0]
                
                try:
                    decoded = json.loads(f_req)
                    print(json.dumps(decoded, indent=2, ensure_ascii=False)[:2000])
                except:
                    print(payload[:2000])
            
            print("\n" + "="*80 + "\n")

# Mostrar todas as requisições únicas (RPCs diferentes)
print("\n📋 TODOS OS RPCs ÚNICOS CAPTURADOS:\n")

unique_rpcs = {}
for i, req in enumerate(data):
    url = req['url']
    rpc_id = url.split('rpcids=')[1].split('&')[0] if 'rpcids=' in url else 'unknown'
    
    if rpc_id not in unique_rpcs:
        unique_rpcs[rpc_id] = {
            'count': 0,
            'first_seen': i+1,
            'payload_sizes': []
        }
    
    unique_rpcs[rpc_id]['count'] += 1
    unique_rpcs[rpc_id]['payload_sizes'].append(len(req.get('postData', '')))

for rpc_id, info in sorted(unique_rpcs.items(), key=lambda x: max(x[1]['payload_sizes']), reverse=True):
    max_payload = max(info['payload_sizes'])
    print(f"{rpc_id}: {info['count']}x, max payload: {max_payload} bytes (first: #{info['first_seen']})")

# Mostrar detalhes dos RPCs menos comuns (provavelmente são as mensagens)
print("\n\n🔬 DETALHES DOS RPCs MENOS COMUNS (provavelmente são as mensagens):\n")

for rpc_id, info in sorted(unique_rpcs.items(), key=lambda x: x[1]['count']):
    if info['count'] <= 2 and rpc_id not in INIT_RPCS:
        print(f"RPC: {rpc_id} ({info['count']}x)")
        
        # Mostrar a primeira ocorrência
        for i, req in enumerate(data):
            url = req['url']
            req_rpc_id = url.split('rpcids=')[1].split('&')[0] if 'rpcids=' in url else 'unknown'
            
            if req_rpc_id == rpc_id:
                print(f"  Ocorrência #{i+1}:")
                if req.get('postData'):
                    payload = urllib.parse.unquote(req['postData'])
                    if payload.startswith('f.req='):
                        f_req = payload[6:]
                        if '&' in f_req:
                            f_req = f_req.split('&')[0]
                        
                        try:
                            decoded = json.loads(f_req)
                            print(f"  Payload: {json.dumps(decoded, ensure_ascii=False)[:500]}")
                        except:
                            print(f"  Payload: {payload[:500]}")
                
                if req.get('response') and req['response'].get('body'):
                    body = req['response']['body']
                    print(f"  Response: {len(body)} bytes")
                    if len(body) < 300:
                        print(f"  Body: {body}")
                
                print()
                break
        
        print()
