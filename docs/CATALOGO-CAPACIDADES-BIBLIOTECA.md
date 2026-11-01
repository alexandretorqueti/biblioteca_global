# Catálogo de Capacidades da Biblioteca Global

> **Versão:** v1
> **Data:** 2026-11-01
> **Mantenedor:** Bibliotecária Global (agente do projeto `biblioteca-global`)
> **Regra de atualização:** este catálogo DEVE ser atualizado a cada capacidade nova
> entregue na plataforma (nova tela padrão, novo tipo de campo, nova máscara/validador,
> novo módulo nativo, mudança em auth/RBAC). Ao adicionar uma capacidade: (1) criar/editar
> a seção correspondente, (2) citar o arquivo-fonte, (3) incrementar a versão no cabeçalho
> e registrar a data. Capacidades removidas saem do corpo e vão para a seção 14 quando
> ainda forem demanda recorrente.
>
> **Consumo automatizado:** o motor injeta o conteúdo integral deste arquivo como
> `<CATALOGO_CRUD>` no prompt de Geração Macro de tarefas
> (`projects/gerenteagentes/docs/PROPOSTA-GERACAO-MACRO-TAREFAS.md` §5). Por isso as
> seções são estáveis e numeradas — não renomear/reordenar sem atualizar o prompt.

---

## 1. Para que serve este catálogo

O Analista de Planejamento usa este catálogo ANTES de especificar: para cada
requisito/funcionalidade do projeto novo, ele classifica contra o que está listado aqui:

- **`crud`** — coberto nativamente pela plataforma (basta declarar `schema.ts` + `config.ts`;
  nenhuma tarefa de código é necessária além da especificação CRUD);
- **`custom`** — exige tela/fluxo personalizado (componente React em `projects/<slug>/screens/`
  ou módulo próprio); gera tarefa macro com `executor=agente-projeto`;
- **`lacuna`** — funcionalidade desejável que a biblioteca NÃO tem (ver seção 14); entra no
  registro acumulativo `lacunas_biblioteca` como candidata a roadmap.

**Regra de ouro do planejador:** se a capacidade está neste catálogo, o projeto NÃO deve
reimplementá-la — deve reutilizá-la (fonte: `docs/MANUAL_CONFIG_PROJETOS.md` §8).

## 2. Visão geral da plataforma

A Biblioteca Global é um monorepo TypeScript que **gera sistemas CRUD configuráveis**:
cada projeto é uma pasta `projects/<slug>/` com `schema.ts` (modelo de dados Drizzle/MySQL),
`config.ts` (navegação/telas) e `migrations/`. A plataforma fornece API genérica, front
genérico, autenticação única e isolamento de banco por projeto.

| Camada | Onde vive | O que faz |
|---|---|---|
| Contratos | `packages/shared` | Schemas Zod de config, campos, auth, perfis |
| Geração de config | `packages/schema-tools` | Deriva telas/campos do `schema.ts` |
| HTTP tipado | `packages/api-client` | `createDataSource`; única camada de rede da UI |
| Componentes UI | `packages/ui` | `GeradorSistema`, `Cadastro`, `DynamicForm`, `ExternalScreen`, `AuthPanel`, menus/layout |
| Backend | `apps/api` | NestJS: auth, CRUD genérico, provisionamento, usuários, LGPD |
| Frontend | `apps/web` | React/Vite: autodescoberta de configs e telas custom em build time |
| Banco | `database/` + `projeto_<id>` | `core` (plataforma) + banco isolado por projeto |

Fontes: `docs/MANUAL_CONFIG_PROJETOS.md` (seções 1–6), `docs/CONTEXTO-ANALISTA.md`.

## 3. Telas CRUD padrão

Todo `resource` (tabela do `schema.ts`, whitelisted em
`apps/api/src/modules/crud/schema-registry.ts`) ganha automaticamente uma tela
**cadastro** completa se não estiver referenciado na config
(`packages/schema-tools/src/gerar-config.ts`). A tela cadastro padrão inclui:

- **Listagem (grid)** com paginação (`page`/`pageSize`), **busca textual** (`search` —
  OR LIKE case-insensível nas colunas de texto), **filtros por coluna** via query string
  e **ordenação** (`orderBy=campo:asc,campo:desc`, com `valuesLast`) —
  fonte: `apps/api/src/modules/crud/crud.controller.ts` e `crud.service.ts`;
