#!/usr/bin/env python3
"""
Procura especificamente pela resposta que contém 'Brasília' (a resposta real)
"""

import json
import urllib.parse

with open('/tmp/webai-direct-capture.json') as f:
    data = json.load(f)

print("🔍 Procurando pela resposta que contém 'Brasília' (resposta real)...\n")

# Procurar em todas as responses
found = False
for i, req in enumerate(data):
    url = req['url']
    rpc_id = url.split('rpcids=')[1].split('&')[0] if 'rpcids=' in url else 'unknown'
    
    if req.get('response') and req['response'].get('body'):
        body = req['response']['body']
        
        # Procurar especificamente por Brasília (a resposta real)
        if 'brasília' in body.lower():
            found = True
            print(f"🎯 RESPOSTA REAL ENCONTRADA! Requisição #{i+1} (RPC: {rpc_id})")
            print(f"   URL: {url}")
            print(f"   Response size: {len(body)} bytes")
            print(f"\n   Response body (primeiros 3000 chars):")
            print(body[:3000])
            print("\n" + "="*80 + "\n")
            
            # Agora procurar a requisição correspondente
            print(f"📤 Procurando a requisição que gerou essa resposta...\n")
            
            # A requisição deve ter o mesmo RPC ID e ser enviada antes
            for j, req2 in enumerate(data):
                if j >= i:
                    break
                    
                url2 = req2['url']
                rpc_id2 = url2.split('rpcids=')[1].split('&')[0] if 'rpcids=' in url2 else 'unknown'
                
                if rpc_id2 == rpc_id and req2.get('postData'):
                    print(f"   Requisição #{j+1} (RPC: {rpc_id2})")
                    payload = urllib.parse.unquote(req2['postData'])
                    
                    if payload.startswith('f.req='):
                        f_req = payload[6:]
                        if '&' in f_req:
                            f_req = f_req.split('&')[0]
                        
                        try:
                            decoded = json.loads(f_req)
                            print(f"   Payload: {json.dumps(decoded, indent=2, ensure_ascii=False)}")
                        except:
                            print(f"   Raw payload: {payload[:2000]}")
                    
                    print()

if not found:
    print("❌ Resposta com 'Brasília' não encontrada")
    print("\n🔍 Procurando por outras variações...\n")
    
    # Procurar por variações
    for i, req in enumerate(data):
        url = req['url']
        rpc_id = url.split('rpcids=')[1].split('&')[0] if 'rpcids=' in url else 'unknown'
        
        if req.get('response') and req['response'].get('body'):
            body = req['response']['body']
            
            # Procurar por variações
            if any(variant in body.lower() for variant in ['distrito federal', 'capital federal', 'planalto central']):
                print(f"📝 Possível resposta encontrada! Requisição #{i+1} (RPC: {rpc_id})")
                print(f"   Response size: {len(body)} bytes")
                print(f"   Preview: {body[:500]}")
                print()

# Mostrar todas as responses que contêm texto substancial
print("\n" + "="*80)
print("\n📝 TODAS AS RESPONSES COM TEXTO SUBSTANCIAL (> 5000 bytes):\n")

for i, req in enumerate(data):
    url = req['url']
    rpc_id = url.split('rpcids=')[1].split('&')[0] if 'rpcids=' in url else 'unknown'
    
    if req.get('response') and req['response'].get('body'):
        body = req['response']['body']
        
        if len(body) > 5000:
            print(f"#{i+1:2d} RPC: {rpc_id:10s} | Response: {len(body):5d} bytes")
            
            # Verificar se contém palavras-chave
            keywords = []
            if 'brasília' in body.lower():
                keywords.append('Brasília')
            if 'capital' in body.lower():
                keywords.append('capital')
            if 'brasil' in body.lower():
                keywords.append('Brasil')
            
            if keywords:
                print(f"   🎯 Keywords: {', '.join(keywords)}")
            
            # Mostrar preview
            print(f"   Preview: {body[:300]}")
            print()
