# Projeto GerenteAgentes

Pacote Drizzle ORM do projeto GerenteAgentes — fonte única do schema e migrations.

## Arquitetura

- **Source of Truth:** `schema.ts` (Drizzle) → gera migrations SQL + `_journal.json`
- **Banco:** MySQL 8
- **Commit gate:** `.husky/pre-commit` gera migrations automaticamente ao commitar `schema.ts`
- **CI gate:** `.github/workflows/ci.yml` falha se as migrations estiverem desatualizadas

## Como funciona o commit hook

Antes de fazer `git commit`, o hook `.husky/pre-commit` verifica:

1. Se `projects/gerenteagentes/schema.ts` foi alterado → roda `npm run db:generate`
2. Adiciona automaticamente `projects/gerenteagentes/migrations/` ao commit

Assim, schema e migrations nunca ficam dessincronizados.

### Bypass do hook (exceções)

```bash
git commit --no-verify -m "sua mensagem"
```

Use com responsabilidade — migrations fora de sincronia causam falhas no deploy.

### CI: validação de migrations

No CI (GitHub Actions), o workflow `.github/workflows/ci.yml` roda:

```bash
# dentro de projects/gerenteagentes/
npm run db:generate
# e depois, na raiz do repo:
git diff --exit-code projects/gerenteagentes/migrations/
```

Se houver divergência entre o `schema.ts` commitado e as migrations versionadas, o gate falha com a mensagem exata:

> Migrations desatualizadas. Rode npm run db:generate e commit as mudanças.

#### Como resolver falha por migrations desatualizadas

1. Rode localmente no diretório do projeto: `cd projects/gerenteagentes && npm run db:generate`
2. Commit as mudanças: `git add projects/gerenteagentes/migrations/ && git commit`
3. Push novamente

## Scripts

| Script | Descrição |
|--------|-----------|
| `npm run db:generate` (no diretório do projeto) | Gera migrations a partir do `schema.ts` (drizzle-kit; SQL + `_journal.json`) |
| `npm run db:generate:gerenteagentes` (na raiz do repo) | Equivalente ao anterior, executado da raiz do monorepo |

## Estrutura

```
projects/gerenteagentes/
  schema.ts          # Schema Drizzle (fonte única)
  drizzle.config.ts  # Configuração do drizzle-kit
  migrations/        # SQL versionado (auto-gerado)
    meta/_journal.json  # Registro de migrations (não editar manualmente)
```

## Consequências de ignorar o hook

- ❌ Deploy roda mas migrations não são aplicadas
- ❌ Erro silencioso: schema no código ≠ schema no banco
- ❌ Tarefa "zumbi" travada em `ready` (ver `MEMORY.md`)

**Regra de ouro:** Nunca commitar `schema.ts` sem rodar `db:generate` primeiro.
