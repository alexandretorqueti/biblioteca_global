# Auditoria e invariantes — Mapa de Agentes

Tarefa **826** — "Nova tela Mapa de Agentes" (menu "Mapa de agentes" abaixo de
"Acompanhar Tarefa"). Subtarefa **1084**: *auditar a tela existente e definir
invariantes*.

Método: leitura direta do código vigente (não da documentação) + inventário de
endpoints/hooks/estados + derivação de invariantes verificáveis. As fontes
citadas são arquivos deste projeto.

## 1. Tela existente auditada

- `screens/TaskMonitorScreen.tsx` (2.264 linhas) — "Acompanhar Tarefa".
- `screens/TaskFlowMap.tsx` (1.401 linhas) — "Mapa Vivo da Operação" (v1 do mapa).
- `screens/taskFlowHelpers.ts` — prioridade/tempo/avatar/métricas (puro, determinístico).
- `motor-v2/src/shared/task-statuses.ts` — fonte canônica de status (13 atuais + 3 legados).
- `api/gerenteagentes.controller.ts` / `gerenteagentes.service.ts` — endpoints consumidos.

### 1.1 Componentes e hooks
- `useApi()` (`apps/web/src/hooks/useApi`) fornece o bundle HTTP autenticado (`bundle.http.request`).
- `RealtimeClient` (`@biblioteca-global/api-client`) + `resolveApiBaseUrl`/`resolveRealtimeUrl`.
- UI: MUI 7 + `@biblioteca-global/ui` (`DynamicForm`, `BibliotecaThemeProvider`), `TarefaForm`.

### 1.2 Endpoints (contrato congelado)
| Uso | Endpoint |
|---|---|
| Lista com status | `GET /gerenteagentes/tarefas-com-status` (`pageSize`) |
| Projetos | `GET /gerenteagentes/projetos_captados` |
| Atividade/workers | `GET /gerenteagentes/motor-activity` (= `GET /api/motor/stats`) |
| Diagnóstico de deploy | `GET /gerenteagentes/motor-deploy-diagnostics` |
| Detalhe do motor | `GET /gerenteagentes/tarefas/:id/motor-detail` |
| Subtarefas (DB) | `GET /gerenteagentes/tarefas/:id/subtarefas` |
| Chat | `GET/POST /gerenteagentes/tarefas/:id/chat` |
| Sessões do analista | `GET /gerenteagentes/tarefas/:id/sessoes-analista` |
| Sessão da subtarefa | `GET /gerenteagentes/tarefas/:id/subtarefas/:seq/sessao` |
| Tarefa | `POST /gerenteagentes/tarefas`, `PUT /gerenteagentes/tarefas/:id` |
| Subtarefa | `PUT /gerenteagentes/subtarefas/:id` |
| Operação | `POST /gerenteagentes/tarefas/:id/{start,pause,resume,unlock}` |
| Em massa | `POST /gerenteagentes/tarefas/{pause-all,resume-all}` |

### 1.3 Estado governado pelo motor (não editável pela UI)
- Status de tarefa em `TASK_STATUSES` (`task-statuses.ts`); finais em `TASK_STATUS_FINAIS`;
  "startável" em `TASK_STATUS_STARTABLE`; "em execução" em `TASK_STATUS_EXECUTING`.
- Estações do fluxo: `MAIN_FLOW` (draft, planned, analyzing, ready, running, completed, deployed)
  e `SIDE_FLOW` (waiting, repair, attention, closed) em `TaskFlowMap.tsx`.
- `getEffectiveStatus`: `paused` **sem subtarefas** (ou `subtaskCount` indefinido) conta como **Rascunhos**.
- Status derivado de fatos operacionais → **não há drag-and-drop** nem "responsável".

