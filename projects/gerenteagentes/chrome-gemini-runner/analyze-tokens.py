#!/usr/bin/env python3
import json

with open("/tmp/chain-analysis.json") as f:
    data = json.load(f)

exchanges = data["exchanges"]

# Analisar template[3] em detalhe
print("=== ANÁLISE DETALHADA template[3] ===")
tokens3 = [e["template"][3] for e in exchanges]

for i, t in enumerate(tokens3):
    print(f"\nReq {i} ({len(t)} chars):")
    print(f"   Primeiros 80: {t[:80]}")
    print(f"   Últimos 80:   {t[-80:]}")

# Encontrar onde os tokens divergem
print("\n=== COMPARAÇÃO PAR A PAR ===")
for i in range(len(tokens3) - 1):
    a = tokens3[i]
    b = tokens3[i+1]
    
    # Sufixo comum (a partir do final)
    suffix_len = 0
    while suffix_len < min(len(a), len(b)) and a[-(suffix_len+1)] == b[-(suffix_len+1)]:
        suffix_len += 1
    
    # Prefixo comum (do início)
    prefix_len = 0
    while prefix_len < min(len(a), len(b)) and a[prefix_len] == b[prefix_len]:
        prefix_len += 1
    
    none_str = "(nenhum)"
    suffix_a = a[-suffix_len:] if suffix_len > 0 else none_str
    var_a = a[prefix_len:len(a)-suffix_len] if suffix_len > 0 else a[prefix_len:]
    var_b = b[prefix_len:len(b)-suffix_len] if suffix_len > 0 else b[prefix_len:]
    
    print(f"\nReq {i} vs {i+1}:")
    print(f"   Prefixo comum (início): {prefix_len} chars: '{a[:prefix_len]}'")
    print(f"   Sufixo comum (fim): {suffix_len} chars: '{suffix_a}'")
    print(f"   Parte variável req{i} ({len(var_a)} chars): '{var_a}'")
    print(f"   Parte variável req{i+1} ({len(var_b)} chars): '{var_b}'")

# Comparação 3-way (todos os 3 tokens)
print("\n=== COMPARAÇÃO 3-WAY ===")
# Encontrar sufixo comum a TODOS os 3
min_len = min(len(t) for t in tokens3)
suffix_all = 0
while suffix_all < min_len and all(t[-(suffix_all+1)] == tokens3[0][-(suffix_all+1)] for t in tokens3):
    suffix_all += 1

print(f"Sufixo comum a TODOS os 3: {suffix_all} chars")
if suffix_all > 0:
    print(f"   '{tokens3[0][-suffix_all:]}'")

# Prefixo comum a todos
prefix_all = 0
while prefix_all < min_len and all(t[prefix_all] == tokens3[0][prefix_all] for t in tokens3):
    prefix_all += 1
print(f"Prefixo comum a TODOS os 3: {prefix_all} chars: '{tokens3[0][:prefix_all]}'")

# Analisar template[2][9]
print("\n=== ANÁLISE template[2][9] ===")
tokens29 = [str(e["template"][2][9]) for e in exchanges]
for i, t in enumerate(tokens29):
    print(f"Req {i}: {t}")

# Prefixo e sufixo comuns
prefix29 = 0
while prefix29 < min(len(tokens29[0]), len(tokens29[1])) and tokens29[0][prefix29] == tokens29[1][prefix29]:
    prefix29 += 1
suffix29 = 0
while suffix29 < min(len(tokens29[0]), len(tokens29[1])) and tokens29[0][-(suffix29+1)] == tokens29[1][-(suffix29+1)]:
    suffix29 += 1

none_str = "(nenhum)"
print(f"\nPrefixo comum: {prefix29} chars: '{tokens29[0][:prefix29]}'")
sufix_str = tokens29[0][-suffix29:] if suffix29 > 0 else none_str
print(f"Sufixo comum: {suffix29} chars: '{sufix_str}'")

# Parte variável
for i, t in enumerate(tokens29):
    var = t[prefix29:len(t)-suffix29] if suffix29 > 0 else t[prefix29:]
    print(f"   Req {i} variável: '{var}'")

# Analisar template[4] (hash)
print("\n=== ANÁLISE template[4] (hash) ===")
for i, e in enumerate(exchanges):
    msg = e["template"][0][0]
    h = e["template"][4]
    print(f"Req {i}: hash={h}, msg=\"{msg}\"")
