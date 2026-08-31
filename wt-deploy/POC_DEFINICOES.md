# Biblioteca Global — PoC: Definições do Sistema (v2)

> **Status:** definição final — aguardando OK do Alexandre para iniciar o scaffold (fase 1 do §13).
> **Data:** 2026-08-14 · **Revisado:** 2× (consistência + completude)
> **Autor:** Biblioteca Global 📚 (agente) + Alexandre (dono do produto)
> **Backup de referência:** `biblioteca_old/` (consulta para compatibilidade da biblioteca de componentes)

---

## 1. Decisões confirmadas

| Tema | Decisão |
|---|---|
| Linguagem | **100% TypeScript** — zero `.js` no projeto. Tipagem obrigatória em toda variável, parâmetro, retorno e DTO. `tsc --noEmit` + ESLint (`no-explicit-any` = erro) como barreira. |
| Monorepo | npm workspaces — front + back + pacotes + **pastas de projetos** |
| Backend | **NestJS** (modular, DI, controllers/services/repositories) |
| ORM / Migrations | **Drizzle ORM** — schema em TS, migrations SQL versionadas, seeds em TS |
| Banco | **MySQL 8** — um único servidor, **um database `core` + um database por projeto** |
| Frontend | React 19 + Vite + MUI 7 + biblioteca `@biblioteca-global/ui` (reconstruída) |
| Biblioteca de componentes | **Refeita e modernizada** (backup = referência funcional) |
| Documentação | **Projeto separado na tabela de projetos** (telas custom) |
| Auth | Componente `AuthPanel` (identificador configurável + senha) + **JWT por projeto** |
| Geração de telas | `GeradorSistema` movido a **config JSON por projeto**, **gerada a partir do modelo de dados** |
| Fonte da verdade | **`schema.ts` do projeto** (Drizzle) → gera banco, validação (Zod) e config JSON — uma escrita, três artefatos |
| Modelo de dados por projeto | **Database MySQL próprio por projeto** — clientes com modelos completamente diferentes |
| Estrutura por projeto | Pasta versionada `projects/<slug>/` com `schema.ts`, `migrations/`, `screens/`, `config.ts` |

---

## 2. Visão do sistema

O `biblioteca-global` é uma **plataforma que gera sistemas a partir de configuração**:

1. O usuário autentica com o `AuthPanel` (email, login, telefone ou CPF — configurável por aplicação).
2. O sistema descobre os projetos do usuário; ele seleciona um (ou vai direto se houver só um).
3. O backend emite um **token de acesso exclusivo daquele projeto** e entrega a **config JSON** dele.
4. O front monta o `GeradorSistema` a partir da config: menu, telas de CRUD e telas custom.
5. Toda operação de dados roda no **database do projeto da sessão** — isolamento físico por projeto (ver §4).

**Cada projeto é um "mundo próprio":** define o seu modelo de dados (schema), as suas telas custom e a sua apresentação. A biblioteca de componentes (`packages/ui`) é o motor visual comum; a plataforma (auth + core + geração) é o chassi.

---

## 3. Monorepo

```
biblioteca-global/
├── package.json                 # workspaces + scripts raiz
├── docker-compose.yml           # mysql + api + web (dev)
├── .env.example                 # variáveis de ambiente documentadas
├── packages/
│   ├── ui/                      # @biblioteca-global/ui (NOVA — reconstruída)
│   ├── api-client/              # @biblioteca-global/api-client (NOVO — tipado)
│   └── shared/                  # @biblioteca-global/shared (contratos front+back)
├── apps/
│   ├── api/                     # NestJS (backend)
│   └── web/                     # React 19 + Vite (frontend)
├── projects/                    # ★ UM DIRETÓRIO POR PROJETO DA PLATAFORMA
│   ├── biblioteca-global/
│   │   ├── schema.ts            # modelo de dados do projeto (Drizzle) — fonte da verdade
│   │   ├── drizzle.config.ts    # config de migrations do projeto
│   │   ├── migrations/          # SQL versionado DO PROJETO
│   │   ├── screens/             # telas custom React do projeto
│   │   └── config.ts            # config base (overrides de UX/menu)
│   └── documentacao/
│       ├── schema.ts
│       ├── migrations/
│       └── screens/             # telas da documentação
└── database/
    └── migrations/              # SQL versionado do database core (sistêmico) + seeds
```

