# PostDeployVerifier — Verificação Semântica Pós-Deploy

**Tarefa:** 971  
**Status:** Implementado  
**Data:** 2026-10-09

## Objetivo

Após cada deploy bem-sucedido, o Monitor verifica semanticamente o batch em produção e cria tarefas de correção se houver incongruência.

**Motivação:** Tarefas 964 e 960 passaram nos gates de teste mas não funcionavam corretamente em produção.

## Arquitetura

### Componentes

1. **PostDeployVerifier** (`src/monitor/PostDeployVerifier.ts`)
   - Consumidor assíncrono acionado por `DEPLOY_BATCH_SUCCEEDED`
   - Idempotente por `batch_id`
   - Nunca bloqueia o pipeline (falha = log + segue)
   - Sessão única do Monitor por lote

2. **PostDeployPromptResolver** (`src/monitor/PostDeployPromptResolver.ts`)
   - Resolve prompt gerenciado `monitor.verificacao_pos_deploy`
   - Contexto: tarefas, subtarefas, commits, test_runs, diagnósticos
   - Auditoria em `prompts_execucoes`

3. **PostDeployVerdictParser** (`src/monitor/PostDeployVerdictParser.ts`)
   - Parse de veredito estruturado: `CONSISTENTE | INCONGRUENTE | INCONCLUSIVO`
   - Findings por tarefa com descrição, evidência e severidade

4. **Primitiva `createTask`** (`src/primitives/db.ts`)
   - Cria tarefa de desenvolvimento pausada
   - External_id canônico
   - Evento `TASK_CREATED` com ator `monitor-pos-deploy`
   - Retomada via `TASK_RESUME_REQUESTED`

### Fluxo

```
DEPLOY_BATCH_SUCCEEDED
  ↓
PostDeployVerifier.handle()
  ↓
[Verifica flag motor.postdeploy_verification.active]
  ↓
[Idempotência: verifica motor_postdeploy_verifications]
  ↓
[Carrega contexto: tarefas, subtarefas, commits, test_runs, diagnósticos]
  ↓
[Resolve prompt monitor.verificacao_pos_deploy]
  ↓
[Executa missão com cadeia MONITOR]
  ↓
[Parse do veredito]
  ↓
[Aplica veredito]
  ├─ CONSISTENTE → registra auditoria
  ├─ INCONCLUSIVO → reagenda 1x, depois notifica humano
  └─ INCONGRUENTE → cria tarefas corretivas (anti-loop: máx 2 por origem)
```

## Persistência

### Tabela `motor_postdeploy_verifications`

```sql
CREATE TABLE motor_postdeploy_verifications (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  batch_id VARCHAR(255) NOT NULL UNIQUE,
  status ENUM('pending', 'consistent', 'incongruent', 'inconclusive', 'failed'),
  verdict_json LONGTEXT,
  retry_count INT UNSIGNED DEFAULT 0,
  created_at DATETIME,
  updated_at DATETIME
);
```

**Idempotência:** índice único em `batch_id` impede verificações duplicadas.

### Flag `motor.postdeploy_verification.active`

- **Default:** `true`
- **Independente** de `motor.monitor.active`
- **Seed:** migration `0081_postdeploy_verifications.sql`

## Contrato do Prompt

### Marcadores

- `**BATCHID**`: ID do batch
- `**TAREFAS**`: lista de tarefas com título, descrição, critérios, subtarefas
- `**COMMITS**`: commits do batch com diffstat
- `**TESTRUNS**`: test_runs do batch
- `**DIAGNOSTICOS**`: duração do deploy, erros registrados

### Veredito

```
VEREDITO: CONSISTENTE | INCONGRUENTE | INCONCLUSIVO

## Findings

### Tarefa: <task_id>
- Descrição: <o que está errado>
- Evidência: <sondagem empírica, logs, endpoints>
- Severidade: high | medium | low
```

## Anti-Loop

**Regra:** máximo de 2 correções por tarefa-origem.

**Implementação:**
```sql
SELECT COUNT(*) FROM tarefas
WHERE descricao LIKE '%Tarefa origem: <task_id>%'
  AND tipo = 'desenvolvimento'
```

**3ª incongruência:** notifica humano com histórico, não cria tarefa.

## Auditoria

### Eventos registrados

- `postdeploy_verification_finished`: execução do Monitor concluída
- `postdeploy_consistente`: batch consistente
- `postdeploy_inconclusivo_rescheduled`: reagendamento (INCONCLUSIVO)
- `postdeploy_inconclusivo_notified`: humano notificado após retries
- `postdeploy_correction_task_created`: tarefa corretiva criada
- `postdeploy_anti_loop_triggered`: limite de correções atingido
- `postdeploy_verification_failed`: falha do verificador

### Operation Log

- `received`: verificação iniciada
- `decision` / `skipped`: flag off, já verificado, in-flight
- `completed`: verificação concluída
- `failed`: falha do verificador

## Configuração

### Variáveis de ambiente

- `MOTOR_POSTDEPLOY_TIMEOUT_MS`: timeout da sessão do Monitor (default: 900000 = 15 min)
- `MOTOR_POSTDEPLOY_MAX_RETRIES`: retries para INCONCLUSIVO (default: 1)
- `MOTOR_POSTDEPLOY_MAX_CORRECTIONS`: máx correções por tarefa (default: 2)

### Desativar verificação

```sql
UPDATE motor_configuracoes
SET valor = 'false'
WHERE chave = 'motor.postdeploy_verification.active';
```

## Testes

Cobertura completa em `test/postdeploy-verifier.test.ts` e `test/postdeploy-verdict-parser.test.ts`:

- Disparo único e idempotência
- CONSISTENTE: apenas registra
- INCONGRUENTE: cria tarefa + notifica
- Anti-loop: máx 2 correções por origem
- INCONCLUSIVO: reagenda 1x, depois notifica
- Flag false: desliga sem efeitos
- Falha não bloqueante: pipeline segue

## Restrições

- **Somente leitura:** verificador não altera dados em produção
- **Não bloqueia pipeline:** falha do verificador = log + segue
- **Não altera fluxo de swap:** deploy continua igual
- **Sem compose/credenciais:** não toca em infraestrutura

## Migrations

1. `0081_postdeploy_verifications.sql`: tabela + flag
2. `0082_postdeploy_verification_prompt.sql`: prompt gerenciado

## Referências

- Tarefa 971 (Motor)
- Tarefas 964 e 960 (motivação: passaram nos gates mas não funcionavam)
- `docs/MONITOR-RESOLVEDOR-DE-BLOQUEIOS.md` (padrão do MonitorResolutionConsumer)
- `docs/DEPLOY-AGRUPADO-MOTOR-OCIOSO.md` (fluxo de deploy)