- **Formulário de criação/edição** (`DynamicForm`) derivado do schema + annotations;
- **Exclusão** com endpoint `DELETE /:resource/:id`;
- **Overrides de apresentação** (sem inventar campo): `hiddenColumns`, `columnLabels`,
  `columns` (1–3), `newLabel`, `fields` — fonte: `cadastroOverridesConfigSchema` em
  `packages/shared/src/config.ts`;
- **Ações customizadas**: `actions` (globais) e `rowActions` (por linha, com `:id` no path),
  cada uma com `method`, `path`, `confirm` opcional e `disabledWhen` (condição por registro) —
  fonte: `customActionSchema` em `packages/shared/src/config.ts`;
- **Master-detail**: `children` (`childResource` + `fkField`) e `relatedScreens` —
  fonte: `childScreenSchema`/`cadastroScreenConfigSchema` em `packages/shared/src/config.ts`;
- **Rotas filhas contextuais (`childRoutes`)**: botão na grid que navega para outra tela com
  filtro automático (ex.: `tarefas` filtrado por `projetoId` do pai), recursivas, com fields,
  overrides, actions, `defaultOrderBy` e `componentId` próprios —
  fonte: `childRouteSchema` em `packages/shared/src/config.ts`;
- **Ordenação padrão da tela** (`defaultOrderBy` por campo/direção/`valuesLast`) —
  fonte: `cadastroScreenConfigSchema` em `packages/shared/src/config.ts`.

### Outros tipos de tela suportados na config

- **`custom`** — tela React específica do projeto, identificada por `componentId`; o
  componente vive em `projects/<slug>/screens/` e é autodescoberto em build time
  (`apps/web/src/project/registry/customScreens.tsx`) — fonte: `docs/MANUAL_CONFIG_PROJETOS.md` §3/§5;
- **`external`** — tela ligada a REST fora do schema: `baseUrl`, `method`, `pathTemplate`,
  `dataPath`, `query` estática, detalhe (`detailPathTemplate`/`detailDataPath`), painel de
  chat opcional (`chat`), `hiddenColumns` e **edição** de registros externos (`edit` com
  method/pathTemplate/fields/bodyPath) — fonte: `externalScreenConfigSchema` e
  `editScreenConfigSchema` em `packages/shared/src/config.ts`.

**Tela de Usuários:** injetada automaticamente pela plataforma em todo projeto (o projeto
nasce sem telas de negócio e já tem gestão de usuários) — fonte: `docs/MANUAL_CONFIG_PROJETOS.md` §3.

**CRUD genérico (backend):** `GET /:resource`, `GET /:resource/:id`, `POST /:resource`,
`PUT /:resource/:id`, `DELETE /:resource/:id` para qualquer resource whitelisted, com
conexão resolvida pelo projeto do token (`apps/api/src/modules/crud/project-db.factory.ts`) —
fonte: `docs/MANUAL_CONFIG_PROJETOS.md` §6.

## 4. Menus, agrupamentos e navegação

- Menu lateral organizado em **groups** (seções) → **items** (rotas), com `label`, `path`
  estável, `icon` (nome resolvido por mapa — `resolveIcon`, não ReactNode) e `description` —
  fonte: `geradorSistemaGroupSchema`/`geradorSistemaRouteSchema` em `packages/shared/src/config.ts`;
- **Filtro de visibilidade por perfil** em cada item de menu (`roleFilter` com
  `admin|gerente|operador|visualizador`; a autorização real é enforced no backend) —
  fonte: `geradorSistemaRouteSchema.roleFilter` em `packages/shared/src/config.ts`;
- Layout configurável: `app.name`, `app.logo`, `drawerWidth`, `autoHideMenu` —
  fonte: `geradorSistemaConfigSchema` em `packages/shared/src/config.ts`;
- Componentes de layout prontos: `SistemaMenu`, `SistemaBarraSuperior`, `LayoutContainer`,
  `LayoutItem`, breadcrumbs (`getSistemaBreadcrumb`) — fonte: `packages/ui/src/index.ts`;
