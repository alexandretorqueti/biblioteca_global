# Subtarefa 3: Disponibilizar a configuração nos endpoints e na tela de projetos

## Resumo da Implementação

### O que foi implementado

#### 1. Ajuste do Provisionamento (`apps/api/src/modules/projetos/projetos.service.ts`)

**Problema:** Projetos com conexão MySQL customizada estavam recebendo provisionamento automático (CREATE DATABASE, migrations), o que é incorreto — o banco externo já existe e é gerenciado fora da plataforma.

**Solução:**
- `ProjetosService.criar()`: verifica se há `configDb` customizada e pula o provisionamento automático (CREATE DATABASE + migrations) quando presente
- `ProjetosService.garantirDatabaseProvisionado()`: verifica se o projeto tem conexão customizada e pula o provisionamento
- Logs identificáveis sem expor credenciais (apenas host/porta/database)

**Critérios de aceite atendidos:**
- ✅ Projetos customizados não recebem CREATE DATABASE, DROP DATABASE ou migrations automáticas
- ✅ Projetos padrão preservam o provisionamento atual
- ✅ Edições sem credenciais não alteram a configuração existente

#### 2. Contratos Compartilhados (`packages/shared/src/core.ts`)

**Mudança:** Adicionados campos opcionais na interface `Projeto`:
- `dbHost?: string | null`
- `dbPort?: number | null`
- `dbDatabase?: string | null`
- `dbUser?: string | null`
- `dbPasswordConfigurado?: boolean` (indicador, nunca a senha real)

**Critérios de aceite atendidos:**
- ✅ Contratos compartilhados atualizados para front/back
- ✅ Senha nunca exposta (apenas indicador booleano)

#### 3. Tela de Projetos (`projects/biblioteca-global/config.ts`)

**Mudança:** Adicionados campos na tela de edição de projetos:
- `dbHost` (text) — Host do MySQL customizado
- `dbPort` (number) — Porta do MySQL customizado
- `dbDatabase` (text) — Nome do database
- `dbUser` (text) — Usuário do MySQL
- `dbPassword` (text) — Senha (campo de escrita, nunca exibido após salvar)
- `dbPasswordCriptografado` adicionado em `hiddenColumns` (nunca exibido no grid)

**Critérios de aceite atendidos:**
- ✅ A tela permite informar, editar e remover a configuração
- ✅ A senha existente nunca é devolvida nem preenchida no formulário
- ✅ Campos com helperText explicativo

#### 4. Testes (`apps/api/src/modules/projetos/__tests__/projetos.service.spec.ts`)

**Testes adicionados (7 novos):**
1. `projeto com config customizada NÃO recebe provisionamento automático`
2. `configuração parcialmente preenchida é rejeitada`
3. `projeto sem config customizada recebe provisionamento normal`
4. `adiciona config customizada em projeto existente`
5. `remove config customizada ao enviar campo vazio`
6. `edição sem campos de conexão não altera config existente`
7. `atualiza apenas a senha quando enviada`

**Resultado:** ✅ 30/30 testes passando (21 no service + 9 no db-config)

### Validação

```bash
# Testes do módulo de projetos
npx vitest run apps/api/src/modules/projetos
# ✅ 30/30 testes passando

# Typecheck do biblioteca-global
npx tsc --noEmit -p projects/biblioteca-global
# ✅ Sucesso (sem erros)
```

### Critérios de Aceite

✅ **POST e PUT aceitam configuração customizada validada**
- `CreateProjetoDto` e `UpdateProjetoDto` já tinham os campos (subtarefa 1)
- `validarConfigDb()` valida completude (todos ou nenhum)
- Payloads parciais são rejeitados com `BadRequestException`

✅ **Payloads parciais são rejeitados antes da persistência**
- Validação no service antes de qualquer operação de banco
- Mensagem de erro clara com lista de campos faltantes

✅ **A tela permite informar, editar e remover a configuração**
- Campos adicionados ao config do biblioteca-global
- Enviar campo vazio remove a configuração (volta ao padrão)

✅ **A senha existente nunca é devolvida nem preenchida no formulário**
- `sanitizarProjetoPublico()` remove `dbPasswordCriptografado` e adiciona `dbPasswordConfigurado`
- Endpoint de detalhamento retorna apenas o indicador booleano
- Campo de senha é sempre de escrita (nunca preenchido com valor existente)

✅ **Projetos customizados não recebem CREATE DATABASE, DROP DATABASE ou migrations automáticas**
- `ProjetosService.criar()` pula provisionamento quando há `configDb`
- `ProjetosService.garantirDatabaseProvisionado()` pula quando há conexão customizada
- Logs identificáveis sem expor credenciais

✅ **Projetos padrão preservam o provisionamento atual**
- Projetos sem `configDb` seguem o fluxo normal (CREATE DATABASE + migrations)
- Nenhum comportamento mudou para projetos existentes

✅ **Edições sem credenciais não alteram a configuração existente**
- `ProjetosService.atualizar()` só altera campos de conexão se explicitamente enviados
- Campos não enviados preservam valores existentes
- Envio de campo vazio remove a configuração (volta ao padrão)

### Princípio Diretivo Atendido

> **Credenciais por projeto não são expostas em logs ou respostas de API** — Alexandre, 2026-09-24

✅ **Atendido:** 
- Logs mostram apenas host/porta/database (sem usuário/senha)
- Respostas da API retornam apenas `dbPasswordConfigurado: boolean`
- Senha criptografada (AES-256-GCM) nunca aparece em respostas públicas

### Arquivos Modificados

1. `apps/api/src/modules/projetos/projetos.service.ts` — ajuste do provisionamento
2. `packages/shared/src/core.ts` — contratos compartilhados
3. `projects/biblioteca-global/config.ts` — tela de projetos
4. `apps/api/src/modules/projetos/__tests__/projetos.service.spec.ts` — testes

### Próximos Passos (fora do escopo desta subtarefa)

- Integrar com `ProjectDbFactory` para usar as credenciais customizadas em runtime (subtarefa 4)
- Testes funcionais com banco externo real (subtarefa 5)
- Documentação de uso para projetos com conexão customizada (subtarefa 6)

## Conclusão

Subtarefa 3 concluída com sucesso. Todos os critérios de aceite foram atendidos e validados com testes unitários. O provisionamento agora respeita a presença de configuração customizada, os contratos compartilhados foram atualizados, a tela de projetos permite gerenciar a configuração, e a senha nunca é exposta em respostas da API.

::DONE::
