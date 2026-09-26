# Plano — WebSocket centralizado e terminal de execução

**Status:** proposta aguardando aprovação para desenvolvimento  
**Data:** 2026-08-27  
**Escopo deste documento:** contrato e plano de integração entre a Biblioteca Global, o GerenteAgentes e as telas de acompanhamento de tarefas.

## 1. Objetivo

Substituir o polling periódico da tela de acompanhamento por comunicação em tempo real, centralizada em um serviço WebSocket da Biblioteca Global.

O serviço deverá ser reutilizável por outros subprojetos. No caso do GerenteAgentes, deverá transmitir:

- mudanças de status da tarefa;
- progresso e subtarefa atual;
- eventos do workflow;
- comandos executados pelo motor;
- saída incremental de `stdout` e `stderr`;
- respostas dos agentes/modelos;
- exit code, duração, timeout e erros.

O terminal será somente visualização. A tela não enviará comandos shell para execução.

## 2. Decisão arquitetural proposta

O WebSocket ficará na Biblioteca Global, por ser uma capacidade transversal de plataforma. O GerenteAgentes continuará dono da execução, do workflow e do estado operacional das tarefas.

```text
Motor GerenteAgentes
  └─ publica eventos de execução
       ↓
  Transporte interno autenticado
       ↓
Biblioteca Global — Realtime/WebSocket Service
  └─ autenticação, autorização, roteamento e conexões
       ↓
Tela da Biblioteca — acompanhamento da tarefa
```

### Responsabilidades da Biblioteca

- manter conexões WebSocket;
- autenticar a conexão do usuário;
- autorizar acesso por organização, projeto e tarefa;
- validar o contrato de eventos;
- rotear eventos para os clientes corretos;
- controlar sequência, reconexão e backpressure;
- oferecer histórico/replay quando houver persistência;
- impedir que um projeto receba eventos de outro projeto.

### Responsabilidades do GerenteAgentes

- executar o workflow da tarefa;
- emitir eventos de domínio e execução;
- capturar `stdout` e `stderr` dos processos filhos;
- associar cada evento à tarefa e, quando aplicável, à subtarefa;
- informar comandos, respostas, duração e resultado;
- não expor segredos nos eventos;
- continuar oferecendo endpoint HTTP de detalhe para snapshot, diagnóstico e fallback.

## 3. Contrato de eventos

Todos os eventos deverão possuir envelope comum:

```json
{
  "eventId": "evt-uuid",
  "sequence": 1842,
  "occurredAt": "2026-08-27T14:30:00.000Z",
  "source": "gerenteagentes",
  "organizationId": "org-1",
  "projectId": "project-1",
  "taskId": "task-123",
  "subtaskId": "st-2",
  "type": "task.command.output",
  "payload": {}
}
```

`subtaskId`, `projectId` e outros campos opcionais deverão ser omitidos quando não se aplicarem.

### Eventos mínimos

#### Mudança de status

```json
{
  "type": "task.status.changed",
  "payload": {
    "previousStatus": "planning",
    "status": "running"
  }
}
```

#### Comando iniciado

```json
{
  "type": "task.command.started",
  "payload": {
    "commandId": "cmd-8",
    "command": ["npm", "test"],
    "displayCommand": "npm test",
    "cwd": "/workspace/projeto",
    "at": "2026-08-27T14:30:00.000Z"
  }
}
```

`displayCommand` deverá ser sanitizado. Segredos e argumentos sensíveis não podem ser publicados.

#### Saída do comando

```json
{
  "type": "task.command.output",
  "payload": {
    "commandId": "cmd-8",
    "stream": "stdout",
    "text": "24 testes passaram\\n",
    "chunkIndex": 17
  }
}
```

#### Comando finalizado

```json
{
  "type": "task.command.finished",
  "payload": {
    "commandId": "cmd-8",
    "exitCode": 0,
    "timedOut": false,
    "durationMs": 3210,
    "success": true
  }
}
```

#### Resposta do agente

```json
{
  "type": "task.agent.output",
  "payload": {
    "runId": "run-9",
    "model": "modelo-exemplo",
    "stream": "delta",
    "text": "Analisando a implementação..."
  }
}
```

O streaming de respostas dos agentes depende da capacidade disponível no driver/runtime. Se o runtime só disponibilizar a resposta final, o evento será emitido ao término da chamada.

## 4. Serviço WebSocket na Biblioteca

### 4.1 Endpoint lógico

```text
GET /realtime/ws
```

O cliente deverá enviar, após a conexão, uma mensagem de inscrição:

```json
{
  "type": "subscribe",
  "channel": "task",
  "taskId": "task-123",
  "lastSequence": 1830
}
```