### Regras do monorepo
- **`packages/shared`** é o contrato único de tipos entre front e back: `EntityRecord`, `GeradorSistemaConfig` (serializável), DTOs de auth, tipos de sessão, schemas Zod derivados. Front e back importam daqui — nunca duplicam tipos.
- **`packages/api-client`** expõe clientes REST tipados (`RestEntityClient<T>`) e é a única camada do front que fala HTTP.
- **`packages/ui`** é 100% desacoplada de HTTP (regra mantida): recebe `dataSource` prontos.
- **`projects/<slug>/`** guarda a estrutura de cada projeto da plataforma — versionada no git, tipada e revisável. Nome da pasta = `slug` (legível); database = `projeto_<id>` (estável) — o mapa `slug ↔ id` vive na tabela `projetos`.
- Todo pacote: `"type": "module"`, TS `strict`, exports explícitos, sem `any`.

---

## 4. Banco de dados (MySQL 8 + Drizzle)

### 4.1 Um servidor, vários databases

```
Servidor MySQL (1 instância)
│
├── database: core            ← sistêmico/global — tabelas:
│                                usuarios, projetos, projetos_usuarios, refresh_tokens
│
├── database: projeto_1       ← negócio do projeto 1 (cliente A)
│                                produtos, clientes, vendas   (o que o cliente A definir)
│
└── database: projeto_2       ← negócio do projeto 2 (cliente B)
                                 imoveis, locacoes            (estrutura completamente diferente)
```

- **`core`** é o database da plataforma: usuários (globais), projetos e vínculos. Não muda por cliente.
- **Cada projeto tem o seu database** (`projeto_<id>`) com as tabelas de negócio **exatamente** como o cliente definiu. Nome gerado pelo sistema (nunca input do cliente) — sem risco de injeção; resolução `projeto → database` via whitelist no back.
- **Não há coluna `projeto_id` nas tabelas de negócio:** o isolamento é **físico** (database próprio) — mais seguro e mais simples que filtro por coluna. O database do projeto é derivado do token da sessão, nunca do payload.

### 4.2 Tabelas do database `core`

**`usuarios`** — usuários são **globais** (uma conta pode estar em vários projetos):

| Coluna | Tipo | Obrigatória | Observação |
|---|---|---|---|
| `id` | BIGINT UNSIGNED PK AI | sim | |
| `username` | VARCHAR(100) | não | identificador opcional (login) |
| `email` | VARCHAR(255) | não | identificador opcional |
| `telefone` | VARCHAR(30) | não | identificador opcional |
| `cpf` | VARCHAR(14) | não | identificador opcional |
| `password_hash` | VARCHAR(255) | sim | argon2id |
| `nome` | VARCHAR(150) | sim | nome de exibição |
| `ativo` | BOOLEAN | sim | default `true` |
| `created_at` / `updated_at` | TIMESTAMP | sim | |

> **Regra de identificador:** o `AuthPanel` recebe `loginIdentifier` (email | username | phone | cpf | document). O back autentica procurando o usuário pela coluna correspondente. Colunas não usadas ficam `NULL`. Index único por coluna de identificador (MySQL 8 aceita múltiplos NULL em UNIQUE).

**`projetos`**:

| Coluna | Tipo | Obrigatória | Observação |
|---|---|---|---|
| `id` | BIGINT UNSIGNED PK AI | sim | base do nome do database (`projeto_<id>`) |
| `nome` | VARCHAR(150) | sim | nome exibido (ex.: "Biblioteca Global") |
| `slug` | VARCHAR(100) | sim | identifica a pasta `projects/<slug>/` e rotas — UNIQUE |
| `ativo` | BOOLEAN | sim | default `true` |
| `config` | JSON | sim | overrides de config do GeradorSistema (ver §7) |
| `created_at` / `updated_at` | TIMESTAMP | sim | |

**`projetos_usuarios`** (pivot N:N):

| Coluna | Tipo | Observação |
|---|---|---|
| `projeto_id` | BIGINT UNSIGNED FK → projetos | PK composta |
| `usuario_id` | BIGINT UNSIGNED FK → usuarios | PK composta |
| `perfil` | ENUM('admin','gerente','operador','visualizador') | perfil **dentro daquele projeto** |
| `created_at` | TIMESTAMP | |

**`refresh_tokens`**: id, usuario_id FK, token hash, expiração, revogado — usado no fluxo de renovação/logout (§5).

### 4.3 Migrations e seeds

