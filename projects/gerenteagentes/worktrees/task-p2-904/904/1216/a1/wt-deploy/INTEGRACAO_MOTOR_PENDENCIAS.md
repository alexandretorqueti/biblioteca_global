# Integração Biblioteca ↔ Motor — Pendências (2026-08-19)

## Contexto
O motor PROD está rodando no MySQL `projeto_640` (Fase 2 completa). A biblioteca já tem:
- ✅ Schema completo (13 tabelas)
- ✅ Controller com endpoints básicos
- ✅ Service com lógica de negócio
- ✅ Dados migrados (11 tasks, 46 subtarefas)

## ✅ O QUE JÁ EXISTE

### Backend (apps/api/src/modules/gerenteagentes/)

**Controller (152 linhas):**
- ✅ `POST /tarefas/:id/start` — iniciar tarefa
- ✅ `POST /tarefas/:id/pause` — pausar tarefa
- ✅ `POST /tarefas/:id/resume` — retomar tarefa
- ✅ `GET /tarefas/:id/chat` — listar chat da tarefa
- ✅ `POST /tarefas/:id/chat` — adicionar mensagem ao chat da tarefa
- ✅ `GET /projetos-captados/:id/chat` — listar chat do projeto
- ✅ `POST /projetos-captados/:id/chat` — adicionar mensagem ao chat do projeto
- ✅ `POST /projetos-captados/:id/start` — iniciar geração de tarefas macro
- ✅ `GET /projetos-captados/:id/geracoes` — listar gerações do projeto
- ✅ `GET /tarefas/:id/subtarefas` — listar subtarefas
- ✅ `POST /projetos-captados/:id/desenvolvimento` — provisionar projeto na plataforma

**Service (11KB):**
- ✅ Todas as operações CRUD implementadas
- ✅ Validação de escopo de projeto (ProjectScopeGuard)
- ✅ Integração com ProvisionService
- ✅ Uso do schema do projeto gerenteagentes

**Schema (projects/gerenteagentes/schema.ts):**
- ✅ 13 tabelas definidas (agentes, contatos, projetos_captados, definições, chats, chat_mensagens, tarefas, subtarefas, tarefa_chats, projeto_chats, geracoes_projeto, bloqueios)
- ✅ Relações definidas (FK, cascade)
- ✅ Annotations de formulário

---

## ❌ PENDÊNCIAS (O QUE FALTA)

### 1. **ENDPOINTS DE LEITURA (CRUD COMPLETO)**

#### Tarefas
- ❌ `GET /tarefas` — listar todas as tarefas do projeto (com filtros: status, agente)
- ❌ `GET /tarefas/:id` — detalhes de uma tarefa (com contagem de subtarefas, progresso)
- ❌ `POST /tarefas` — criar tarefa manualmente (draft)
- ❌ `PUT /tarefas/:id` — editar tarefa (título, descrição, agente, timeout)
- ❌ `DELETE /tarefas/:id` — cancelar tarefa

#### Subtarefas
- ❌ `GET /subtarefas` — listar todas as subtarefas do projeto (com filtros)
- ❌ `GET /subtarefas/:id` — detalhes de uma subtarefa
- ❌ `POST /subtarefas` — criar subtarefa manualmente
- ❌ `PUT /subtarefas/:id` — editar subtarefa (título, escopo, critérios)
- ❌ `DELETE /subtarefas/:id` — cancelar subtarefa
- ❌ `POST /subtarefas/:id/skip-gate` — marcar subtarefa para pular gate (debug)

#### Projetos Captados
- ❌ `GET /projetos-captados` — listar todos os projetos (já existe via CRUD genérico?)
- ❌ `GET /projetos-captados/:id` — detalhes do projeto (com contagens)

#### Agentes
- ❌ `GET /agentes` — listar agentes disponíveis
- ❌ `GET /agentes/:id` — detalhes do agente
- ❌ `POST /agentes` — criar agente
- ❌ `PUT /agentes/:id` — editar agente
- ❌ `DELETE /agentes/:id` — desativar agente

