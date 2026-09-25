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
