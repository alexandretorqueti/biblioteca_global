# Relatório de aceite da PoC v2 — 2026-08-15

## Resultado

- Typecheck de todos os workspaces e database: aprovado.
- ESLint: aprovado.
- Testes: 21 arquivos, 163 testes aprovados, zero falha/skip com MySQL real.
- Builds UI e web: aprovados. Vite informou apenas aviso de chunk web acima de 500 kB.
- Imagens `biblioteca-global-api:v2` e `biblioteca-global-web:v2`: construídas.
- Containers MySQL/API/web: ativos; web e MySQL saudáveis.
- Boot API: migrations + seed idempotente + NestJS iniciado.
- HTTP: web 200; rota protegida sem token 401; proxy nginx → API funcional.
- Fluxo autenticado: login 201, 2 projetos, seleção de `documentacao`, `/me` admin e `/componentes` 200.
- Segurança/isolamento: cobertos pela suíte funcional (token entre databases, whitelist, vínculo, body indevido e autenticação).
- Documentação custom: registry e navegação cobertos por teste de componente.

## Pendências que exigem humano/serviço externo

- Aceite visual do Alexandre no navegador.
- Execução do workflow CI no GitHub após push.
- Revisão formal do novo manual pelo Alexandre.
- Publicação npm não executada (proibida sem ordem explícita).

O database existente foi preservado; não foi feito `down -v`. A idempotência foi validada executando migrations e seed novamente no banco real.