- **Database `core`:** migrations em `database/migrations/` (drizzle-kit a partir de um schema TS do core).
- **Database de cada projeto:** migrations em `projects/<slug>/migrations/` — geradas pelo `drizzle.config.ts` da pasta, a partir do `schema.ts` do projeto. **Um projeto não afeta a migration de outro.**
- **Seeds (TS, idempotentes — upsert):** rodam junto com a migração do core:
  1. Projeto `biblioteca-global` (slug `biblioteca-global`).
  2. Projeto `documentacao` (slug `documentacao`).
  3. Usuário `alexandre` — username `alexandre`, senha inicial gerada (hash argon2id), vínculos `admin` nos **dois** projetos.
  4. Criação dos databases `projeto_<id>` + aplicação das migrations dos dois projetos iniciais — **usando o mesmo mecanismo do ciclo de vida de projeto (§6.3)**.

---

## 5. Autenticação & sessão

### 5.1 Fluxo
1. `AuthPanel` → `POST /api/auth/login` com `{ identifier, password, identifierType }`.
2. `AuthService` localiza o usuário (coluna do tipo), confere hash argon2id, checa `ativo`.
3. Back devolve **refresh token** (identifica o usuário, sem escopo de projeto, vida longa) + **lista de projetos** do usuário (com perfil em cada um).
4. Se 1 projeto → já emite o access token dele. Se vários → tela de seleção de projeto → `POST /api/auth/select-project`.
5. **Seleção de projeto** → emite **access token curto (~15 min)** com claims `{ sub, projetoId, perfil }` — **vale somente para aquele projeto**.

### 5.2 Token por projeto (regra de segurança central)
- O **escopo vem do token**, nunca do body/query/header. O `ProjectScopeGuard` lê `projetoId` e `perfil` dos claims e injeta na requisição.
- Trocar de projeto → **novo access token** (o anterior continua válido só até expirar, e só acessa o projeto antigo).
- A cada request autenticado, o back **revalida na pivot** `projetos_usuarios` que o vínculo ainda existe (revoga na hora se o vínculo caiu) e que `usuario.ativo = true`.
- `RolesGuard` libera ações sensíveis por perfil (ex.: só `admin` cria projeto/edita config).
- **Logout** revoga o refresh token (denylist); expiração curta limita janela de token vazado; rate limiting no login (anti brute force).
- **Resultado:** um token emitido para o projeto A **não lista dados do projeto B**, mesmo que o usuário pertença aos dois.

### 5.3 Sessão no front
`accessToken` + `projetoAtual` (id/slug) + `perfil` — em memória (Context) + `localStorage` opcional ("lembrar de mim" do AuthPanel). O front injeta o token no api-client; o campo `projetoId` **nunca** é enviado pelo cliente (vem do token).

---

## 6. Backend — NestJS em camadas

### 6.1 Estrutura

```
apps/api/src/
├── main.ts                  # bootstrap (validação global, CORS, prefixo /api)
├── app.module.ts
├── config/                  # ConfigModule + env tipado (MYSQL_*, JWT_SECRET)
├── database/
│   ├── core/                # conexão com database core + schema core
│   └── projects/            # fábrica de conexão por projeto (cache por projetoId)
├── common/
│   ├── decorators/          # @CurrentUser(), @CurrentProject(), @Public()
│   ├── guards/              # JwtAuthGuard, ProjectScopeGuard, RolesGuard
│   ├── interceptors/        # transformação de resposta, erro padronizado
│   ├── filters/             # HttpExceptionFilter (Drizzle/validação → 400/409/404)
│   └── dto/                 # PaginationDto, filtros genéricos
├── modules/
│   ├── auth/                # login, select-project, refresh, logout, change-password
│   ├── usuarios/            # CRUD usuários + vínculos por projeto
│   ├── projetos/            # CRUD projetos + ciclo de vida (criar db + migrar)
│   └── crud/                # CRUD genérico por resource (telas geradas)
└── entities/                # schemas Drizzle do core + tipos
```

**Princípio:** controllers finos (validam entrada, chamam service), services com regra de negócio, repositories (Drizzle) só SQL. O repositório de projeto recebe o database do projeto **derivado da sessão** — impossível consultar outro projeto trocando payload.

### 6.2 Endpoints principais

**Auth**
```
POST   /api/auth/login            → { refreshToken, usuario, projetos[] }
POST   /api/auth/select-project   → { accessToken }   (claims: sub, projetoId, perfil)
POST   /api/auth/refresh          → novo refresh + lista de projetos
POST   /api/auth/logout           → revoga refresh token
POST   /api/auth/change-password
GET    /api/auth/me               → usuário + projeto atual + perfil
```

