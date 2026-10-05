# Validação da Migration 0004 — Legado Mirror

## Contexto

O commit `feb963bc` (2025-09-25) renomeou tabelas e adicionou colunas em `schema.ts` para espelhar o banco legado `bdportalemp`, mas nenhuma migration foi gerada. Isso causou falha em todas as telas do sistema administrativo porque o DynamicSchemaRegistry da API carrega o schema novo enquanto o banco `projeto_6241` ainda tem o schema antigo.

## Delta Identificado

### Tabelas Renomeadas
1. `circulares` → `circular`
2. `contatos_site` → `api_contatosite_contatos`

### Colunas Adicionadas/Modificadas

**usuarios:**
- + `senha` (varchar 255)
- + `primeiro_acesso` (boolean default true)
- ~ `nome`: varchar(200) NOT NULL → varchar(100) nullable
- ~ `email`: varchar(200) NOT NULL UNIQUE → varchar(150) NOT NULL
- ~ `papel`: enum('admin','usuario') → varchar(50)
- - `created_at`, `updated_at`
- - UNIQUE constraint em `email`

**clientes:**
- + `usuario` (varchar 50)
- + `data` (timestamp)
- + `data_edicao` (timestamp)
- - `administrador_id` (e FK associada)
- - `created_at`, `updated_at`
- ~ Vários campos NOT NULL → nullable
- ~ Vários varchar reduzidos (200→100, 300→100, etc.)

**responsaveis:**
- + `cpf`, `logradouro`, `numero`, `complemento`, `bairro`, `cidade`, `uf`, `cep`, `ramal`, `data`
- - `created_at`, `updated_at`
- ~ `cliente_id`, `nome`: NOT NULL → nullable
- ~ Vários varchar reduzidos

**contratos:**
- ~ `numero` → `numerocontrato` (rename)
- + `linkcontrato` (varchar 255)
- + `data` (timestamp)
- - `created_at`, `updated_at`
- ~ `cliente_id`: NOT NULL → nullable
- ~ FK recriada após rename de coluna

**circular (ex-circulares):**
- + `autor` (varchar 100)
- + `ativo` (boolean default true)
- - `created_at`, `updated_at`

**api_contatosite_contatos (ex-contatos_site):**
- + `site_id` (bigint NOT NULL)
- + `ip`, `user_agent`, `origem`
- ~ `assunto`: adicionado DEFAULT ''
- ~ Vários varchar reduzidos

**departamentos:**
- ~ `nome`: varchar(50) → varchar(100)

**config_empresa:**
- - `created_at`, `updated_at`
- ~ Vários varchar reduzidos

## Arquivos Gerados

1. **`migrations/0004_legado_mirror.sql`** — SQL da migration com todos os ALTER/RENAME statements
2. **`migrations/meta/0004_snapshot.json`** — Snapshot do schema após a migration
3. **`migrations/meta/_journal.json`** — Atualizado com entrada para 0004
4. **`apply-migration.js`** — Script Node.js para aplicar a migration

## Como Aplicar

### Opção 1: Script Node.js (recomendado)

```bash
cd projects/sistema-adm-global
export MYSQL_ROOT_PASSWORD=<senha_real>
node apply-migration.js
```

### Opção 2: Via API (provisionamento idempotente)

A API possui o método `garantirDatabaseProvisionado(projetoId, slug)` que aplica migrations pendentes automaticamente. Pode ser chamado via endpoint de provisionamento ou diretamente pelo service.

### Opção 3: Manual (mysql CLI)

```bash
mysql -h host.docker.internal -P 3308 -u root -p projeto_6241 < migrations/0004_legado_mirror.sql

# Registrar em __drizzle_migrations:
mysql -h host.docker.internal -P 3308 -u root -p projeto_6241 -e "INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES ('manual_apply_$(date +%s)', $(date +%s), '0004_legado_mirror.sql');"
```

## Validação Pós-Aplicação

### 1. Verificar tabelas renomeadas
```sql
SHOW TABLES LIKE 'circular';
SHOW TABLES LIKE 'api_contatosite_contatos';
SHOW TABLES LIKE 'circulares';  -- NÃO deve existir
SHOW TABLES LIKE 'contatos_site';  -- NÃO deve existir
```

### 2. Verificar colunas novas
```sql
DESCRIBE usuarios;  -- deve ter senha, primeiro_acesso
DESCRIBE clientes;  -- deve ter usuario, data, data_edicao
DESCRIBE contratos;  -- deve ter numerocontrato, linkcontrato
```

### 3. Verificar migration registrada
```sql
SELECT * FROM __drizzle_migrations WHERE name LIKE '0004%';
```

### 4. Testar endpoints CRUD
```bash
# Auth
curl -X POST http://localhost:3003/api/auth/login -H "Content-Type: application/json" -d '{"email":"...","code":"..."}'

# Listar clientes
curl http://localhost:3003/api/crud/sistema-adm-global/clientes/list -H "Authorization: Bearer <token>"

# Listar circulares
curl http://localhost:3003/api/crud/sistema-adm-global/circular/list -H "Authorization: Bearer <token>"

# Listar contatos do site
curl http://localhost:3003/api/crud/sistema-adm-global/api_contatosite_contatos/list -H "Authorization: Bearer <token>"
```

### 5. Testar telas no frontend
- Dashboard (circulares)
- Clientes
- Contatos do Site
- Circulares
- Usuários
- Empresa
- Departamentos

## Preservação de Dados

A migration usa `RENAME TABLE` (não DROP/CREATE), preservando todos os dados existentes. Colunas novas são adicionadas com valores NULL ou DEFAULT, não destruindo dados migrados do legado.

## Rollback (se necessário)

```sql
-- Reverter renomes
RENAME TABLE `circular` TO `circulares`;
RENAME TABLE `api_contatosite_contatos` TO `contatos_site`;

-- Remover colunas novas (cuidado: perde dados)
ALTER TABLE `usuarios` DROP COLUMN `senha`, DROP COLUMN `primeiro_acesso`;
-- ... demais reversões
```

**Nota:** Rollback não é recomendado pois o schema.ts já está usando os nomes novos. Reverter a migration quebraria a API.

## Status

- [x] Migration SQL gerada
- [x] Snapshot gerado
- [x] Journal atualizado
- [x] Script de aplicação criado
- [ ] Migration aplicada ao banco (requer acesso ao banco)
- [ ] Validação pós-aplicação (requer API rodando)

## Próximos Passos

1. Aplicar a migration usando um dos métodos acima
2. Validar que todas as tabelas/colunas existem conforme esperado
3. Testar endpoints CRUD de todos os módulos
4. Testar carregamento de todas as telas no frontend
5. Registrar resultado nos critérios de aceite da tarefa
