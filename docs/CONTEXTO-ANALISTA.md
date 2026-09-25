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
