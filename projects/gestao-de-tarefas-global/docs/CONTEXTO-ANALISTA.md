# Contexto do Analista — Gestão de Tarefas Global

> Status: bootstrap recriado em 2026-11-19.
> Projeto: gestao-de-tarefas-global
> Origem: artefato perdido no teardown piloto-8496 (commit `1ff565ad`, 04/11) e recriado
> manualmente com autorização do Alexandre para destravar o gate de setup
> (preflight da análise 1063 falhou em 18/11 por ausência deste arquivo).

## Identidade técnica

Sistema de gestão de tarefas global da Biblioteca Global: multi-organização
(tenancy intra-projeto), ciclo de vida de tarefas com delegação em cadeia,
recorrências, notificações in-app, anexos, dashboard pessoal/quiosque e visões
por área e por tag. Projeto misto (CRUD + telas custom), com agente dedicado.

## Arquitetura e módulos

- `config.ts` + `schema.ts` na raiz do projeto — fontes de verdade do CRUD
  (entidades: organizacoes, areas, tags, colaboradores, tarefas, recorrências,
  notificações, anexos — ver `docs/ESPEC-CRUD.md` para campos/máscaras/validações).
- `migrations/` — Drizzle; toda mudança de banco exige migration nova.
- `src/` — lógica de domínio; `screens/` — telas custom (registro no registry do front).
- Regra da plataforma: mudanças de schema/campos exigem sincronizar `config.ts` E
  `config.json` (MEMORY: incidente 872).

## Fontes de verdade

1. `docs/ESPEC-CRUD.md` — spec gerada do plano macro aprovado (geracoes_projeto #1).
2. `schema.ts` / `config.ts` — estado real do banco e do CRUD.
3. Macro de tarefas 1063–1070 (tenancy → ciclo de vida → recorrência →
   notificações → anexos → dashboard → visões → integração final).

## Decisões vigentes

- Teardown do piloto velho (1021–1025) em 04/11: código anterior foi revertido;
  a base atual parte do esqueleto recriado (commits `a62078c5`, `132eb66a`, `391bac29`).
  Não reaproveitar decisões do piloto sem revalidar contra a ESPEC-CRUD.

## Limitações e riscos conhecidos

- Este arquivo é bootstrap: seções "Identidade/Arquitetura" devem ser refinadas
  pelo analista após a primeira inspeção real do código.
- `migrations/` reiniciadas no teardown — numerar a partir do estado atual.

## Registro confirmado por tarefa

_Nenhuma tarefa da macro 1063–1070 concluída até esta data._
