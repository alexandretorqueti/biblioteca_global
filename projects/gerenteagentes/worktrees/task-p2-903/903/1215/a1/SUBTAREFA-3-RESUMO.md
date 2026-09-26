# Resumo da Implementação — Subtarefa #3: Gate VERIFY

## O que foi implementado

### 1. ConfigLintPolicy (`src/policies/ConfigLintPolicy.ts`)

Política do motor-v2 que valida o `config.ts` do projeto novo na fase VERIFY do gate.

**Funcionalidades:**

- **Lint de FK number sem multipleChoice:** detecta campos com nome que sugere FK (terminam em `Id` ou `_id`) declarados como `type: "number"` sem `multipleChoice` → reprova com diagnóstico claro e sugestão de correção.

- **Validação de componentId de telas custom:** extrai todos os `componentId` de telas com `kind: "custom"` e verifica se existe arquivo de implementação correspondente em `projects/<slug>/screens/` → reprova se não existir.

- **Validação de completude de actions:** extrai todos os `rowActions` e `actions` com endpoints e verifica se existe implementação correspondente no código → reprova se não existir.

- **Formatação de relatório:** gera relatório legível com lista de pendências e sugestões de correção.

**Funções exportadas:**

```typescript
lintFkNumberWithoutMultipleChoice(configContent: string): ConfigLintIssue[]
extractCustomScreenComponentIds(configContent: string): Array<{ componentId: string; path: string }>
extractActions(configContent: string): Array<{ actionId: string; method: string; actionPath: string; configPath: string }>
hasCustomScreenImplementation(projectPath: string, projectSlug: string, componentId: string): boolean
hasActionImplementation(projectPath: string, actionPath: string): boolean
readProjectConfig(projectPath: string, projectSlug: string): string | null
lintConfig(configContent: string): ConfigLintResult
validateCompleteness(projectPath: string, projectSlug: string, configContent: string): CompletenessResult
validateProjectConfig(projectPath: string, projectSlug: string): ConfigValidationResult
formatConfigValidationReport(result: ConfigValidationResult): string
```

### 2. Testes (`test/ConfigLintPolicy.test.ts`)

34 testes cobrindo todas as regras de lint e validação de completude:

- Detecção de FK number sem multipleChoice (7 testes)
- Extração de componentIds de telas custom (4 testes)
- Extração de actions/rowActions (3 testes)
- Verificação de implementação de telas custom (4 testes)
- Verificação de implementação de actions (2 testes)
- Lint completo (3 testes)
- Validação de completude (4 testes)
- Validação completa do projeto (2 testes)
- Formatação de relatório (3 testes)
- Leitura de config (2 testes)

**Resultado:** ✅ 34/34 testes passando

### 3. Documentação (`docs/ADR-CONFIG-LINT-POLICY.md`)

ADR (Architecture Decision Record) documentando:

- Decisão e motivação (lições do TaQui)
- Implementação (funções, regras, integração)
- Testes (cobertura)
- Consequências (positivas e negativas)
- Referências

### 4. Export no index (`src/policies/index.ts`)

Adicionado export do `ConfigLintPolicy` para uso por outros módulos.

## Validação

```bash
# Build
npm run build
# ✅ Sucesso (tsc limpo)

# Testes
npm run test -- --run
# ✅ 294/294 testes passando (30 arquivos de teste)
```

## Critérios de aceite

✅ **FK number sem multipleChoice e componentId não registrado reprovam com diagnóstico claro**
- Implementado em `lintFkNumberWithoutMultipleChoice()` e `validateCompleteness()`
- Mensagens de erro claras com sugestões de correção

✅ **Declarações do config sem implementação correspondente reprovam o gate com lista de pendências**
- Implementado em `validateCompleteness()`
- Relatório formatado lista todas as pendências

✅ **Vitest cobre cada regra de lint e de completude**
- 34 testes cobrindo todas as regras
- Todos passando

## Princípio diretivo atendido

> **Sempre que houver decisão ou proibição, ela deve ser CONTROLADA PELO MOTOR (código/gate), não apenas escrita no prompt do agente.** Prompt orienta; código obriga. — Alexandre, 2026-09-03

✅ **Atendido:** o `ConfigLintPolicy` é executado pelo motor na fase VERIFY, reprova automaticamente config.ts com problemas, independente do agente seguir ou não as orientações do prompt.

## Próximos passos (fora do escopo desta subtarefa)

- Integrar o `ConfigLintPolicy` na fase VERIFY do `TaskWorker` (subtarefa de integração)
- Adicionar validação de `projeto_id` (subtarefa #7)
- Implementar promoção manual sem código (subtarefa #5)
- Verificação de agente no gateway (subtarefa #6)
