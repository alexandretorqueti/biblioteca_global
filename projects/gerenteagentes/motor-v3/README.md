# Motor-v3

Motor de orquestração de agentes event-driven da Global Tecnologia.

- **Status:** em desenvolvimento (big-bang a partir de 2026-09-16, branch `motor-v3`)
- **Padrão de arquitetura:** `docs/MOTOR-V3-EVENT-DRIVEN.md` (workspace do agente gerenteagentes)
- **Mapeamento v2 + decisões D1–D8 + buracos B01–B22:** `docs/MOTOR-V2-SIMULACAO-TEXTUAL.md` (idem)
- **LOG de execução (ponto atual, ações, erros, correções):** `docs/MOTOR-V3-LOG.md` (idem)
- **Motor-v2:** PARADO por decisão do Alexandre (16/09). Não religar até o v3 estar validado.

Princípios v3 (aprovados 16/09):
1. Conversa livre com o agente; validação pela REALIDADE (diff/build/testes), não por auto-relato JSON.
2. Muros de capacidade (sandbox/mounts/rede), não de instrução (prompt).
3. Motor faz o bookkeeping git (commit/merge/publish/promote/deploy).
4. Catálogo configurável de eventos/patterns/reações; Monitor (modelo caro) cataloga o não previsto.
