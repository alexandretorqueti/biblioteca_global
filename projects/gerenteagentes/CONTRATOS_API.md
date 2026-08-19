# Contratos de API — Gerente Agentes

**Versão:** 1.0 (2026-08-18)  
**Base URL:** `/api/gerenteagentes` (API da plataforma)  
**Auth:** Token de serviço (provision) ou JWT de usuário autenticado

---

## Sumário

1. [Captação (Isa)](#1-captação-isa)
2. [Gestão de Projetos](#2-gestão-de-projetos)
3. [Gestão de Tarefas](#3-gestão-de-tarefas)
4. [Chats](#4-chats)
5. [Execução (Motor)](#5-execução-motor)

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

```json
// Request
{
  "nome": "Sistema de Gestão",
  "slug": "sistema-gestao",
  "descricao": "Sistema web para gestão de clientes",
  "regras": "Usar React + TypeScript. Banco MySQL.",
  "contatoId": 1,
  "agenteId": 1
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

---

## 3. Gestão de Tarefas

### 3.1 CRUD de Tarefas

**POST /api/gerenteagentes/projetos-captados/:projetoId/tarefas**  
Cria uma nova tarefa (draft).

```json
// Request
{
  "agenteId": 1,
  "titulo": "Implementar autenticação",
  "descricao": "Criar sistema de login com email/senha",
  "repoPath": "/data/workspace/projects/sistema-gestao",
  "buildCommand": "npm run build",
  "unitTestCommand": "npm run test",
  "dependsOnTaskId": null,
  "autoStart": false
}

// Response 201
{
  "id": 1,
  "projetoId": 1,
  "agenteId": 1,
  "titulo": "Implementar autenticação",
  "descricao": "Criar sistema de login com email/senha",
  "repoPath": "/data/workspace/projects/sistema-gestao",
  "buildCommand": "npm run build",
  "unitTestCommand": "npm run test",
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
Inicia a execução da tarefa (draft → planned → running).

```json
// Response 202
{
  "id": 1,
  "status": "running",
  "message": "Tarefa iniciada"
}
```

**POST /api/gerenteagentes/tarefas/:id/pause**  
Pausa a tarefa (running → paused).

**POST /api/gerenteagentes/tarefas/:id/resume**  
Retoma a tarefa (paused → running).

### 3.3 Subtarefas

**GET /api/gerenteagentes/tarefas/:id/subtarefas**  
Lista subtarefas da tarefa.

```json
// Response 200
{
  "subtarefas": [
    {
      "id": 1,
      "tarefaId": 1,
      "seq": 1,
      "titulo": "Criar schema de banco",
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

### 5.1 Polling de Tarefas

**GET /api/gerenteagentes/tarefas/pending**  
Lista tarefas prontas para execução (planned + auto_start=true ou dependências resolvidas).

```json
// Response 200
{
  "tarefas": [
    {
      "id": 1,
      "projetoId": 1,
      "agenteId": 1,
      "titulo": "Implementar autenticação",
      "repoPath": "/data/workspace/projects/sistema-gestao",
      "buildCommand": "npm run build",
      "unitTestCommand": "npm run test",
      "status": "planned",
      "maxRework": 3,
      "hardTimeoutMs": 600000
    }
  ]
}
```

### 5.2 Atualização de Estado

**PATCH /api/gerenteagentes/tarefas/:id/status**  
Atualiza status da tarefa (usado pelo motor).

```json
// Request
{
  "status": "running",
  "bootRetryCount": 0
}
```

**POST /api/gerenteagentes/tarefas/:id/subtarefas**  
Cria/atualiza subtarefa (usado pelo motor).

```json
// Request
{
  "seq": 1,
  "titulo": "Criar schema de banco",
  "descricao": "Criar tabelas users e sessions",
  "status": "running"
}
```

**PATCH /api/gerenteagentes/subtarefas/:id**  
Atualiza subtarefa (resultado, duração, status).

```json
// Request
{
  "status": "verified",
  "resultado": "Schema criado com sucesso",
  "duracaoSegundos": 45,
  "finalizadaEm": "2026-08-18T14:30:45Z"
}
```

**POST /api/gerenteagentes/tarefas/:id/bloqueios**  
Registra bloqueio da tarefa.

```json
// Request
{
  "blockReason": "Teste falhou",
  "blockCommand": "npm run test",
  "blockExitCode": 1,
  "blockExcerpt": "Expected 200, got 401"
}
```

### 5.3 Chat (Motor → Admin)

**POST /api/gerenteagentes/tarefas/:id/chat**  
Analista faz pergunta ao admin.

```json
// Request
{
  "role": "analyst",
  "texto": "Qual biblioteca de autenticação devo usar?"
}
```

---

## Status de Tarefas

- `draft`: rascunho, não planejada
- `planned`: planejada, aguardando start
- `running`: em execução
- `paused`: pausada
- `completed`: concluída com sucesso
- `failed`: falhou (após max_rework)
- `cancelled`: cancelada

## Status de Subtarefas

- `pending`: pendente
- `running`: em execução
- `verified`: verificada com sucesso
- `failed`: falhou

## Fluxo de Execução

1. Admin cria tarefa (draft) → `POST /tarefas`
2. Admin inicia tarefa → `POST /tarefas/:id/start` (draft → planned → running)
3. Motor faz polling → `GET /tarefas/pending`
4. Motor executa subtarefas → `POST /tarefas/:id/subtarefas` + `PATCH /subtarefas/:id`
5. Motor atualiza status → `PATCH /tarefas/:id/status`
6. Admin acompanha → `GET /tarefas/:id` + `GET /tarefas/:id/subtarefas`
7. Admin interage → `POST /tarefas/:id/chat`

## Fluxo de Projeto

1. Isa capta contato + projeto + definições → `POST /contatos` + `POST /projetos-captados` + `POST /projetos-captados/:id/definicoes`
2. Admin revisa projeto → `GET /projetos-captados/:id`
3. Admin dispara geração macro → `POST /projetos-captados/:id/start`
4. Analista forte gera tarefas → motor cria tarefas automaticamente
5. Admin acompanha geração → `GET /projetos-captados/:id/geracoes`
6. Admin interage com analista → `POST /projetos-captados/:id/chat`
7. Ao iniciar desenvolvimento: motor cria app na plataforma → `plataformaProjetoId` preenchido
