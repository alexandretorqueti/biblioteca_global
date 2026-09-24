# Subtarefa 2: ProjectDbFactory com Conexões Customizadas — Implementação

## Resumo

Adaptada a `ProjectDbFactory` para suportar conexões MySQL customizadas por projeto, mantendo retrocompatibilidade com o comportamento padrão (env + `projeto_<id>`).

## Mudanças Implementadas

### 1. `apps/api/src/modules/crud/project-db.factory.ts`

**Mudanças:**
- Nova interface `OpcoesConexao` com host, port, user, password, database
- `ConectorProjeto` agora recebe `OpcoesConexao` completas (não apenas database)
- `criarConectorPadrao()` não depende mais de `EnvService` — recebe opções da factory
- `ProjectDbFactory` agora:
  - Injeta `CORE_DB` e `EnvService`
  - Busca config do projeto no core (`projetos.dbHost`, `dbPort`, `dbDatabase`, `dbUser`, `dbPasswordCriptografado`)
  - Resolve opções: customizadas (se config completa) ou padrão (env + `projeto_<id>`)
  - Descriptografa senha em memória com `decryptDbPassword()` (AES-256-GCM)
  - Cache com fingerprint — invalida quando config muda (ex.: rotação de senha)
  - Fecha conexão antiga antes de criar nova

**Segurança:**
- Senha descriptografada apenas em memória, nunca logada
- Fingerprint inclui senha CRIPTOGRAFADA (não a descriptografada)
- Logs de reconexão não expõem credenciais

### 2. `apps/api/src/modules/crud/crud.module.ts`

**Mudanças:**
- `criarConectorPadrao` não recebe mais `EnvService`
- `ProjectDbFactory` usa `useFactory` com injeção de `CONECTOR_PROJETO`, `CORE_DB`, `EnvService`
- Imports atualizados: `CoreDb`, `ConectorProjeto`

### 3. `apps/api/src/modules/crud/__tests__/project-db.factory.spec.ts` (novo)

**13 testes cobrindo:**
- **Fallback para padrão** (3 testes): projeto sem config, config parcial, projeto inexistente
- **Conexão customizada** (2 testes): config completa, senha descriptografada
- **Cache** (2 testes): mesma instância, projetos diferentes
- **Invalidação de cache** (3 testes): mudança de senha, mudança de host, remoção de config
- **Segurança** (1 teste): credenciais não aparecem em logs
- **Database derivado do id** (1 teste): padrão `projeto_<id>` sempre respeitado
- **criarConectorPadrao** (1 teste): não depende de env

### 4. `apps/api/src/modules/crud/__tests__/crud.service.spec.ts`

**Mudanças:**
- Removidos testes antigos da `ProjectDbFactory` (movidos para `project-db.factory.spec.ts`)
- Removidos imports não utilizados (`ConexaoProjeto`, `ConectorProjeto`)
- Comentário explicativo apontando para o novo arquivo de testes

## Critérios de Aceite

✅ **Projeto sem configuração usa MYSQL_* e projeto_<id>**
- Teste: "projeto sem config customizada usa credenciais do env e database projeto_<id>"

✅ **Projeto customizado usa host, porta, database, usuário e senha próprios**
- Teste: "projeto com config completa usa host/porta/database/user/senha próprios"

✅ **A seleção continua baseada no projeto do token**
- O `obter({ id })` recebe o id do token, não do payload do cliente
- Database é derivado do id (`nomeDatabaseDoProjeto(id)`) no fallback

✅ **Alterações de credenciais fecham e recriam a conexão em cache**
- Testes: "alteração de senha criptografada fecha conexão antiga e cria nova", "alteração de host fecha conexão antiga e cria nova", "remoção de config customizada volta para o padrão"
- Fingerprint compara config criptografada — qualquer mudança invalida o cache

✅ **AuthService e demais repositórios do core continuam usando CORE_DB**
- `ProjectDbFactory` usa `CORE_DB` apenas para buscar config do projeto
- `AuthService`, `usuarios`, `projetos`, `refreshTokens` continuam usando `CORE_DB` diretamente
- Nenhuma mudança nesses módulos

✅ **Credenciais não aparecem em logs**
- Teste: "nenhum log contém senha descriptografada ou criptografada"
- Logs de reconexão mencionam apenas o id do projeto, não credenciais
- Fingerprint (interno) inclui senha criptografada, mas não é logado

✅ **Há testes unitários para os cenários padrão e customizado**
- 13 testes novos em `project-db.factory.spec.ts`
- Todos os 231 testes da API passam

## Validação

```bash
# Typecheck
npx tsc --noEmit -p apps/api/tsconfig.json
# ✅ Sucesso (sem erros no código da API)

# Lint
npx eslint apps/api/src/modules/crud/project-db.factory.ts apps/api/src/modules/crud/crud.module.ts apps/api/src/modules/crud/__tests__/project-db.factory.spec.ts
# ✅ Sucesso (sem erros)

# Testes
npx vitest run apps/api/
# ✅ 231/231 testes passando (22 arquivos)
```

## Retrocompatibilidade

- Projetos sem config customizada funcionam exatamente como antes
- `nomeDatabaseDoProjeto(id)` continua sendo usado no fallback
- API pública da `ProjectDbFactory.obter({ id })` não mudou
- `ConectorProjeto` mudou de assinatura, mas é injetável (testes fake atualizados)

## Próximos Passos (fora do escopo desta subtarefa)

- Migration SQL para adicionar colunas `db_host`, `db_port`, `db_database`, `db_user`, `db_password_criptografado` na tabela `projetos` (se ainda não existir)
- UI para admin configurar credenciais por projeto
- Documentação no `MANUAL_DESENVOLVIMENTO.md` sobre como configurar conexão customizada
- Variável de ambiente `DB_CREDENTIALS_ENCRYPTION_KEY` no `.env` e no deploy
