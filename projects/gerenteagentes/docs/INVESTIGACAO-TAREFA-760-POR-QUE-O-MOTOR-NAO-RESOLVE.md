# Investigação: por que a tarefa 760 travou no motor (e foi resolvida em minutos no atendimento interativo)

**Data:** 2026-09-04
**Origem:** pergunta do Alexandre — "quando a tarefa é enviada ao agente pelo motor, ele parece não saber de nada".
**Caso concreto:** tarefa 760 ("Corrigir criação de tarefas pela tela de Projetos"), blocked após 7 entregas (4 na subtarefa 796 + 3 na correção 806). O mesmo problema foi diagnosticado e corrigido em minutos no atendimento interativo (commit `8c4cfe9`).

## Resumo executivo

O agente do motor NÃO é "burro" nem desprovido de arquivos — ele roda como sessão do agente real (com o workspace e a memória dele). O que trava é o **fluxo**:

1. O **briefing veio com diagnóstico errado** (o analista apontou para um bug que já estava corrigido no código).
2. O **gate era impossível**: o teste escopado (`crud.functional.spec.ts`) está obsoleto (auth mudou para passwordless; o teste faz login com usuário/senha seed) e falha em QUALQUER workspace — inclusive intocado.
3. O **baseline que deveria pegar isso exclui specs funcionais de propósito** (decisão de 2026-08-31, tarefa 731), mas o **gate escopado as reinclui** quando a subtarefa toca o código coberto. Contradição entre as duas políticas.
4. O **classificador de falhas de gate estava quebrado** (bug `model not allowed: alibaba/[object Object]`) — justamente o componente que deveria dizer "isso é teste obsoleto, pare de queimar modelos".
5. **Cada entrega nasce sem memória da anterior** (sessão nova; só o output bruto do gate vai como feedback), então o agente redescobre tudo do zero, 7 vezes.

## Cadeia causal detalhada

### 1. Briefing com premissa errada

Descrição da tarefa 760 (criada pelo analista):

> "Após converter as chaves para o formato do Drizzle, CrudService.criar lê `valores.projeto_id`, mas o valor está em `valores.projetoId`. Corrigir a validação..."

Esse bug **já estava corrigido** no código quando a tarefa executou: `crud.service.ts` lê `(parse.data).projeto_id` com comentário explicando exatamente isso (o corpo validado usa snake_case; `valores` usa camelCase). A causa real era outra: `assertSemProjetoId` no `packages/api-client/src/http.ts` bloqueava `projetoId` (camelCase) no body — o front precisava enviar `projeto_id`.

O worker recebeu a premissa errada como "Descrição da missão" (autoritativa) e tentou consertar código que não estava quebrado. O protocolo do worker (`done|need_help|blocked_environment`) não tem saída para "a premissa do briefing está errada — evidências anexas".

### 2. Gate impossível: teste funcional obsoleto

O gate escopado rodou:

```
npm run test -- apps/api/src/modules/crud/__tests__/crud.functional.spec.ts ...crud.service.spec.ts
```

`crud.functional.spec.ts` é teste de integração de ambiente real: sobe o NestJS, conecta no MySQL e faz `POST /api/auth/login` com usuário `alexandre` + senha hardcoded (`Bo4MfU29r0GPi1`). A auth da plataforma migrou para **passwordless** (código por e-mail) — o teste ficou obsoleto e retorna **401 no login em qualquer workspace**:

```
AssertionError: expected 401 to be 201
  ? login crud.functional.spec.ts:108
```

Nenhuma entrega do agente poderia deixar esse gate verde. (Corrigido em 2026-09-04: teste removido, commit `8c4cfe9`.)

### 3. Contradição BaselinePolicy × GateScopePolicy

- `BaselinePolicy` (2026-08-31) **exclui** `**/*.functional.spec.ts` do baseline porque "specs funcionais usam MySQL real + estado de seed e não são confiáveis como gate automático" (caso da tarefa 731).
- `GateScopePolicy` usa regra de diretório: subtarefa tocou `crud.service.ts` → todos os testes de `crud/__tests__/` são "afetados" → o teste funcional **volta ao gate**.

Resultado: baseline verde (por exclusão) + gate escopado vermelho (por reinclusão) = o motor gastou 4 entregas + escada de modelos num gate que nunca fecharia.

### 4. Classificador de falhas quebrado (`alibaba/[object Object]`)

Evidência nos logs da tarefa 762/760:

```
[GateFailureClassifier] Classificando falha de gate com modelo [object Object] (degrau 0)
[GateFailureClassifier] Falha ao classificar com modelo [object Object]: model not allowed: alibaba/[object Object]
[GateFailureClassifier] Classificador indisponível
```

Causa em `GateFailureClassifier.resolveChain()`: a query usa **LEFT JOIN** com `projeto_model_chain` (fase `monitor`). Quando o projeto não tem cadeia de monitor, o LEFT JOIN devolve 1 linha com `modelo = NULL`; o código faz `rows.map((r) => String(r.modelo ?? r))` → `"[object Object]"` em vez de cair no fallback (`openai/gpt-5.6-terra`). O gateway rejeita o modelo inválido, o classificador morre, e o fluxo segue fail-open **sem classificação de causa raiz** — exatamente quando mais precisava do veredito `test_files_issue` para parar a sangria.

### 5. "Workspace intocado" não detecta baseline vermelha no gate

