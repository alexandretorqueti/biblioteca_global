# Biblioteca Global — Etapas de Desenvolvimento (v2)

> **Companheiro do `POC_DEFINICOES.md`** — as definições (o "o quê") estão lá; este arquivo é o "como e em que ordem".
> **Data:** 2026-08-14
> **Regra de ouro:** uma etapa só é declarada **concluída** quando todos os seus critérios de saída passam (build + testes + validação funcional). Sem exceção. Cada etapa termina com commit.

---

## Convenções gerais

- **Checklist** de cada etapa marca o progresso real (editar este arquivo ao concluir).
- **Testes:** unitários (vitest) rodam em todas as etapas com código; funcionais (API real + MySQL real em container) a partir da Etapa 2.
- **Validação mínima por etapa:** `tsc --noEmit` nos workspaces tocados + testes da etapa + inspeção do `git diff`.
- **Ambiente:** sempre `npm install --include=dev` no container (NODE_ENV=production omite devDeps por padrão).
- **Commits:** um (ou poucos) commits atômicos por etapa, mensagem no padrão `etapa-N: <resumo>`.
- **Escopo:** somente a pasta `biblioteca-global`. Backup em `biblioteca_old/` é referência, nunca editado.

### Mapa de dependências

```
Etapa 0 (fundação)
 └─ Etapa 1 (shared) ─┬─ Etapa 2 (core DB) ─ Etapa 3 (auth) ─ Etapa 4 (usuarios/projetos) ─ Etapa 5 (crud genérico)
                      ├─ Etapa 7 (api-client)
                      └─ Etapa 8 (ui) ─ Etapa 9 (web)
Etapa 6 (projects/) entra após Etapa 2 · Etapa 10 (documentação) após Etapa 9
Etapa 11 (e2e) após todas · Etapa 12 (containers/CI) pode avançar em paralelo a partir da Etapa 3
Etapa 13 (manual/publicação) por último
```

---

## Etapa 0 — Fundação do monorepo e ambiente

**Objetivo:** estrutura do monorepo funcionando, MySQL 8 em container, ferramentas de qualidade ativas.

**Entregas:**
- [x] `package.json` raiz com workspaces (`packages/*`, `apps/*`, `projects/*` se aplicável) e scripts (`dev`, `build`, `test`, `lint`, `typecheck`)
- [x] TS configs base (`tsconfig.base.json` com `strict: true`) + configs por workspace
- [x] ESLint com `no-explicit-any` = erro, aplicado a todos os workspaces
- [x] `docker-compose.yml`: serviço `mysql` (MySQL 8, database inicial, healthcheck)
- [x] `.env.example` documentado (`MYSQL_*`, `JWT_SECRET`, portas)
- [x] `.gitignore`, README atualizado com a nova arquitetura
- [x] Estrutura vazia dos diretórios: `packages/{ui,api-client,shared}`, `apps/{api,web}`, `projects/`, `database/migrations`

**Validação:**
- [x] `npm install --include=dev` conclui sem erro
- [x] `docker compose up -d mysql` sobe e healthcheck passa; conexão de teste (`mysql -e "SELECT 1"`) funciona
- [x] `npm run typecheck` e `npm run lint` passam no estado inicial
- [x] Commit `etapa-0: fundação do monorepo`

---

## Etapa 1 — `packages/shared`: contratos únicos

**Objetivo:** todos os tipos e contratos compartilhados entre front e back, com validação Zod.

**Entregas:**
- [x] `EntityRecord`, tipos base (`ApiRecord`, filtros, paginação)
- [x] `GeradorSistemaConfig` **serializável** (app, groups, items, screens: cadastro com `resource` + overrides; custom com `componentId`)
- [x] Schemas Zod da config (validação estrutural — a validação contra o schema do projeto vem na Etapa 6)
- [x] DTOs/tipos de auth e sessão (`LoginRequest`, `LoginResponse`, `SessionInfo`, claims do token, perfis)
- [x] Tipos de `Usuario`, `Projeto`, `ProjetoUsuario` espelhando o core
- [x] Testes unitários: validação da config (aceita config válida, rejeita campo obrigatório ausente, rejeita estrutura inválida)

**Validação:**
- [x] `tsc --noEmit` + vitest passando no pacote
- [x] Nenhum tipo `any`; exports explícitos
- [x] Commit `etapa-1: contratos shared`

---

## Etapa 2 — Database `core`: schema, migrations e seeds

**Objetivo:** o database `core` existe com as 4 tabelas, migração versionada e seed idempotente.

