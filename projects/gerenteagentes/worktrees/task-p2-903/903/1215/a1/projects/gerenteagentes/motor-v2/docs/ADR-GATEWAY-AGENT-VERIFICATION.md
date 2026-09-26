# ADR: Verificação do Agente no Gateway Antes de Enfileirar

- **Status:** aplicado (2026-09-03)
- **Contexto:** lições do TaQui (caso de teste do motor)

## Problema

O motor enfileirava tarefas para agentes que nunca foram registrados no gateway OpenClaw,
resultando em erro "Unknown agent id" sem diagnóstico útil. O agente só descobria o
problema quando a tarefa já estava em execução e falhava ao tentar criar a sessão.

## Princípio diretivo (Alexandre 2026-09-03)

> Sempre que houver decisão ou proibição, ela deve ser CONTROLADA PELO MOTOR
> (código/gate), não apenas escrita no prompt do agente. Prompt orienta; código obriga.

## Decisão

Implementar verificação obrigatória do agente no gateway como controle de código no motor:

### 1. Política `GatewayAgentVerificationPolicy`

Localização: `motor-v2/src/policies/GatewayAgentVerificationPolicy.ts`

Funções exportadas:
- `verifyAgentInGateway(agentId, driver)` — verifica se o agente existe no gateway
  via Console API (endpoint `/api/agents`)
- `formatAgentVerificationReport(result)` — formata relatório para log/erro
- `shouldBlockEnqueue(result)` — retorna true se o enqueue deve ser bloqueado

Resultados possíveis:
- `ok: true` — agente confirmado no gateway (com workspace quando disponível)
- `ok: false, failureKind: 'agent_id_empty'` — agentId vazio/nulo
- `ok: false, failureKind: 'agent_not_found'` — agente não registrado no gateway
  (inclui lista de agentes disponíveis e comando de registro)
- `ok: false, failureKind: 'gateway_unreachable'` — erro de rede (ECONNREFUSED, timeout)
- `ok: false, failureKind: 'gateway_error'` — erro HTTP (401, 500, etc.)

### 2. Método `listAgents()` no ConsoleAgentRuntimeDriver

Localização: `motor-v2/src/runtime/ConsoleAgentRuntimeDriver.ts`

Diferente de `getAgentWorkspace()` (que engole erros), `listAgents()` propaga erros
para que o chamador possa distinguir entre "agente não existe" e "gateway fora do ar".

### 3. Integração no TaskCoordinator.enqueueTask()

Localização: `motor-v2/src/coordinator/TaskCoordinator.ts`

Antes de enfileirar tarefa de execução (não setup), o coordenador:
1. Chama `verifyAgentBeforeEnqueue(agentId)` 
2. Se `shouldBlockEnqueue(result)` for true:
   - Persiste bloqueio auditável na tabela `bloqueios`
   - Lança erro com relatório formatado (causa clara)
   - NUNCA prossegue para o enqueue
3. Se ok: loga confirmação e prossegue

Exceção: tarefas de setup (taskType='setup') não precisam dessa verificação porque
são executadas pelo agente da biblioteca, não pelo agente do projeto novo.

### 4. Método privado `verifyAgentBeforeEnqueue()`

Adaptador entre o `ConsoleAgentRuntimeDriver` e a política. Se `OPENCLAW_CONSOLE_URL`
ou `OPENCLAW_CONSOLE_TOKEN` não estiverem configurados, retorna ok=true com aviso
(modo desenvolvimento). Em produção, essas variáveis são obrigatórias.

### 5. Testes

Localização: `motor-v2/test/GatewayAgentVerificationPolicy.test.ts`

21 testes cobrindo:
- Agente presente (com workspace, sem workspace, trim de spaces)
- Agente ausente (não encontrado, lista vazia, agentId vazio/nulo/undefined/só espaços)
- Erro de consulta (ECONNREFUSED, ETIMEDOUT, HTTP 401, erro genérico)
- formatAgentVerificationReport (sucesso com/sem workspace, erro com/sem failureKind)
- shouldBlockEnqueue (todos os cenários de bloqueio)

4 testes adicionais em `ConsoleAgentRuntimeDriver.test.ts`:
- listAgents retorna lista de agentes
- listAgents retorna lista vazia
- listAgents propaga erro HTTP 401
- listAgents propaga erro de rede

## Fluxo completo

```
POST /api/motor/task/:id/enqueue
  → MotorAPI.handleEnqueueTask()
  → TaskCoordinator.enqueueTask(taskId)
  → Validação de projeto_id (ProjectIdValidationPolicy)
  → Verificação de agente (GatewayAgentVerificationPolicy)
    → verifyAgentBeforeEnqueue(agentId)
      → ConsoleAgentRuntimeDriver.listAgents()
      → verifyAgentInGateway(agentId, adapter)
    → Agente encontrado? → enqueue prossegue
    → Agente ausente? → bloqueio auditável + erro claro
  → Task salva como 'ready'
  → pump() inicia execução
```

## Diagnóstico para o usuário

Quando o enqueue é bloqueado, o erro inclui:
- ID do agente que não foi encontrado
- Lista de agentes disponíveis no gateway (quando houver)
- Comando exato para registrar o agente: `openclaw agents add <id> --workspace <pasta> --model <modelo> --non-interactive`

Exemplo:
```
❌ Verificação do agente falhou [agent_not_found]: Agente "taqui" não encontrado no
gateway OpenClaw. Agentes disponíveis no gateway: programa-senior, biblioteca-global.
Registre o agente com: openclaw agents add taqui --workspace <pasta> --model <modelo>
--non-interactive
```

## Arquivos alterados

- `motor-v2/src/policies/GatewayAgentVerificationPolicy.ts` (novo) — política de verificação
- `motor-v2/test/GatewayAgentVerificationPolicy.test.ts` (novo) — 21 testes
- `motor-v2/src/runtime/ConsoleAgentRuntimeDriver.ts` — método `listAgents()` adicionado
- `motor-v2/test/ConsoleAgentRuntimeDriver.test.ts` — 4 testes para `listAgents()`
- `motor-v2/src/coordinator/TaskCoordinator.ts` — integração no `enqueueTask()` + método privado `verifyAgentBeforeEnqueue()`
