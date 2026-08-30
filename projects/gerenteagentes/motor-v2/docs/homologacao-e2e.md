# Matriz de Homologação — Motor v2

Validação do motor-v2 em ambiente remoto/homologação (container
`biblioteca-global-api`, motor em `http://127.0.0.1:3010` dentro do container).
Ferramenta: `scripts/run-e2e.sh` (somente modo `smoke`, local/não versionado).

> **Status (2026-08-30):** matriz executada. Em seguida, os fixtures
> (projeto 5 e tarefas 727–730), o modo `matriz` do script e o testbed
> isolado (`e2e-testbed.sh`) foram **removidos** a pedido do Alexandre —
> não deve ficar no projeto nada que sirva apenas para simular situações.
> Este documento permanece como registro histórico da validação.

## Estados de referência (fixtures de 2026-08-30 — REMOVIDOS)

| Fixture | Propósito | Estado final antes da remoção |
| --- | --- | --- |
| Projeto 5 (`motor-v2-fixture`) | repo local `/tmp/motor-fixture-repo` + remote bare; build `true`, test `false` (falha determinística) | removido |
| Tarefa 728 (projeto 4) | falha ambiental — repo inexistente | `blocked` (bloqueio persistido) → removida |
| Tarefa 729 (projeto 5) | gate falha repetida → correção automática | correção criada e executada → removida |
| Tarefa 730 (projeto 5) | cancelamento via API | `cancelled` → removida |
| Tarefa 727 | caminho feliz completo | `completed` → removida |

## Cenários da matriz

| # | Cenário | Como dispara | Critério de aceite |
| --- | --- | --- | --- |
| 1 | Caminho feliz | tarefa nova no projeto fixture + `enqueue` | análise → plano → execução → gate verde → publish → merge; tarefa `completed` |
| 2 | Rework/escada de modelos | tarefa 729 reenfileirada | gate falha → rework até `max_rework` → subtarefa de correção automática; escada sobe quando modelo local indisponível |
| 3 | Bloqueio ambiental | tarefa 728 reenfileirada | `blocked_environment` em `bloqueios`; subtarefa e tarefa `blocked`; sem loop |
| 4 | Pausa/retomada | `pause` durante o cenário 2, depois `resume` | worker encerrado (SIGKILL), subtarefa de volta a `pending`, retomada do ponto certo |
| 5 | Cancelamento | `cancel` em tarefa em execução | tarefa `cancelled`, worker encerrado, lease liberado |
| 6 | Concorrência | `MOTOR_MAX_WORKERS=2` + duas tarefas de projetos diferentes | `stats.workers[]` com 2 entradas; as duas completam sem interleaving no mesmo repositório |

## Execução

```bash
# seguro, sem disparar nada (checagem pós-deploy):
scripts/run-e2e.sh smoke --url http://127.0.0.1:3010
```

O modo `matriz` (que reenfileirava os fixtures 728/729) foi removido junto
com os fixtures.

## Regras

- **Nunca disparar cenários de homologação sem instrução explícita do Alexandre** —
  cada execução consome LLM e move código em repositório real.
- O cenário 6 exigiu subir `MOTOR_MAX_WORKERS=2` no ambiente do motor —
  autorizado pelo Alexandre em 2026-08-30 (deploy P1).
- Registrar resultado de cada cenário nesta tabela ao concluir:

| # | Data | Resultado | Evidência |
| --- | --- | --- | --- |
| smoke | 2026-08-30 | ✅ health/stats(workers[])/pump OK no build novo | deploy P1, memory/2026-08-30 |
| 1 | 2026-08-30 | ✅ completed (tarefa 727, P0) | commit `4e56cfc` |
| 2 | 2026-08-30 | ✅ correção criada e executada no build novo (gate determinístico) | memory/2026-08-30 |
| 3 | 2026-08-30 | ✅ blocked_environment persistido, revalidado no build novo | memory/2026-08-30 |
| 4 | 2026-08-30 | ✅ pause/resume validado (P0) | memory/2026-08-30 |
| 5 | 2026-08-30 | ✅ cancel validado (P0) | memory/2026-08-30 |
| 6 | — | a validar com as tarefas reais do Alexandre (`MOTOR_MAX_WORKERS=2` já ativo) | — |
