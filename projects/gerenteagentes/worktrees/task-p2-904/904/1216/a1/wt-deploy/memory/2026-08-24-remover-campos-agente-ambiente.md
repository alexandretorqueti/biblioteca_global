# 2026-08-24 — Remoção dos campos Agente e Ambiente de Execução

**Decisão do Alexandre:** remover os campos 'Agente', 'Caminho do Repo', 'Comando de Build' e 'Comando de Teste' da tela de inclusão, edição e grid, e também da tabela, pois essas informações ficam no projeto (não precisam estar no banco).

## Arquivos alterados

1. **`projects/gerenteagentes/schema.ts`**
   - Removidas colunas de `projetosCaptados`: `agenteId`, `repoPath`, `buildCommand`, `unitTestCommand`
   - Removidas annotations correspondentes em `projetos_captados`

2. **`projects/gerenteagentes/config.ts`**
   - Removidos 4 fields da tela de projetos: `agenteId`, `repoPath`, `buildCommand`, `unitTestCommand`

3. **`projects/gerenteagentes/screens/DashboardScreen.tsx`**
   - Removido `agenteId` da interface `Projeto`
   - Removido `agenteId` do display de tarefas recentes

4. **`projects/gerenteagentes/__tests__/config.spec.ts`**
   - Atualizado teste "define o projeto com agente e ambiente de execução" → "não define agente e ambiente de execução no projeto (removidos — 2026-08-24)"
   - Teste agora valida que os 4 campos NÃO existem na tela de projetos nem na tela de tarefas

5. **`projects/gerenteagentes/migrations/0006_warm_natasha_romanoff.sql`** (nova)
   - Migration idempotente (stored procedure) para DROP COLUMN das 4 colunas em `projetos_captados`

6. **`projects/gerenteagentes/migrations/meta/_journal.json`**
   - Adicionada entrada para migration 0006

7. **`projects/gerenteagentes/migrations/meta/0006_snapshot.json`** (novo)
   - Snapshot atualizado sem as 4 colunas

## Validação

- ✅ Typecheck do gerenteagentes: passou (erros pré-existentes em `crud.controller.ts` não relacionados)
- ✅ Testes: 40/40 passaram (5 arquivos de teste do gerenteagentes)
- ✅ Lint: sem erros nos arquivos alterados
- ✅ Build: passou

## Contexto

Esses campos foram movidos de `tarefas` para `projetos_captados` na migration 0003 (2026-08-20). Agora o Alexandre decidiu que não precisam estar no banco — serão gerenciados de outra forma (configuração manual, variáveis de ambiente, ou outro mecanismo fora do schema).

A tabela `projetos_captados` agora tem apenas: `id`, `nome`, `slug`, `descricao`, `regras`, `contatoId`, `ativo`, `plataformaProjetoId`, `createdAt`, `updatedAt`.
