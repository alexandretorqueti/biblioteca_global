# Proposta — Religação da Geração Macro de Tarefas (spec → plano → aprovação → execução)

> Status: **APROVADA por Alexandre em 2026-10-29 17:18** — faseamento F1–F5 aprovado e convertido em tarefas do motor (ver §9). Nada implementado ainda; tarefas criadas `planned`/pausadas, sem play.
> (Desenhada em 2026-10-29, sem implementação.)
> Origem: revisão do fluxo "Isa capta projeto → executar projeto → tarefas criadas pela IA",
> usando o projeto **Gestão de Tarefas Global** como caso de estudo (tarefas 1021–1025 pobres,
> furos de escopo — multi-tenancy, permissões, visões, responsividade, infra de email).
> Diagnóstico completo: conversa de 2026-10-29 (workspace gerenteagentes, memory/2026-10-29.md).

## 0. Problema em uma frase

A criação das tarefas macro do projeto novo acontece hoje como **efeito colateral do passo 3.6
da missão de setup**, com prompt enviesado para "telas custom", alimentado por **um parágrafo**
(`projetos_captados.descricao`), sem inventário de requisitos, sem matriz de cobertura, sem
dependências e sem aprovação humana — enquanto o fluxo desenhado para isso
(`geracoes_projeto` + clarificação no chat do projeto) existe mas está **desconectado**
(tabela com 0 linhas; nenhum consumidor de `status='pending'` no código).

## 0.1 Alinhamento 2026-10-29 15:41 (Alexandre) — incorporado a esta proposta

1. **O planejador deve conhecer a biblioteca ANTES de especificar.** Entrada obrigatória do
   plano: **Catálogo de Capacidades da Biblioteca** (artefato versionado e mantido — o que o
   CRUD/plataforma cobre nativamente: tipos de tela, campos, validadores/máscaras, auth única,
   RBAC, menus, relatórios padrão…). Só com ele o plano classifica cada funcionalidade como
   `crud | custom | lacuna`.
2. **Critério do agente dedicado = existência de custom no PLANO** (não no improviso do setup).
   Sistema 100% CRUD → **nenhum agente separado é criado**; o projeto vive na plataforma. O
   setup passa a **materializar** a decisão do plano (criar agente só se o plano indicar ≥1
   funcionalidade custom).
3. **O plano produz DOIS tipos de especificação, com executores distintos:**
   - **Especificação CRUD** (entidades, campos, menus, validações) → artefato declarativo que
     dirige o `config.ts`/`schema.ts`; executor = **biblioteca-global**;
   - **Especificações de telas/funcionalidades personalizadas** → tarefas do motor; executor =
     **agente do projeto novo**.
   Cada tarefa do plano carrega `executor: "biblioteca-global" | "agente-projeto"`.
4. **Registro histórico de lacunas da biblioteca (roadmap por demanda real):** toda
   funcionalidade pedida que a biblioteca NÃO tem nativamente entra num registro acumulativo
   (`lacunas_biblioteca`: projeto, REQ, funcionalidade, data, decisão posterior
   `absorver|adiar|recusada`). Funcionalidades recorrentes entre projetos viram candidatas a
   capacidade nativa da biblioteca.

## 1. Princípios da proposta

1. **Planejamento é fase dedicada, não subproduto do provisionamento.** Setup cuida de
   infraestrutura (pasta, config, schema, banco, registros, agente). Quem cria as tarefas de
   negócio é a **Geração Macro**, a partir da especificação completa.
2. **Especificação rica viaja até as tarefas.** Cada tarefa macro nasce com escopo, critérios
   de aceite, REQs cobertos e dependências — o analista da tarefa nunca precisa re-inventar
   intenção a partir de uma frase.