**Entregas:**
- [x] Schema Drizzle do core em `database/schema.ts`: `usuarios` (username/email/telefone/cpf não obrigatórios + UNIQUE por identificador, `password_hash`, `nome`, `ativo`), `projetos` (`nome`, `slug` UNIQUE, `ativo`, `config` JSON), `projetos_usuarios` (PK composta + `perfil` ENUM), `refresh_tokens`
- [x] `drizzle.config.ts` do core + migrations SQL geradas em `database/migrations/`
- [x] Seeds TS idempotentes (upsert): projeto `biblioteca-global`, projeto `documentacao`, usuário `alexandre` (hash argon2id da senha inicial) + vínculos `admin` nos dois
- [x] Scripts: `db:generate`, `db:migrate`, `db:seed` (raiz)

**Validação:**
- [x] `npm run db:migrate` cria as tabelas no MySQL em container; `db:seed` insere os dados iniciais
- [x] Seed roda **duas vezes** sem duplicar (idempotência)
- [x] Query manual confirma: alexandre vinculado aos 2 projetos com perfil admin; `password_hash` presente, senha em texto ausente
- [x] Commit `etapa-2: core schema + migrations + seeds`

---

## Etapa 3 — Backend: base NestJS + módulo Auth

**Objetivo:** API NestJS autenticando de verdade, com JWT por projeto e guards de escopo.

**Entregas:**
- [x] Scaffold NestJS em `apps/api` (main.ts com validação global, CORS, prefixo `/api`, exception filter padronizado)
- [x] `ConfigModule` com env tipado; `DatabaseModule` (pool Drizzle → core)
- [x] `AuthModule`: `POST /auth/login`, `POST /auth/select-project`, `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/change-password`, `GET /auth/me`
- [x] `AuthService`: busca por coluna do identificador, argon2id, checagem `ativo`, emissão de refresh (persistido em `refresh_tokens`) + access curto com claims `{ sub, projetoId, perfil }`
- [x] Guards: `JwtAuthGuard`, `ProjectScopeGuard` (escopo só dos claims; revalida pivot + `usuario.ativo` a cada request), `RolesGuard` (por perfil)
- [x] Decorators: `@CurrentUser()`, `@CurrentProject()`, `@Public()`
- [x] Rate limiting no login

**Testes unitários:**
- [x] `AuthService`: credencial válida/inválida, usuário inativo, identificador inexistente, claims corretos por projeto
- [x] `ProjectScopeGuard`: token sem claim de projeto rejeitado; vínculo removido → 403
- [x] `RolesGuard`: perfil insuficiente → 403

**Testes funcionais (API real + MySQL em container):**
- [x] Login alexandre → refresh + 2 projetos
- [x] select-project → access token; `GET /auth/me` devolve projeto e perfil
- [x] Token do projeto A em rota que exige projeto → ok; token inválido/expirado → 401
- [x] `change-password` funciona; login com senha nova ok, antiga falha
- [x] Logout revoga refresh (refresh posterior → 401)

**Validação:**
- [x] Todos os testes passando; `tsc --noEmit`; lint
- [x] Commit `etapa-3: api base + auth com jwt por projeto`

---

## Etapa 4 — Backend: módulos Usuários e Projetos

**Objetivo:** CRUDs do core com escopo por projeto e o ciclo de vida de projetos.

**Entregas:**
- [x] `UsuariosModule`: CRUD com filtro automático pela pivot do projeto do token; `POST` cria usuário + vínculo no projeto do token; `DELETE` desvincula; rejeita `projetoId` no body
- [x] Endpoints exclusivos do admin global: `GET /usuarios?projetoId=`, `PUT /usuarios/:id/vincular`
- [x] `ProjetosModule`: CRUD restrito a admin global; `POST /projetos` executa o ciclo de vida (registro → `CREATE DATABASE projeto_<id>` → migrations da pasta do projeto → config inicial gerada do schema)
- [x] `PUT /projetos/:id` valida a config contra o schema do projeto antes de salvar
- [x] Serviços + repositórios separados; interfaces no shared

**Testes unitários:**
- [x] `UsuariosService`: escopo pela pivot (nunca lista fora do projeto); criação vincula corretamente; exclusão desvincula sem apagar usuário global
- [x] `ProjetosService`: ciclo de vida (mock do executor de migrations); validação de config (campo inexistente → rejeita)

**Testes funcionais:**
- [x] Logado no projeto `documentacao`: lista de usuários só contém vinculados ao documentacao
- [x] Criar usuário no documentacao → vínculo criado automaticamente; body com `projetoId` → ignorado/rejeitado
- [x] Logado no `biblioteca-global`: vê usuários de qualquer projeto; vincula usuário a projeto; cria projeto novo → database criado + migrado
- [x] Token de projeto comum tentando `POST /projetos` → 403

