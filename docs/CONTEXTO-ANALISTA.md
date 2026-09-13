# Contexto do Analista — Biblioteca Global

Plataforma monorepo TypeScript que gera sistemas configuráveis. Fontes principais: `README.md`, `MANUAL_DESENVOLVIMENTO.md`, `apps/api`, `apps/web`, `packages/*`, `database/` e `projects/<slug>/`.

## Arquitetura

- `packages/shared`: contratos; `packages/api-client`: HTTP tipado; `packages/ui`: componentes.
- `apps/api`: NestJS, autenticação e CRUD; `apps/web`: React/Vite.
- `schema.ts` de cada projeto é fonte de verdade para dados; config define interface gerada.
- MySQL: `core` para plataforma e `projeto_<id>` isolado por projeto.

## Regras

- Identidade, usuários, perfis/RBAC, projetos core e telas administrativas pertencem à Biblioteca, não ao Motor.
- Antes de alterar contrato compartilhado, localizar consumidores em API, web e projetos.
- Leia `config.ts`, `schema.ts`, migrations e testes da área afetada.

## Registro confirmado por tarefa

_Contexto inicial curado em 2026-09-13._
