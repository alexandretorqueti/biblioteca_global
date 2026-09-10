#!/usr/bin/env python3
"""
Extrai o payload completo da requisição que contém a mensagem do usuário
"""

import re
import urllib.parse

with open("/tmp/realtime-monitor.log", "rb") as f:
    content = f.read()

# Procurar por "qual%20e%20a%20capital" (URL encoded)
pattern = b"qual%20e%20a%20capital"
idx = content.find(pattern)

if idx != -1:
    # Extrair contexto maior
    start = max(0, idx - 2000)
    end = min(len(content), idx + 20000)
    context = content[start:end]
    
    # Extrair apenas texto legível
    text = context.decode("utf-8", errors="ignore")
    
    # Procurar por "f.req=" antes da mensagem
    msg_idx = text.find("qual%20e%20a%20capital")
    if msg_idx != -1:
        # Voltar para encontrar "f.req="
        f_req_idx = text.rfind("f.req=", 0, msg_idx)
        
        if f_req_idx != -1:
            # Extrair o payload completo
            # Procurar pelo próximo "&" ou fim da linha
            end_idx = text.find("&", f_req_idx)
            if end_idx == -1 or end_idx - f_req_idx > 20000:
                end_idx = f_req_idx + 20000
            
            f_req = text[f_req_idx:end_idx]
            
            print("📡 Requisição completa encontrada!")
            print()
            
            # Decodificar URL
            if f_req.startswith("f.req="):
                decoded = urllib.parse.unquote(f_req[6:])
                
                # Salvar em arquivo
                with open("/tmp/gemini-message-payload.txt", "w") as out:
                    out.write(decoded)
                
                print(f"✅ Payload salvo em: /tmp/gemini-message-payload.txt")
                print(f"   Tamanho: {len(decoded)} bytes")
                print()
                print("📦 Payload decodificado (primeiros 10000 chars):")
                print(decoded[:10000])
else:
    print("❌ Padrão não encontrado")
