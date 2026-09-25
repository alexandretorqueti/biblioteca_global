# Contexto do Analista — Biblioteca Global

Plataforma monorepo TypeScript que gera sistemas configuráveis. Fontes principais: `README.md`, `MANUAL_DESENVOLVIMENTO.md`, `apps/api`, `apps/web`, `packages/*`, `database/` e `projects/<slug>/`.

## Arquitetura

- `packages/shared`: contratos; `packages/api-client`: HTTP tipado; `packages/ui`: componentes.
- `apps/api`: NestJS, autenticação e CRUD; `apps/web`: React/Vite.
- `schema.ts` de cada projeto é fonte de verdade para dados; config define interface gerada.
- MySQL: `core` para plataforma e `projeto_<id>` isolado por projeto.

## Regras

- Identidade, usuários, perfis/RBAC, projetos core e telas administrativas pertencem à Biblioteca, não ao Motor.
- Antes de alterar contrato compartilhado, localizar consumidores em API, web e projetos.
- Leia `config.ts`, `schema.ts`, migrations e testes da área afetada.

## Registro confirmado por tarefa

_Contexto inicial curado em 2026-09-13._

### Tarefa task-p2-835: Melhorias de layout em Mapa de Agentes

#### Subtarefa 7: Revisão de melhorias adicionais e validação do layout integrado (2026-09-25)

**Decisões estruturais confirmadas (implementadas nas subtarefas 1-6):**

1. **Container dos quadros (OperationMapScreen):**
   - `maxWidth: 1800` mantido, mas sem restrições de altura
   - Layout flex com `flexDirection: { xs: "column", lg: "row" }` para coluna lateral em telas largas
   - Gap de 16px entre mapa e detalhe

2. **Quadros de tarefas uniformes (StationNode em OperationMapCanvas):**
   - `minWidth: { xs: 170, md: 190 }` e `flex: "1 1 0"` para largura uniforme
   - Sombras removidas, substituídas por bordas coloridas: `borderTop: 2` com `borderTopColor: toneColor(station.tone)`

3. **Responsividade (OperationMapCanvas):**
   - `flexWrap: "wrap"` nas linhas de estações para quebra em telas pequenas
   - `gap: { xs: 1, md: 0.75 }` para espaçamento responsivo
   - Larguras mínimas fixas (1250px e 740px) removidas
   - Conectores → envolvidos em `Box` com `display: "inline-flex"` para manter alinhamento

4. **Detalhe da tarefa (OperationMapScreen):**
   - Telas largas (>= 1280px): coluna lateral fixa com `width: { lg: 480 }`, `position: "sticky"`, `top: 16`
   - Telas pequenas: Drawer à esquerda com `width: 480`, `maxWidth: "90vw"`
   - Botão de minimizar/maximizar: `IconButton` com `ExpandMoreRounded`/`ExpandLessRounded`
   - Estado `detailMinimized` controla visibilidade

5. **Seleção inicial determinística (OperationMapScreen):**
   - Função `selectInitialTask` prioriza tarefas com status `awaiting_clarification` ou `paused`
   - Fallback para tarefa concluída mais recentemente (por `updatedAt`, depois `createdAt`)
   - `initialSelectionDone` ref preserva seleção do usuário durante atualizações periódicas

**Arquivos modificados (subtarefas 1-6):**
- `projects/gerenteagentes/screens/OperationMapScreen.tsx` — layout flex, coluna lateral, seleção inicial, minimizar/maximizar
- `projects/gerenteagentes/screens/OperationMapCanvas.tsx` — responsividade, quebra de linha, bordas coloridas
- `projects/gerenteagentes/screens/__tests__/OperationMapCanvas.responsive.test.tsx` — 8 testes responsivos (novo)
- `projects/gerenteagentes/screens/__tests__/OperationMapScreen.selection.test.tsx` — 10 testes de seleção e comportamento (novo)

**Sugestões visuais adicionais:** 13 sugestões identificadas e documentadas em `SUBTAREFA-7-RELATORIO.md`, submetidas à aprovação do responsável antes de implementação.

**Status:** Relatório final submetido. Testes e typecheck pendentes de execução (ambiente npm indisponível nesta subtarefa). Validação manual em runtime recomendada.
### Tarefa 824 — Menu e tela de Modelos Globais (validado 2026-09-25)

**Estado original:** A implementação da tarefa 824 foi concluída nos commits e worktree da tarefa (`motor-v2/task-p2-824/integracao`, subtarefas 1065–1083), mas **não estava incorporada à branch base** (`base-desenvolvimento`). O menu de “Modelos Globais” não aparecia no deploy porque a branch de integração nunca foi promovida.

**O que foi implementado (confirmado por testes e diff):**

- **Aba MODELOS na tela CONFIGURAÇÕES:** A tela `ConfiguracoesScreen.tsx` ganhou abas (Tabs MUI). A aba “Parâmetros” mantém os parâmetros operacionais do Motor; a nova aba **“MODELOS”** expõe a configuração global da fila de modelos (DEV / ANALYST / MONITOR), com combos de provider/model encadeados populados pelo proxy `/gerenteagentes/modelos-console`, botões de adicionar/remover/reordenar, e botão “Salvar e propagar” que aplica a configuração em todos os projetos ativos.
- **Rota e posição do menu:** A funcionalidade fica acessível pelo menu **CONFIGURAÇÕES** (último grupo do menu lateral, ícone `settings`), aba “MODELOS”. Não há um item de menu separado — a configuração global é uma aba dentro da tela de Configurações existente.
- **Schema:** Duas novas tabelas em `schema.ts` e migrations 0066/0067:
  - `global_model_selection` — filas globais por tipo (DEV/ANALYST/MONITOR), com índice único por (tipo, ordem).
  - `project_model_selection` — filas materializadas por projeto (project_slug, tipo, ordem), com índice único por (project_slug, tipo, ordem).
  - Migration 0067: trigger `AFTER INSERT ON projetos_captados` que herda automaticamente a configuração global para novos projetos.
- **Motor (MotorAPI):** Endpoints `GET/PUT /api/model-selection/global` no Motor v2, com validação pelo contrato `global-model-selection.ts` e propagação transacional para todos os projetos ativos.
- **API (Biblioteca):** Endpoints `GET/PUT /api/gerenteagentes/model-selection/global` no controller e service, com proxy para o Motor e validação de payload.
- **Contrato shared:** `motor-v2/src/shared/global-model-selection.ts` e `src/shared/global-model-selection.ts` — tipos `GlobalModelSelection`, `GlobalModelSelectionEntry`, `GlobalModelSelectionTipo`, função `parseGlobalModelSelection` com validação estrita (rejeita tipos desconhecidos, campos extras, provider/model vazios).

**Validação (2026-09-25):**
- Testes focados: 8/8 passam (GlobalModelSelection, GlobalModelSelectionInheritance, MotorAPIModelSelectionRegression).
- Testes da tela: 11/11 passam (ModelSelectionScreen — seleção global, navegação, combos encadeados, legado, console indisponível, parentRow).
- Testes da API: 6/6 passam (modelos-console) + 4/4 passam (model-selection persistida).
- Build: OK (apps/web e packages compilam sem erro).
- Suíte aplicável: 1224 testes passam; 6 falhas pré-existentes no motor-v3 (erro de ambiente `node:` module, não relacionado à tarefa 824).
- Diff: 13 arquivos alterados, +914/-18 linhas — apenas mudanças relacionadas à tarefa 824, preservando alterações posteriores da base (mapa-agentes, motor-v3, etc.).