Em `phaseVerify`, quando o teste falha, o motor roda uma "confirmação no workspace intocado" — mas é só uma **re-execução do mesmo comando** (para descartar flake), sem reverter as alterações do agente (sem stash/reset). Como a falha é ambiental (teste obsoleto), ela "confirma" a falha e conclui que o código do agente está errado → `rejected` → rework. Não existe caminho que diga: "essa falha independe das alterações → bloquear como baseline/ambiente".

### 6. Amnésia entre entregas

Cada entrega cria sessão nova (`formatSessionKey(..., generation)`). O único carry-over é o `reworkNote` (output bruto do gate, truncado do meio/fim — nas entregas 3-4 o agente recebeu HTML de componente MUI como "erro", sem a linha real `expected 401 to be 201`). Nenhum aprendizado da tentativa anterior ("já tentei X, não funciona porque Y") é passado adiante.

### 7. O que o agente do motor enxerga (resposta direta à hipótese do Alexandre)

- A sessão é criada no Console com o `agentId` real do projeto (workspace e bootstrap do agente — AGENTS.md/MEMORY.md — carregam normalmente). `workspacePath` **não é suportado** para sessões normais do Console (comentário no código); o worktree vai só como texto no prompt.
- O briefing contém: título da tarefa, subtarefa, escopo, critérios de aceite, caminho do workspace e a descrição (até 12KB). Não contém: regras do projeto, decisões passadas, contexto de infra, nem a configuração do gate (build/test commands).
- As instruções são "faça as alterações nos arquivos; responda APENAS JSON". O agente é tratado como executor de edição de código, não como engenheiro investigador: sem incentivo nem protocolo para validar premissas, conferir logs de runtime, ou refutar critérios de aceite.

## Por que no interativo foi rápido

1. Contexto rico e bidirecional (sintoma descrito pelo Alexandre + memória de longo prazo).
2. Liberdade de investigação: banco, docker logs, código-fonte, host — sem restrição de protocolo.
3. Possibilidade de refutar a premissa: identifiquei que a causa real (`assertSemProjetoId`) estava fora do escopo diagnosticado pelo analista.
4. Identifiquei que o teste que falhava era obsoleto/ambiental — e a ação correta era removê-lo, não "consertar o CrudService".

## Correções propostas (priorizadas)

### Status (2026-09-05)

- **P0 implementado** na branch `feature/motor-p0-classificador-gate` (worktree `wt-motor-p0`):
  classificador migrado para `project_model_selection` (tipo MONITOR), sem cadeia
  padrão (decisão Alexandre: projeto sem modelos cadastrados não usa default),
  regressão do `[object Object]` coberta por teste; specs funcionais fora do gate
  automático em todos os caminhos (escopado, suíte cheia, correção de baseline).
  Suíte do motor-v2: 367 testes passando.
- **MotorMonitorStep** (`src/steps/MotorMonitorStep.ts`) tem a MESMA query legado
  (`projeto_model_chain`) mas não é usado no fluxo v2 (apenas exportado) — corrigir
  quando for ativado.
- P1/P2 abaixo continuam abertas.

### P0 — parar a sangria

1. **Corrigir `GateFailureClassifier.resolveChain`**: filtrar `modelo` NULL/undefined (ou INNER JOIN) para cair no fallback da cadeia default. Sem isso, qualquer projeto sem cadeia `monitor` deixa o classificador morto.
2. **Honrar a decisão de 2026-08-31 também no gate escopado**: excluir `*.functional.spec.ts` (e equivalentes de ambiente real) do gate automático por subtarefa, como o baseline já faz. Testes de integração de ambiente real não são gate automático — ficam para CI/execução humana.

### P1 — detectar o impossível cedo

3. **Detecção de falha independente das alterações**: na "confirmação no workspace intocado", fazer `git stash` das alterações do agente antes de re-rodar; se continuar falhando sem as alterações, é baseline/ambiente → bloquear como `baseline_red`/`environment` e criar subtarefa de correção de baseline, em vez de gastar entregas e escalar modelos.
4. **Feedback entre entregas com aprendizado**: além do output do gate, passar um resumo estruturado do que a tentativa anterior tentou e por que falhou (o agente da entrega anterior pode gerar o resumo antes de terminar).

### P2 — briefing e protocolo

5. **Protocolo de refutação**: permitir ao worker responder `premise_incorrect` com evidências → volta ao analista para re-briefing, em vez de queimar tentativas contra premissa falsa.
6. **Briefing enriquecido**: incluir no prompt regras relevantes do projeto, comandos de build/teste configurados e caminhos de docs (config.ts/schema) — o agente precisa saber onde estão as fontes de verdade.

## Evidências

- Banco `projeto_640`: tarefa 760 (`blocked`), subtarefas 796 (`rejected`, 4 entregas), 806 (`blocked`, 3 entregas), 797 (`pending`), tabela `subtarefas_entregas` (ids 20-32, 36-37, 97-104).
- Logs `biblioteca-global-api`: `Gate vermelho; confirmando falha no workspace intocado`, `GateFailureClassifier ... model not allowed: alibaba/[object Object]`.
- Código: `TaskWorker.ts` (buildProgrammerPrompt L1050, phaseVerify L706, runBaselineCheck L820), `BaselinePolicy.ts` (BASELINE_TEST_EXCLUDES), `GateScopePolicy.ts` (regra b de diretório), `GateFailureClassifier.ts` (resolveChain), `packages/api-client/src/http.ts` (assertSemProjetoId).
- Correções já aplicadas em 2026-09-04: teste funcional removido + front enviando `projeto_id` (commit `8c4cfe9`); listagem de tarefas com slug (commit `120ed06`).
