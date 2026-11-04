# ESPEC-CRUD — Gestão de Tarefas Global (gestao-de-tarefas-global)

> Fonte de verdade para `config.ts`/`schema.ts` do projeto
> (docs/PROPOSTA-GERACAO-MACRO-TAREFAS.md §4). Gerado a partir do plano
> macro aprovado (geracoes_projeto #1) em 2026-11-04T22:03:43.906Z.
> Edições manuais devem preservar este formato.

## Classificação do sistema

- Classificação: misto
- Requer agente dedicado: sim

## Entidades

### organizacoes
- Menu: Administração → Organizações (roleFilter: admin)
- Campos:
  - id PK
  - nome varchar(160) NOT NULL
  - descricao text NULL
  - ativa boolean default true
  - timestamps
- Máscaras/validações:
  - nome: required, minLength 2

### areas
- Menu: Cadastros → Áreas
- Campos:
  - id PK
  - organizacaoId FK→organizacoes NOT NULL
  - nome varchar(120) NOT NULL
  - descricao text NULL
  - responsavelId FK→colaboradores NULL
  - timestamps
- Máscaras/validações:
  - nome: required
  - UNIQUE(organizacaoId, nome)

### tags
- Menu: Cadastros → Tags
- Campos:
  - id PK
  - organizacaoId FK→organizacoes NOT NULL
  - nome varchar(80) NOT NULL
- Máscaras/validações:
  - nome: required
  - UNIQUE(organizacaoId, nome)

### colaboradores
- Menu: Administração → Colaboradores (roleFilter: admin|gerente)
- Campos:
  - id PK
  - organizacaoId FK→organizacoes NOT NULL
  - nome varchar(160) NOT NULL
  - email varchar(160) NOT NULL
  - telefone varchar(20) NULL
  - cpf char(14) NULL (sensível)
  - ativo boolean default true
  - usuarioId int NULL (vínculo com usuário global da plataforma)
- Máscaras/validações:
  - nome: validator nomeCompleto, required
  - email: type email, required
  - telefone: mask+validator telefone
  - cpf: mask+validator cpf; visível apenas admin/gerente (hiddenColumns + bloqueio backend)

### tarefas
- Menu: Tarefas → Todas as tarefas (children: chat, histórico, anexos)
- Campos:
  - id PK
  - organizacaoId FK→organizacoes NOT NULL
  - titulo varchar(200) NOT NULL
  - descricao text NULL
  - areaId FK→areas NOT NULL
  - responsavelId FK→colaboradores NOT NULL (único ativo)
  - criadoPorId FK→colaboradores NOT NULL
  - prioridade enum('baixa','media','alta','urgente') default 'media'
  - prazo datetime NULL
  - status enum('aberta','delegada','concluida','precisa_informacoes','aguardando_terceiro','cancelada') default 'aberta'
  - lembreteAntecedenciaMinutos int NULL (NULL = sem aviso; proibido não-nulo com prazo NULL)
  - regraRecorrenciaId FK→regras_recorrencia NULL
  - concluidaEm datetime NULL
  - timestamps
- Máscaras/validações:
  - titulo: required, minLength 3
  - enums → select
  - FKs → multipleChoice inferido
  - defaultOrderBy prazo:asc valuesLast, prioridade:desc
  - status editável apenas via endpoints do fluxo custom

### tarefa_tags
- Menu: (pivot sem tela; tags via multipleChoice multiple na tarefa)
- Campos:
  - id PK
  - tarefaId FK→tarefas cascade
  - tagId FK→tags cascade
  - UNIQUE(tarefaId, tagId)
- Máscaras/validações:
  - —

### mensagens_tarefa
- Menu: (chat da tarefa; UI reaproveita TaskChat nativo)
- Campos:
  - id PK
  - tarefaId FK→tarefas NOT NULL
  - autorId FK→colaboradores NOT NULL
  - texto text NOT NULL
  - criadoEm timestamp
- Máscaras/validações:
  - texto: required, textarea

### anexos
- Menu: (childScreen de tarefas via fluxo custom de anexos)
- Campos:
  - id PK
  - tarefaId FK→tarefas NOT NULL
  - organizacaoId FK→organizacoes NOT NULL
  - nomeArquivo varchar(255) NOT NULL
  - mimeType varchar(120) NULL
  - tamanhoBytes bigint NULL
  - chaveArmazenamento varchar(500) NOT NULL
  - enviadoPorId FK→colaboradores NOT NULL
  - criadoEm timestamp
- Máscaras/validações:
  - limites no módulo custom: máx ~10MB/arquivo; tipos pdf, imagens, texto

### regras_recorrencia
- Menu: Tarefas → Recorrências
- Campos:
  - id PK
  - organizacaoId FK→organizacoes NOT NULL
  - titulo varchar(200) NOT NULL
  - descricao text NULL
  - areaId FK→areas NOT NULL
  - responsavelId FK→colaboradores NOT NULL
  - frequencia enum('diaria','semanal','mensal') NOT NULL
  - diasSemana json NULL (obrigatório p/ semanal)
  - horaDoDia time NULL
  - dataInicio date NOT NULL
  - dataFim date NULL (NULL = sem fim)
  - ativa boolean default true
  - proximaGeracao datetime NULL
  - timestamps
- Máscaras/validações:
  - frequencia: select do enum
  - dataInicio: required
  - dataFim: minDate ≥ dataInicio

### historico_tarefas
- Menu: (childScreen de tarefas: Histórico)
- Campos:
  - id PK
  - tarefaId FK→tarefas NOT NULL
  - tipoEvento enum('criacao','delegacao','devolucao_concluida','devolucao_precisa_info','devolucao_aguardando_terceiro','reatribuicao','mudanca_status','mudanca_prazo','mudanca_prioridade','anexo','lembrete_gerado') NOT NULL
  - deColaboradorId FK→colaboradores NULL
  - paraColaboradorId FK→colaboradores NULL
  - mensagem text NULL
  - criadoEm timestamp
- Máscaras/validações:
  - append-only: grid somente leitura, sem create/edit/delete na config

### notificacoes
- Menu: (consumidas pelo sino custom; sem tela de cadastro)
- Campos:
  - id PK
  - organizacaoId FK→organizacoes NOT NULL
  - usuarioId int NOT NULL
  - titulo varchar(200) NOT NULL
  - corpo text NULL
  - tipo enum('lembrete','delegacao','devolucao','sistema') NOT NULL
  - tarefaId FK→tarefas NULL
  - lida boolean default false
  - criadoEm timestamp
- Máscaras/validações:
  - —

## Observações

PROJETO ÚNICO (clarificação 1): não criar projeto por organização; todas as tabelas de negócio têm organizacaoId e toda leitura/escrita é filtrada pela organização do usuário logado (escopo row-level custom). Auth/usuários/perfis 100% reaproveitados da plataforma: master = admin da plataforma (tela Usuários nativa + provision/vincular); admin de organização = perfil admin; gerente vê dados sensíveis (clarificação 8); colaboradores = operador; visualizador somente leitura. Chat reaproveita TaskChat nativo. Lembrete é sempre 'x antes do prazo'; prazo NULL → proibido lembrete (decisão 2026-10-22). Config nas duas fontes (config.ts + config corrente no core) conforme MANUAL_CONFIG_PROJETOS §1.
