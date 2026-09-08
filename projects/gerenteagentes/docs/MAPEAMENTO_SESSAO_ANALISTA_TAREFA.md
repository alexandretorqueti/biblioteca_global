# Mapeamento — sessão do analista no acompanhamento da tarefa

## Escopo e conclusão do levantamento

Este documento descreve o fluxo existente sem alterar comportamento. A tela
`screens/TaskMonitorScreen.tsx` hoje expõe somente a sessão do programador por
subtarefa. A sessão do analista acontece antes de as subtarefas serem criadas
e, portanto, não possui `subtarefa_id`; ela não é persistida em
`motor_agent_sessions` nem em `motor_agent_session_messages`.

## Fluxo atual por subtarefa

1. `TaskWorker.phaseExecute` escolhe a cadeia `development` e, para cada
   modelo/entrega, constrói uma `sessionKey` estável com tarefa, subtarefa,
   fase e índice do modelo (`TaskWorker.ts`, chamadas a `formatSessionKey`).
2. `ConsoleAgentRuntimeDriver.createSession` cria/materializa a sessão no
   Console (`POST /api/sessions`, seguido de `PATCH` para desarquivar).
3. O worker envia o prompt com `POST /api/chat/send` e aguarda o término por
   polling de `GET /api/sessions/describe`; ao terminar, lê o resultado em
   `GET /api/chat/history`.
4. Para tarefas de desenvolvimento, `openDeveloperSession` registra a sessão
   em `motor_agent_sessions`. No `finally`,
   `persistDeveloperSessionHistory` copia até 500 mensagens para
   `motor_agent_session_messages`, com hash, papel, sequência e timestamp.
5. Sessão aprovada é apagada do Console por `DELETE /api/sessions` e marcada
   localmente como `closed/approved`; em reprovação, bloqueio ou retorno, a
   sessão remota é preservada e a cópia local fica `returnable`.
6. A API `GET /tarefas/:id/subtarefas/:seq/sessao` valida projeto/tarefa,
   seleciona a sessão da subtarefa mais recentemente ativa e retorna suas
   mensagens ordenadas por `sequence_number`. A tela chama essa rota ao
   clicar no olho da linha da subtarefa e mostra o transcript em um dialog.

As mensagens locais têm FK para a sessão e as sessões têm FK para a
subtarefa, ambas com `ON DELETE CASCADE`. Portanto, apagar a subtarefa também
apaga o transcript; apagar somente a sessão remota do Console não remove a
cópia local.

## Fluxo atual do analista e escalonamento

`TaskWorker.phaseAnalyze` resolve a cadeia `analysis`, cria uma sessão por
modelo tentado e envia primeiro os blocos da descrição, depois o prompt do
analista. Cada run é aguardado pelo mesmo driver. Resposta inválida recebe um
retry corretivo na mesma sessão; falha persistente, modelo indisponível ou
plano rejeitado avança para o próximo modelo. As tentativas seguintes usam
`modelIndex` na chave da sessão; uma nova análise após clarificação também é
uma execução independente. O transcript do analista é mantido remoto apenas:
o `finally` registra que a sessão foi preservada, mas não chama
`getSessionHistory`, não insere `motor_agent_sessions` e não fecha a sessão.

Origem confiável do modelo: `model.model`, vindo de `chainFor(input,
"analysis")`, que é carregada da seleção do projeto e normalizada como
`provider/model`. Não usar o modelo cadastrado no agente nem inferir a partir
da `sessionKey`.

Ordem confiável: para uma sessão, `motor_agent_session_messages.sequence_number`
é a ordem do transcript. Para várias sessões do analista, a ordem de início é
`opened_at` com `id` como desempate; o índice `modelIndex`/ordem da cadeia
explica o escalonamento, mas não substitui timestamps para ordenar eventos
reais. A ordem de exibição deve ser crescente (primeira sessão, segunda, etc.)
e manter as mensagens de cada sessão juntas.

## Pontos de captura e persistência propostos

Sem mudar o fluxo de execução:

- imediatamente após `createSession` na fase `analysis`: inserir um registro
  de sessão ligado à tarefa, com `agent_id`, `model`, `session_key`,
  `runtime_session_id`, `phase='analysis'`, `model_index`, `generation`,
  `opened_at` e status;
- no `finally` da análise: chamar `getSessionHistory` antes de qualquer
  eventual limpeza remota e fazer upsert idempotente das mensagens por
  `(session_id, message_key)`, depois registrar `closed_at`/`close_reason`;
- em falha de criação/execução: persistir o estado/falha usando a mesma
  sessão, relacionando-a à tarefa e, quando aplicável, ao `run_id`;
- manter `motor_agent_sessions`/messages atuais para desenvolvimento por
  subtarefa e acrescentar um escopo explícito de tarefa para o analista, em
  vez de usar `subtarefa_id` nulo sem distinção.

O armazenamento deve ser histórico (não sobrescrever sessões anteriores), com
índices por `(tarefa_id, phase, opened_at)` e unicidade da `session_key`. A
retenção local passa a ser a fonte da consulta após `DELETE /api/sessions` no
Console.

## Contratos a alterar

### Banco/schema

Opção recomendada: ampliar `motor_agent_sessions` com `tarefa_id` obrigatório
e `subtarefa_id` opcional, além de `phase`, `model_index` e `generation`, e
alterar a FK de subtarefa para `ON DELETE SET NULL`. Isso preserva a mesma
tabela/transcript, distingue análise de desenvolvimento e permite agrupar
por tarefa sem criar uma segunda tabela. A migration e `schema.ts` devem
manter a unicidade da chave e o cascade das mensagens.

### Backend

Adicionar uma rota protegida, paralela à rota existente:

`GET /api/gerenteagentes/tarefas/:id/sessao-analista`

Contrato sugerido:

```json
{
  "available": true,
  "sessions": [
    {
      "id": 10,
      "model": "provider/model-a",
      "sessionKey": "...",
      "status": "closed",
      "openedAt": "2026-09-08T10:00:00.000Z",
      "closedAt": "2026-09-08T10:08:00.000Z",
      "messages": [
        { "sequenceNumber": 0, "role": "user", "text": "...", "occurredAt": "..." }
      ]
    }
  ],
  "text": "[provider/model-a]\\n[user]\\n..."
}
```

`taskId` deve ser validado contra `CurrentProject`, assim como
`sessaoSubtarefa`. Consultar `ORDER BY opened_at ASC, id ASC` e mensagens por
`sequence_number ASC`; não consultar o Console em tempo real para preencher o
histórico.

### Frontend

`TaskMonitorScreen` já possui estado/dialog e padrão de carregamento para a
sessão por subtarefa. O ponto de integração é acrescentar uma ação no cabeçalho
da tarefa (ou na área de atividade) que chama a nova rota e renderiza cada
sessão em sequência, exibindo o modelo no início de cada bloco. O contrato
deve continuar permitindo `available=false` e transcript vazio, preservando o
comportamento atual quando não há sessão persistida.

## Limites identificados

- O repositório deste projeto não contém a implementação da tela de
  acompanhamento da Biblioteca Global; a tela local é o único consumidor
  frontend encontrado.
- `motor_agent_sessions` existente cobre somente sessões de desenvolvimento
  por subtarefa. Não deve ser tratado como fonte da sessão do analista sem a
  extensão de escopo acima.
- `subtarefas_entregas` registra modelo e ordem de entregas, mas não contém
  transcript; não atende ao requisito de consultar a sessão após apagá-la.