**Validação:**
- [x] Testes passando; commit `etapa-4: usuarios + projetos com escopo`

---

## Etapa 5 — Backend: CRUD genérico por resource

**Objetivo:** as telas geradas têm endpoints REST funcionando contra o database do projeto.

**Entregas:**
- [x] `CrudModule`: rotas `GET/POST /api/:resource`, `GET/PUT/DELETE /api/:resource/:id`
- [x] Whitelist de resources derivada do `schema.ts` do projeto da sessão (nunca string arbitrária)
- [x] Fábrica de conexão por projeto (cache por projetoId; conexão aponta para `projeto_<id>`)
- [x] Validação de entrada com Zod derivado do Drizzle (insert/select); filtros e paginação padronizados
- [x] Erros padronizados: resource desconhecido → 404; validação → 400; conflito → 409

**Testes unitários:**
- [x] Resolução de resource (whitelist), montagem de query de filtro, validação Zod
- [x] Fábrica de conexão (cache, nome do database derivado do id — nunca do input)

**Testes funcionais:**
- [x] Resource válido no projeto → CRUD completo funciona no database do projeto
- [x] Resource inexistente → 404; registro com campo inválido → 400
- [x] **Isolamento:** dado criado via token do projeto A não aparece nem é acessível com token do projeto B (tentativa direta de id → 404)

**Validação:**
- [x] Testes passando; commit `etapa-5: crud genérico por resource`

---

## Etapa 6 — `projects/`: estrutura por projeto + gerador de config

**Objetivo:** os dois projetos iniciais com pasta completa, migrations próprias e config gerada do schema.

> **Notas da execução (2026-08-14):** (1) Convenção de annotation = mapa `annotations` exportado pelo schema (decorator por coluna não funciona — drizzle constrói instâncias novas a partir dos builders); (2) o pacote `drizzle-zod` não foi usado (é zod v3; o projeto usa zod v4) — a derivação Zod insert/update vive no `@biblioteca-global/schema-tools` (`zodParaInsert`/`zodParaUpdate`), mesmo resultado; (3) `gridColumns` entra com a UI na Etapa 8; (4) a config gerada é salva no core pelo seed estendido (mecanismo do §6.3).

**Entregas:**
- [x] `projects/biblioteca-global/`: `schema.ts`, `drizzle.config.ts`, `migrations/`, `screens/` (placeholder), `config.ts`
- [x] `projects/documentacao/`: idem
- [x] **Gerador de fields**: lê `schema.ts` + annotations `@form` → gera `fields` (DynamicField[]) e `gridColumns`; documentar a convenção de annotations
- [x] `drizzle-zod` integrado: schemas Zod de insert/select exportados via `packages/shared`
- [x] Config JSON inicial de cada projeto gerada (`config.ts` + gerador) e salva no core pelo seed/provisionamento (mesmo mecanismo do §6.3 do PoC)
- [x] Seed estendido (Etapa 2): provisiona os databases `projeto_<id>` dos dois projetos e aplica as migrations deles

**Testes unitários:**
- [x] Gerador de fields: coluna com annotation → field correto (label, required, tipo); coluna sem annotation → default sensato; tipo não suportado → erro claro
- [x] Validação de overrides contra o schema (campo inexistente → rejeita)

**Testes funcionais:**
- [x] Após seed: `SHOW DATABASES` lista `core`, `projeto_<id do biblioteca-global>`, `projeto_<id do documentacao>`; tabelas dos projetos presentes nos databases certos
- [x] Config dos dois projetos no core coincide com a gerada

**Validação:**
- [x] Commit `etapa-6: projects/ + gerador de config`

---

## Etapa 7 — `packages/api-client`: transporte tipado

**Objetivo:** única camada do front que fala HTTP, com token automático e tipos do shared.

**Entregas:**
- [x] `RestEntityClient<T>` genérico (list/get/create/update/remove) com filtros e paginação
- [x] Cliente de auth (login/select-project/refresh/logout/change-password/me)
- [x] Injeção automática do access token; **nunca** envia `projetoId` no body
- [x] Tratamento de erros padronizado (401 → sinaliza relogin/refresh; mapeia erro do back)
- [x] `createDataSource<T>(resource)` → devolve `CadastroDataSource<T>` compatível com a UI

