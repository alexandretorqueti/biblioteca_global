# Modelo do Mapa de Agentes (tarefa 826)

Documento de referência da camada de **modelo** do Mapa Vivo da Operação —
subtarefa **1085** *"criar modelos e verificadores do mapa"*.

- Código: `screens/operationMapModel.ts` (puro, sem React/MUI/serviços).
- Verificadores: `screens/__tests__/operationMapModel.test.ts` (40 testes) +
  `verificarInvariantesDoModelo()`.
- Auditoria de referência: `docs/AUDITORIA-E-INVARIANTES-MAPA-DE-AGENTES.md`
  (subtarefa 1084) — este módulo implementa a etapa 2 do plano ("extrair a
  representação") sem tocar nas telas legadas.

## Por que existe

A missão exige **uma lógica, duas UIs**: o acompanhamento atual
(`TaskMonitorScreen` + `TaskFlowMap`) continua intacto e a tela nova
(`OperationMapScreen` + `OperationMapCanvas`) apenas acrescenta uma
representação. Para isso, tudo que é *decisão sobre dados* (classificação,
contagem, filtro, densidade, workers) saiu do componente e virou função pura.

Nenhuma tela antiga foi alterada. `TaskFlowMap.tsx`, `TaskMonitorScreen.tsx`,
`taskFlowHelpers.ts`, `registry.ts` e `config.ts` permanecem como estavam.

## Superfície do módulo

### Catálogo de estações

| Export | Uso |
|---|---|
| `OPERATION_MAIN_STATIONS` / `OPERATION_EXCEPTION_STATIONS` / `OPERATION_STATIONS` | Estações do fluxo, já separadas entre principal e excepcional. |
| `OPERATION_STATION_BY_ID` | Busca por id (ex.: `"running"`). |
| `stationForStatus(status)` | Estação de um status cru (`undefined` se desconhecido). |
| `stationForTask(task)` | Estação considerando o status **efetivo**; status desconhecido cai em `attention` (nada desaparece do mapa). |
| `stationTasks(tarefas, estação)` | Tarefas da estação. |
| `unmappedTasks(tarefas)` | Tarefas fora do catálogo — reportadas, nunca escondidas. |
| `effectiveOperationStatus(task)` | Regra única de `paused` **sem subtarefas → Rascunhos** (INV-F11). |
| `OPERATION_TONE_META` / `describeTone(tone)` | Rótulo + token de tema + glifo do tom (nunca só cor — INV-A2). |

O catálogo é **idêntico** a `MAIN_FLOW`/`SIDE_FLOW` da tela legada (id, rótulo,
subtítulo, statuses e tom), o que é verificado por teste — se alguém mudar um
lado só, a suíte quebra (INV-L3/INV-C2).

### Filtros (INV-F3)

- `OPERATION_FILTER_GROUPS`: `em-execucao`, `aguardando`, `bloqueadas`,
  `concluidas` (mesmos slugs usados pelo `FiltrosMapa` legado; `aguardando`
  destaca **só** a resposta humana).
- `filterOperationTasks(tarefas, filtros)`: busca por `#id`/título, projeto,
  prioridade derivada (`deriveTaskPriority`) e chips por status **efetivo**.
- `hasActiveOperationFilters`, `describeActiveOperationFilters`
  (ex.: `Projeto: Biblioteca Global`) para deixar o filtro visível na tela.
- `EMPTY_OPERATION_FILTERS` limpa tudo (reversível).

### Densidade (INV-F2, INV-F7)

- `selectVisibleMarkers(itens, { expanded, limit })`
  → `{ visible, hidden, total, hasMore }`. Padrão: **5** marcadores
  (`OPERATION_MARKER_LIMIT`) e "+N / ver todas"; `expanded` mostra todas.
  **O total nunca se perde** — o acesso às demais tarefas continua.
- `sortByRecency` + `OPERATION_DEPLOYED_PREVIEW_LIMIT` (3): Deployadas viram
  prévia no terminal de produção, nunca lista ilimitada.

### Intervenção humana, workers e conexão

- `tasksAwaitingHuman(tarefas)`: tarefas em `awaiting_clarification` (INV-F9).
- `summarizeWorkers(stats)`: normaliza o payload de `/motor-activity`
  (= `GET /api/motor/stats`) em `{ activeWorkers, maxWorkers, workers,
  executingTaskIds, busy }`, **defensivo** (payload inválido vira resumo vazio
  em vez de quebrar o mapa).
- `describeConnection(state)`: rótulo/tom/aria de `open|connecting|closed`
  ("Tempo real conectado", "Conectando…", "Reconectando…").

### Métricas e modelo pronto

- `summarizeMetrics(...)`: total, filtrado, executando, bloqueadas, entregues,
  deployadas, aguardando você, concluídas hoje, tempo médio e `byStation`
  (mesmas chaves do `MetricasMapa.porEstacao` legado).
- `buildOperationMapModel(input)`: devolve o modelo completo já organizado
  (`stations`, `mainStations`, `exceptionStations`, `filtered`, `metrics`,
  `exceptions`, `awaitingHuman`, `deployedPreview`, `activities`,
  `activeTaskIds`, `unmapped`, `activeFilters`, `hasActiveFilters`).
  Puro, determinístico (o "agora" é injetável) e **não muta** as entradas.

### Verificador

```ts
import { verificarInvariantesDoModelo } from "./operationMapModel"

verificarInvariantesDoModelo() // → [] quando íntegro; lista de violações caso contrário
```

Checa: id único por estação, rótulo/descrição/status/tom válidos, **todo
status canônico em exatamente uma estação**, grupos de filtro referenciando só
status existentes e limite de marcadores coerente. A tela nova pode rodar isso
em desenvolvimento (aviso no console) sem custo em produção.

## Como a tela nova consome (subtarefas 1086–1090)

```tsx
const modelo = buildOperationMapModel({
  tarefas: mapped,              // FlowTask[] já carregadas pela tela
  projetos,
  atividades: activities,       // MotorActivity[]
  filtros,                      // FiltrosMapa (mesmo contrato da tela legada)
  stats,                        // payload cru de /motor-activity
  selectedTaskId,
  expandedStations,             // estações "ver todas"
})

modelo.mainStations.map(view => /* desenhar a estação */)
modelo.exceptionStations.map(view => /* exceções — só destacam se view.total > 0 */)
modelo.awaitingHuman              // banner "N tarefa(s) precisa(m) de você"
modelo.metrics.workers            // "3 workers ativos" + popover
modelo.deployedPreview            // terminal de produção com "ver todas"
modelo.activeFilters              // chips de filtro visível
describeConnection(realtime)      // selo de tempo real
```

A apresentação continua sendo responsabilidade do canvas: este módulo não
importa nada de React/MUI. Os tipos `FlowTask`, `FiltrosMapa`, `MotorActivity`
e `ProjetoInfo` são importados **por tipo** de `TaskFlowMap`, garantindo que
modelo e tela falem o mesmo contrato sem duplicar definições.

## Invariantes cobertos por teste

| Invariante | Onde |
|---|---|
| INV-F1 alcance (status desconhecido → Atenção + `unmapped`) | `operationMapModel.test.ts` |
| INV-F2 densidade + acesso às demais | idem |
| INV-F3 filtros (busca/projeto/prioridade/status) reversíveis | idem |
| INV-F7 Deployadas em prévia limitada | idem |
| INV-F8 exceções destacadas só quando > 0 | idem |
| INV-F9 espera humana evidente | idem |
| INV-F10 contadores e conexão coerentes | idem |
| INV-F11 `paused` sem subtarefas = Rascunhos (nas 3 implementações) | idem |
| INV-C2 rótulos/status da fonte canônica, sem duplicar | idem |
| INV-A1/A2 tom com rótulo e token de tema, nunca só cor | idem |
| INV-L3 equivalência com `MAIN_FLOW`/`SIDE_FLOW` | idem |

## Validação executada (1085)

```bash
node node_modules/vitest/vitest.mjs run projects/gerenteagentes/screens/__tests__/operationMapModel.test.ts
# → 40 testes verdes

node node_modules/vitest/vitest.mjs run projects/gerenteagentes/screens apps/web/src/project/registry
# → 246 testes verdes (10 arquivos)

node node_modules/eslint/bin/eslint.js \
  projects/gerenteagentes/screens/operationMapModel.ts \
  projects/gerenteagentes/screens/__tests__/operationMapModel.test.ts
# → sem erros
```

Sem dependências novas (INV-C4): o módulo usa apenas TypeScript da stdlib.
