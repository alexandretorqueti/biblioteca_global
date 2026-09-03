# ADR: Smoke Test Funcional Obrigatório no Setup de Projeto Novo

- **Status:** aplicado (2026-09-03)
- **Contexto:** lições do TaQui (caso de teste do motor)

## Problema

O setup do projeto TaQui fechou como concluído mas os endpoints CRUD não respondiam.
O motor não tinha como verificar funcionalidade real — confiava apenas no relato do agente.

## Princípio diretivo (Alexandre 2026-09-03)

> Sempre que houver decisão ou proibição, ela deve ser CONTROLADA PELO MOTOR (código/gate),
> não apenas escrita no prompt do agente. Prompt orienta; código obriga.

## Decisão

Implementar smoke test funcional obrigatório como controle de código no motor:

### 1. Subtarefa obrigatória no plano de setup

- A missão de setup (`montarMissaoSetup` em `gerenteagentes.service.ts`) inclui o PASSO 4
  (smoke test funcional) com instruções explícitas de como executar e formatar a evidência.
- O prompt do analista (`buildAnalystPrompt` em `TaskWorker.ts`) instrui o analista a SEMPRE
  incluir a subtarefa de smoke test como última do plano.
- **Controle de código:** se o analista não incluir a subtarefa de smoke test, o motor
  a injeta automaticamente (`generateSmokeTestSubtask` em `SetupSmokeTest.ts`).

### 2. Evidência funcional no gate

- O agente deve gravar no resultado da subtarefa um JSON com a evidência:
  ```json
  {
    "smoke_test": {
      "url": "http://localhost:3000/api/<slug>/",
      "method": "GET",
      "status": 200,
      "response_body": "...",
      "timestamp": "2026-09-03T..."
    }
  }
  ```
- O gate (`phaseVerify` em `TaskWorker.ts`) valida a evidência antes de marcar como verified:
  - Resultado vazio → reprova
  - Sem campo `smoke_test` → reprova
  - Status não-2xx → reprova
  - URL não aponta para o projeto novo → reprova
- Sem evidência válida, a subtarefa é rejeitada e o setup NÃO fecha como concluído.

### 3. Módulo `SetupSmokeTest.ts`

Localização: `motor-v2/src/policies/SetupSmokeTest.ts`

Funções exportadas:
- `isSetupTask(title, description)` — detecta tarefa de setup
- `isSmokeTestSubtask(title)` — detecta subtarefa de smoke test
- `extractSmokeTestEvidence(resultContent)` — extrai e valida evidência do resultado
- `validateSmokeTestGate(subtaskTitle, resultContent, projectSlug)` — validação completa no gate
- `generateSmokeTestSubtask(seq)` — gera subtarefa padrão para injeção no plano
- `planHasSmokeTest(subtasks)` — verifica se o plano já inclui smoke test
- `executeSmokeTest(config)` — executa smoke test real (HTTP) pelo motor

### 4. Testes

Localização: `motor-v2/test/SetupSmokeTest.test.ts`

24 testes cobrindo:
- Detecção de tarefa de setup
- Detecção de subtarefa de smoke test
- Extração de evidência válida
- Reprovação sem evidência
- Reprovação com status não-2xx
- Reprovação com URL fora do projeto
- Aprovação com evidência válida
- Geração de subtarefa padrão
- Detecção de smoke test no plano

## Fluxo completo

```
Tarefa de setup criada
  → Motor detecta isSetupTask(title)
  → Analista gera plano de subtarefas
  → Motor verifica planHasSmokeTest(subtasks)
  → Se ausente: motor injeta generateSmokeTestSubtask(seq)
  → Subtarefas executam em sequência
  → Última subtarefa = smoke test
  → Agente executa curl, grava evidência no resultado
  → Gate (phaseVerify) chama validateSmokeTestGate()
  → Evidência válida → subtarefa verified → setup concluído
  → Evidência inválida/ausente → subtarefa rejected → rework/escala
```

## Arquivos alterados

- `motor-v2/src/policies/SetupSmokeTest.ts` (novo) — módulo do smoke test
- `motor-v2/test/SetupSmokeTest.test.ts` (novo) — 24 testes
- `motor-v2/src/workers/TaskWorker.ts` — integração: injeção no plano + validação no gate + prompt do analista
- `api/gerenteagentes.service.ts` — missão de setup com PASSO 4 (smoke test)