O servidor validará se o usuário pode acessar a tarefa. A resposta será:

```json
{
  "type": "subscribed",
  "taskId": "task-123",
  "currentSequence": 1842
}
```

### 4.2 Reconexão e replay

- o servidor atribui sequência monotônica aos eventos;
- o cliente envia `lastSequence` ao reconectar;
- a Biblioteca reenvia eventos disponíveis após essa sequência;
- se o histórico não estiver disponível, o servidor informa `replay_unavailable`;
- a tela então busca um snapshot HTTP e retoma o WebSocket a partir da nova sequência.

### 4.3 Heartbeat e encerramento

- heartbeat periódico para detectar conexões mortas;
- timeout de cliente inativo;
- encerramento limpo quando a tarefa terminar, mantendo o histórico consultável;
- mensagens de erro padronizadas para inscrição inválida, não autorizado e canal inexistente.

## 5. Publicação de eventos pelo GerenteAgentes

### Fase inicial de transporte

Usar um publicador interno autenticado, preferencialmente HTTP, caso a Biblioteca já possua endpoint de ingestão. O GerenteAgentes enviará eventos em lote pequeno ou individualmente, conforme a necessidade de latência.

```text
POST /internal/realtime/events
Authorization: Bearer <credencial de serviço>
```

A credencial deverá ficar somente em `.env`/secrets. O endpoint interno deverá aceitar apenas eventos de serviços autorizados.

### Evolução possível

Se volume, disponibilidade ou múltiplas instâncias exigirem, substituir o transporte HTTP por um barramento compartilhado, como Redis Streams ou outro mecanismo já adotado pela plataforma. Essa decisão não deve ser tomada antes de medir a necessidade.

## 6. Alterações no motor

### 6.1 Event bus

Criar uma abstração de publicação desacoplada do WebSocket:

```ts
interface TaskExecutionEventPublisher {
  publish(event: TaskExecutionEvent): Promise<void>;
}
```

Implementações previstas:

- `InMemoryTaskEventPublisher` para testes;
- `LibraryRealtimePublisher` para produção;
- eventualmente `PersistedTaskEventPublisher` para histórico durável.

Os eventos internos atuais do workflow deverão ser adaptados para esse contrato.

### 6.2 CommandRunner

Evoluir o contrato atual para aceitar saída incremental:

```ts
onOutput?: (chunk: {
  stream: "stdout" | "stderr";
  text: string;
}) => void;
```

O executor baseado em `spawn` deverá publicar:

1. `task.command.started` antes do processo iniciar;
2. `task.command.output` a cada bloco recebido;
3. `task.command.finished` no fechamento do processo;
4. evento de timeout ou erro quando aplicável.

Devem ser cobertos todos os usos relevantes do runner: baseline, build, testes, Git, workspace, publicação, integração, limpeza e deploy.

### 6.3 Sanitização

Criar uma etapa única de sanitização antes da publicação. Ela deverá:

- mascarar tokens, senhas, chaves e e-mails sensíveis quando aplicável;
- remover valores de variáveis de ambiente protegidas;
- limitar o tamanho dos chunks;
- limitar o tamanho total por tarefa;
- evitar publicação de conteúdo binário;
- preservar indicação de que a saída foi truncada.

## 7. Alterações na tela

### 7.1 Conexão

Ao abrir a tela de acompanhamento:

1. buscar o snapshot inicial por HTTP;
2. renderizar tarefa, subtarefas e histórico existente;
3. abrir o WebSocket da Biblioteca;
4. inscrever-se na tarefa;
5. aplicar eventos incrementalmente.

O polling de 5 segundos será removido como mecanismo principal. O endpoint HTTP permanecerá para carregamento inicial, reconciliação e fallback.

### 7.2 Terminal

Exibir, enquanto a tarefa estiver em execução e também após seu término:

- painel preto com fonte monoespaçada;
- comando atual destacado;
- horário de cada evento;
- saída normal e erro com cores distintas;
- exit code, timeout e duração;
- identificação de subtarefa;
- resposta do agente separada da saída shell;
- rolagem automática com botão para congelar/descongelar;
- aviso de conexão perdida e reconexão;
- indicação de saída truncada.

O terminal será somente leitura e não aceitará entrada de comandos.

## 8. Persistência e retenção

### MVP

Manter o snapshot da tarefa no banco e eventos recentes em memória ou no serviço de realtime, com limite definido. Essa opção é suficiente para demonstrar a experiência em tempo real, mas perde eventos no reinício do processo.

### Versão recomendada

Persistir eventos de execução em tabela própria, com:

- `event_id`;
- `sequence`;
- `task_id`;
- `subtask_id`;
- `type`;
- payload JSON;
- timestamp;
- origem;
- política de retenção.

Implementar retenção por tamanho, idade e tarefa. O histórico completo não deve crescer indefinidamente.

## 9. Segurança e operação

- autenticação de usuário no WebSocket da Biblioteca;
- autorização por organização/projeto/tarefa;
- autenticação serviço-a-serviço entre motor e Biblioteca;
- TLS quando atravessar rede não confiável;
- validação de schema dos eventos;
- limite de conexões por usuário e organização;
- limite de tamanho de mensagem;
- proteção contra publicação de dados sensíveis;
- logs de conexão, inscrição, rejeição e falha de transporte;
- métricas de eventos publicados, entregues, descartados e atrasados.

Não alterar configurações do OpenClaw para implementar esse recurso. Qualquer mudança de proxy, compose ou Gateway deverá ser planejada e aprovada separadamente.

## 10. Plano de execução por etapas

### Etapa 1 — Contratos e prova de transporte

- definir schema dos eventos;
- definir autenticação serviço-a-serviço;
- confirmar endpoint e responsabilidade na Biblioteca;
- validar upgrade WebSocket no proxy;
- criar publisher fake e cliente de teste.

### Etapa 2 — Serviço realtime da Biblioteca

- criar conexão WebSocket;
- implementar subscribe por tarefa;
- implementar autenticação/autorização;
- adicionar heartbeat;
- adicionar sequência e reconexão;
- adicionar ingestão interna de eventos;
- criar testes de isolamento entre projetos.

### Etapa 3 — Eventos do motor

- criar `TaskExecutionEventPublisher`;
- publicar mudanças de status e eventos existentes;
- evoluir `CommandRunner` para streaming;
- publicar início, chunks e finalização dos comandos;
- aplicar sanitização e limites;
- manter endpoint HTTP de detalhe como snapshot/fallback.

### Etapa 4 — Tela de acompanhamento

- trocar o refresh periódico pelo WebSocket;
- implementar aplicação incremental de eventos;
- construir terminal visual;
- implementar reconexão e reconciliação por snapshot;
- testar tarefas em execução, concluídas, bloqueadas e falhas.

### Etapa 5 — Respostas dos agentes

- identificar se o driver fornece deltas em tempo real;
- publicar `task.agent.output` quando possível;
- usar resposta final como fallback;
- diferenciar saída do agente e saída de comandos shell.

### Etapa 6 — Persistência e endurecimento

- persistir eventos, se necessário;
- implementar replay após reconexão;
- adicionar métricas, retenção e alertas;
- executar testes de carga e falha de conexão;
- documentar operação e troubleshooting.

## 11. Critérios de aceite

- a tela não depende de polling periódico para atualizar status;
- uma mudança de status aparece em tempo real;
- um comando aparece antes de terminar;
- stdout e stderr aparecem incrementalmente;
- exit code, timeout e duração são exibidos;
- eventos ficam associados à tarefa correta;
- reconexão não duplica eventos;
- refresh da tela recupera o estado atual;
- tarefas de projetos diferentes permanecem isoladas;
- segredos não aparecem no terminal;
- o terminal permanece disponível após falha ou conclusão;
- build, typecheck e testes do projeto permanecem verdes.

## 12. Esforço e confiança

Estimativa preliminar:

- serviço WebSocket na Biblioteca: 3–5 dias;
- integração do motor e streaming do `CommandRunner`: 2–3 dias;
- alteração da tela e terminal: 2–3 dias;
- testes, segurança, reconexão e documentação: 2–4 dias;
- persistência/replay completo: +1–2 dias.

Total estimado:

- MVP funcional: 6–9 dias;
- versão robusta e auditável: 9–14 dias.

Confiança geral: **86%**.

Confiança por parte:

- WebSocket e roteamento: 90%;
- streaming de comandos shell: 95%;
- tela e terminal: 92%;
- reconexão e replay: 82%;
- streaming das respostas dos agentes: 70%, dependente do runtime OpenClaw;
- integração entre Biblioteca e motor: 80%, dependente dos contratos e do transporte interno já disponíveis.

## 13. Decisões pendentes antes do desenvolvimento

1. Confirmar que a Biblioteca Global será o proprietário do serviço realtime.
2. Escolher o transporte inicial entre motor e Biblioteca: HTTP interno assinado ou barramento existente.
3. Confirmar se o MVP terá persistência de eventos ou apenas retenção temporária.
4. Confirmar quais usuários/organizações podem acompanhar cada tarefa.
5. Confirmar disponibilidade de streaming incremental no driver dos agentes.
6. Aprovar o início da implementação, respeitando a separação entre os projetos.