**Projetos** (restrito a admin global — perfil `admin` no projeto `biblioteca-global`)
```
GET    /api/projetos              → lista (admin global)
GET    /api/projetos/:id          → detalhe + config
POST   /api/projetos              → cria projeto: registro + database projeto_<id> + migrations da pasta
PUT    /api/projetos/:id          → atualiza (config validada contra o schema do projeto)
DELETE /api/projetos/:id          → desativa (soft delete; database preservado)
```

**Usuários (escopo do projeto do token — §8)**
```
GET    /api/usuarios              → usuários DO projeto do token (filtros/paginação)
GET    /api/usuarios/:id          → somente se pertencer ao projeto
POST   /api/usuarios              → cria usuário + vínculo no projeto do token
PUT    /api/usuarios/:id          → edita (nunca aceita projetoId no body)
DELETE /api/usuarios/:id          → desvincula do projeto (soft: remove vínculo)
── exclusivo do projeto biblioteca-global ──
GET    /api/usuarios?projetoId=&  → usuários de QUALQUER projeto (filtro opcional)
PUT    /api/usuarios/:id/vincular → gerencia vínculos multi-projeto (add/remove projeto+perfil)
```

**CRUD genérico (telas geradas — database do projeto do token)**
```
GET    /api/:resource             → listar (filtros + paginação)
GET    /api/:resource/:id
POST   /api/:resource
PUT    /api/:resource/:id
DELETE /api/:resource/:id
```
- `resource` = nome de tabela do `schema.ts` do projeto (whitelist derivada do schema, nunca string arbitrária).
- A conexão usada é **sempre a do database do projeto do token** — o CRUD nem enxerga outros databases.
- Na PoC v1, os resources oficiais do projeto `biblioteca-global` são os do core (via módulos específicos); recursos de negócio novos entram pelo mesmo mecanismo, bastando declarar a tabela no `schema.ts` do projeto.

### 6.3 Ciclo de vida de um projeto novo
1. Desenvolvedor cria a pasta `projects/<slug>/` com `schema.ts` + `screens/` + `config.ts` (commit no git).
2. `POST /api/projetos` registra o projeto → back cria `database projeto_<id>` → roda as migrations da pasta → seed se houver.
3. Config JSON inicial é **gerada do schema** (§7) e salva como base; o admin ajusta overrides de UX.
4. Evolução do modelo: nova migration na pasta do projeto → `drizzle-kit migrate` no database dele — **sem afetar outros projetos**.

---

## 7. GeradorSistema — config JSON com fonte única

### 7.1 O que era no backup
A config era objeto TS no `App.tsx` (`app`, `groups[]` → `items[]` → `screen`), com funções (`dataSource`) e JSX (`logo`, `icon`, telas custom) — **não serializável**.

### 7.2 Fonte única: `schema.ts` gera banco, validação e config

```
schema.ts (do projeto — ÚNICA escrita)
   ├─→ drizzle-kit  →  migrations SQL        →  database projeto_<id>
   ├─→ drizzle-zod  →  Zod schemas (insert/select) →  validação back + front (packages/shared)
   └─→ gerador de fields →  config JSON padrão     →  GeradorSistema
```

- **Drizzle é a fonte da verdade** (schema TS declarativo e tipado). Zod **não** gera banco (não há ferramenta madura Zod→DDL) — o Zod é **derivado** do Drizzle via `drizzle-zod`, garantindo que validação nunca diverge da tabela.
- **Annotations no `schema.ts`** (`@form({ label, required, fullWidth })`) alimentam o gerador de `fields` do DynamicForm e dos `gridColumns`.
- O gerador roda no build/seed e produz o **config JSON padrão** do projeto.

### 7.3 Config JSON no banco (overrides)

```jsonc
{
  "app": { "name": "Biblioteca Global", "logo": "menu_book" },   // logo/icon = string (mapa no front)
  "drawerWidth": 280,
  "groups": [
    {
      "id": "administracao",
      "label": "Administração",
      "items": [
        {
          "id": "usuarios",
          "label": "Usuários",
          "path": "usuarios",
          "icon": "people",
          "screen": {
            "kind": "cadastro",
            "resource": "usuarios",        // api-client monta o CRUD para /api/usuarios
            "title": "Usuários",
            "description": "...",
            "overrides": {                  // ← só o que difere do gerado pelo schema
              "fields": [],                 //   (ex.: reordenar, mudar label — nunca inventar campo)
              "hiddenColumns": ["createdAt", "updatedAt"],
              "columns": 2,
              "newLabel": "Novo usuário"
            }
          }
        },
        {
          "id": "documentacao",
          "label": "Documentação",
          "path": "documentacao",
          "icon": "menu_book",
          "screen": { "kind": "custom", "componentId": "documentation" }  // registry no front
        }
      ]
    }
  ]
}
```

