#!/usr/bin/env python3
"""
Procura especificamente pela requisição que envia a mensagem do usuário
Análise detalhada de todas as requisições após a pergunta
"""

import json
import urllib.parse

with open('/tmp/webai-direct-capture.json') as f:
    data = json.load(f)

print("🔍 Análise detalhada das requisições após a pergunta...\n")

# Baseado no log, a pergunta foi feita após "💬 Fazendo pergunta..."
# As requisições após #31 são as mais prováveis

print("📋 ANÁLISE COMPLETA DAS REQUISIÇÕES #31-#44:\n")

for i in range(30, len(data)):
    req = data[i]
    url = req['url']
    rpc_id = url.split('rpcids=')[1].split('&')[0] if 'rpcids=' in url else 'unknown'
    
    print(f"\n{'='*80}")
    print(f"REQUISIÇÃO #{i+1} (RPC: {rpc_id})")
    print(f"{'='*80}")
    
    # Mostrar payload completo
    if req.get('postData'):
        payload = urllib.parse.unquote(req['postData'])
        print(f"\n📤 PAYLOAD:")
        
        if payload.startswith('f.req='):
            f_req = payload[6:]
            if '&' in f_req:
                f_req = f_req.split('&')[0]
            
            try:
                decoded = json.loads(f_req)
                print(json.dumps(decoded, indent=2, ensure_ascii=False))
            except:
                print(payload)
    
    # Mostrar response completo
    if req.get('response') and req['response'].get('body'):
        body = req['response']['body']
        print(f"\n📥 RESPONSE ({len(body)} bytes):")
        
        # Tentar decodificar
        if body.startswith(")]}'"):
            # Remover prefixo
            lines = body.split('\n')
            if len(lines) > 1:
                # Pegar a segunda linha (JSON)
                json_line = lines[1]
                try:
                    decoded = json.loads(json_line)
                    print(json.dumps(decoded, indent=2, ensure_ascii=False)[:2000])
                except:
                    print(body[:2000])
        else:
            print(body[:2000])

# Procurar especificamente por requisições que podem conter a mensagem
print("\n\n" + "="*80)
print("🎯 PROCURANDO POR REQUISIÇÕES COM MENSAGEM DO USUÁRIO...\n")

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
                payload_str = json.dumps(decoded, ensure_ascii=False)
                
                # Procurar por padrões que indicam mensagem do usuário
                # Geralmente contém strings longas ou arrays com texto
                if len(payload_str) > 200 and rpc_id not in ['ESY5D', 'L5adhe', 'ozz5Z', 'otAQ7b', 'MaZiqc']:
                    print(f"📝 Requisição #{i+1} (RPC: {rpc_id}) - {len(payload_str)} bytes")
                    print(f"   Payload: {payload_str[:500]}")
                    
                    # Verificar se contém a mensagem
                    if 'capital' in payload_str.lower() or 'brasil' in payload_str.lower() or 'qual' in payload_str.lower():
                        print(f"   🎯 CONTÉM PALAVRAS-CHAVE!")
                    
                    print()
            except:
                pass
