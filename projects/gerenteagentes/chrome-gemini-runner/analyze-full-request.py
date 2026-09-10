#!/usr/bin/env python3
"""
Analisa a captura completa da requisição StreamGenerate do Gemini
Extrai e documenta o formato exato do payload e da resposta
"""

import json
import urllib.parse

with open("/tmp/gemini-full-request.json") as f:
    data = json.load(f)

req = data[0]

print("=" * 80)
print("📡 URL COMPLETA:")
print(req["url"])
print()
print("=" * 80)
print("📨 HEADERS:")
for k, v in req["headers"].items():
    # Ocultar cookies (são longos e sensíveis)
    if k.lower() == "cookie":
        print(f"  {k}: <{len(v)} bytes - OCULTO>")
    else:
        print(f"  {k}: {v}")
print()

print("=" * 80)
print("📦 POSTDATA (decodificado):")
post_data = req["postData"]

# Parsear o form data
params = urllib.parse.parse_qs(post_data)
for key, values in params.items():
    print(f"\n--- {key} ---")
    for v in values:
        if len(v) > 3000:
            print(v[:3000] + "\n... [TRUNCADO]")
        else:
            print(v)

print()
print("=" * 80)
print("📥 RESPONSE BODY (formato raw):")
body = req.get("response", {}).get("body", "")
print(body[:4000])
print()

# Analisar estrutura do payload f.req
print("=" * 80)
print("🔬 ANÁLISE ESTRUTURAL DO f.req:")
f_req = params.get("f.req", [""])[0]
try:
    parsed = json.loads(f_req)
    print(f"Tipo: {type(parsed).__name__}, len: {len(parsed)}")
    for i, item in enumerate(parsed):
        if isinstance(item, str) and len(item) > 100:
            print(f"\n[{i}] STRING ({len(item)} chars):")
            # Tentar parsear como JSON aninhado
            try:
                nested = json.loads(item)
                print(json.dumps(nested, indent=2, ensure_ascii=False)[:4000])
            except Exception as e:
                print(f"  (não é JSON: {e})")
                print(f"  {item[:1500]}")
        else:
            print(f"\n[{i}] {repr(item)[:300]}")
except Exception as e:
    print(f"Erro: {e}")

# Analisar resposta
print()
print("=" * 80)
print("🔬 ANÁLISE ESTRUTURAL DA RESPOSTA:")
# Formato: )]}'\n\n<size>\n<json>\n...
lines = body.split("\n")
for i, line in enumerate(lines):
    line = line.strip()
    if line.startswith("[["):
        try:
            resp_json = json.loads(line)
            # wrb.fr contém a resposta principal
            if resp_json and resp_json[0] and resp_json[0][0] == "wrb.fr":
                rpc_id = resp_json[0][1]
                inner = resp_json[0][2]
                print(f"\nRPC: {rpc_id}")
                print(f"Inner ({len(inner)} chars):")
                try:
                    inner_parsed = json.loads(inner)
                    # A resposta do Gemini está tipicamente em inner_parsed[0][2] ou [4]
                    # Mostrar estrutura
                    def walk(obj, path="", depth=0):
                        if depth > 4:
                            return
                        if isinstance(obj, list):
                            for j, item in enumerate(obj):
                                if isinstance(item, str) and len(item) > 30:
                                    print(f"  {path}[{j}]: ({len(item)} chars) {item[:400]}")
                                elif isinstance(item, list):
                                    walk(item, f"{path}[{j}]", depth + 1)
                    walk(inner_parsed)
                except Exception as e:
                    print(f"  (parse erro: {e})")
                    print(f"  {inner[:1000]}")
        except Exception:
            pass