3. **Cobertura auditável.** O plano exige inventário REQ-* extraído da especificação e matriz
   REQ → tarefas. Requisito sem tarefa = lacuna explícita no plano (o plano diz "ficou de fora
   nesta fase porque X"), não buraco silencioso.
4. **Aprovação humana antes de executar.** Nada de `auto_start=true` direto do berço: o plano
   é apresentado, o Alexandre aprova/edita/rejeita; só então as tarefas são criadas e
   enfileiradas (e só após `setup_status='verified'`).
5. **Perguntar em vez de inventar.** A geração usa a clarificação interativa que já existe
   (`registrarClarificacaoProjeto` + `projeto_chats` + `awaiting_clarification`).
6. **Planejamento fica no modelo pago** (regra já confirmada: não delegar
   arquitetura/planejamento para modelo local). A cadeia de modelos da geração é configurável,
   com default pago.
7. **Reusar o que existe.** `geracoes_projeto` (inclusive a coluna `tasks` json), endpoints
   `start`/`geracoes`/`clarificacao`/chat do projeto, prompt do analista com matriz REQ-*,
   padrões de reconciliador/lease do motor-v3.

## 2. Fluxo alvo (ponta a ponta)

```
Isa (captação)
  └─ produz ESPECIFICAÇÃO COMPLETA (doc estruturado, não só parágrafo)
       grava em projetos_captados.especificacao + projects/<slug>/docs/ESPECIFICACAO.md

"Executar projeto" (botão)
  ├─ (A) Provisionamento + missão de setup  [como hoje, SEM o passo 3.6 de criar tarefas]
  │      └─ setup_status: pending → queued → running → verified
  └─ (B) POST projetos-captados/:id/start → cria geracao (status=pending)   [endpoint já existe]

Motor-v3: ProjectGenerationWorker (NOVO — consumidor de geracoes_projeto)
  pending ──claim (lease)──▶ running
  running ──analista (modelo pago, sessão Console/OpenClaw)──▶
      │  entrada: especificação completa + docs do projeto + catálogo do que o CRUD
      │           da biblioteca já cobre + histórico do chat do projeto
      │  contrato de saída (JSON):
      │    forma 1: { kind:"perguntas", resumo, perguntas[] }  → awaiting_clarification
      │    forma 2: { kind:"plano", requisitos[REQ-*], tarefas[...], matrizCobertura,
      │               lacunas[], riscos[] }
      ├─ perguntas → registrarClarificacaoProjeto (já existe) → awaiting_clarification
      │     └─ resposta no chat do projeto (role=user) → pending → reprocessa com histórico
      └─ plano → grava em geracoes_projeto.tasks (json) → status=awaiting_approval (NOVO)

Aprovação (tela do projeto + notificação Telegram)
  ├─ aprovar como está ─────────────▶ materializa tarefas (ver §4) → completed
  ├─ editar (título/escopo/aceite/dependências/ordem) ▶ re-salva plano → aprova
  ├─ pedir revisão com comentário ──▶ running (nova rodada com feedback)
  └─ rejeitar ──────────────────────▶ rejected (fim; nada é criado)

Execução
  tarefas criadas com auto_start/dependências ──▶ motor só despacha quando
  setup_status='verified' (gate novo) ──▶ análise por tarefa (prompt do analista já
  recebe descrição rica + REQs + docs) ──▶ fluxo normal DEV/gates/deploy
```

## 3. Componentes (o que criar / o que mudar)

### 3.1 Motor-v3 (`projects/gerenteagentes/motor-v3`)

| Item | Tipo | Descrição |
|---|---|---|
| `ProjectGenerationWorker` | NOVO | Consome `geracoes_projeto` `pending` (poll curto ou outbox), claim com lease, monta prompt, dispara sessão do agente analista, interpreta contrato de saída, grava `tasks` json e faz transições de status. Espelho do padrão `TaskWorker`/analysis, porém no nível do projeto. |
| `GenerationClaimReconciler` | NOVO | Órfãos: `running` sem worker vivo → volta para `pending` (padrão AnalysisClaimReconciler; boot + 5 min). |
| Status novos na geracao | AJUSTE | `awaiting_approval`, `approved`, `rejected`, `failed` (coluna varchar já comporta). Transições documentadas no schema. |
| Gate de execução | AJUSTE | `selectNextTask`/pump: tarefa de projeto com `setup_status != 'verified'` não é despachada (capacidade/espera, não falha). |
| Prompt de geração macro | NOVO (catálogo) | Ver §5. Entra no catálogo de prompts (`prompts_agentes`/seed-prompts) para ser versionável/editável na tela de Prompts. |
| Catálogo de Capacidades da Biblioteca | NOVO (artefato) | `docs/CATALOGO-CAPACIDADES-BIBLIOTECA.md` versionado no monorepo (mantido pela Bibliotecária Global a cada capacidade nova): tipos de tela CRUD, campos/máscaras/validadores, auth, RBAC, menus, relatórios padrão. Entrada obrigatória do prompt de geração (§5 `<CATALOGO_CRUD>`). |
| Registro de lacunas | NOVO (tabela) | `lacunas_biblioteca` (projeto_id, geracao_id, req_id, funcionalidade, contexto, status `aberta|absorver|adiar|recusada`, decided_at/decided_by). Alimentada pelo plano na aprovação; insumo de roadmap da biblioteca (recorrência entre projetos = candidata a capacidade nativa). |

### 3.2 API biblioteca (`projects/gerenteagentes/api`)

| Item | Tipo | Descrição |
|---|---|---|
| `POST projetos-captados/:id/geracoes/:geracaoId/aprovar` | NOVO | Body: `{ decisao: 'approve'|'reject'|'revise', comentario?, planoEditado? }`. Transação única: valida estado `awaiting_approval`, materializa tarefas (ou rejeita), registra no chat do projeto e no feed operacional. |
| `GET projetos-captados/:id/geracoes` | EXISTE | Passa a expor o plano (`tasks` json) para a tela renderizar. |
| `montarMissaoSetup` | AJUSTE | Remove o passo 3.6 de criação de tarefas e a decisão improvisada de agente dedicado: o setup passa a **materializar o plano aprovado** — cria o agente do projeto SOMENTE se `requerAgenteDedicado=true`; gera config.ts/schema.ts a partir da `especificacaoCrud` do plano (não re-analisa a descrição); mantém registros obrigatórios e smoke test. Sem plano aprovado ainda, executa só a estrutura mínima; o gate de execução (§2) segura as tarefas até lá. |
| `iniciarDesenvolvimento` | AJUSTE | Além do setup, cria a geracao inicial (chama `iniciarGeracaoProjeto`) — os dois trilhos (A e B) partem juntos do mesmo clique. |
| Especificação | AJUSTE | `projetos_captados.especificacao` (longtext, migration) + gravação do doc em `projects/<slug>/docs/ESPECIFICACAO.md` no setup (passo 1.1.x). Enquanto a Isa não produzir o doc completo, o campo aceita a descrição estendida que ela já consegue gerar. |

### 3.3 Isa (captação — `global-ia`/isa-chat)

| Item | Tipo | Descrição |
|---|---|---|
| Saída estruturada | AJUSTE | Ao final da captação, a Isa gera o documento de especificação (seções mínimas: visão geral, atores/papéis, requisitos funcionais numerados, requisitos não-funcionais, entidades de dados, integrações, fora-de-escopo) e grava em `especificacao`. O parágrafo `descricao` continua existindo como resumo. |

> Fronteira Biblioteca vs. Motor (regra de ouro): schema/coluna nova e endpoints são do
> projeto gerenteagentes (motor/API do motor); a mudança na Isa é no projeto dela, com
> contrato apenas no formato do documento. Nada disso é plataforma (core) — não toca RBAC/identity.

### 3.4 Front (telas do gerenteagentes na Biblioteca)

| Item | Tipo | Descrição |
|---|---|---|
| Painel "Plano do projeto" | NOVO | Na tela do projeto captado: estado da geração (pending/clarificação/aguardando aprovação), plano renderizado (REQs, tarefas com escopo/aceite/dependências, matriz de cobertura, lacunas), botões Aprovar / Editar / Pedir revisão / Rejeitar, e o chat de clarificação já existente. |
| Notificação | AJUSTE | Telegram quando entrar em `awaiting_clarification` e `awaiting_approval` (o evento já sai pelo barramento; falta o disparo). |

## 4. Materialização das tarefas (na aprovação)

Para cada tarefa do plano aprovado, em transação única:

- `tarefas.titulo` / `tarefas.descricao` ← descrição rica: objetivo, escopo, critérios de
  aceite, REQ-* cobertos, apontador para `docs/ESPECIFICACAO.md` (seção correspondente);
- `tarefas.depends_on_task_id` ← grafo de dependências do plano (cadeia única hoje suportada;
  o plano expressa ordem linear topológica — ver §7 Risco 4);
- `tarefas.auto_start=true` **somente** para o que o plano marcou como execução automática;
  o default passa a ser sequência controlada por dependência, não disparo simultâneo;
- `tarefas.external_id` ← `macro-<slug>-<n>` (idempotência: aprovação duplicada não duplica tarefas);
- vínculo `geracao → tarefas` materializado (coluna `tasks` json guarda os ids criados);
- **roteamento por executor:** tarefas `executor=biblioteca-global` ficam no projeto captado
  biblioteca-global (agente Bibliotecária); tarefas `executor=agente-projeto` ficam no projeto
  captado novo (agente dedicado). Se `requerAgenteDedicado=false`, não pode existir tarefa
  `agente-projeto` (validação na materialização);
- **`especificacaoCrud` do plano** é gravada como artefato do projeto
  (`projects/<slug>/docs/ESPEC-CRUD.md`, fonte de verdade para config.ts/schema.ts);
- **`lacunasBiblioteca[]` do plano** é persistido em `lacunas_biblioteca` (histórico acumulativo);
- registro no chat do projeto ("plano aprovado, N tarefas criadas") + feed operacional.

## 5. Prompt de geração macro (o que o modelo vai receber)

Estrutura proposta (template no catálogo, com placeholders):

```
Você é o Analista de Planejamento do projeto "<NOME>" (slug: <SLUG>).
Sua saída será um PLANO DE TAREFAS MACRO que será revisado e aprovado pelo dono
do produto antes de qualquer execução.

== ENTRADAS ==
1. Especificação completa (fonte de verdade): <ESPECIFICACAO>
2. Resumo da captação: <DESCRICAO>
3. O que a plataforma já cobre automaticamente (CRUD genérico da Biblioteca):
   <CATALOGO_CRUD>            ← telas cadastro padrão, auth única, RBAC da plataforma
4. Documentação técnica do monorepo relevante: <DOCS>
5. Histórico de clarificação deste projeto (se houver): <CHAT>
6. Feedback do revisor (em rodadas de revisão): <FEEDBACK>

== MÉTODO OBRIGATÓRIO ==
1. Extraia o inventário de requisitos da especificação: REQ-F-### (funcionais),
   REQ-NF-### (não-funcionais), REQ-D-### (dados/entidades), REQ-I-### (integrações).
   Não invente requisito; não descarte requisito implícito sem registrá-lo como lacuna.
2. Para cada requisito, decida: (a) coberto pelo CRUD/plataforma, (b) precisa de
   tarefa macro, (c) fora de fase (justificar).
3. Classifique cada requisito/funcionalidade contra o CATÁLOGO DA BIBLIOTECA:
   `crud` (cobre nativamente) | `custom` (exige tela/fluxo personalizado) |
   `lacuna` (funcionalidade desejável que a biblioteca não tem — registrar no histórico).
   Sistema 100% crud → registre `requerAgenteDedicado=false`.
4. Desenhe as tarefas macro por CAPACIDADE DE SISTEMA (não por tela): modelo de
   dados e tenancy, papéis/permissões, fluxos/estados, integrações e infraestrutura
   (ex.: email), interfaces específicas, requisitos não-funcionais verificáveis.
   Marque em cada tarefa o EXECUTOR: `biblioteca-global` (specs CRUD/config, registros,
   materialização) ou `agente-projeto` (telas/fluxos personalizados).
5. Para cada tarefa: título, objetivo, escopo (o que entra/o que NÃO entra),
   critérios de aceite testáveis, REQs cobertos, dependências (quais tarefas precisam
   estar prontas antes), executor, risco/complexidade.
6. Produza a **especificação CRUD** (`especificacaoCrud`): entidades, campos/tipos,
   máscaras/validações, menus e agrupamentos — no formato do MANUAL_CONFIG_PROJETOS,
   suficiente para gerar config.ts/schema.ts sem re-análise.
7. Gere a matriz de cobertura REQ → (tarefa | CRUD | fora-de-fase). TODO requisito
   deve aparecer na matriz. Ambiguidades vão para `lacunas[]`; funcionalidades que a
   biblioteca não cobre nativamente vão para `lacunasBiblioteca[]` (histórico acumulativo
   para roadmap da biblioteca).
8. Se faltar informação DECISÓRIA, não presuma: devolva perguntas (máx. 8, numeradas,
   com `resumo` do entendimento atual).

== CONTRATO DE SAÍDA (JSON único) ==
{ "kind": "plano",
  "classificacaoSistema": "100% crud | misto | predominantemente custom",
  "requerAgenteDedicado": true|false,
  "requisitos": [{ "id": "REQ-F-001", "texto": "...", "origem": "seção/trecho da spec",
                   "classificacao": "crud|custom|lacuna" }],
  "especificacaoCrud": { "entidades": [{ "nome": "...", "campos": ["..."],
                          "mascarasValidacoes": ["..."], "menu": "..." }],
                          "observacoes": "..." },
  "tarefas": [{ "seq": 1, "titulo": "...", "objetivo": "...", "escopo": "...",
                "aceite": ["..."], "requisitos": ["REQ-F-001"], "executor": "biblioteca-global|agente-projeto",
                "depende_de": [], "auto_start": false, "risco": "baixo|medio|alto" }],
  "matrizCobertura": [{ "req": "REQ-F-001", "cobertoPor": "tarefa:1|crud:entidade|fora_de_fase" , "justificativa": "..." }],
  "lacunas": ["..."],
  "lacunasBiblioteca": [{ "funcionalidade": "...", "req": "REQ-F-009", "contexto": "por que a biblioteca não cobre" }],
  "riscos": ["..."], "foraDeFase": [{ "req": "...", "motivo": "..." }] }
ou
{ "kind": "perguntas", "resumo": "...", "perguntas": ["..."] }
```

Diferenças essenciais em relação ao que existe hoje (passo 3.6): pede inventário +
matriz (cobertura auditável), enquadra por capacidade de sistema (não "telas não-CRUD"),
exige escopo/aceite/dependências/executor por tarefa, classifica CRUD vs custom contra o
catálogo real da biblioteca (a decisão do agente dedicado passa a ser fundamentada), produz
a especificação CRUD como artefato, acumula lacunas da biblioteca para roadmap, trata
não-funcionais como primeira classe e tem válvula de clarificação em vez de presunção.

## 6. Caso de estudo — replanejamento do Gestão de Tarefas Global

Após religar o fluxo, rodar a Geração Macro no projeto (id 13) com a especificação atual:

1. **Pausar** as tarefas 1021–1025 remanescentes (respeitando a semântica de pausa graciosa)
   e avaliar o que já foi `verified` (1021 dashboard, 1023 lembretes, 1024 recorrências,
   partes de 1022/1025) como insumo — o plano novo deve reincorporar, não duplicar.
2. A geração deve surfaced (expectativa do diagnóstico): organizações/tenancy, papéis e
   permissões (líder de área, admin, master), cadastro de colaboradores com CPF e acesso
   restrito, visões agrupadas por área/categoria, dono-da-execução vs criador no modelo de
   dados, responsividade (tablet), infra de email/notificação, máquina de estados da
   delegação (concluída / precisa de info / aguardando terceiro) — hoje 1 tarefa-1 linha.
3. Decisão pendente do Alexandre: rodar o replanejamento **pelo fluxo novo** (desejável,
   serve de teste real) ou manualmente via tarefas avulsas.

## 7. Riscos e mitigações

| # | Risco | Mitigação |
|---|---|---|
| 1 | Plano grande demais (modelo fragmenta em 40 tarefas) | Prompt com guia de granularidade (capacidades de sistema; alvo indicativo 8–15 tarefas macro) + edição humana na aprovação. |
| 2 | Especificação da Isa continua pobre | O fluxo tem clarificação: o analista pergunta antes de planejar. E o gate de aprovação pega o resto. |
| 3 | Worker novo introduz órfãos/race | Padrões já consolidados: lease + reconciliador + idempotência por external_id (lições dos incidentes 25/09 e 989). |
| 4 | Dependência entre tarefas hoje é cadeia única (`depends_on_task_id`) | Plano exporta ordem topológica linear; grafo completo (N:N) fica como evolução futura — não bloqueia esta proposta. |
| 5 | Custo/latência (modelo pago por geração) | Geração é 1 sessão por projeto (com retomadas), não por subtarefa. aceitável. |
| 6 | Setup e geração em paralelo divergirem (schema vs plano) | Gate: tarefas macro só executam com `setup_status='verified'`; o plano recebe o schema/config reais como entrada na aprovação/revisão. |

## 8. Fases de implantação sugeridas (cada uma revertível)

- **F1 — Trilho de planejamento (núcleo):** `ProjectGenerationWorker` + reconciliador +
  prompt no catálogo + **Catálogo de Capacidades da Biblioteca (v1)** + tabela
  `lacunas_biblioteca` + status novos + endpoint aprovar + materialização (com roteamento por
  executor). Sem front: aprovação via endpoint/Telegram. (A especificação de entrada ainda é a
  `descricao` atual.)
- **F2 — Aprovação visual:** painel "Plano do projeto" na tela + notificações Telegram.
- **F3 — Setup limpo:** remover criação de tarefas do 3.6 + gate `setup_status='verified'`
  no despacho + gravar `ESPECIFICACAO.md` no setup.
- **F4 — Isa estruturada:** coluna `especificacao` + doc estruturado na captação.
- **F5 — Piloto:** replanejar Gestão de Tarefas Global pelo fluxo novo (§6).

F1+F3 já eliminam o problema raiz; F2 dá ergonomia; F4 melhora a entrada; F5 valida.

## 9. Tarefas criadas no motor (2026-10-29, aprovação)

Criadas no projeto **Gerente Agentes** (projetos_captados id 2), `planned`, pausadas, `auto_start=false`.
Start manual pelo Alexandre (regra: dependência só desbloqueia, não dispara).

| Fase | Tarefa | external_id | depende de | Escopo |
|---|---|---|---|---|
| F1 | **1048** | task-p2-1048 | — | Núcleo: ProjectGenerationWorker + reconciliador + prompt + Catálogo v1 + tabela lacunas_biblioteca + status novos + endpoint aprovar + materialização + gate setup verified |
| F2 | **1049** | task-p2-1049 | 1048 | Painel "Plano do projeto" (front) + notificações Telegram |
| F3 | **1050** | task-p2-1050 | 1048 | Limpeza do setup (remover 3.6), agente dedicado só se requerAgenteDedicado, gate verified, gravar ESPECIFICACAO/ESPEC-CRUD |

**Fora do escopo criado (decisões pendentes do Alexandre):**
- **F4 — Isa estruturada:** código vive no projeto da **Isa** (global-ia/isa-chat), não em gerenteagentes. Criar tarefa própria naquele projeto quando decidido (coluna `especificacao` + doc estruturado na captação).
- **F5 — Piloto (replanejar Gestão de Tarefas Global):** é ação **operacional** (rodar a Geração Macro no projeto id 13 após F1+F3 no ar), não tarefa de código. Decidir depois: rodar pelo fluxo novo (desejável, vira teste real) vs. tarefas avulsas.

## 10. O que esta proposta NÃO muda

- Fluxo de análise/DEV/gates/deploy por tarefa (motor-v3) — intacto.
- Clarificação por chat de tarefa — intacta.
- Setup: provisionamento, registros obrigatórios, agente dedicado, smoke test — intactos
  (só sai a criação de tarefas).
- Plataforma (core/RBAC/identity) — nada.
