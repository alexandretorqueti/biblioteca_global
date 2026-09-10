#!/usr/bin/env python3
"""
Extrai o texto real da resposta #8 (MaZiqc) que contém a resposta da pergunta
"""

import json

with open("/tmp/webai-direct-capture.json") as f:
    data = json.load(f)

# Requisição #8 (MaZiqc) - resposta com 11993 bytes
req = data[7]  # index 7 = #8
body = req["response"]["body"]

print("📥 Resposta #8 (MaZiqc) - 11993 bytes")
print("="*80)
print()

# Remover prefixo )]}'\n\n11893\n
lines = body.split("\n")

# Encontrar a linha que contém o JSON
for line in lines:
    line = line.strip()
    if line.startswith("[[") or line.startswith("["):
        try:
            decoded = json.loads(line)
            
            # Procurar por texto real na resposta
            def find_text(obj, path="", depth=0):
                if depth > 15:
                    return
                if isinstance(obj, str) and len(obj) > 30:
                    # Verificar se contém palavras-chave
                    keywords = ["país", "pais", "seguro", "atomico", "atômico", 
                               "nova zelândia", "suíça", "suécia", "austrália",
                               "ataque", "nuclear", "morar"]
                    if any(word in obj.lower() for word in keywords):
                        print(f"📝 Texto encontrado em {path} (len={len(obj)}):")
                        print(obj[:2000])
                        print()
                elif isinstance(obj, list):
                    for i, item in enumerate(obj):
                        find_text(item, f"{path}[{i}]", depth+1)
                elif isinstance(obj, dict):
                    for key, value in obj.items():
                        find_text(value, f"{path}.{key}", depth+1)
            
            find_text(decoded)
            
        except json.JSONDecodeError:
            pass

# Também mostrar a estrutura geral
print("\n" + "="*80)
print("\n🔍 ESTRUTURA GERAL DA RESPOSTA:\n")

for line in lines:
    line = line.strip()
    if line.startswith("[[") or line.startswith("["):
        try:
            decoded = json.loads(line)
            # Mostrar a estrutura (sem o conteúdo completo)
            def show_structure(obj, indent=0, max_depth=3):
                if indent > max_depth:
                    return "..."
                if isinstance(obj, str):
                    if len(obj) > 50:
                        return f'"{obj[:50]}..."'
                    return f'"{obj}"'
                elif isinstance(obj, list):
                    if len(obj) > 5:
                        return "[" + ", ".join([show_structure(item, indent+1, max_depth) for item in obj[:3]]) + ", ...]"
                    return "[" + ", ".join([show_structure(item, indent+1, max_depth) for item in obj]) + "]"
                elif isinstance(obj, dict):
                    return "{" + ", ".join([f'"{k}": {show_structure(v, indent+1, max_depth)}' for k, v in list(obj.items())[:3]]) + "}"
                else:
                    return str(obj)
            
            print(show_structure(decoded, max_depth=2))
            
        except:
            pass