- A config é **autodescoberta em build time**: basta existir `projects/<slug>/config.ts`
  exportando `config: GeradorSistemaConfig` (`import.meta.glob` em
  `apps/web/src/project/registry/projects.ts`) — fonte: `docs/MANUAL_CONFIG_PROJETOS.md` §1/§5;
- Referência real de navegação completa (childRoutes, custom, external):
  `projects/gerenteagentes/config.ts`.

## 5. Campos e tipos suportados

Tipos de campo do `DynamicForm` (fonte: `dynamicFieldTypeSchema` em `packages/shared/src/field.ts`):

| Tipo | Uso | Componente (fonte: `packages/ui/src/components/fields/`) |
|---|---|---|
| `text` | texto curto | `FieldText` |
| `email` | e-mail (validação de formato nativa) | `FieldText` |
| `number` | numérico (`min`/`max`) | `FieldText` |
| `date` | data/hora (`minDate`/`maxDate`) | `FieldData` |
| `textarea` | texto longo | `FieldText` |
| `select` | enum (options derivadas do schema) | `Field` |
| `switch` / `boolean` | booleano (`booleanStyle: checkbox|radio|select`, `trueLabel`/`falseLabel`) | `FieldBoolean` |
| `multipleChoice` | combo/relacionamento (resource + idField + displayField, `multiple`, busca com debounce) | `FieldMultipleChoice` |
| `photo` | foto (preview + upload via runtime `getUpload`) | `FieldPhoto` |
| `money` | monetário (`currency`, `currencyLocale`, frações de dígitos; renderização própria na grid) | `FieldMoney`/`FieldGridMoney` |
| `json` | editor JSON em árvore (validação de JSON nativa) | `FieldJson` |

Propriedades por campo (fonte: `dynamicFieldConfigSchema` em `packages/shared/src/field.ts`):
`required`, `placeholder`, `helperText`, `defaultValue`, `options`, `min`/`max`,
`minLength`/`maxLength`, `minDate`/`maxDate`, `fullWidth`, `disabled`, `accept`,
`maxFileSizeMb`, `uploadResource`, `mask`, `validator`, `currency*`, e controle de contexto
`insertable`/`editable`/`gridVisible`.

### Derivação automática do schema (zero config duplicada)

- `packages/schema-tools/src/gerar-fields.ts` deriva tipo, label, obrigatoriedade e options
  de enum a partir das colunas Drizzle: `MySqlEnum→select`, `MySqlBoolean→switch`,
  `MySqlText→textarea`, `MySqlVarChar/Char→text`, `MySqlTimestamp/Date/Datetime→date`,
  number/bigint→`number`, `MySqlJson→json`; primary key, autoincremento e colunas geradas
  são ignoradas no formulário; tipo não suportado → erro explícito pedindo annotation;
- **Inferência automática de FK**: campos `*Id` com `reference` no Drizzle viram
  `multipleChoice` com `displayField` resolvido por heurística (`nome/name/titulo/title/label/
  descricao/description` → primeira coluna string → `id` com warning); override manual sempre
  vence — fonte: `packages/schema-tools/src/inferir-fk.ts`, `docs/MANUAL_CONFIG_PROJETOS.md` §4;
- **Annotations** (`FormAnnotationsPorTabela` no `schema.ts`) ajustam apresentação por coluna:
  `label`, `type`, `required`, `placeholder`, `helperText`, `fullWidth`, `min`/`max`,
  `minLength`/`maxLength`, `currency`, `mask`, `validator`, `disabled` —
  fonte: `packages/schema-tools/src/form.ts` e `gerar-fields.ts`.

## 6. Máscaras e validadores nativos

Declaráveis por campo/annotation via `mask` e `validator`
(fonte: enums em `packages/shared/src/field.ts`; implementação em `packages/ui/src/utils/masks.ts`
e `packages/ui/src/utils/formValidation.ts`):

| Máscara (`mask`) | Formatação | Validador (`validator`) | Regra |
|---|---|---|---|
| `cpf` | 000.000.000-00 | `cpf` | dígitos verificadores + rejeita repetidos |
| `cnpj` | 00.000.000/0000-00 | `cnpj` | dígitos verificadores + rejeita repetidos |
| `telefone` | +55 (00) 00000-0000 / +55 (00) 0000-0000 (fixo/celular, trata prefixo nacional) | `telefone` | mín. 10 dígitos (remove código 55 inicial) |
| `cep` | 00000-000 | `cep` | exatamente 8 dígitos |
| `rg` | — | `rg` | mín. 5 dígitos (sem formatação própria) |
| — | — | `nomeCompleto` | nome com sobrenome (mín. 2 partes) |

