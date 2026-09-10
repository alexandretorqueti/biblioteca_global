#!/usr/bin/env python3
"""
Analisa os dados capturados do Gemini para entender o formato do payload
"""

import json
import urllib.parse

with open('/tmp/webai-direct-capture.json') as f:
    data = json.load(f)

print(f"📊 Total de {len(data)} requisições capturadas\n")

# Procurar requisições que podem conter a mensagem
for i, req in enumerate(data):
    url = req['url']
    rpc_id = url.split('rpcids=')[1].split('&')[0] if 'rpcids=' in url else 'unknown'
    
    if req.get('postData'):
        # Decodificar payload
        payload = urllib.parse.unquote(req['postData'])
        
        # Verificar se contém a mensagem
        if 'capital' in payload.lower() or 'brasil' in payload.lower() or 'qual' in payload.lower():
            print(f"🎯 Requisição #{i+1} (RPC: {rpc_id}) - POSSÍVEL MENSAGEM")
            print(f"   URL: {url[:100]}...")
            print(f"   Payload: {payload[:500]}")
            print()
            
            # Tentar extrair o formato
            if payload.startswith('f.req='):
                f_req = payload[6:]  # Remover 'f.req='
                if '&' in f_req:
                    f_req = f_req.split('&')[0]
                
                try:
                    decoded = json.loads(f_req)
                    print(f"   📦 Formato decodificado:")
                    print(json.dumps(decoded, indent=2, ensure_ascii=False)[:1000])
                    print()
                except:
                    print(f"   ⚠️ Não foi possível decodificar como JSON")
                    print()

# Mostrar a requisição com maior payload (provavelmente a resposta)
print("\n" + "="*80)
print("📝 REQUISIÇÕES COM MAIOR PAYLOAD (provavelmente contêm dados importantes):\n")

sorted_reqs = sorted(enumerate(data), key=lambda x: len(x[1].get('postData', '')), reverse=True)

for i, req in sorted_reqs[:5]:
    url = req['url']
    rpc_id = url.split('rpcids=')[1].split('&')[0] if 'rpcids=' in url else 'unknown'
    payload_size = len(req.get('postData', ''))
    
    print(f"{i+1}. RPC: {rpc_id} - {payload_size} bytes")
    
    if req.get('postData'):
        payload = urllib.parse.unquote(req['postData'])
        if payload.startswith('f.req='):
            f_req = payload[6:]
            if '&' in f_req:
                f_req = f_req.split('&')[0]
            
            try:
                decoded = json.loads(f_req)
                print(f"   Payload: {json.dumps(decoded, ensure_ascii=False)[:300]}")
            except:
                print(f"   Payload: {payload[:300]}")
    
    if req.get('response') and req['response'].get('body'):
        body = req['response']['body']
        print(f"   Response: {len(body)} bytes")
        if len(body) < 500:
            print(f"   Body: {body}")
    
    print()
