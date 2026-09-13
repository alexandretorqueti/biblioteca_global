# Dados e interações do Mapa de Agentes

Tarefa **826** — "Nova tela Mapa de Agentes" (menu "Mapa de agentes" abaixo de
"Acompanhar Tarefa"). Subtarefa **1086**: *"Reproduzir dados e interações
existentes"*.

Escopo recebido: implementar na tela nova as leituras já existentes de
projetos, tarefas, `motor-detail` e subtarefas, além de polling, `RealtimeClient`,
seleção, fallback e as ações `start`, `pause` e `resume`. Reutilizar `useApi`,
autenticação, loading e erros. **Não criar nem alterar endpoint.**

## 1. O que foi feito

A lógica de leitura/estado operacional saiu de dentro da tela e virou um
**núcleo único e testável**: `screens/operationMapData.ts`
(`useOperationMapData`). A tela `screens/OperationMapScreen.tsx` agora é só
apresentação — mapa, lista, painel lateral e diálogos — consumindo esse núcleo.

```
                 ┌── TaskMonitorScreen.tsx   (tela legada, INTACTA — INV-L1)
LÓGICA/ENDPOINTS ┤
                 └── OperationMapScreen.tsx  (tela nova: mapa, lista, painel)
                        └── useOperationMapData()  ← useApi + RealtimeClient
```

Nenhum endpoint, payload ou regra de transição foi criado ou alterado
(INV-C1). O hook não contém regra de negócio: lê, classifica por evento e
delega as ações ao motor (INV-C3).

## 2. Mecanismos reproduzidos (paridade com a tela legada)

| Mecanismo | Endpoint / API | Onde |
|---|---|---|
| Projetos | `GET /gerenteagentes/projetos_captados` (`pageSize: 100`) | `reloadProjects` |
| Tarefas com status do motor | `GET /gerenteagentes/tarefas-com-status` (`pageSize: 100`, filtros opcionais) | `reloadTasks` |
| Detalhe do motor | `GET /gerenteagentes/tarefas/:id/motor-detail` | `reloadDetail` |
| Subtarefas (banco) | `GET /gerenteagentes/tarefas/:id/subtarefas` | `reloadDbSubtasks` |
| Chat (histórico) | `GET /gerenteagentes/tarefas/:id/chat` | `reloadChat` |
| Atividade/workers | `GET /gerenteagentes/motor-activity` | `reloadActivity` |
| Diagnóstico de deploy | `GET /gerenteagentes/motor-deploy-diagnostics` | `reloadActivity` |
| Polling de reconciliação | `setInterval` de 5 s (lista, atividade, selecionada) | `OPERATION_POLL_MS` |
| Tempo real | `RealtimeClient` (ticket + WS por tarefa) | efeito de tempo real |
| Ações | `POST /tarefas/:id/{start,pause,resume,unlock}` | `execute` |
| Ações em massa | `POST /tarefas/{pause-all,resume-all}` | `bulk` |

Comportamentos preservados do tempo real:

- `onStatusChange` → `connecting` / `open` / `closed` (a reconexão e o fechamento
  continuam por conta do `RealtimeClient`, sem mudança);
- `replay_unavailable` → recarga da fonte persistida (detalhe, subtarefas, chat);
- `error` → `chatError`;
- eventos de chat anexados **idempotentemente por `id`** com estado de espera;
- `task.created|updated|status.changed|deleted` aplicados em memória
  (`applyTaskEvent`) sem recarregar tudo;
- `subtask.*` → reconciliação do `motor-detail` + subtarefas do banco;
- **buffer de eventos com limite** (`OPERATION_EVENT_LIMIT = 500`, o mesmo
  `slice(-500)` da tela legada), ajustável por opção e exposto na aba *Logs*.

## 3. API do núcleo (`useOperationMapData`)

Entradas (`OperationMapDataOptions`): `projetoId`, `status` (filtros
server-side, paridade com a legada), `pollMs` (0 desliga), `realtime`,
`eventLimit`.

Saídas (resumo): `tasks`, `mappedTasks` (com `projetoNome`), `projects`,
`activities`, `stats`, `diagnostics`; `selectedId`/`selected`/`select`;
`detail`, `dbSubtasks`, `subtasks`, `subtaskSource` (`motor` | `db` | `none`),
`status`, `canStart`, `canPause`; chat (`chat`, `chatInput`, `setChatInput`,
`chatLoading`, `chatSending`, `chatWaiting`, `chatError`, `sendChat`);
`realtimeStatus`, `realtimeEvents`, `eventLimit`; ações (`execute`, `bulk`,
`bulkAction`, `bulkMessage`, `canPauseAll`, `canResumeAll`); recargas
(`reload*`, `refreshSelected`).

Funções puras exportadas (usadas pelos testes e reutilizáveis pelos próximos
passos): `mergeChatMessages`, `limitRealtimeEvents`, `sortTasksByRecency`,
`resolveSelection`, `applyTaskEvent`, `resolveSubtasks`, `canStartTask`,
`canPauseTask`.

## 4. Critérios de aceite (subtarefa 1086)

| Critério | Como é garantido | Evidência |
|---|---|---|
| Usa os mesmos contratos/mecanismos da tela antiga | mesmos endpoints, query `pageSize: 100`, `auth: "access"` via `useApi` | testes "lê projetos, tarefas, atividade, detalhe e subtarefas..." |
| Polling preservado | intervalo de 5 s recarrega lista, atividade e a selecionada | teste "reconcilia por polling a cada 5 s" |
| Realtime, reconexão, fechamento e limite de eventos | `RealtimeClient` + `close()` + buffer de 500 | testes de status/close, limite e desmontagem |
| Seleção carrega detalhe sem navegação | `select(id)` → `motor-detail`; painel lateral na mesma rota | teste "seleciona ... sem navegar de rota" |
| Start/pause/resume mantêm habilitação e erros | `canStart`/`canPause` + `error` da ação | testes de habilitação, erro e rotas |
| Fallback de subtarefas | `resolveSubtasks` (motor → banco) | testes de fallback (unidade e tela) |

## 5. Notas para as subtarefas seguintes

- 1087+ podem montar o mapa/lista/painel sem tocar em dados: bata em
  `useOperationMapData` (uma só fonte).
- `subtaskSource` distingue a origem das subtarefas exibidas (motor × banco).
- `realtimeEvents` já vem limitado e pronto para a faixa de atividade ao vivo.
- `TaskMonitorScreen.tsx` e `TaskFlowMap.tsx` permanecem intocados (INV-L1).
