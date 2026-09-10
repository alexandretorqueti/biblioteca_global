#!/usr/bin/env python3
"""
Extrai o payload completo da requisição, parando em dados binários
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
            # Procurar pelo próximo "&" ou caractere não-ASCII
            end_idx = f_req_idx + 6  # Pular "f.req="
            
            # Extrair caractere por caractere até encontrar "&" ou dado binário
            payload_chars = []
            while end_idx < len(text) and end_idx - f_req_idx < 20000:
                char = text[end_idx]
                
                # Parar se encontrar "&"
                if char == "&":
                    break
                
                # Parar se encontrar caractere de controle ou não-ASCII
                if ord(char) < 32 or ord(char) > 126:
                    break
                
                payload_chars.append(char)
                end_idx += 1
            
            f_req_encoded = "".join(payload_chars)
            
            print("📡 Requisição completa encontrada!")
            print()
            
            # Decodificar URL
            decoded = urllib.parse.unquote(f_req_encoded)
            
            # Salvar em arquivo
            with open("/tmp/gemini-message-payload-clean.txt", "w") as out:
                out.write(decoded)
            
            print(f"✅ Payload salvo em: /tmp/gemini-message-payload-clean.txt")
            print(f"   Tamanho: {len(decoded)} bytes")
            print()
            print("📦 Payload decodificado:")
            print(decoded)
            print()
            
            # Tentar parsear como JSON
            import json
            try:
                json_data = json.loads(decoded)
                print("✅ JSON parseado com sucesso!")
                print()
                print("Estrutura JSON:")
                print(json.dumps(json_data, indent=2, ensure_ascii=False))
            except Exception as e:
                print(f"⚠️ Erro ao parsear JSON: {e}")
else:
    print("❌ Padrão não encontrado")