**Testes unitários (fetch mockado):**
- [x] Headers corretos (Authorization), montagem de query de filtros, mapeamento de erros, refresh em 401
- [x] Nenhum body carrega `projetoId`

**Validação:**
- [x] Commit `etapa-7: api-client tipado`

---

## Etapa 8 — `packages/ui`: reconstrução e modernização

**Objetivo:** biblioteca refeita sobre o backup, com registry de telas custom e dataSource por resource.

**Entregas:**
- [x] Reconstruir do backup: `AuthPanel`, `Cadastro`, `DynamicForm`, `JsonGrid`, `LayoutContainer`, `LayoutItem`, `SistemaMenu`, `SistemaBarraSuperior`, `GeradorSistema`, todos os Fields, tema (`BibliotecaThemeProvider` + temas), utils (masks, formValidation, layout, system)
- [x] Remover `auth_panel_backup/` (ficou no backup do backup — não volta)
- [x] `GeradorSistema` consumindo **config serializável**: `resource` → dataSource montado fora; `componentId` → registry de telas custom; ícones/logo por string com mapa de resolução
- [x] Registry de telas custom exportado (`registerCustomScreens`/`getCustomScreen`)
- [x] Suporte à flag `globalAdmin` (campo `projetoId` condicional na tela de usuários — via prop/config)
- [x] exports públicos revisados (o que era exportado mantém compatibilidade de nome; novos exports documentados)

**Testes unitários:**
- [x] Manter/portar os 12 testes do backup (utils + FieldMultipleChoice) e passar
- [x] Novos: gerador de config → render do GeradorSistema (menu, breadcrumb, rota cadastro, rota custom via registry)
- [x] AuthPanel: fluxo de login com identificador configurável, estados de loading/erro
- [x] Build do pacote gera `dist/` limpo (js + d.ts)

**Validação:**
- [x] `npm run build` do pacote ok; commit `etapa-8: ui reconstruída`

---

## Etapa 9 — `apps/web`: aplicação React

**Objetivo:** front completo: login → seleção de projeto → sistema gerado.

**Entregas:**
- [ ] Scaffold Vite + React 19 + MUI 7 consumindo `packages/ui` (alias para `src` em dev, `dist` para build)
- [ ] `AuthContext` (login/logout/refresh, sessão com token + projeto + perfil + `globalAdmin`), `ProjectContext` (config carregada + merge com derivado do schema)
- [ ] `LoginScreen` (AuthPanel), `ProjectSelectScreen` (quando >1 projeto), `SystemScreen` (GeradorSistema)
- [ ] `registry/customScreens.tsx` registrando as telas dos projetos
- [ ] Renovação de token (401 → refresh → retry) e logout
- [ ] Tema claro/escuro herdado do backup

**Testes funcionais (manual/browser, registrados como checklist):**
- [ ] Login com senha errada → erro claro; login alexandre → lista de 2 projetos
- [ ] Seleção de projeto → sistema monta com o nome/config do projeto
- [ ] Troca de projeto → novo token, telas do outro projeto
- [ ] Tela de usuários sem campo `projetoId` (projeto comum); com campo (biblioteca-global)
- [ ] Logout → volta ao login; sessão persistida (lembrar de mim) sobrevive a reload

**Validação:**
- [ ] `tsc -b` + build de produção ok; commit `etapa-9: apps/web`

---

## Etapa 10 — Projeto `documentacao`: telas da biblioteca

**Objetivo:** a documentação completa da biblioteca viva como projeto da plataforma.

**Entregas:**
- [ ] Portar o conteúdo do `apps/documentacao` do backup para `projects/documentacao/screens/` (catálogo de componentes, demos executáveis: Grid, Layout, Form, Money, Photo, MultipleChoice, menus, GeradorSistema)
- [ ] Registro no registry com `componentId: "documentation"`
- [ ] Config do projeto documentacao: grupo Documentação (telas custom) + tela Usuários (escopo do projeto)
- [ ] Demos apontando para o `api-client`/dados simulados conforme aplicável (sem HTTP direto de componente)

**Testes funcionais:**
- [ ] Logado no projeto `documentacao`: navegação por todos os componentes da biblioteca funciona
- [ ] Tela de usuários do documentacao lista só usuários do projeto
- [ ] Nenhum resquício de referência externa (zero menções a outros sistemas/clientes)

**Validação:**
- [ ] Commit `etapa-10: documentação como projeto`

---

## Etapa 11 — Validação ponta a ponta (aceite da PoC)

**Objetivo:** provar o sistema inteiro, especialmente segurança e isolamento.

