# Controles de Fluxo para Projeto Novo

> **Lições aprendidas do caso TaQui** — documento registrado em 2026-09-03.

## Princípio Diretivo

**Sempre que houver decisão ou proibição, ela deve ser CONTROLADA PELO MOTOR (código/gate), não apenas escrita no prompt do agente.** Prompt orienta; código obriga.

## Contexto

O projeto TaQui (caso de teste do motor) expôs falhas no fluxo de setup de projeto novo:
1. A tarefa fechou como concluída mas o projeto não foi registrado na plataforma e os endpoints CRUD não respondiam
2. As combos de FK exibiam id em vez de nome
3. As telas personalizadas nunca foram integradas
4. O agente do projeto não foi registrado no gateway

## Decisões Registradas

### 1. Checklist de Registro na Missão de Setup

**Onde:** `projects/gerenteagentes/api/gerenteagentes.service.ts` → `montarMissaoSetup()`

**O que:** A missão gerada para o agente biblioteca-global lista explicitamente os registros obrigatórios para o projeto novo funcionar (enquanto a plataforma não tiver autodescoberta):

| # | Registro | Arquivo/Local |
|---|----------|---------------|
| 2.1 | Schema-registry da API | `apps/api/src/modules/crud/schema-registry.ts` |
| 2.2 | Registry do front (config) | `apps/web/src/project/registry/projects.ts` |
| 2.3 | Telas custom do front | `apps/web/src/project/registry/customScreens.tsx` |
| 2.4 | Seed do banco | `database/seed.ts` ou `projects/<slug>/seed-*.ts` |
| 2.5 | Dockerfiles (COPY package.json) | `apps/api/Dockerfile`, `apps/web/Dockerfile` |
| 2.6 | Lockfile da raiz | `package-lock.json` (npm install na raiz) |
| 2.7 | Project-db-factory | `apps/api/src/modules/crud/project-db.factory.ts` |

**Por quê:** O TaQui falhou porque o agente completou o setup sem registrar o schema no registry da API — os endpoints CRUD retornavam 404 mesmo com o schema.ts criado.

**Controle:** O gate do motor (subtarefa separada) valida a presença de cada registro antes de declarar setup concluído.

### 2. Smoke Test Funcional no Fim do Setup

**Onde:** Gate do motor (subtarefa separada — item 2 do escopo geral).

**O que:** O motor exige evidência funcional de que o projeto novo responde (chamada HTTP real a um endpoint CRUD do projeto novo, com usuário/escopo de teste) antes de declarar o setup concluído.

**Por quê:** O TaQui passou no gate estático (arquivos existiam) mas falhou no runtime (endpoints não respondiam).

**Controle:** Subtarefa obrigatória do plano + verificação no gate final.

### 3. Lint de Config no Gate

**Onde:** Gate do motor (subtarefa separada — item 3 do escopo geral).

**O que:** Na fase VERIFY, validar o config.ts do projeto novo:
- Campo FK declarado como `type: number` sem `multipleChoice` → reprovar com diagnóstico claro
- Tela custom com `componentId` não registrado no front → reprovar

**Por quê:** O TaQui tinha campos FK configurados como `type: number` — as combos exibiam IDs em vez de nomes.

**Controle:** Regra aplicada pelo gate do motor, não só orientada em prompt.

### 4. Validação de Completude

**Onde:** Gate do motor (subtarefa separada — item 4 do escopo geral).

**O que:** Tudo que o config declara (telas custom, rowActions com endpoints) precisa ter implementação correspondente no código antes de a tarefa fechar.

**Por quê:** O TaQui declarou telas custom no config mas nunca as implementou — a tarefa fechou mesmo assim.

**Controle:** Gate reprova/bloqueia com a lista do que falta.

### 5. Promoção Manual Sem Código Não Fecha Tarefa

**Onde:** TaskWorker e scripts de promoção (subtarefa separada — item 5 do escopo geral).

**O que:** Subtarefa promovida manualmente com `workspaceCommitSha` nulo não pode resultar em tarefa `completed` — permanece pendente/bloqueada com motivo auditável.

**Por quê:** No TaQui, subtarefas foram promovidas manualmente sem evidência de código, e a tarefa pai fechou como concluída.

**Controle:** Fluxos de promoção/recover no TaskWorker validam a presença de commit.

### 6. Agente no Gateway

**Onde:** `projects/gerenteagentes/api/gerenteagentes.service.ts` → `montarMissaoSetup()` (passo 3.2)

**O que:**
- **(a)** O briefing da subtarefa de criação do agente do projeto inclui o registro no gateway via CLI:
  ```bash
  openclaw agents add <slug> --workspace /data/workspace/projects/agentes/<slug> --model <modelo> --non-interactive
  ```
- **(b)** O motor verifica a existência do agente no gateway (via Console API) antes de enfileirar tarefa do projeto novo; ausente → falha com causa clara (nunca "Unknown agent id" sem diagnóstico).

**Por quê:** O TaQui criou o agente na tabela `agentes` mas nunca o registrou no gateway — o motor tentava enfileirar tarefas e recebia "Unknown agent id".

