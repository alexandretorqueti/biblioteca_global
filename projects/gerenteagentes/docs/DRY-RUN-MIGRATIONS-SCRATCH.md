# Dry-Run de Migrations em Tabelas Scratch

**Data:** 2026-10-11  
**Contexto:** Tarefa task-p2-974 — Guardas anti-repetição do incidente de migration  
**Status:** Implementado

## Decisão

O gate `pre_deploy` executa dry-run das migrations adicionadas desde o commit-base usando **tabelas scratch prefixadas** (`gate_scratch_<jobId>_<tableName>`) no banco de dados existente, em vez de criar um database temporário isolado.

## Estratégia

1. **Descoberta diferencial:** `git diff --diff-filter=A` + `git ls-files --others` identifica migrations `.sql` adicionadas desde o commit-base.
2. **Clonagem de estrutura:** Para cada tabela referenciada, `SHOW CREATE TABLE` obtém o DDL original, que é reescrito com o nome scratch e `AUTO_INCREMENT=1`.
3. **Reescrita de referências:** Statements SQL têm referências de tabela substituídas pelos nomes scratch (com e sem backticks).
4. **Execução ordenada:** Statements são executados em ordem sobre as tabelas scratch.
5. **Cleanup em finally:** `DROP TABLE IF EXISTS` remove todas as tabelas scratch após sucesso ou falha.

## Justificativa

### Por que tabelas scratch e não database separado?

- **Grants atuais:** O usuário `MYSQL_*` configurado no container da API pode não ter grants para `CREATE DATABASE` / `DROP DATABASE`. Tabelas scratch no database existente funcionam com grants padrão de DDL.
- **Simplicidade:** Não exige gerenciamento de conexão cross-database nem configuração adicional.
- **Cleanup garantido:** `DROP TABLE` é mais simples e rápido que `DROP DATABASE`.

### Limitações conhecidas

- **Isolamento parcial:** Tabelas scratch coexistem com tabelas reais no mesmo database. Nomes prefixados (`gate_scratch_<jobId>_`) previnem colisões, mas um bug no executor poderia teoricamente afetar tabelas reais. A reescrita de referências mitiga esse risco.
- **Tabelas sem clone:** Se uma migration cria uma tabela nova (que ainda não existe), não há DDL para clonar. O executor registra o nome scratch e executa o `CREATE TABLE` reescrito diretamente, validando a sintaxe.
- **Migrations complexas:** Migrations com triggers, stored procedures, ou views podem não ser totalmente validáveis com essa abordagem. O lint de statement-breakpoint (subtarefa 1) cobre a validação estrutural.

### Evolução futura

Quando os grants do MySQL forem expandidos para incluir `CREATE DATABASE`, considerar:
- Criar database efêmero `gate_dryrun_<jobId>` para isolamento completo.
- Dump da estrutura completa do projeto (`mysqldump --no-data`) no database efêmero.
- Execução das migrations no database isolado (zero risco para tabelas reais).

## Integração com o gate

O dry-run roda **antes** do build/test no `TestGateService.run()`:
- Condição: `phase === 'pre_deploy' && baseCommitSha !== commitSha`
- Falha: `MigrationDryRunError` com arquivo, linha, índice do statement e mensagem MySQL.
- Resultado: gravado como `test_run` com `status='failed'` e `test_failures` individuais.

O `DeployConsumer` resolve `baseCommitSha` via `git rev-parse <baseBranch>` em vez de repetir o commit candidato, garantindo que o diff seja contra a branch-base real.

## Arquivos

- `src/migrations/MigrationDryRunExecutor.ts` — executor do dry-run.
- `src/testing/TestGateService.ts` — integração no gate pre_deploy.
- `src/deploy/DeployConsumer.ts` — resolução de baseCommitSha real.
- `test/migration-dry-run-executor.test.ts` — 9 testes unitários.
