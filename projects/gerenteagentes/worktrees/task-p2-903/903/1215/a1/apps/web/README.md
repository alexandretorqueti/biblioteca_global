# @biblioteca-global/web — Frontend da Biblioteca Global

Aplicação React 19 + Vite + TypeScript que consuma `packages/ui` e
`@biblioteca-global/api-client` para levar o usuário de **login → seleção de
projeto → sistema gerado** (GeradorSistema).

## Fluxo

```
Login → (autenticado) → Projeto (se >1) → /app (GeradorSistema)
```

- **Login** — `POST /auth/login` via api-client; o refresh token grava a sessão
  e, com exatamente 1 projeto, o projeto é selecionado automaticamente.
- **Seleção** — lista de `projetos` da sessão; `POST /auth/select-project`
  emite o access token de escopo do projeto (o body **nunca** leva
  `projetoId` — o escopo vem do token).
- **Sistema** — `GeradorSistema` montado a partir da config do projeto
  (registry em `src/project/registry/projects.ts`) + runtime com `dataSource`
  resolvido pela api-client (CRUD por `resource`).

## Renovação de sessão

- **Recovery em 401**: `ApiHttpClient.setSessionRecovery` → `AccessTokenProvider`
  tenta `POST /auth/refresh` e repete a chamada original uma vez.
- **Renovação proativa**: `TokenRefresher` agenda o refresh ~60s antes da
  expiração do access token (claim `exp`), evitando janelas de 401.
- **Logout**: revoga o refresh token no back e limpa a sessão local.

## Tema

- `ThemeSettingProvider` (src/theme) reutiliza o `BibliotecaThemeProvider` da UI
  e persiste a preferência (claro/escuro) em `localStorage`. Quando a API
  expuser preferências de perfil do usuário, basta trocar a fonte de
  persistência por uma chamada api-client — a API deste provider não muda.

## Config do projeto

A config do GeradorSistema é resolvida em `src/project/registry/projects.ts`
a partir das configs versionadas em `projects/<slug>/config.ts` e validadas
com o schema Zod do `@biblioteca-global/shared`. Atualmente não há endpoint
público de "GET config do projeto" na API — este mapa é a porta limpa: se a
API passar a expor a config corrente, troca-se apenas a fonte sem tocar nas
telas.

## Scripts

| Comando | Descrição |
| --- | --- |
| `npm run dev --workspace=@biblioteca-global/web` | Vite dev (porta 5173, proxy `/api` → `:3001`) |
| `npm run build --workspace=@biblioteca-global/web` | Build de produção (Vite) |
| `npm run test --workspace=@biblioteca-global/web` | Testes Vitest (jsdom) |
| `npm run typecheck --workspace=@biblioteca-global/web` | `tsc --noEmit` |

Na raiz do monorepo, os mesmos comandos via workspaces:

```bash
npm run dev      # roda apps/api + apps/web (e demais workspaces com dev)
npm run build
npm test
npm run lint
```

## Começando

Pré-requisitos: banco MySQL provisionado (ver
[docker-compose.yml](../../docker-compose.yml)) e a API rodando em `:3001`.

```bash
# 1) Instalar dependências (raiz do monorepo)
npm install

# 2) Subir o back + migrations (ver apps/api)
npm run dev

# 3) Rodar o front em http://localhost:5173
npm run dev --workspace=@biblioteca-global/web
```

Login de exemplo (após seed): usuário `alexandre` / senha definida no seed.

## Estrutura

```
src/
├── api/          # tokenStore + bundle do api-client
├── auth/         # AuthContext, tokenRefresh (renovação), testes
├── project/      # ProjectContext + registry (config + telas custom)
├── routes/       # RequireAuth/RequireProject/AppRoutes
├── screens/      # LoginScreen, ProjectSelectScreen, SystemScreen
└── theme/        # ThemeSettingProvider (claro/escuro persistido)
```