### 7.4 Regras
| Antes (não serializável) | Agora (dado) | Resolvido por |
|---|---|---|
| `dataSource` (funções) | `resource: string` | `api-client` monta `RestEntityClient` |
| `logo` / `icon` (ReactNode) | string (nome do ícone) | mapa `iconName → componente` no front |
| tela custom (JSX) | `componentId: string` | **registry de telas** no front (telas da pasta `projects/<slug>/screens/`) |
| `DynamicField.upload` (função) | `uploadResource: string` | api-client faz upload e retorna URL |

- **No salvar:** a config é validada contra o schema derivado do projeto — referenciou campo que não existe na tabela? **Rejeita.** (defesa em profundidade)
- **No runtime:** `configFinal = merge(derivado do schema, overrides do banco)` — o modelo gera o padrão; o JSON só sobrescreve apresentação/navegação.
- **Config versionada vs. config corrente:** `projects/<slug>/config.ts` é a **base versionada** (menu/UX por padrão, usada no provisionamento — §6.3); o **banco** guarda a **config corrente** do projeto (iniciada igual à base); edições do admin (editor de config) persistem no banco.
- **No front:** a UI continua sem falar HTTP — o `dataSource` é montado pelo api-client a partir de `resource` + token da sessão.

---

## 8. Regra de escopo: tela de usuários por projeto

- **A tela "Usuários" é injetada automaticamente em todos os projetos** pela plataforma (não dá para remover; a config só reposiciona/personaliza). CRUD **restrito ao projeto da sessão**:
  - A listagem consulta `core.usuarios` **filtrando pela pivot** `projetos_usuarios` do projeto do token.
  - O campo `projetoId` **não aparece no formulário, na grid, nem é aceito no body** — o vínculo vem do token, nunca do cliente.
  - `hiddenColumns` da config oculta no front; **guards e validação do back são a regra de verdade**.
- **Única exceção — projeto `biblioteca-global`:** a tela de usuários permite **gerenciar vínculos entre usuários e qualquer projeto** (campo `projetoId` visível/obrigatório, multi-projeto) e o **CRUD de projetos** (com editor de config validado).
- O front expõe/oculta o campo conforme a flag `globalAdmin` da sessão (true **apenas** no projeto `biblioteca-global`).

---

## 9. Projetos iniciais (seeds)

### 9.1 `biblioteca-global`
- Database próprio `projeto_<id>` (vazio de negócio — o projeto é a administração da plataforma).
- Config: grupo Administração → telas **Usuários** (modo global) e **Projetos** (CRUD + editor de config).
- É o projeto "dono da plataforma": gerencia usuários e projetos de tudo.

### 9.2 `documentacao`
- Database próprio `projeto_<id>` (pode ter tabelas próprias se precisar no futuro).
- Config: telas **custom** (`componentId: "documentation"` — conteúdo da documentação vive em `projects/documentacao/screens/`) + tela **Usuários** (modo padrão, sem `projetoId`).
- **Viabilidade confirmada:** o `GeradorSistema` suporta telas custom via registry; o JSON só aponta `componentId`; a documentação ganha de brinde autenticação + tela de usuários + isolamento de dados.

### 9.3 Usuário padrão — `alexandre`
- `username: alexandre`, `email: alexandre.globaltecnologia@gmail.com`, senha inicial: **`Bo4MfU29r0GPi1`** (gerada pelo agente, hash argon2id no seed — descartável).
- Vínculos na pivot: `admin` em **biblioteca-global** e **documentacao**.
- ⚠️ **Trocar a senha após o primeiro login** (fluxo `change-password` já previsto) — o agente passa a "não saber" a nova senha.

---

## 10. Frontend (apps/web)

```
apps/web/src/
├── main.tsx / App.tsx          # providers: Theme, Auth, Project, Router
├── api/                        # instâncias do api-client (token no header; nunca projetoId)
├── context/
│   ├── AuthContext.tsx         # login/logout/refresh, usuário logado
│   └── ProjectContext.tsx      # projeto atual + config carregada + merge com schema derivado
├── screens/
│   ├── LoginScreen.tsx         # AuthPanel
│   ├── ProjectSelectScreen.tsx # seleção de projeto (quando >1)
│   └── SystemScreen.tsx        # GeradorSistema montado pela config final
├── registry/
│   └── customScreens.tsx       # mapa componentId → componente (registra screens/ dos projetos)
└── theme/                      # BibliotecaThemeProvider + temas
```