**Controle:** Verificação prévia no motor antes de enfileirar.

### 7. Validação de projeto_id

**Onde:** API da biblioteca e entrada do motor (subtarefa separada — item 7 do escopo geral).

**O que:** Tarefas criadas para projeto novo devem referenciar a linha correta de `projetos_captados` (nunca a da biblioteca).

**Por quê:** No TaQui, tarefas foram criadas com `projeto_id` apontando para a biblioteca em vez do projeto novo.

**Controle:** Validação na criação (API da biblioteca) e na entrada do motor, rejeitando com erro claro.

### 8. Briefing do Analista (buildAnalystPrompt)

**Onde:** `projects/gerenteagentes/motor-v2/src/workers/TaskWorker.ts` → `buildAnalystPrompt()`

**O que:** Prompt do analista atualizado com o fluxo oficial:
- **Telas personalizadas de projeto novo NUNCA são subtarefa do setup**
- Viram **tarefas vinculadas ao projeto novo** (`auto_start=true`) executadas pelo **agente do projeto novo**
- O setup do projeto deve APENAS: criar estrutura, config, schema, migrations, registros obrigatórios, e agente no gateway

**Regras adicionadas ao prompt:**
```
Regras para SETUP DE PROJETO NOVO:
- TELAS PERSONALIZADAS (kind: custom no config.ts) NUNCA sao subtarefas do setup.
  Elas viram TAREFAS VINCULADAS AO PROJETO NOVO (com auto_start=true), executadas
  pelo agente do projeto novo (nao pelo biblioteca-global que fez o setup).
- O setup do projeto deve APENAS: criar estrutura, config, schema, migrations,
  registros obrigatorios (schema-registry, front registry, seed, Dockerfiles,
  lockfile), e agente no gateway.
- Se a descricao mencionar telas personalizadas, telas custom, dashboards custom,
  ou funcionalidades alem do CRUD padrao, IGNORE-as no plano de subtarefas do setup.
- Subtarefas do setup devem focar em: estrutura de pastas, config.ts, schema.ts,
  migrations, registros nos Dockerfiles e registries, seed de dados iniciais,
  e registro do agente no gateway.
```

**Por quê:** No TaQui, o analista criou subtarefas de setup para implementar telas custom — mas quem deveria executá-las era o agente do projeto novo (que ainda não existia), não o biblioteca-global.

**Controle:** O gate garante mesmo se o agente ignorar (itens 2 a 4 do escopo geral).

## Fluxo Oficial de Setup de Projeto Novo

```
START no projeto (front Biblioteca)
  │
  ▼
Motor monta briefing (descrição + definições)
  │
  ▼
Analista (biblioteca-global) gera tarefas macro
  │
  ├─ Tarefa 1: Setup do projeto
  │   ├─ Criar estrutura (projects/<slug>/)
  │   ├─ Criar config.ts + schema.ts
  │   ├─ Criar banco projeto_<id>
  │   ├─ Executar migrations
  │   ├─ Checklist de registros (schema-registry, front, seed, Dockerfiles, lockfile)
  │   ├─ Gate de agente dedicado (se telas custom):
  │   │   ├─ Criar agente no OpenClaw
  │   │   ├─ Registrar no gateway (openclaw agents add)
  │   │   ├─ Registrar na tabela projeto_640.agentes
  │   │   └─ Vincular projeto ao agente
  │   └─ Smoke test funcional (endpoint CRUD responde?)
  │
  ├─ Tarefa 2: Implementar tela Dashboard (agente do projeto novo, auto_start)
  ├─ Tarefa 3: Implementar tela X (agente do projeto novo, auto_start)
  └─ ...
```

## Implementação Nesta Subtarefa

Esta subtarefa (#1) implementou apenas os **briefings** (itens 1, 6a e 8):

1. ✅ **Checklist de registro na missão de setup** — `montarMissaoSetup()` atualizado com checklist explícito (seções 2.1 a 2.7)
2. ✅ **Briefing de criação do agente com CLI** — passo 3.2 da missão inclui comando `openclaw agents add`
3. ✅ **buildAnalystPrompt com fluxo oficial** — regras adicionadas para telas custom como tarefas do projeto novo

Os **controles de código** (itens 2, 3, 4, 5, 6b, 7) são implementados em subtarefas separadas.

## Arquivos Modificados

| Arquivo | Mudança |
|---------|---------|
| `projects/gerenteagentes/api/gerenteagentes.service.ts` | `montarMissaoSetup()` reescrito com checklist explícito e CLI de registro no gateway |
| `projects/gerenteagentes/motor-v2/src/workers/TaskWorker.ts` | `buildAnalystPrompt()` com regras para setup de projeto novo |

## Próximas Subtarefas

- **Subtarefa #2:** Smoke test funcional no gate
- **Subtarefa #3:** Lint de config no gate
- **Subtarefa #4:** Validação de completude no gate
- **Subtarefa #5:** Promoção manual sem código não fecha tarefa
- **Subtarefa #6:** Verificação de agente no gateway antes de enfileirar
- **Subtarefa #7:** Validação de projeto_id na criação e entrada do motor
