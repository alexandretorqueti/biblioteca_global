# Mapeamento de transições — Acompanhamento de tarefas

## Escopo e conclusão

Este documento registra o comportamento encontrado na tela “Acompanhar Tarefa”, no endpoint usado pelo arrastar e soltar e no fluxo canônico do Motor v2. A interação visual aplica a matriz de destinos manuais abaixo; a validação do backend permanece necessária para impedir bypass da API.

`draft → running` (rascunho → em execução), incluindo o caminho direto `draft → ready`/`draft → analyzing`, deve ser reservado ao Motor. O usuário pode solicitar o início pela ação `POST .../start`, mas essa ação apenas enfileira no Motor; não deve ser substituída por um PATCH manual de status.

## Status usados no acompanhamento

Status canônicos da tarefa: `draft`, `planned`, `analyzing`, `awaiting_clarification`, `ready`, `running`, `paused`, `completed`, `deployed`, `blocked`, `motor_fix`, `failed`, `cancelled`.

Status legados exibidos para compatibilidade: `finalizada`, `deployada`, `aborted`. Eles aparecem nas estações de concluídas, deployadas e encerradas, respectivamente, mas o Motor v2 não os grava.

Origem: `motor-v2/src/shared/task-statuses.ts:20-54`.

## Estações e ponto de entrada da UI

| Estação | Status exibidos | Status enviado ao soltar |
|---|---|---|
| Rascunhos | `draft` | `draft` |
| Planejadas | `planned` | `planned` |
| Em análise | `analyzing` | `analyzing` |
| Prontas / na fila | `ready` | `ready` |
| Em execução | `running` | `running` |
| Concluídas | `completed`, `finalizada` | `completed` |
| Deployadas | `deployed`, `deployada` | `deployed` |
| Aguardando | `awaiting_clarification`, `paused` | `awaiting_clarification` |
| Correção do motor | `motor_fix` | `motor_fix` |
| Atenção | `blocked`, `failed` | `blocked` |
| Encerradas | `cancelled`, `aborted` | `cancelled` |

O cartão é arrastável quando `onMoveTask` existe. Durante `dragover`, a estação só aceita o evento quando a origem e o destino estão na matriz manual; o `drop` repete a validação antes de chamar `onMoveTask`. A tela também repete a guarda antes da atualização otimista e envia `PATCH /gerenteagentes/tarefas/:id/status` somente para destinos aceitos. Drops rejeitados exibem a transição bloqueada no alerta de erro.

## Matriz canônica de transições

As transições abaixo são as aceitas pelo `TaskStateMachine` do Motor. “Permitida” significa permitida pelo fluxo interno do Motor, não necessariamente uma ação que o usuário possa disparar diretamente.

| Origem | Destinos permitidos | Origem da mudança / autoridade |
|---|---|---|
| `draft` | nenhum no `TaskStateMachine` | criação humana/API; para sair, Motor enfileira como `planned` |
| `planned` | `analyzing`, `blocked`, `cancelled` | Motor: iniciar análise, falha ou cancelamento |
| `analyzing` | `ready`, `awaiting_clarification`, `paused`, `blocked`, `cancelled` | Motor/analista; pausa/cancelamento por ação autorizada |
| `awaiting_clarification` | `planned`, `blocked`, `cancelled` | resposta humana encaminhada ao Motor; falha/cancelamento pelo Motor |
| `ready` | `running`, `completed`, `blocked`, `cancelled` | Motor/coordenador; `completed` somente quando a validação permite |
| `running` | `completed`, `ready`, `paused`, `blocked`, `cancelled` | Motor/coordenador ou ações de pausa/cancelamento |
| `paused` | `ready`, `planned`, `blocked`, `cancelled` | Motor: retomar com/sem plano, recuperar, falhar ou cancelar |
| `completed` | `deployed` | Motor: conclusão do deploy |
| `deployed` | nenhum | estado final operacional |
| `blocked` | `cancelled` | cancelamento; desbloqueio é endpoint próprio e recalcula `draft`/`ready` |
| `motor_fix` | nenhum definido | estado de atividade reservado ao Motor; sem transição declarada na máquina |
| `failed` | `cancelled` | cancelamento; reinício passa por ação `start`, não por PATCH |
| `cancelled` | nenhum | estado final |

Fonte: `motor-v2/src/policies/TaskStateMachine.ts:9-75`. A máquina não declara transições para `draft`, `motor_fix` ou estados legados; isso é diferente de dizer que o PATCH atual os bloqueia.

### Matriz de proibição para o usuário

Para o arrastar e soltar, o destino deve ser rejeitado quando não estiver na lista de destinos permitidos da origem acima. Assim, toda combinação não listada é **não permitida**. Em particular:

- `draft → running` é **exclusiva do Motor**; também são exclusivas do Motor as saídas de `draft` para `planned`, `analyzing` ou `ready`.
- O usuário não deve mover manualmente tarefas para estados ativos (`analyzing`, `ready`, `running`, `motor_fix`) nem para resultados (`completed`, `deployed`); esses estados são efeitos do processamento do Motor.
- O usuário pode acionar as operações próprias de iniciar, pausar, retomar, desbloquear e solicitar deploy, sujeitas às validações desses endpoints. Isso não autoriza escrever o status arbitrariamente via PATCH.
- Estados legados (`finalizada`, `deployada`, `aborted`) são somente leitura/visualização e não devem ser destinos de drag-and-drop.

## Backend e persistência

1. `api/gerenteagentes.controller.ts:67-76` expõe `PATCH /gerenteagentes/tarefas/:id/status`, com papéis `admin`, `gerente` e `operador`.
2. `api/gerenteagentes.service.ts:599-614` valida apenas se o destino pertence a `ALL_TASK_STATUSES`, verifica a existência da tarefa e grava diretamente `tarefas.status`. Não consulta o status de origem, não chama `TaskStateMachine` e não distingue usuário de Motor.
3. `motor-v2/src/coordinator/TaskCoordinator.ts:1802-1829` usa `transitionTask` antes de persistir as mudanças internas do Motor; uma transição inválida é registrada como bloqueio sistêmico.
4. `motor-v2/src/database/DrizzleDb.ts:84-105` persiste o status recebido pelo coordenador com `UPDATE` na tarefa.
5. `POST .../start`, `POST .../pause` e `POST .../resume` são caminhos separados no controller (`api/gerenteagentes.controller.ts:78+`) e, no serviço, chamam o Motor antes de persistir o estado resultante. O deploy também tem endpoint próprio.

## Proteção implementada na interação visual

`TASK_STATUS_USER_DROP_DESTINATIONS` e `isTaskStatusUserDropAllowed` em `motor-v2/src/shared/task-statuses.ts` centralizam a matriz usada pelo mapa e pela tela. Em particular, `draft` não possui destinos manuais, portanto `draft → running` (e demais saídas de `draft`) fica reservado ao Motor. A autorização no serviço do PATCH continua sendo uma evolução separada necessária para impedir alterações diretas fora da UI; o Motor deve continuar usando `TaskStateMachine`.
