# Contratos de API — Gerente Agentes

**Versão:** 1.2 (2026-08-21)
**Base URL:** `/api/gerenteagentes` (API da plataforma)
**Auth:** JWT de usuário autenticado (escopo do projeto via token)

> **Nota v1.2 (2026-08-21):** agentes são mantidos exclusivamente pelo Console
> OpenClaw. O CRUD expõe apenas o resource virtual `__openclaw_agentes__` para
> leitura; não existe tabela local de agentes. O schema de `tarefas` perdeu
> `agenteId`/`repoPath`/`buildCommand`/`unitTestCommand` — esses campos
> (ambiente de execução + agente) vivem agora em `projetos_captados` (1 projeto, 1 ambiente,
> 1 agente). A execução real é feita pelo **motor do console OpenClaw** — ver
> [§6](#6-integração-com-console-openclaw).

---

## Sumário

1. [Captação (Isa)](#1-captação-isa)
2. [Gestão de Projetos](#2-gestão-de-projetos)
3. [Gestão de Tarefas](#3-gestão-de-tarefas)
4. [Chats](#4-chats)
5. [Execução (Motor)](#5-execução-motor)
6. [Integração com Console OpenClaw](#6-integração-com-console-openclaw)
7. [Status](#7-status)

---

## 1. Captação (Isa)

### 1.1 Contatos

**POST /api/gerenteagentes/contatos**
Cria um novo contato.

```json
// Request
{
  "nome": "João Silva",
  "email": "joao@exemplo.com",
  "telefone": "+55 11 99999-9999",
  "origem": "site"
}

// Response 201
{
  "id": 1,
  "nome": "João Silva",
  "email": "joao@exemplo.com",
  "telefone": "+55 11 99999-9999",
  "origem": "site",
  "createdAt": "2026-08-18T14:30:00Z",
  "updatedAt": "2026-08-18T14:30:00Z"
}
```

**GET /api/gerenteagentes/contatos**
Lista todos os contatos.

**GET /api/gerenteagentes/contatos/:id**
Retorna um contato específico.

**PUT /api/gerenteagentes/contatos/:id**
Atualiza um contato.

**DELETE /api/gerenteagentes/contatos/:id**
Remove um contato.

### 1.2 Projetos Captados

**POST /api/gerenteagentes/projetos-captados**
Cria um novo projeto a partir da captação da Isa.

O projeto carrega também o **ambiente de execução** (`repoPath`,
`buildCommand`, `unitTestCommand`) e o **agente responsável** (`agenteId`) —
a fonte única usada pelo motor quando uma tarefa do projeto é iniciada.

```json
// Request
{
  "nome": "Sistema de Gestão",
  "slug": "sistema-gestao",
  "descricao": "Sistema web para gestão de clientes",
  "regras": "Usar React + TypeScript. Banco MySQL.",
  "contatoId": 1,
  "agenteId": 1,
  "repoPath": "/data/workspace/projects/sistema-gestao",
  "buildCommand": "npm run build",
  "unitTestCommand": "npm run test"
}

// Response 201
{
  "id": 1,
  "nome": "Sistema de Gestão",
  "slug": "sistema-gestao",
  "descricao": "Sistema web para gestão de clientes",
  "regras": "Usar React + TypeScript. Banco MySQL.",
  "contatoId": 1,
  "agenteId": 1,
  "repoPath": "/data/workspace/projects/sistema-gestao",
  "buildCommand": "npm run build",
  "unitTestCommand": "npm run test",
  "ativo": true,
  "plataformaProjetoId": null,
  "createdAt": "2026-08-18T14:30:00Z",
  "updatedAt": "2026-08-18T14:30:00Z"
}
```

**GET /api/gerenteagentes/projetos-captados**
Lista todos os projetos.

**GET /api/gerenteagentes/projetos-captados/:id**
Retorna um projeto específico.

**PUT /api/gerenteagentes/projetos-captados/:id**
Atualiza um projeto.

**DELETE /api/gerenteagentes/projetos-captados/:id**
Remove um projeto (soft delete: `ativo = false`).

### 1.3 Definições

**POST /api/gerenteagentes/projetos-captados/:projetoId/definicoes**
Adiciona uma definição ao projeto.

```json
// Request
{
  "texto": "O sistema deve ter autenticação por email e senha",
  "seq": 1
}

// Response 201
{
  "id": 1,
  "projetoId": 1,
  "texto": "O sistema deve ter autenticação por email e senha",
  "seq": 1,
  "createdAt": "2026-08-18T14:30:00Z",
  "updatedAt": "2026-08-18T14:30:00Z"
}
```

**GET /api/gerenteagentes/projetos-captados/:projetoId/definicoes**
Lista todas as definições do projeto (ordenadas por `seq`).

**PUT /api/gerenteagentes/definicoes/:id**
Atualiza uma definição.

**DELETE /api/gerenteagentes/definicoes/:id**
Remove uma definição.

### 1.4 Chats de Captação

**POST /api/gerenteagentes/chats**
Cria um novo chat de captação.

```json
// Request
{
  "contatoId": 1,
  "projetoId": 1
}

// Response 201
{
  "id": 1,
  "contatoId": 1,
  "projetoId": 1,
  "status": "aberto",
  "createdAt": "2026-08-18T14:30:00Z",
  "updatedAt": "2026-08-18T14:30:00Z"
}
```

**POST /api/gerenteagentes/chats/:chatId/mensagens**
Adiciona uma mensagem ao chat.

```json
// Request
{
  "role": "user",
  "texto": "Olá, quero um sistema de gestão"
}

// Response 201
{
  "id": 1,
  "chatId": 1,
  "role": "user",
  "texto": "Olá, quero um sistema de gestão",
  "createdAt": "2026-08-18T14:30:00Z"
}
```

**GET /api/gerenteagentes/chats/:chatId/mensagens**
Lista todas as mensagens do chat (ordenadas por `createdAt`).

### 1.5 Agentes (Console OpenClaw)

**GET** `/api/__openclaw_agentes__` — proxy somente leitura para
`GET /api/agents` do Console OpenClaw. O retorno usa o ID estável do console:

```json
{ "id": "biblioteca-global", "name": "Biblioteca Global" }
```

POST, PUT e DELETE não são suportados. `projetos_captados.agenteId` guarda
diretamente esse `id` string; não existe FK nem tabela local de agentes.

---

## 2. Gestão de Projetos

### 2.1 Listagem e Detalhe

**GET /api/gerenteagentes/projetos-captados**
Lista projetos com contagem de tarefas e status.

```json
// Response 200
{
  "projetos": [
    {
      "id": 1,
      "nome": "Sistema de Gestão",
      "slug": "sistema-gestao",
      "descricao": "...",
      "contato": { "id": 1, "nome": "João Silva", "email": "joao@exemplo.com" },
      "agente": { "id": 1, "nome": "programador-senior", "modelo": "ollama/qwen3.6" },
      "repoPath": "/data/workspace/projects/sistema-gestao",
      "buildCommand": "npm run build",
      "unitTestCommand": "npm run test",
      "ativo": true,
      "plataformaProjetoId": null,
      "tarefasCount": 5,
      "tarefasConcluidas": 2,
      "createdAt": "2026-08-18T14:30:00Z"
    }
  ]
}
```

**GET /api/gerenteagentes/projetos-captados/:id**
Retorna projeto com definições e estatísticas.

### 2.2 Start de Projeto (Geração Macro)

**POST /api/gerenteagentes/projetos-captados/:id/start**
Dispara a geração de tarefas macro pelo analista forte.

```json
// Response 202
{
  "geracaoId": 1,
  "status": "pending",
  "message": "Geração de tarefas iniciada"
}
```

**GET /api/gerenteagentes/projetos-captados/:id/geracoes**
Lista histórico de gerações do projeto.

### 2.3 Chat do Projeto

**GET /api/gerenteagentes/projetos-captados/:id/chat**
Lista mensagens do chat do projeto.

**POST /api/gerenteagentes/projetos-captados/:id/chat**
Adiciona mensagem ao chat do projeto (admin ↔ analista).

```json
// Request
{
  "role": "user",
  "texto": "Preciso alterar o requisito de autenticação"
}

// Response 201
{
  "id": 1,
  "projetoId": 1,
  "role": "user",
  "texto": "Preciso alterar o requisito de autenticação",
  "createdAt": "2026-08-18T14:30:00Z"
}
```

### 2.4 Iniciar Desenvolvimento

**POST /api/gerenteagentes/projetos-captados/:id/desenvolvimento**
Provisiona o app do projeto na plataforma (vincula `plataformaProjetoId`).
Idempotente: se já houver `plataformaProjetoId`, retorna o vínculo existente.

```json
// Response 200
{
  "projetoId": 1,
  "plataformaProjetoId": 640,
  "usuarioId": 12,
  "perfil": "admin",
  "criado": true,
  "message": "Desenvolvimento iniciado - projeto provisionado na plataforma"
}
```

---

## 3. Gestão de Tarefas

### 3.1 CRUD de Tarefas

**POST /api/gerenteagentes/projetos-captados/:projetoId/tarefas**
Cria uma nova tarefa (draft).

> **Mudança v1.1:** a tarefa **não** carrega `agenteId`, `repoPath`,
> `buildCommand` nem `unitTestCommand`. Esses dados vivem em
> `projetos_captados` (1 projeto, 1 ambiente, 1 agente) e são resolvidos pelo
> motor via `tarefa.projetoId` no momento do start.

```json
// Request
{
  "titulo": "Implementar autenticação",
  "descricao": "Criar sistema de login com email/senha",
  "dependsOnTaskId": null,
  "autoStart": false
}

// Response 201
{
  "id": 1,
  "projetoId": 1,
  "titulo": "Implementar autenticação",
  "descricao": "Criar sistema de login com email/senha",
  "status": "draft",
  "maxRework": 3,
  "hardTimeoutMs": null,
  "dependsOnTaskId": null,
  "autoStart": false,
  "bootRetryCount": 0,
  "createdAt": "2026-08-18T14:30:00Z",
  "updatedAt": "2026-08-18T14:30:00Z"
}
```

**GET /api/gerenteagentes/projetos-captados/:projetoId/tarefas**
Lista tarefas do projeto.

**GET /api/gerenteagentes/tarefas/:id**
Retorna tarefa específica com subtarefas e bloqueios.

**PUT /api/gerenteagentes/tarefas/:id**
Atualiza tarefa (apenas draft/planned).

**DELETE /api/gerenteagentes/tarefas/:id**
Remove tarefa (apenas draft/planned).

### 3.2 Ações de Tarefa

**POST /api/gerenteagentes/tarefas/:id/start**
Inicia a execução da tarefa (draft → planned). A API resolve o agente e o
ambiente de execução do **projeto** (`projetos_captados`) e encaminha a tarefa
ao motor — ver [§6.2](#62-iniciar-tarefa-start).

```json
// Response 202
{
  "id": 1,
  "status": "planned",
  "message": "Tarefa iniciada no motor",
  "motorId": "task-biblioteca-1"
}
```

**POST /api/gerenteagentes/tarefas/:id/pause**
Pausa a tarefa (running → paused).

**POST /api/gerenteagentes/tarefas/:id/resume**
Retoma a tarefa (paused → running).

### 3.3 Subtarefas

**GET /api/gerenteagentes/tarefas/:id/subtarefas**
Lista subtarefas da tarefa (tabela local; a fonte da verdade da execução é o
motor — ver [§6](#6-integração-com-console-openclaw)).

```json
// Response 200
{
  "subtarefas": [
    {
      "id": 1,
      "tarefaId": 1,
      "seq": 1,
      "titulo": "Criar schema de banco",
      "scope": "Criar tabelas users e sessions",
      "acceptanceCriteria": ["tabelas criadas", "migrations aplicadas"],
      "descricao": "Criar tabelas users e sessions",
      "status": "verified",
      "resultado": "Schema criado com sucesso",
      "duracaoSegundos": 45,
      "iniciadaEm": "2026-08-18T14:30:00Z",
      "finalizadaEm": "2026-08-18T14:30:45Z"
    }
  ]
}
```

### 3.4 Detalhe no Motor (proxy)

**GET /api/gerenteagentes/tarefas/:id/motor-detail**
Proxy para o motor: task + subtasks + events + currentSubTask. O motor é a
fonte da verdade da execução; a tabela `subtarefas` local é secundária
(Fase 3 ainda não sincroniza).

```json
// Response 200
{
  "motorId": "task-biblioteca-1",
  "exists": true,
  "task": { "id": "task-biblioteca-1", "status": "running", "...": "..." },
  "subtasks": [
    {
      "id": 1,
      "titulo": "Criar schema",
      "status": "verified",
      "deliverCount": 2,
      "deliveryHistory": [
        {
          "id": 1,
          "deliverNumber": 1,
          "model": "openai/gpt-5.6-sol",
          "eventType": "delivery_started",
          "reason": null,
          "createdAt": "2026-09-03T14:00:00Z"
        },
        {
          "id": 2,
          "deliverNumber": 1,
          "model": "openai/gpt-5.6-sol",
          "eventType": "gate_rejected",
          "reason": "Build failed: TypeScript error in schema.ts",
          "createdAt": "2026-09-03T14:05:00Z"
        },
        {
          "id": 3,
          "deliverNumber": 2,
          "model": "openai/gpt-5.6-sol",
          "eventType": "delivery_started",
          "reason": null,
          "createdAt": "2026-09-03T14:10:00Z"
        },
        {
          "id": 4,
          "deliverNumber": 2,
          "model": "openai/gpt-5.6-sol",
          "eventType": "completed",
          "reason": null,
          "createdAt": "2026-09-03T14:15:00Z"
        }
      ]
    }
  ],
  "currentSubTask": { "id": 2 },
  "events": [ { "type": "subtask_started", "at": "2026-08-18T14:30:00Z" } ],
  "errors": [],
  "models": []
}
```

**Campos de `deliveryHistory` por subtarefa:**

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `id` | number | ID do registro no histórico |
| `deliverNumber` | number | Número da entrega (1, 2, 3...) — incrementa a cada tentativa |
| `model` | string \| null | Modelo usado nesta entrega |
| `eventType` | string | Tipo do evento: `delivery_started`, `gate_rejected`, `return_for_rework`, `blocked`, `completed` |
| `reason` | string \| null | Motivo/erro (presente em `gate_rejected`, `return_for_rework`, `blocked`) |
| `createdAt` | string | Timestamp ISO do evento |

**Tipos de evento:**
- `delivery_started`: Entrega iniciada (programador chamado)
- `gate_rejected`: Gate vermelho (build/test falhou)
- `return_for_rework`: Retorno para rework (correção criada após falha repetida)
- `blocked`: Tarefa/subtarefa bloqueada (ambiente, sistema, etc.)
- `completed`: Entrega bem-sucedida (gate verde, subtarefa verificada)

// Response 200 (tarefa nunca enviada ao motor)
{
  "motorId": "task-biblioteca-1",
  "exists": false,
  "message": "Tarefa ainda não foi enviada ao motor (clique em Iniciar)."
}
```

---

## 4. Chats

### 4.1 Chat da Tarefa

**GET /api/gerenteagentes/tarefas/:id/chat**
Lista mensagens do chat da tarefa.

**POST /api/gerenteagentes/tarefas/:id/chat**
Adiciona mensagem ao chat da tarefa (admin ↔ analista).

```json
// Request
{
  "role": "user",
  "texto": "Pode usar bcrypt para hash de senha"
}

// Response 201
{
  "id": 1,
  "tarefaId": 1,
  "role": "user",
  "texto": "Pode usar bcrypt para hash de senha",
  "createdAt": "2026-08-18T14:30:00Z"
}
```

---

## 5. Execução (Motor)

### 5.1 Cache de Status (tempo real)

**GET /api/gerenteagentes/tasks/by-status**
Retorna o cache do `TaskStatusPollerService` (alimentado por polling do
endpoint `GET /api/tasks/by-status` do motor, intervalo de 5 s, com
incremental `?since=<timestamp>`).

```json
// Response 200
{
  "tasks": {
    "running": [
      { "id": "task-biblioteca-1", "agentId": "programador-senior", "title": "Implementar autenticação", "status": "running" }
    ],
    "completed": [
      { "id": "task-biblioteca-0", "agentId": "programador-senior", "title": "Scaffold do repo", "status": "completed" }
    ]
  },
  "timestamp": "2026-08-18T14:31:05Z",
  "projetoId": 640
}
```

> Os fluxos legados de polling de `tarefas/pending` e `PATCH
> /tarefas/:id/status` **não existem** como endpoints desta API — o estado da
> execução vive no motor (console OpenClaw) e chega aqui somente via cache do
> poller (§5.1) e via proxy de detalhe (§3.4).

### 5.2 Bloqueios

A tabela `bloqueios` (resource `bloqueios`) é mantida pelo CRUD genérico
(campos: `tarefaId`, `subtarefaId`, `blockReason`, `blockCommand`,
`blockExitCode`, `blockExcerpt`, `blockedAt`) e preenchida pelo
encaminhamento de eventos do motor — sem endpoint dedicado neste módulo.

---

## 6. Integração com Console OpenClaw

O motor de execução roda dentro do **container do OpenClaw** (porta interna
`6283`), exposto via proxy Nginx Proxy Manager. A API da biblioteca (NestJS)
e o motor trocam HTTP diretamente — a UI **nunca** fala com o motor.

### 6.1 Configuração (env da API)

| Variável | Default | Descrição |
|---|---|---|
| `MOTOR_DEV_URL` | `http://192.168.1.16` | Base URL do motor (via proxy NPM, IP do host) |
| `MOTOR_URL_HOST` | `api.tarefas.localhost` | Host header para roteamento virtual do NPM. Vazio/omitido quando `MOTOR_DEV_URL` já é a URL direta do motor. |

### 6.2 Iniciar Tarefa (start)

Fluxo interno de `POST /api/gerenteagentes/tarefas/:id/start`:

1. Valida que a tarefa está em `draft` ou `planned`.
2. Resolve o `projetos_captados` de `tarefa.projetoId` → **ambiente de
   execução** (`repoPath`, `buildCommand`, `unitTestCommand`).
3. Usa `projetos_captados.agenteId` diretamente como `agentId` do OpenClaw
   (fallback: `programador-senior`).
4. **`POST /api/tasks`** no motor, com ID determinístico
   `task-biblioteca-<id da tarefa>`:

   ```json
   {
     "id": "task-biblioteca-1",
     "agentId": "programador-senior",
     "title": "Implementar autenticação",
     "description": "Criar sistema de login com email/senha",
     "repoPath": "/data/workspace/projects/sistema-gestao",
     "buildCommand": "npm run build",
     "unitTestCommand": "npm run test"
   }
   ```

5. **`POST /api/task/task-biblioteca-1/start`** — o motor enfileira (FIFO) e
   executa, criando e processando subtarefas até a conclusão.
6. Atualiza `tarefas.status = 'planned'` e responde com `motorId`.

Falha de rede/rejeição do motor → `400` com mensagem
`Motor indisponível…` / `Motor rejeitou…` — a tarefa **não** muda de status.

### 6.3 Detalhe da Tarefa (proxy)

`GET /api/gerenteagentes/tarefas/:id/motor-detail` → **`GET /api/task/<motorId>/detail`**
no motor (§3.4). O motor é a fonte da verdade; 404 no motor →
`{ "exists": false }`.

### 6.4 Polling de Status

`TaskStatusPollerService` (iniciado no `onModuleInit`, intervalo 5 s) consulta
**`GET /api/tasks/by-status`** (incremental com `?since=`) no motor e mantém
um cache em memória por status — exposto em
`GET /api/gerenteagentes/tasks/by-status` (§5.1). Falhas de polling são
logadas e toleradas (o próximo ciclo tenta de novo).

### 6.5 Direção da comunicação

```
UI (web) ──► API NestJS (/api/gerenteagentes) ──► motor (container OpenClaw)
                                    │
                                    └── database projeto_<id> (Drizzle/MySQL)
```

- A UI só conhece a API da plataforma.
- A API fala com o motor via `motorRequest`/`motorGet` (timeout 10 s / 5 s).
- IDs de tarefa no motor são determinísticos (`task-biblioteca-<id>`), o que
  torna create/start/proxy idempotentes por ID.
- O ID do agente do OpenClaw é armazenado diretamente em
  `projetos_captados.agente_id`.

---

## 7. Status

### Status de Tarefas

- `draft`: rascunho, não planejada
- `planned`: planejada, aguardando start (ou já enviada ao motor)
- `running`: em execução
- `paused`: pausada
- `completed`: concluída com sucesso
- `failed`: falhou (após max_rework)
- `cancelled`: cancelada

### Status de Subtarefas

- `pending`: pendente
- `running`: em execução
- `verified`: verificada com sucesso
- `failed`: falhou

### Fluxo de Execução

1. Admin cria tarefa (draft) → `POST /api/gerenteagentes/projetos-captados/:projetoId/tarefas`
2. Admin inicia tarefa → `POST /api/gerenteagentes/tarefas/:id/start`
   (API resolve agente + ambiente do projeto e encaminha ao motor)
3. Motor enfileira (FIFO) e executa as subtarefas
4. API acompanha em tempo real → `GET /api/gerenteagentes/tasks/by-status` (cache do poller)
5. Admin detalha execução → `GET /api/gerenteagentes/tarefas/:id/motor-detail`
6. Admin interage → `POST /api/gerenteagentes/tarefas/:id/chat`

### Fluxo de Projeto

1. Isa capta contato + projeto (com ambiente: repoPath/buildCommand/unitTestCommand) + definições → `POST /api/gerenteagentes/contatos` + `POST /api/gerenteagentes/projetos-captados` + `POST /api/gerenteagentes/projetos-captados/:id/definicoes`
2. Admin revisa projeto → `GET /api/gerenteagentes/projetos-captados/:id`
3. Admin inicia desenvolvimento → `POST /api/gerenteagentes/projetos-captados/:id/desenvolvimento` (`plataformaProjetoId` preenchido)
4. Admin dispara geração macro → `POST /api/gerenteagentes/projetos-captados/:id/start`
5. Analista forte gera tarefas → motor cria tarefas automaticamente
6. Admin acompanha geração → `GET /api/gerenteagentes/projetos-captados/:id/geracoes`
7. Admin interage com analista → `POST /api/gerenteagentes/projetos-captados/:id/chat`