Validações adicionais automáticas do `DynamicForm` (`validateDynamicForm` em
`packages/ui/src/utils/formValidation.ts`): obrigatoriedade, `minLength`/`maxLength`,
formato de e-mail (tipo `email`), JSON válido (tipo `json`) e os validadores da tabela acima.

Uso real em produção (máscaras + validadores declarados em config):
`projects/sistema-adm-global/config.json` (campos `cpf`, `cnpj`, `rg`, `telefone`, `cep`,
`nomeCompleto` de colaboradores/empresas).

> ⚠️ Regra das duas fontes de config: validadores/máscaras precisam constar em
> `projects/<slug>/config.ts` (front, build time) E `config.json`/config corrente
> (`projetos.config` no core, API) — ver `docs/MANUAL_CONFIG_PROJETOS.md` §1.

## 7. Autenticação única da plataforma (passwordless)

Auth **centralizada e obrigatória** — projetos NÃO criam login, senha, refresh ou tabela de
usuários próprios (fonte: `docs/MANUAL_CONFIG_PROJETOS.md` §8, regra 1). Capacidades nativas
(fonte: `apps/api/src/modules/auth/auth.controller.ts`, `auth.service.ts`, `email.service.ts`,
`packages/shared/src/auth.ts`, `packages/ui/src/components/AuthPanel.tsx`):

- **Login por código via e-mail (passwordless)**: `POST /auth/request-code` (resposta sempre
  `{ok:true}` — não revela se o e-mail existe) + `POST /auth/verify-code` (código HMAC com
  TTL e limite de tentativas); primeiro acesso define senha opcional (`POST /auth/set-password`,
  fluxo `primeiraVez`);
- **Login por senha** também suportado (`POST /auth/login` com `identifier`/`identifierType`);
- **Sessão**: access token curto (~15 min) + refresh global rotativo
  (`POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`);
- **Seleção de projeto**: `POST /auth/select-project` emite access token com claims
  `{ sub, projetoId, perfil }` — o escopo viaja no token, nunca no body/query;
- **UI pronta**: `AuthPanel` (login/código/senha/consentimento) reutilizável por qualquer projeto;
- **Consentimento LGPD no login**: `POST/GET /auth/consentimento`;
- **Provisionamento de usuário+projeto por serviço**: `POST /provision/project` idempotente
  (`{email, nome?, projetoNome, projetoSlug?}`, `Authorization: Bearer <PROVISION_TOKEN>`) —
  cria/reutiliza usuário e projeto e vincula como admin
  (fonte: `docs/MANUAL_CONFIG_PROJETOS.md` §5, `apps/api/src/modules/provision/`);
- **Gestão de usuários nativa**: CRUD de usuários globais + vínculos por projeto com perfil
  (`apps/api/src/modules/usuarios/usuarios.controller.ts`: `gerais/globais`, `:id/vincular`,
  `:id/vinculos`); tela de Usuários injetada em todo projeto;
- **Mascaramento de CPF em respostas de autenticação** (`mascararCpf` em `packages/shared/src/auth.ts`);
- **Logs de login**: módulo `apps/api/src/modules/logs-login/`.

## 8. RBAC e perfis

- **Perfis por projeto** (pivot `projetos_usuarios`): `admin`, `gerente`, `operador`,
  `visualizador` — enum único em `perfilSchema` (`packages/shared/src/auth.ts`);
- **Escopo por token**: `JwtAuthGuard` + `ProjectScopeGuard` derivam projeto/perfil do access
  token; o banco do projeto é resolvido pelo token (`project-db.factory.ts`) — nunca por
  parâmetro do cliente (fonte: `docs/MANUAL_CONFIG_PROJETOS.md` §6);
- **Regras de escrita do CRUD genérico**: leitura = access + escopo; escrita
  (`POST/PUT/DELETE`) = `admin|gerente|operador`; `visualizador` é somente leitura
  (fonte: `docs/MANUAL_CONFIG_PROJETOS.md` §6);