#### Bloqueios
- ❌ `GET /bloqueios` — listar bloqueios do projeto/tarefa
- ❌ `POST /bloqueios/:id/resolve` — marcar bloqueio como resolvido

#### Gerações de Projeto
- ❌ `GET /geracoes-projeto/:id` — detalhes de uma geração (com tarefas geradas)
- ❌ `POST /geracoes-projeto/:id/retry` — re-tentar geração falha

#### Chats (Isa)
- ❌ `GET /chats` — listar chats do projeto (com filtros: status, contato)
- ❌ `GET /chats/:id` — detalhes do chat (com mensagens)
- ❌ `GET /chats/:id/mensagens` — listar mensagens do chat (com paginação)
- ❌ `POST /chats/:id/mensagens` — adicionar mensagem manualmente

### 2. **INTEGRAÇÃO COM MOTOR (PROXY/REDIRECT)**

**Problema:** O motor tem endpoints próprios (porta 6283) que a biblioteca precisa expor de forma unificada.

#### Opção A: Proxy Reverso (recomendado)
- ❌ Configurar proxy no NestJS para redirecionar `/api/motor/*` → `http://localhost:6283/*`
- ❌ Autenticação JWT do proxy (usar mesmo guard)
- ❌ Log de requisições proxy

#### Opção B: Cliente HTTP
- ❌ Criar `MotorClient` no service para chamar endpoints do motor
- ❌ Cache de respostas (Redis/memória)
- ❌ Retry/circuit breaker

**Endpoints do motor que precisam ser expostos:**
```
GET  /api/tasks/running        → tarefas em execução
GET  /api/task/:id             → detalhes da tarefa
POST /api/task/:id/execute     → executar tarefa (alternativa ao /start)
GET  /api/task/:id/events      → stream de eventos (SSE/WebSocket)
GET  /dashboard                → dashboard HTML (será descontinuado)
```

### 3. **TELAS DO FRONTEND**

#### Dashboard do Projeto
- ❌ Resumo do projeto (contagens: tarefas por status, subtarefas por status)
- ❌ Gráfico de progresso (tarefas concluídas vs total)
- ❌ Atividade recente (últimas tarefas, bloqueios)

#### Lista de Tarefas
- ❌ Tabela com filtros (status, agente, data)
- ❌ Busca por título/descrição
- ❌ Ordenação (data, status, progresso)
- ❌ Ações em lote (iniciar, pausar, cancelar)

#### Detalhes da Tarefa
- ❌ Header com título, status, agente, progresso
- ❌ Descrição (markdown renderizado)
- ❌ Lista de subtarefas (com progresso)
- ❌ Chat da tarefa (histórico + input)
- ❌ Timeline de eventos (criada, iniciada, pausada, etc.)
- ❌ Bloqueios ativos (com botão de resolver)

#### Detalhes da Subtarefa
- ❌ Header com título, status, sequência
- ❌ Escopo (markdown)
- ❌ Critérios de aceite (checklist)
- ❌ Resultado (se verificada)
- ❌ Duração, contagem de entregas
- ❌ Logs de execução (se disponível)

#### Chat do Projeto
- ❌ Interface de chat (mensagens + input)
- ❌ Histórico com paginação
- ❌ Renderização de markdown/código
- ❌ Menção de tarefas/subtarefas (links)

#### Chat da Tarefa
- ❌ Mesma interface do chat do projeto
- ❌ Contexto da tarefa (header fixo)
- ❌ Links para subtarefas mencionadas

#### Gerações de Projeto
- ❌ Lista de gerações (status, data, modelo)
- ❌ Detalhes da geração (briefing, tarefas geradas)
- ❌ Botão de retry (se falhou)

#### Agentes
- ❌ Lista de agentes (nome, modelo, status)
- ❌ Detalhes do agente (descrição, tarefas atribuídas)
- ❌ Formulário de criação/edição

### 4. **FUNCIONALIDADES AVANÇADAS**

#### Notificações
- ❌ Notificar quando tarefa completa
- ❌ Notificar quando subtarefa verifica
- ❌ Notificar quando bloqueio ocorre
- ❌ Integração com email/Slack/Discord