**Checklist e2e:**
- [ ] Ambiente limpo: `docker compose down -v` → `up` → `db:migrate` + `db:seed` do zero → dados corretos
- [ ] Login alexandre (senha do seed) → seleção → `biblioteca-global`: CRUD de usuários multi-projeto e CRUD de projetos funcionam (criar projeto novo provisiona database)
- [ ] Troca para `documentacao`: documentação navegável; usuários restritos ao projeto
- [ ] Criar usuário novo via tela; logar com ele; só enxerga os projetos vinculados
- [ ] **Testes de isolamento (obrigatórios, com evidência):**
  - [ ] Token do projeto A não acessa recurso do database do projeto B (id conhecido → 404)
  - [ ] Request sem token / token expirado → 401
  - [ ] `projetoId` enviado no body de criação de usuário → ignorado (vínculo vem do token)
  - [ ] Usuário desvinculado de um projeto perde acesso na próxima request (revalidação da pivot)
  - [ ] Resource fora da whitelist → 404
- [ ] `change-password` do alexandre → nova senha funciona; fluxo completo retestado
- [ ] Relatório de aceite escrito (o que passou, o que falhou, sem maquiagem)

**Validação:**
- [ ] Todos os itens acima verdes; commit `etapa-11: validação e2e`

---

## Etapa 12 — Containers de produção e CI

**Objetivo:** ambiente dockerizado completo e pipeline de qualidade.

**Entregas:**
- [ ] Dockerfiles: `apps/api` (build NestJS → node:22-alpine), `apps/web` (build Vite → nginx estático), MySQL 8 já no compose
- [ ] `docker-compose.yml` final: mysql + api + web (com healthchecks, restart, env por arquivo)
- [ ] Migrations do core e dos projetos rodando no boot do container da api (script de entrada idempotente)
- [ ] GitHub Actions: `typecheck` (todos os workspaces) → `lint` → `test` (unitários) → `build` → **migrations validadas em MySQL de serviço** → build das imagens
- [ ] Secrets: `MYSQL_*`, `JWT_SECRET` via GitHub Secrets (nunca em `.env` commitado)

**Testes funcionais:**
- [ ] `docker compose up` do zero → seed ok → login ok → fluxo completo ok dentro dos containers
- [ ] CI verde em branch de teste

**Validação:**
- [ ] Commit `etapa-12: containers + ci`

---

## Etapa 13 — Manual novo e decisão de publicação

**Objetivo:** fechar o ciclo: documentação do processo e futuro do pacote.

**Entregas:**
- [ ] Novo `MANUAL_DESENVOLVIMENTO.md` refletindo a v2 (substitui o antigo, que ficou no backup): arquitetura, como criar componente, como evoluir, protocolo para agentes, convenção de annotations `@form`, ciclo de vida de projeto
- [ ] **Decisão com o Alexandre:** nome/escopo dos pacotes publicados (manter `@alexandretorqueti/biblioteca-global-ui` vs `@biblioteca-global/ui` — risco §12.8 do PoC)
- [ ] Workflow de publicação revisado (`.github/workflows/publish-ui.yml`) — **publicar somente com ordem explícita do Alexandre**
- [ ] README da raiz atualizado com arquitetura nova, portas e comandos

**Validação:**
- [ ] Manual revisado pelo Alexandre; commit `etapa-13: manual + publicação`

---

## Registro de progresso

| Etapa | Nome | Status | Concluída em |
|---|---|---|---|
| 0 | Fundação do monorepo e ambiente | ✅ concluída | 2026-08-14 |
| 1 | `packages/shared` | ✅ concluída | 2026-08-14 |
| 2 | Database `core` (schema/migrations/seeds) | ✅ concluída | 2026-08-14 |
| 3 | API base + Auth (JWT por projeto) | ✅ concluída | 2026-08-14 |
| 4 | Usuários + Projetos (escopo) | ✅ concluída | 2026-08-14 |
| 5 | CRUD genérico por resource | ✅ concluída | 2026-08-14 |
| 6 | `projects/` + gerador de config | ✅ concluída | 2026-08-14 |
| 7 | `packages/api-client` | ✅ concluída | 2026-08-14 |
| 8 | `packages/ui` reconstruída | ✅ concluída | 2026-08-14 |
| 9 | `apps/web` | ⬜ não iniciada | — |
| 10 | Projeto `documentacao` | ⬜ não iniciada | — |
| 11 | Validação ponta a ponta | ⬜ não iniciada | — |
| 12 | Containers + CI | ⬜ não iniciada | — |
| 13 | Manual + publicação | ⬜ não iniciada | — |