- **Visibilidade de menu por perfil**: `roleFilter` por item de rota (seção 4) —
  fonte: `packages/shared/src/config.ts`;
- **Isolamento de dados por projeto**: banco físico `projeto_<id>` derivado do id
  (fonte: `docs/MANUAL_CONFIG_PROJETOS.md` §2/§5).

> Limite: os 4 perfis são fixos da plataforma; RBAC customizado por projeto (papéis de negócio,
> permissão por registro) NÃO é nativo — ver seção 14.

## 9. LGPD nativa

Módulo `apps/api/src/modules/lgpd/` (fonte: controllers do módulo; contexto em
`docs/AUDITORIA_LGPD.md`):

- Exportação de dados do titular (`GET lgpd/:id/export`);
- Retificação (`PUT lgpd/:id/dados`) e eliminação (`DELETE lgpd/:id/dados`);
- Logs de acesso a dados (`GET logs-acesso`, interceptor `acesso-dados.interceptor.ts`);
- Retenção/expurgo (`POST executar-retencao`, `retencao.service.ts`);
- Consentimento registrado no fluxo de auth (seção 7).

Aplica-se à plataforma e, por consequência, aos projetos que reutilizam a auth única.

## 10. Infraestrutura transversal disponível

- **WebSocket realtime genérico**: `RealtimeGateway` em `/api/realtime/ws` com autenticação
  por ticket/cookie, canais (`task`, `map`, `project-feed`), buffer circular com replay,
  deduplicação por `eventId` e sequência monotônica; cliente pronto
  `RealtimeClient` em `packages/api-client/src/realtime.ts` com reconexão automática —
  fonte: `apps/api/src/modules/realtime/`, `docs/CONTEXTO-ANALISTA.md` (tarefa task-p2-832);
- **Componentes de chat prontos**: `TaskChat`, `AgentChat`, `HelpDeskWidget`
  (fonte: `packages/ui/src/index.ts`);
- **`JsonGrid`** para exibição de dados JSON (fonte: `packages/ui/src/index.ts`);
- **Virtual resources** no CRUD genérico (prefixo `__`, ex.: `__openclaw_agentes__`) para
  dados fora do schema do projeto (fonte: `RESOURCE_NAME_REGEX` em `packages/shared/src/field.ts`,
  `apps/api/src/modules/crud/crud.service.ts`).

## 11. Relatórios padrão

**Não existe gerador de relatórios nativo** (listagens com filtros/ordenação/busca da seção 3
são o recurso de consulta padrão; a única exportação nativa é a de dados do titular da LGPD,
seção 9). Levantamento v1: nenhuma ocorrência de módulo/tela de relatório ou exportação
CSV/Excel/PDF genérica em `apps/` ou `packages/`. Relatórios de negócio (agregações, gráficos,
exportação, impressão) são **lacuna** — ver seção 14.

## 12. Fluxo de criação de um projeto novo (100% CRUD)

Passos nativos, sem código de negócio (fonte: `docs/MANUAL_CONFIG_PROJETOS.md` §2–§7, §9):

1. `projects/<slug>/schema.ts` com tabelas Drizzle + `annotations`;
2. Migrations geradas (`npm run db:generate:<slug>`, pasta `migrations/` + meta);
3. Registro do schema em `apps/api/src/modules/crud/schema-registry.ts`;
4. `projects/<slug>/config.ts` (autodescoberto; telas cadastro derivadas automaticamente
   pelo `schema-tools` para tabelas não referenciadas);
5. Provisionamento (`POST /provision/project`) cria banco `projeto_<id>`, aplica migrations
   e vincula usuário admin;
6. Checklist de entrega: typecheck, lint, test, build, `git diff --check`.

Telas custom só quando a UX exige comportamento fora dos componentes prontos
(regra 3 do §8 do manual); HTTP sempre via `packages/api-client`.

## 13. Fontes consultadas nesta versão (v1)

- `docs/MANUAL_CONFIG_PROJETOS.md` (manual operacional — seções 1–9)
- `docs/CONTEXTO-ANALISTA.md` (arquitetura e registros validados)
- `packages/shared/src/config.ts`, `field.ts`, `auth.ts` (contratos Zod)
- `packages/schema-tools/src/gerar-config.ts`, `gerar-fields.ts`, `inferir-fk.ts`, `form.ts`
- `packages/ui/src/index.ts`, `components/` (AuthPanel, Cadastro, DynamicForm, ExternalScreen,
  GeradorSistema, campos), `utils/masks.ts`, `utils/formValidation.ts`