#### Métricas
- ❌ Tempo médio de execução por tarefa
- ❌ Taxa de sucesso (verified vs failed)
- ❌ Uso de tokens por agente
- ❌ Custo estimado por tarefa

#### Automação
- ❌ Auto-start de tarefas dependentes (depends_on_task_id)
- ❌ Retry automático de subtarefas falhas (até max_rework)
- ❌ Escalonamento de modelos (se subtarefa falha N vezes)

#### Debug/Dev Tools
- ❌ Logs detalhados do motor (stream)
- ❌ Inspeção de sessão do agente (histórico completo)
- ❌ Re-execução manual de subtarefa
- ❌ Export de logs (JSON/CSV)

### 5. **INTEGRAÇÃO COM OPENCLAW**

#### Sessões de Agentes
- ❌ Listar sessões ativas do agente
- ❌ Ver histórico de uma sessão (mensagens + tool calls)
- ️ Enviar mensagem manual para sessão (debug)
- ❌ Forçar encerramento de sessão

#### Gateway
- ❌ Health check do gateway
- ❌ Lista de agentes registrados
- ❌ Métricas de uso (tokens, requisições)

### 6. **SEGURANÇA E PERMISSÕES**

#### Roles (já definidos, mas verificar)
- ✅ `admin` — acesso total
- ✅ `gerente` — gerenciar tarefas/projetos
- ✅ `operador` — executar tarefas, ver chats
- ❌ `visualizador` — apenas leitura (se necessário)

#### Escopo de Projeto
- ✅ ProjectScopeGuard (verifica se usuário tem acesso ao projeto)
- ❌ Auditoria de ações (quem fez o quê, quando)

### 7. **PERFORMANCE E OTIMIZAÇÕES**

- ❌ Cache de listagens (tarefas, subtarefas) — invalidar em mutations
- ❌ Paginação em listagens grandes (chats, bloqueios)
- ❌ Indexação de queries frequentes (status, projeto_id, agente_id)
- ❌ Lazy loading de chats (carregar sob demanda)

### 8. **TESTES**

- ❌ Testes unitários do service (mock DB)
- ❌ Testes de integração (DB real)
- ❌ Testes E2E (frontend → backend → DB)
- ❌ Testes de carga (múltiplas tarefas simultâneas)

---

## 🎯 PRIORIDADES (SUGESTÃO)

### Fase 1 — MVP (2-3 dias)
1. Endpoints de leitura (listar tarefas, subtarefas, chats)
2. Tela de lista de tarefas (com filtros básicos)
3. Tela de detalhes da tarefa (com subtarefas)
4. Chat da tarefa (histórico + input)

### Fase 2 — Funcionalidades Core (3-5 dias)
5. Dashboard do projeto (resumo + gráficos)
6. CRUD completo de tarefas/subtarefas
7. Chat do projeto
8. Integração com motor (proxy ou cliente)

### Fase 3 — Avançado (5-7 dias)
9. Notificações
10. Métricas e analytics
11. Automação (auto-start, retry)
12. Debug tools

---

## 📊 STATUS ATUAL

**Backend:**
- Endpoints implementados: 11/40 (27%)
- Linhas de código: ~300 (controller + service)

**Frontend:**
- Telas implementadas: 0/12 (0%)
- Componentes: 0

**Dados:**
- Tasks no MySQL: 11
- Subtarefas no MySQL: 46
- Chats: 0 (ainda não migrados do Postgres?)

**Motor:**
- Rodando: ✅ (PID 376160, porta 6283)
- Dashboard: ✅ (HTTP 200)
- Persistência: ✅ (MySQL projeto_640)

---

## 🔗 REFERÊNCIAS

- Motor PROD: `/data/workspace/projects/agentes/gerenteagentes/prod/GerenteAgentes`
- Biblioteca: `/data/workspace/projects/agentes/bibliotecaglobal/project/biblioteca-global`
- Schema: `projects/gerenteagentes/schema.ts`
- Endpoints motor: `apps/manager/src/task-server.ts`
- Documentação: `docs/MIGRACAO_MYSQL_PENDENCIAS.md`
