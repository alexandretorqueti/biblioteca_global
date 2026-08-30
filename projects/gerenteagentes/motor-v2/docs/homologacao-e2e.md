# Matriz de Homologação — Motor v2

Validação do motor-v2 em ambiente remoto/homologação (container
`biblioteca-global-api`, motor em `http://127.0.0.1:3010` dentro do container).
Ferramenta: `scripts/run-e2e.sh`. O testbed totalmente isolado (containers
dedicados, sem LLM real) continua em `scripts/e2e-testbed.sh`.

## Estados de referência (fixtures de 2026-08-30)

| Fixture | Propósito | Estado após P0 |
| --- | --- | --- |
| Projeto 5 (`motor-v2-fixture`) | repo local `/tmp/motor-fixture-repo` + remote bare; build `true`, test `false` (falha determinística) | ativo |
| Tarefa 728 (projeto 4) | falha ambiental — repo inexistente | `blocked` (bloqueio persistido) |
| Tarefa 729 (projeto 5) | gate falha repetida → correção automática | `blocked` (worktree órfão reportado) |
| Tarefa 730 (projeto 5) | cancelamento via API | `cancelled` |
| Tarefa 727 | caminho feliz completo | `completed` |

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
# seguro, sem disparar nada:
scripts/run-e2e.sh smoke --url http://127.0.0.1:3010

# matriz completa (dispara tarefas reais; exige decisão explícita):
MOTOR_E2E_MYSQL_CMD='docker exec -i biblioteca-global-api mysql -uroot -p<senha> projeto_640' \
  scripts/run-e2e.sh matriz --autorizo --url http://127.0.0.1:3010
```

## Regras

- **Nunca disparar a matriz sem instrução explícita do Alexandre** — cada
  execução consome LLM e move código em repositório real.
- O cenário 6 exige subir `MOTOR_MAX_WORKERS=2` no ambiente do motor — decisão
  de rollout do Alexandre (o padrão de produção permanece 1).
- Registrar resultado de cada cenário nesta tabela ao concluir:

| # | Data | Resultado | Evidência |
| --- | --- | --- | --- |
| smoke | 2026-08-30 | a validar | — |
| 1 | 2026-08-30 | ✅ completed (tarefa 727, P0) | commit `4e56cfc` |
| 2 | 2026-08-30 | ✅ correção automática criada (P0) | memory/2026-08-30 |
| 3 | 2026-08-30 | ✅ blocked_environment persistido (P0) | memory/2026-08-30 |
| 4 | 2026-08-30 | ✅ pause/resume validado (P0) | memory/2026-08-30 |
| 5 | 2026-08-30 | ✅ cancel validado (P0) | memory/2026-08-30 |
| 6 | — | pendente (decisão de janela: `MOTOR_MAX_WORKERS=2`) | — |