- `apps/api/src/modules/`: `auth/`, `crud/`, `usuarios/`, `provision/`, `lgpd/`, `logs-login/`,
  `realtime/`, `projetos/`
- `apps/web/src/project/registry/projects.ts`, `customScreens.tsx`, `ProjectContext.tsx`
- Exemplos reais: `projects/gerenteagentes/config.ts`, `projects/sistema-adm-global/config.json`,
  `projects/documentacao/`
- `projects/gerenteagentes/docs/PROPOSTA-GERACAO-MACRO-TAREFAS.md` (§0.1, §3.1, §5 — contrato
  de consumo deste catálogo)

## 14. O que NÃO é coberto nativamente (candidatas a lacuna)

Funcionalidades pedidas com frequência que a plataforma **não** entrega hoje — o planejador
deve classificá-las como `lacuna` (registro em `lacunas_biblioteca`) ou `custom`
(tarefa com `executor=agente-projeto`), nunca presumir cobertura:

1. **Relatórios de negócio**: agregações, dashboards com gráficos, exportação CSV/Excel/PDF,
   impressão (seção 11 — nada nativo; verificado por levantamento em `apps/`/`packages/`).
2. **Papéis/permissões de negócio**: RBAC além dos 4 perfis fixos; permissão por registro,
   por campo ou hierarquia de papéis customizada (seção 8 — `perfilSchema` é enum fechado).
3. **Multi-tenancy intra-projeto**: organizações/unidades/departamentos com isolamento de
   dados dentro do mesmo projeto (o isolamento nativo é por PROJETO, `projeto_<id>` —
   `docs/MANUAL_CONFIG_PROJETOS.md` §2; tenancy finer-grained exige modelagem + custom).
4. **Máquinas de estado/fluxos de trabalho**: transições de status com regras, aprovação em
   múltiplos níveis, delegação (o CRUD nativo é CRUD; fluxos exigem tela/lógica custom —
   ações customizadas da seção 3 são o ponto de extensão, não um motor de workflow).
5. **E-mail transacional de negócio**: a infra de e-mail existente (`apps/api/src/modules/auth/email.service.ts`)
   é de uso EXCLUSIVO do fluxo de auth (códigos de acesso); não há serviço genérico de
   notificação/e-mail para projetos (verificado: `EmailService` referenciado apenas em
   `auth.service.ts`/`auth.module.ts`).
6. **Notificações push/in-app genéricas**: não há centro de notificações nativo para projetos.
7. **Upload/armazenamento de arquivos genérico**: o campo `photo` existe na UI
   (`FieldPhoto` + `uploadResource`), mas o runtime de upload (`getUpload`) é opcional e
   nenhum endpoint nativo de armazenamento foi identificado em `apps/api` (verificado em
   `packages/ui/src/types.ts` e busca por upload em `apps/api/src/modules/crud/`);
   projetos que precisam de arquivos devem tratar como lacuna/custom.
8. **Busca avançada**: além do `search` OR-LIKE e filtros por coluna (seção 3), não há
   busca full-text, facetas ou filtros salvos.
9. **Auditoria de dados de negócio**: os logs nativos cobrem login (`logs-login`) e acesso a
   dados pessoais (LGPD, seção 9); não há trilha de auditoria de alterações (quem mudou o quê)
   para tabelas de negócio.
10. **Offline/mobile nativo**: o front é web responsivo (MUI); não há app mobile nem modo offline.
11. **Integrações externas**: telas `external` consomem REST pronto (seção 3), mas não há
    conectores nativos (pagamento, ERP, mensageria) nem jobs/agendamentos de sincronização.

> Esta lista é o inventário v1 de lacunas conhecidas; novas lacunas descobertas na Geração
> Macro entram em `lacunas_biblioteca` e, quando recorrentes entre projetos, viram candidatas
> a capacidade nativa — ao serem implementadas, MIGRAM desta seção para a seção apropriada
> (regra de manutenção do cabeçalho).
