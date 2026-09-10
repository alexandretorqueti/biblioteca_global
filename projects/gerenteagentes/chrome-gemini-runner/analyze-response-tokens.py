#!/usr/bin/env python3
"""
Analisa a resposta do servidor para encontrar onde o token template[3] é atualizado
"""
import json

with open("/tmp/chain-analysis.json") as f:
    data = json.load(f)

exchanges = data["exchanges"]

print("=== ANÁLISE RESPOSTA → TOKEN ===")
print()

for i in range(len(exchanges) - 1):
    curr = exchanges[i]
    next_ex = exchanges[i + 1]
    
    curr_tok3 = curr["template"][3]
    next_tok3 = next_ex["template"][3]
    response = curr["responseFirst500"]
    
    print(f"Exchange {i} → {i+1}:")
    print(f"  Token req[{i}] ({len(curr_tok3)} chars): {curr_tok3[:60]}...")
    print(f"  Token req[{i+1}] ({len(next_tok3)} chars): {next_tok3[:60]}...")
    print(f"  Diferença de tamanho: {len(next_tok3) - len(curr_tok3)} chars")
    print(f"  Response[{i}] first 200: {response[:200]}")
    print()
    
    # Procurar fragmentos do próximo token na resposta
    # O token pode estar codificado (URL-encoded, base64, etc.)
    fragments_to_check = [
        next_tok3[10:50],   # fragmento do início
        next_tok3[100:140], # fragmento do meio
        next_tok3[-50:],    # fragmento do fim
    ]
    
    for j, frag in enumerate(fragments_to_check):
        if frag in response:
            print(f"  ✅ Fragmento {j} encontrado na resposta!")
        else:
            print(f"  ❌ Fragmento {j} NÃO encontrado na resposta")
    
    # Verificar se o token novo contém o token antigo como prefixo
    if next_tok3.startswith(curr_tok3[:20]):
        print(f"  ✅ Token novo começa com prefixo do token antigo")
    else:
        print(f"  ❌ Token novo NÃO começa com prefixo do token antigo")
    
    print()

# Análise detalhada: comparar token antigo vs novo char por char
print("=== COMPARAÇÃO CHAR-BY-CHAR ===")
t0 = exchanges[0]["template"][3]
t1 = exchanges[1]["template"][3]

# Encontrar a primeira diferença
first_diff = 0
while first_diff < min(len(t0), len(t1)) and t0[first_diff] == t1[first_diff]:
    first_diff += 1

print(f"Primeira diferença entre token[0] e token[1]: posição {first_diff}")
print(f"  token[0][{first_diff}:{first_diff+20}]: {t0[first_diff:first_diff+20]}")
print(f"  token[1][{first_diff}:{first_diff+20}]: {t1[first_diff:first_diff+20]}")

# Encontrar onde voltam a ser iguais
same_again = first_diff
while same_again < min(len(t0), len(t1)) and t0[same_again] != t1[same_again]:
    same_again += 1

print(f"\nVoltam a ser iguais na posição: {same_again}")
print(f"  Parte diferente token[0] ({same_again - first_diff} chars): {t0[first_diff:same_again]}")
print(f"  Parte diferente token[1] ({same_again - first_diff} chars): {t1[first_diff:same_again]}")

# Verificar se o resto é igual
rest_equal = t0[same_again:] == t1[same_again:same_again + len(t0) - same_again]
print(f"\nResto é igual? {rest_equal}")
if not rest_equal:
    # Encontrar próxima diferença
    next_diff = same_again
    while next_diff < min(len(t0), len(t1)) and t0[next_diff] == t1[next_diff]:
        next_diff += 1
    print(f"Próxima diferença na posição: {next_diff}")

# Análise da resposta completa (não só first 500)
print("\n=== ANÁLISE RESPOSTA COMPLETA ===")
for i, e in enumerate(exchanges):
    resp_len = e.get("responseLen", 0)
    print(f"Response[{i}]: {resp_len} bytes")
