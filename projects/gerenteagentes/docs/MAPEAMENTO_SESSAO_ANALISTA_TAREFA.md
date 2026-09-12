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
`execution_order ASC` (com `id ASC` como desempate); o índice `modelIndex`/ordem
da cadeia explica o escalonamento, mas não substitui os registros persistidos.
Para desenvolvimento, a seleção atual usa `last_activity_at DESC` (com `id
DESC` como desempate). Essas ordens de tentativas são preservadas, mantendo as
mensagens de cada sessão juntas; somente as mensagens dentro de cada tentativa
passam a ser descendentes.

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

### Paginação dos transcripts (contrato desta alteração)

A paginação é interna a cada tentativa. A resposta nunca pagina a coleção de
tentativas: o endpoint continua retornando todos os registros persistidos e na
mesma ordem de hoje. Portanto, não se cria uma entidade ou agrupamento novo de
tentativas:

- desenvolvimento: uma tentativa é um registro de
  `motor_agent_sessions` ligado à subtarefa por `subtarefa_id`;
- analista: uma tentativa é um registro de `analyst_task_sessions` ligado à
  tarefa por `tarefa_id`.

O contrato comum de cada endpoint é:

```ts
type SessionMessagesPage = {
  items: Array<{
    role: string;
    text: string;
    sequenceNumber: number;
    occurredAt: string | null;
  }>;
  nextCursor: string | null;
  hasNextPage: boolean;
};

type SessionAttempt = {
  // Os metadados atuais da tentativa permanecem no mesmo nível.
  sessionKey: string;
  messages: SessionMessagesPage;
};
```

`items` é sempre ordenado por `sequenceNumber DESC` (e por `id DESC` como
desempate), ou seja, a mensagem mais recente vem primeiro. O cursor é opaco,
estável para aquela tentativa e representa a continuação da consulta dessa
tentativa; `nextCursor: null` e `hasNextPage: false` encerram o transcript.
Uma página inicial usa `pageSize` (valor padrão definido pelo backend); uma
requisição de continuação envia o cursor da própria tentativa. Cursor, offset,
`hasNextPage` e carregamento são independentes entre tentativas. A lista de
tentativas não recebe `cursor`, `offset`, `hasNextPage` nem limite.

Na primeira resposta, o backend devolve todos os registros de tentativas e uma
primeira página de mensagens para cada um. O frontend mantém esse conjunto e
renderiza as tentativas na ordem existente, inserindo um separador visual entre
blocos. Ao atingir o fim de um bloco, busca somente a próxima página daquele
bloco e anexa as mensagens abaixo das já exibidas (preservando a ordem
descendente no transcript).

Para o desenvolvedor, a fonte continua sendo `motor_agent_sessions` e
`motor_agent_session_messages`; para o analista, continua sendo
`analyst_task_sessions` e `analyst_task_session_messages`. A ordenação da lista
de tentativas não muda: desenvolvimento mantém a ordem atualmente usada para
as sessões da subtarefa e analista mantém `executionOrder ASC` (a primeira
tentativa antes da segunda). A paginação não pode selecionar apenas a sessão
mais recente nem remover tentativas anteriores.

O estado de disponibilidade também permanece compatível com os endpoints
atuais:

- `available: false` com `sessions: []`/tentativa equivalente vazia quando
  não há registro persistido;
- `available: true` quando há histórico persistido, inclusive quando uma
  tentativa existente tem uma página vazia;
- erro continua sendo o erro HTTP já produzido pela rota, sem transformar erro
  em `available: false`.

O parâmetro de continuação identifica explicitamente a tentativa (por
`sessionKey`) e seu cursor; nunca existe um cursor único compartilhado pela
lista. A rota de continuação deve retornar o mesmo envelope de tentativa e
somente a página solicitada, sem alterar a coleção de tentativas. O contrato
deve manter também os metadados atuais (`model`, status, datas e motivo de
fechamento) e, quando o consumidor precisar de texto, montá-lo a partir das
mensagens recebidas — não é um transcript completo implícito na primeira
página.

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
      "messages": {
        "items": [
          { "sequenceNumber": 7, "role": "assistant", "text": "...", "occurredAt": "..." }
        ],
        "nextCursor": "opaque-cursor",
        "hasNextPage": true
      }
    }
  ],
  "text": "[provider/model-a]\\n[user]\\n..."
}
```

`taskId` deve ser validado contra `CurrentProject`, assim como
`sessaoSubtarefa`. Não consultar o Console em tempo real para preencher o
histórico. A lista de sessões permanece completa e na ordem de tentativas
definida acima; cada `messages` é uma página independente, ordenada por
`sequence_number DESC` (e `id DESC` como desempate).

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