### 1.4 Tempo real
- WebSocket por tarefa selecionada (`RealtimeClient`), com `onStatusChange`.
- Eventos tratados: `task.status.changed` (atualiza status local), prefixos `task.*`/`subtask.*`
  (recarrega lista/detalhe/subtarefas), eventos de chat (append idempotente por `id`), `replay_unavailable`
  (recarrega via REST) e `error`.
- Fallback: polling de 5 s (`setInterval`) para lista/atividade/detalhe selecionado.

### 1.5 Interações existentes
- Filtros: busca por `#id`/título, projeto, status agrupado (`em-execucao`, `bloqueadas`, `concluidas`),
  prioridade (derivada). Na tela nova acrescentou-se o grupo `aguardando` (aguardando você).
- Seleção de tarefa → detalhe (na tela nova, **Drawer lateral direito ~38–40 %**).
- Detalhe com abas: **Resumo, Chat, Execução, Logs, Histórico**; ações iniciar/pausar/retomar/desbloquear;
  edição de tarefa; sessões; edição de subtarefa; histórico de entregas (recolhível).
- Chat: texto, "Ctrl/Cmd+Enter" para enviar (Enter = nova linha), estado "agente respondendo".
- Paginação: lista `pageSize`; sessões com **cursor** (`hasNextPage`/`nextCursor`) carregado ao rolar.
- Carregamento incremental de tarefas por estação (legado: `PAGE_SIZE = 10` com "carregar mais";
  mapa novo: 5 marcadores + expansão/"ver todas").
- Ações em massa: Pausar todas / Retomar todas. Criar tarefa: diálogo "Nova tarefa".

## 2. Invariantes (não podem quebrar)

### Funcionais (INV-F)
- **INV-F1** Toda tarefa permanece alcançável: marcador/lista/expansão → detalhe.
- **INV-F2** O acesso às tarefas além das primeiras exibidas é preservado (expandir/ver todas/paginar).
- **INV-F3** Busca e filtros (projeto, status, prioridade) afetam a visualização e são reversíveis.
- **INV-F4** Selecionar tarefa abre o detalhe sem navegar para outra página/rota.
- **INV-F5** Chat íntegro: histórico, envio, estados de espera, erros e idempotência por `id`.
- **INV-F6** Ações iniciar/pausar/retomar/desbloquear e em massa continuam funcionando com as mesmas rotas.
- **INV-F7** Deployadas não são renderizadas como lista ilimitada, mas seguem acessíveis.
- **INV-F8** Estados excepcionais (Aguardando, Correção do motor, Atenção, Encerradas) acessíveis e
  destacados apenas quando `quantidade > 0`.
- **INV-F9** Espera por resposta humana é evidente e leva à tarefa correspondente.
- **INV-F10** Atualização em tempo real e reconciliação (replay/polling) preservadas; contadores coerentes.
- **INV-F11** `getEffectiveStatus` é a única regra de "paused sem subtarefas" usada na classificação.

### Contrato / negócio (INV-C)
- **INV-C1** Nenhum endpoint, payload ou regra de transição de status é alterado.
- **INV-C2** A lista de status/cores/labels vem de `task-statuses.ts` (sem duplicar).
- **INV-C3** O mapa não executa regra de negócio; apenas apresenta dados e delega ações à tela.
- **INV-C4** Nenhuma dependência nova é introduzida (zoom/pan sem libs).

### Apresentação / acessibilidade (INV-A)
- **INV-A1** Funciona em tema claro e escuro usando tokens do tema (sem cores hardcoded incompatíveis).
- **INV-A2** Não depender só de cor: rótulos/ícones/tooltips acompanham a cor.
- **INV-A3** `prefers-reduced-motion` desativa animações.
- **INV-A4** Foco de teclado, `aria-label` e contraste adequados.
- **INV-A5** Desktop prioriza uso horizontal; mobile não empilha todos os estados verticalmente.
- **INV-A6** Métricas do topo permanecem compactas (não virar coleção de cards).

