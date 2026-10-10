# Implementação: Validação de Monotonicidade do Journal de Migrations

## Subtarefa 2: Bloquear journals de migrations não monotônicos no pre_deploy

### Resumo

Implementada validação que garante que o campo `when` de cada entrada do `meta/_journal.json` seja estritamente maior que o da entrada anterior, prevenindo o skip silencioso de migrations pelo Drizzle.

### Arquivos Modificados

1. **`src/migrations/MigrationJournalIntegrity.ts`**
   - Adicionado `MigrationJournalMonotonicityViolation` interface
   - Adicionado `MigrationJournalMonotonicityError` classe com mensagem clara em português
   - Atualizado `MigrationJournalInspection` para incluir `monotonicityViolations`
   - Atualizado `inspectProjectMigrationJournal` para validar monotonicidade
   - Atualizado `assertAddedMigrationsHaveJournalEntries` para lançar `MigrationJournalMonotonicityError`
   - Atualizado `warnOnMigrationJournalIntegrity` para logar violações de monotonicidade
   - Atualizado `isJournal` type guard para incluir campo `when`
   - Adicionado `validateMonotonicity` função auxiliar

2. **`test/migration-journal-integrity.test.ts`**
   - Adicionado teste: "bloqueia journal com when não monotônico (menor ou igual ao anterior)"
   - Adicionado teste: "bloqueia journal com when igual ao anterior"
   - Adicionado teste: "gate reprova journal não monotônico adicionado desde o commit-base"
   - Atualizado testes existentes para incluir `monotonicityViolations` nas asserções
   - Atualizado fixture para suportar campo `whens` opcional

### Critérios de Aceite — Validação

✅ **Um journal com when menor ou igual ao da entrada anterior é considerado inválido**
- Teste: "bloqueia journal com when não monotônico (menor ou igual ao anterior)"
- Teste: "bloqueia journal com when igual ao anterior"
- Implementação: `validateMonotonicity()` verifica `current.when <= previous.when`

✅ **Um journal com valores when estritamente crescentes é aceito**
- Teste: "bloqueia journal com when não monotônico" (caso monotonic passa sem violações)
- Implementação: retorna array vazio quando todos os valores são crescentes

✅ **O gate pre_deploy falha antes da autorização do deploy quando encontra violação monotônica no checkout candidato**
- Integração: `GitVerificationIntegrator.verifyAndIntegrate()` chama `assertAddedMigrationsHaveJournalEntries()`
- Teste: "gate reprova journal não monotônico adicionado desde o commit-base"
- Fluxo: validação ocorre antes do commit técnico e da integração

✅ **A mensagem de falha é clara, em português, identifica a entrada ou tag, mostra o when anterior e o atual e orienta usar o valor anterior+1000**
- Exemplo de mensagem:
  ```
  Journal de migrations com valores "when" não monotônicos (devem ser estritamente crescentes):
  - projects/alpha/migrations/meta/_journal.json: entrada 2 (tag "0003_new") tem when=1500, mas a entrada anterior (tag "0002_ok") tem when=2000. Orientação: use when=3000 ou superior.
  Corrija os timestamps do journal antes de concluir a entrega.
  ```

✅ **A verificação existente de migrations SQL adicionadas sem tag correspondente continua funcionando**
- Teste: "exige correspondência exata entre nome SQL e tag" (passa)
- Teste: "no gate só reprova SQL adicionado desde o commit-base" (passa)
- Implementação: `orphaned` continua sendo verificado antes de `monotonicityViolations`

✅ **Ausência, JSON inválido e estrutura inválida do journal mantêm tratamento explícito**
- Teste: "reconhece migration registrada e deixa explícito journal inválido ou ausente"
- Implementação: retorna `monotonicityViolations: []` quando journal está ausente/inválido

✅ **Os testes de MigrationJournalIntegrity incluem fixtures monotônica e não monotônica, e o teste de integração do gate comprova o bloqueio**
- 7 testes no total (todos passando)
- Fixtures: monotonic (3 entradas crescentes), non_monotonic (1000, 2000, 1500), equal (1000, 1000)
- Teste de integração: "gate reprova journal não monotônico adicionado desde o commit-base"

✅ **Nenhuma migration SQL já aplicada nem o journal histórico vigente é reescrito como parte da implementação**
- Nenhuma alteração em arquivos de migration existentes
- Validação é read-only (apenas lê o journal)

✅ **Build, typecheck e suíte existente aplicável ao motor-v3 permanecem verdes**
- Typecheck: `npm run typecheck` → passa
- Build: `npm run build` → passa
- Testes: 542 testes passando (incluindo 7 novos/atualizados)

### Integração com o Pipeline

A validação de monotonicidade é integrada ao pipeline de deploy através de:

1. **Execução da subtarefa** → `SubtaskExecutionConsumer` chama `GitVerificationIntegrator.verifyAndIntegrate()`
2. **Verificação de integridade** → `verifyAndIntegrate()` chama `assertAddedMigrationsHaveJournalEntries()`
3. **Validação diferencial** → apenas migrations adicionadas desde o commit-base são verificadas
4. **Falha do gate** → se violação encontrada, lança `MigrationJournalMonotonicityError` e bloqueia a integração
5. **Deploy bloqueado** → tarefa não transiciona para 'delivered', deploy não é enfileirado

### Mensagem de Erro

A mensagem de erro segue o padrão:
- Identifica o projeto e o arquivo do journal
- Mostra o índice da entrada problemática
- Mostra a tag da entrada atual e da anterior
- Mostra os valores `when` atual e anterior
- Orienta usar `anterior + 1000` ou superior
- Texto em português brasileiro

Exemplo real (do teste):
```
Journal de migrations com valores "when" não monotônicos (devem ser estritamente crescentes):
- projects/alpha/migrations/meta/_journal.json: entrada 2 (tag "0003_new") tem when=1500, mas a entrada anterior (tag "0002_ok") tem when=2000. Orientação: use when=3000 ou superior.
Corrija os timestamps do journal antes de concluir a entrega.
```

### Prevenção do Incidente de 2026-10-09

Esta implementação previne o incidente registrado em 2026-10-09 onde:
- Migrations 0082 e 0083 foram consideradas aplicadas sem nunca rodar
- Causa: timestamp `when` reaproveitado ao resolver conflito de merge
- Resultado: Drizzle pulou silenciosamente as migrations
- Consequência: tabelas/flags não criadas, deploy falhou

Agora, qualquer tentativa de adicionar uma migration com `when` menor ou igual ao anterior será bloqueada antes da integração, com mensagem clara orientando o desenvolvedor a usar um timestamp correto.

### Notas de Implementação

- A validação é diferencial: só verifica migrations adicionadas desde o commit-base
- Journals históricos com violações preexistentes não bloqueiam novas entregas (apenas warning no boot)
- A ordem de verificação é: (1) migrations órfãs, (2) monotonicidade
- Ambas as verificações lançam erros distintos para facilitar o diagnóstico
- O campo `when` é validado como `number` no type guard `isJournal`