Fluxo: `LoginScreen` (AuthPanel) → `ProjectSelectScreen` (se necessário) → `SystemScreen` (GeradorSistema com config do projeto). O `projetoId` é derivado da sessão pelo api-client, nunca enviado nem renderizado — exceto no modo global do projeto `biblioteca-global`.

---

## 11. Segurança e qualidade

- **Tipagem estrita:** `strict: true`, `noImplicitAny`, `no-explicit-any` (error); DTOs com `class-validator` no back e Zod (derivado do Drizzle) nos contratos compartilhados.
- **Isolamento físico:** cada projeto tem database próprio; a conexão é escolhida pelo token — nem o CRUD nem o usuário conseguem alcançar outro database.
- **Token por projeto:** access curto com `{ sub, projetoId, perfil }`; refresh global revogável; revalidação da pivot a cada request; rate limiting no login.
- **Validação de entrada** em toda rota (DTOs) — nunca confiar no body.
- **Senhas:** argon2id; `password_hash` nunca logado/retornado.
- **Config JSON validada** contra o schema do projeto no ato de salvar (campo inexistente → rejeita).
- **CI (GitHub Actions):** `tsc --noEmit` (todos os workspaces) → ESLint → testes unitários → build → migrations validadas em MySQL de teste.
- **Ambiente:** `docker-compose` com MySQL 8 + api (NestJS) + web (Vite). Env via `.env` (nunca commitado) — `MYSQL_*`, `JWT_SECRET`, `PORT`.

---

## 12. Riscos e pontos abertos

1. **Ciclo de vida de projeto novo:** criar database + rodar migrations exige robustez (passos transacionais/compensáveis). Provisionamento de projeto novo é **processo guiado**: pasta no git → registro → migração (v1 sem self-service total).
2. **N databases = N migrations/backups:** custo operacional maior que schema único; aceito em troca do isolamento. Backup/restore por database.
3. **Annotations do schema:** o gerador de fields depende de annotations padronizadas — definir convenção (`@form`) no manual para não virar bagunça.
4. **Telas custom exigem deploy:** conteúdo/telas novas do projeto vivem no git (não são runtime). Decisão consciente — versionamento e revisão valem o deploy.
5. **Editor visual de config:** v1 aceita JSON validado; editor visual é melhoria futura.
6. **Senha inicial do `alexandre`:** trocada por ele no primeiro login (a gerada é descartável).
7. **Migrations do core vs. dos projetos:** esteiras separadas — o seed do core cria os databases dos projetos iniciais e aplica as migrations deles; falha parcial deve ser tratada com logs claros.
8. **Nome/escopo dos pacotes publicados:** o pacote anterior foi publicado como `@alexandretorqueti/biblioteca-global-ui` (v0.1.19). Se a biblioteca nova for publicada como `@biblioteca-global/ui`, **quebra consumidores existentes** — confirmar com o Alexandre se mantém o nome antigo ou aceita a quebra (v2).

---

## 13. Próximos passos (quando o Alexandre autorizar)

1. **Scaffold do monorepo:** `package.json` raiz, workspaces, TS configs, ESLint, docker-compose (MySQL 8), `.env.example`.
2. **`packages/shared`:** tipos/contratos (EntityRecord, GeradorSistemaConfig serializável, DTOs de auth/sessão).
3. **`packages/ui` reconstruída:** componentes do backup modernizados + registry de telas custom + dataSource por resource.
4. **`packages/api-client`:** clientes tipados + injeção de token (nunca projetoId no body).
5. **`apps/api` (NestJS):** database core + Drizzle + módulos auth/usuarios/projetos/crud + ciclo de vida de projeto + migrations/seeds.
6. **`projects/`:** pastas `biblioteca-global` e `documentacao` com `schema.ts` + `screens/` + `config.ts`; gerador de fields (drizzle-zod + annotations).
7. **`apps/web`:** login → seleção de projeto → GeradorSistema; tela de usuários com regra de escopo §8; documentação como tela custom.
8. **Validação ponta a ponta:** seed → login `alexandre` → seleção de projeto → CRUD usuários/projetos → documentação → teste de isolamento entre databases (token do projeto A não enxerga projeto B).
