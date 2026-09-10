#!/usr/bin/env python3
"""
Procura especificamente pela requisição que contém a mensagem do usuário
Foca em payloads que contêm texto real (não metadata)
"""

import json
import urllib.parse

with open('/tmp/webai-direct-capture.json') as f:
    data = json.load(f)

print("🔍 Procurando pela requisição com a mensagem do usuário...\n")

# Procurar em todas as requisições
for i, req in enumerate(data):
    url = req['url']
    rpc_id = url.split('rpcids=')[1].split('&')[0] if 'rpcids=' in url else 'unknown'
    
    if req.get('postData'):
        payload = urllib.parse.unquote(req['postData'])
        
        if payload.startswith('f.req='):
            f_req = payload[6:]
            if '&' in f_req:
                f_req = f_req.split('&')[0]
            
            try:
                decoded = json.loads(f_req)
                
                # Procurar por payloads que contêm texto real
                # Geralmente são arrays com strings longas
                payload_str = json.dumps(decoded, ensure_ascii=False)
                
                # Ignorar payloads muito pequenos ou de inicialização
                if len(payload_str) < 100:
                    continue
                
                # Ignorar RPCs conhecidos de inicialização
                if rpc_id in ['otAQ7b', 'sJBwce', 'aPya6c', 'cYRIkd', 'GPRiHf', 'maGuAc', 
                             'I4z33b', 'MyzX6c', 'PCck7e', 'VxUbXb', 'ESY5D', 'L5adhe', 'ozz5Z']:
                    continue
                
                # Verificar se o payload contém texto que parece ser uma mensagem
                # Geralmente contém strings com espaços, palavras comuns, etc.
                has_real_text = False
                
                # Procurar por strings que parecem ser mensagens
                def check_for_text(obj, depth=0):
                    if depth > 5:
                        return False
                    if isinstance(obj, str):
                        # Verificar se a string parece ser uma mensagem
                        if len(obj) > 10 and (' ' in obj or any(word in obj.lower() for word in ['qual', 'capital', 'brasil', 'olá', 'oi'])):
                            return True
                    elif isinstance(obj, list):
                        for item in obj:
                            if check_for_text(item, depth+1):
                                return True
                    elif isinstance(obj, dict):
                        for value in obj.values():
                            if check_for_text(value, depth+1):
                                return True
                    return False
                
                has_real_text = check_for_text(decoded)
                
                if has_real_text:
                    print(f"🎯 POSSÍVEL MENSAGEM! Requisição #{i+1} (RPC: {rpc_id})")
                    print(f"   URL: {url[:150]}...")
                    print(f"   Payload:")
                    print(json.dumps(decoded, indent=2, ensure_ascii=False))
                    print()
                    
                    # Mostrar response se disponível
                    if req.get('response') and req['response'].get('body'):
                        body = req['response']['body']
                        print(f"   Response ({len(body)} bytes):")
                        print(body[:500])
                        print()
                    
                    print("="*80)
                    print()
            
            except Exception as e:
                pass

# Se não encontrou, mostrar todas as requisições únicas
print("\n📋 TODAS AS REQUISIÇÕES ÚNICAS (RPCs não ignorados):\n")

for i, req in enumerate(data):
    url = req['url']
    rpc_id = url.split('rpcids=')[1].split('&')[0] if 'rpcids=' in url else 'unknown'
    
    # Ignorar RPCs conhecidos
    if rpc_id in ['otAQ7b', 'sJBwce', 'aPya6c', 'cYRIkd', 'GPRiHf', 'maGuAc', 
                 'I4z33b', 'MyzX6c', 'PCck7e', 'VxUbXb', 'ESY5D', 'L5adhe', 'ozz5Z']:
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
                
                if len(payload_str) > 100:
                    print(f"#{i+1:2d} RPC: {rpc_id:10s} | Payload: {len(payload_str):5d} bytes")
                    print(f"   {payload_str[:300]}")
                    print()
            except:
                pass
