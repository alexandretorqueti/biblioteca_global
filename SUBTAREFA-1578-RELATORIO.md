# Subtarefa 1578 (macro-gestao-de-tarefas-global-2) — Matriz de testes de permissão por perfil e organização

**Data:** 2026-11-24 · **Worktree:** `.motor-v3-worktrees/macro-gestao-de-tarefas-global-2/1578/a1` · base `a170da64`

## O que foi entregue

- `apps/api/src/modules/crud/__tests__/fixtures/matriz-perfis.fixture.ts` — fixtures reutilizáveis:
  boot da app + cenário canônico (organizações A e B; usuários master, admin A, gerente A,
  operador A, visualizador A, admin B — cada um com login real + select-project;
  colaboradores ativos vinculados; área/tag/tarefa por organização; tarefa FECHADA em A;
  alvo sensível com cpf/telefone/email) e limpeza completa em FK-order.
- `apps/api/src/modules/crud/__tests__/gestao-tarefas-global-matriz-perfis.functional.spec.ts` —
  suíte da matriz (25 testes, API real + MySQL real `projeto_8496`), mapeada aos 5 critérios:
  - **CA1 isolamento A×B:** leitura 404, escrita/exclusão 404 (403 p/ read-only), listagens sem
    vazamento em `organizacoes/colaboradores/areas/tags/tarefas` por TODOS os perfis de A,
    simetria B→A, FK cruzada B→A no create → 400;
  - **CA2 master:** `criarOrganizacaoComAdmin` cria organização + colaborador ativo vinculado +
    perfil admin no pivot `projetos_usuarios`; master rejeitado em gestão de colaboradores;
    master sem sessão do projeto não transita no CRUD (403/404); sem token → 401;
  - **CA3 admin cadastra colaboradores:** organização sempre a da sessão (body com org de B →
    400 no service / ignorado no CRUD), gerente/operador rejeitados (admin exclusivo),
    vínculo duplicado na org → 409, invisibilidade cross-org do cadastrado;
  - **CA4 sensíveis:** admin/gerente leem cpf/telefone/email; operador/visualizador não recebem
    as chaves nem em lista nem em detalhe (API direta) e não gravam (400/403); admin B não vê
    alvo de A; matriz nominal dos 6 participantes;
  - **CA5 tarefa:** os 4 perfis criam tarefa (org forçada pela sessão, status default 'aberta');
    PUT em tarefa `concluida` → 409 com erro claro ("edição indisponível … só evolui pelo fluxo
    da tarefa"); PUT em aberta ok p/ admin/gerente/operador, 403 p/ visualizador; `status` no
    corpo → 400.
- `apps/api/src/modules/gestao-organizacoes/gestao-organizacoes.service.ts` — correções
  mínimas exigidas pela execução da matriz (ver "Ajustes no service" abaixo).

## Ajustes no service (pré-existentes que quebravam em runtime/typecheck)

1. `buscarColaborador(NaOrganizacao)`: `select().limit(1).at(0)` — `.at()` não existe no builder
   do Drizzle (só após await) → `TypeError` em runtime; corrigido para `linhas[0]`.
2. `require("./dto/…")` dinâmico não resolve sob ESM/vitest (module sem `./`-resolver) →
   `Cannot find module` em runtime; substituído por import estático (não há ciclo: o dto não
   importa o service) e `parseOu400` com tipagem compatível com Zod 4 (`path: PropertyKey[]`).
3. `import()` dinâmico de `database/schema` em `garantirPerfilAdminNoProjeto` → import estático
   (mesmo motivo: TS2835 sob node16 + fragilidade runtime).
   Comportamento de negócio inalterado — suítes das subtarefas 2-5 seguem verdes.

## Evidência de execução (todos na raiz do worktree, MySQL real host.docker.internal:3308)

```
# Matriz + suítes funcionais do escopo (rodam "separadamente" — fora do vitest root)
$ npx vitest run --config /tmp/func-gtg.mts   # include: gestao-tarefas-global-*.functional.spec.ts
 Test Files  4 passed (4)     Tests  53 passed (53)
  ├─ gestao-tarefas-global-crud.functional.spec.ts      8 ✓
  ├─ gestao-tarefas-global-sensiveis.functional.spec.ts 8 ✓
  ├─ gestao-tarefas-global-tenancy.functional.spec.ts  12 ✓
  └─ gestao-tarefas-global-matriz-perfis.functional.spec.ts 25 ✓  (nova)

# Unidade da área afetada (tenancy + CRUD genérico — regressão)
$ npx vitest run apps/api/src/modules/crud projects/gestao-de-tarefas-global
 Test Files  8 passed (8)     Tests  156 passed (156)

# apps/api completo (vitest root, sem funcionais)
$ npx vitest run apps/api
 Test Files  45 passed (45)   Tests  405 passed (405)

# Typecheck
$ (apps/api) npx tsc --noEmit
 sem erros fora do baseline pré-existente projects/gerenteagentes/api/gerenteagentes.service.ts
 (moduleResolution Node16 — pré-existente na base, tolerado pelo gate diferencial)

# Lint (arquivos desta subtarefa)
$ npx eslint .../matriz-perfis.functional.spec.ts .../matriz-perfis.fixture.ts .../gestao-organizacoes.service.ts
 0 erros

# Build
$ npm run build   → ok (vite production build concluído)
```

## Cobertura critério → teste

| Critério de aceite da macro | Testes |
|---|---|
| A não lê/escreve em B em nenhum recurso | CA1 (5 testes, todos os perfis + simetria + FK cruzada) + tenancy.spec (12, todos os 11 resources) |
| Master cria organização e admin | CA2 (service real + DI da app; colab ativo, vínculo, pivot admin) |
| Admin cadastra colaboradores da própria org | CA3 (5 testes: force de sessão, rejeição de org alheia, gerente/operador bloqueados, 409 duplicidade, CRUD HTTP) |
| Sensíveis só admin/gerente (inclusive API direta) | CA4 (5 testes) + sensiveis.spec (8) |
| Qualquer usuário cria tarefa; status ≠ aberta rejeita edição | CA5 (5 testes) + escopo.spec (unit, 46) |
| Sem regressão de outros projetos/CRUD genérico | apps/api 405 ✓, crud.* specs ✓, build ✓ |
