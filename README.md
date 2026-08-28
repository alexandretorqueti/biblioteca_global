<!-- Teste motor-v2 -->

# Biblioteca Global (v2)

Plataforma da **Global Tecnologia** que gera sistemas a partir de configuração:
autenticação (`AuthPanel`), seleção de projeto e montagem automática do sistema
(`GeradorSistema`) a partir de uma config JSON derivada do modelo de dados.

> Especificação completa: [`POC_DEFINICOES.md`](./POC_DEFINICOES.md) ·
> Plano de execução: [`ETAPAS_DESENVOLVIMENTO.md`](./ETAPAS_DESENVOLVIMENTO.md) ·
> Backup funcional da v1: `biblioteca_old/` (referência — nunca editar).

## Arquitetura

- **100% TypeScript** (zero `.js`, tipagem estrita, `no-explicit-any` = erro).
- Monorepo npm workspaces:

```
packages/
  ui/           @biblioteca-global/ui          — componentes React 19 + MUI 7 (sem HTTP)
  api-client/   @biblioteca-global/api-client  — única camada que fala HTTP (tipada)
  shared/       @biblioteca-global/shared      — contratos únicos front ↔ back
apps/
  api/          NestJS — auth, usuários, projetos, CRUD genérico por resource
  web/          React 19 + Vite — login → seleção de projeto → sistema gerado
projects/
  <slug>/       schema.ts (fonte da verdade) + migrations + screens + config
database/
  migrations/   SQL versionado do database core
```

- **Banco:** MySQL 8 — um database `core` (plataforma) + um database
  `projeto_<id>` por projeto (isolamento físico; o database vem do token,
  nunca do payload).
- **Auth:** JWT por projeto — access token curto com `{ sub, projetoId, perfil }`;
  refresh token global revogável.
- **Fonte única:** `schema.ts` (Drizzle) → migrations SQL, validação Zod e
  config JSON do `GeradorSistema`.

## Ambiente de desenvolvimento

Pré-requisitos: Node >= 22, Docker Compose.

```bash
npm install --include=dev      # o container roda NODE_ENV=production: SEMPRE --include=dev
cp .env.example .env           # e ajuste as senhas/segredos
docker compose up -d --build   # web :5174, API :3003, MySQL :3308
```

Scripts raiz: `npm run dev|build|test|lint|typecheck`.

## Acesso local

- Aplicativo: `http://localhost:5174`
- API: `http://localhost:3003/api`
- MySQL: `localhost:3308`

O container da API aplica migrations e o seed idempotente antes de iniciar.
Consulte o [`MANUAL_DESENVOLVIMENTO.md`](./MANUAL_DESENVOLVIMENTO.md) para
criar/evoluir componentes e projetos. O aceite e o progresso ficam em
[`ETAPAS_DESENVOLVIMENTO.md`](./ETAPAS_DESENVOLVIMENTO.md).
