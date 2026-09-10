#!/usr/bin/env python3
"""
Analisa todas as requisições para encontrar o padrão de envio de mensagem
"""

import json
import urllib.parse

with open('/tmp/webai-direct-capture.json') as f:
    data = json.load(f)

print("🔍 Análise completa de todas as requisições...\n")

# Mostrar todas as requisições em ordem
for i, req in enumerate(data):
    url = req['url']
    rpc_id = url.split('rpcids=')[1].split('&')[0] if 'rpcids=' in url else 'unknown'
    
    payload_size = len(req.get('postData', ''))
    response_size = len(req.get('response', {}).get('body', ''))
    
    print(f"#{i+1:2d} RPC: {rpc_id:10s} | Payload: {payload_size:5d} bytes | Response: {response_size:5d} bytes")
    
    if req.get('postData'):
        payload = urllib.parse.unquote(req['postData'])
        if payload.startswith('f.req='):
            f_req = payload[6:]
            if '&' in f_req:
                f_req = f_req.split('&')[0]
            
            try:
                decoded = json.loads(f_req)
                # Mostrar apenas o segundo elemento (payload real)
                if len(decoded) > 0 and len(decoded[0]) > 1:
                    inner_payload = decoded[0][1] if len(decoded[0]) > 1 else ''
                    print(f"      Inner payload: {inner_payload[:200]}")
            except:
                print(f"      Raw: {payload[:200]}")
    
    print()

# Procurar especificamente por requisições que podem conter a mensagem
print("\n" + "="*80)
print("\n🎯 PROCURANDO POR PADRÕES DE MENSAGEM DO USUÁRIO...\n")

for i, req in enumerate(data):
    url = req['url']
    rpc_id = url.split('rpcids=')[1].split('&')[0] if 'rpcids=' in url else 'unknown'
    
    if req.get('postData'):
        payload = urllib.parse.unquote(req['postData'])
        
        # Procurar padrões que podem indicar mensagem do usuário
        # Geralmente contém: strings longas, arrays com texto, ou padrões específicos
        if payload.startswith('f.req='):
            f_req = payload[6:]
            if '&' in f_req:
                f_req = f_req.split('&')[0]
            
            try:
                decoded = json.loads(f_req)
                
                # Verificar se o payload contém strings que parecem ser mensagens
                payload_str = json.dumps(decoded)
                
                # Procurar por padrões suspeitos
                if any(pattern in payload_str for pattern in ['"qual', '"capital', '"brasil', 'capital do']):
                    print(f"🎯 ENCONTRADA! Requisição #{i+1} (RPC: {rpc_id})")
                    print(f"   Payload completo: {json.dumps(decoded, indent=2, ensure_ascii=False)}")
                    print()
                
                # Verificar se tem strings longas (possíveis mensagens)
                if len(payload_str) > 200 and rpc_id not in ['ESY5D', 'L5adhe', 'ozz5Z']:
                    print(f"📝 Payload grande: #{i+1} (RPC: {rpc_id}) - {len(payload_str)} bytes")
                    print(f"   {payload_str[:500]}")
                    print()
                    
            except Exception as e:
                pass

# Mostrar a requisição que provavelmente é a mensagem (baseado no timing)
print("\n" + "="*80)
print("\n📋 REQUISIÇÕES NO MOMENTO DA PERGUNTA (após 'Fazendo pergunta...'):\n")

# A pergunta foi feita após o log "💬 Fazendo pergunta..."
# Vou procurar requisições que foram enviadas nesse momento
# Baseado no log, as requisições após #31 são as mais prováveis

for i in range(30, len(data)):
    req = data[i]
    url = req['url']
    rpc_id = url.split('rpcids=')[1].split('&')[0] if 'rpcids=' in url else 'unknown'
    
    print(f"#{i+1:2d} RPC: {rpc_id}")
    
    if req.get('postData'):
        payload = urllib.parse.unquote(req['postData'])
        if payload.startswith('f.req='):
            f_req = payload[6:]
            if '&' in f_req:
                f_req = f_req.split('&')[0]
            
            try:
                decoded = json.loads(f_req)
                print(f"   Payload: {json.dumps(decoded, ensure_ascii=False)[:500]}")
            except:
                print(f"   Raw: {payload[:500]}")
    
    if req.get('response') and req['response'].get('body'):
        body = req['response']['body']
        print(f"   Response: {len(body)} bytes")
        if 'capital' in body.lower() or 'brasília' in body.lower() or 'brasilia' in body.lower():
            print(f"   🎯 CONTÉM RESPOSTA!")
            print(f"   Body preview: {body[:500]}")
    
    print()