### Compatibilidade com a tela antiga (INV-L)
- **INV-L1** `TaskMonitorScreen.tsx` e `TaskFlowMap.tsx` não são alterados.
- **INV-L2** A nova tela é registrada por rota própria (`config.ts`/`screens/registry.ts`), sem substituir a antiga.
- **INV-L3** Ambas consomem a **mesma lógica** (mesmos hooks/endpoints/tipos) — duas UIs, um só núcleo.

## 3. Plano curto da refatoração (mantido)

1. Congelar contrato e invariantes (este documento).
2. Extrair a representação: novo componente de mapa independente, reaproveitando hooks/tipos existentes.
3. Entregar a tela nova (`OperationMapScreen` + `OperationMapCanvas`) com o menu "Mapa de agentes".
4. Permitir as duas visualizações coexistirem (Mapa / Lista / Atividade) consumindo o mesmo núcleo.
5. Validar equivalência por checklist e testes; só depois considerar remoção de código antigo.

## 4. Riscos/divergências observados na auditoria

- **R1 (resolvido na entrega)** A lista de tarefas usa `pageSize: 100`; acima disso a visão é parcial em
  ambas as telas. Não é regressão introduzida, mas limita o "total". *Não alterado* (fora de escopo).
- **R2 (resolvido)** `paused` sem subtarefas aparecia como "Aguardando"; a classificação correta
  (Rascunhos) é aplicada via `getEffectiveStatus` — usar sempre esse helper (INV-F11).
- **R3 (aceito)** "Aguardando você" na tela nova considera apenas `awaiting_clarification`
  (a legenda legada agrupa `paused` + `awaiting_clarification`); a estação `waiting` continua
  recebendo ambos, e o filtro dedicado destaca só a resposta humana.
- **R4 (aceito)** Densidade de marcadores: 5 visíveis + expansão/ver-todas (mapa novo) vs.
  página de 10 (mapa legado). O mecanismo de acesso às demais é preservado em ambos.

## 5. Matriz de validação (equivalência)

| Critério | Onde é garantido | Status |
|---|---|---|
| Tarefas acessíveis | marcador / Lista / "ver todas" | ✅ |
| Carregamento incremental | `MARKER_LIMIT` + expandir/ver todas | ✅ |
| Busca / projeto / status / prioridade | filtros do canvas | ✅ |
| Seleção sem navegar | Drawer lateral direito | ✅ |
| Chat (envio, espera, erros) | aba Chat do Drawer | ✅ |
| Pausar / retomar / iniciar / desbloquear | ações do Resumo | ✅ |
| Ações em massa | cabeçalho da tela | ✅ |
| Nova tarefa / edições | diálogos existentes | ✅ |
| Sessões + cursor | diálogos de sessão | ✅ |
| Deployadas acessíveis | terminal de produção + Lista | ✅ |
| Exceções acessíveis | estações de exceção | ✅ |
| Tempo real | WS + polling de 5 s | ✅ |
| Intervenção humana | banner "precisa de você" | ✅ |
| Workers | indicador + popover | ✅ |
| Claro/escuro | tokens do tema | ✅ |
| Responsividade | rail horizontal + zoom/ajuste | ✅ |
| Acessibilidade | labels/tooltips/reduced-motion | ✅ |

Evidência de execução da entrega (mesma árvore): `eslint` sem erros; `vitest` do diretório
`screens` + registry com **216 testes** verdes (10 novos para o canvas); `vite build` de
`apps/web` íntegro; auditoria de layout em Chromium real (claro e escuro) sem overflow.

## 6. Decisões registradas

- Menus: "Acompanhar Tarefa" permanece; "Mapa de agentes" é rota nova (não substitui).
- Lógica única, duas UIs: nenhuma regra de negócio no mapa.
- Nomes escolhidos: `OperationMapScreen` / `OperationMapCanvas` (equivalentes a
  `CurrentTaskView` / `OperationMapView` da missão).
