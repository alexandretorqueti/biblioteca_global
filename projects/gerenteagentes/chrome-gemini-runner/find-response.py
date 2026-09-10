#!/usr/bin/env python3
"""
Procura pela resposta que contém "Brasília" ou "capital" para encontrar a requisição correta
"""

import json
import urllib.parse

with open('/tmp/webai-direct-capture.json') as f:
    data = json.load(f)

print("🔍 Procurando pela resposta que contém 'Brasília' ou 'capital'...\n")

# Procurar em todas as responses
for i, req in enumerate(data):
    url = req['url']
    rpc_id = url.split('rpcids=')[1].split('&')[0] if 'rpcids=' in url else 'unknown'
    
    if req.get('response') and req['response'].get('body'):
        body = req['response']['body']
        
        # Procurar por Brasília ou capital na resposta
        if 'brasília' in body.lower() or 'brasilia' in body.lower() or ('capital' in body.lower() and 'brasil' in body.lower()):
            print(f"🎯 RESPOSTA ENCONTRADA! Requisição #{i+1} (RPC: {rpc_id})")
            print(f"   URL: {url}")
            print(f"   Response size: {len(body)} bytes")
            print(f"\n   Response body (primeiros 2000 chars):")
            print(body[:2000])
            print("\n" + "="*80 + "\n")
            
            # Agora procurar a requisição correspondente
            print(f"📤 Procurando a requisição que gerou essa resposta...\n")
            
            # A requisição deve ter o mesmo RPC ID
            for j, req2 in enumerate(data):
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
                            print(f"   Raw payload: {payload[:1000]}")
                    
                    print()

# Se não encontrou, mostrar todas as responses grandes
print("\n" + "="*80)
print("\n📝 TODAS AS RESPONSES GRANDES (> 1000 bytes):\n")

for i, req in enumerate(data):
    url = req['url']
    rpc_id = url.split('rpcids=')[1].split('&')[0] if 'rpcids=' in url else 'unknown'
    
    if req.get('response') and req['response'].get('body'):
        body = req['response']['body']
        
        if len(body) > 1000:
            print(f"#{i+1:2d} RPC: {rpc_id:10s} | Response: {len(body):5d} bytes")
            
            # Verificar se contém palavras-chave
            if any(word in body.lower() for word in ['brasília', 'brasilia', 'capital', 'brasil']):
                print(f"   🎯 CONTÉM PALAVRAS-CHAVE!")
            
            # Mostrar preview
            print(f"   Preview: {body[:300]}")
            print()
