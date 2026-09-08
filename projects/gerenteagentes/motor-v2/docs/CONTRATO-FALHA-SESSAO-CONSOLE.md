# Contrato de falha de sessão Console/OpenClaw

**Escopo:** subtarefa 1 da correção de `Session failed`.

## Diagnóstico do fluxo atual

O fluxo que reduz o erro remoto a uma falha genérica está em
`src/runtime/ConsoleAgentRuntimeDriver.ts`, dentro de
`waitForRunCompletion()`:

1. O Motor consulta `GET /api/sessions/describe?key={sessionKey}&agentId={agentId}`.
2. Se `status === "failed"` ou `state === "failed"`, retorna apenas:
   `{ state: "error", runId, errorMessage: "Session failed" }`.
3. Se `status/state === "error"`, retorna apenas:
   `{ state: "error", runId, errorMessage: "Session ended with error" }`.
4. Erros HTTP ou de rede durante o polling são capturados, registrados no
   console e descartados; o polling continua até timeout de inatividade.
5. O worker transmite somente `{ type: "failed", executionId, error }` em
   `src/workers/WorkerProtocol.ts`. O coordenador recebe esse texto em
   `onTaskFailed()` e classifica como definitivo, salvo quando `kind` é
   explicitamente `timeout`, `lease_lost`, `lease_expired` ou `lost`.

Portanto, hoje não há consulta a um endpoint de detalhe de erro nem
persistência estruturada do erro da sessão. O único identificador remoto
persistido para sessões de desenvolvimento é `runtime_session_id` na tabela
`motor_agent_sessions` (migração `0026_motor_session_continuity.sql`).

## Contrato remoto observado

| Operação | Endpoint/campos observados | Uso | Lacuna |
|---|---|---|---|
| Criar sessão | `POST /api/sessions`; resposta `{ key, sessionId? }` | `RuntimeSession.key`, `RuntimeSession.sessionId` | `sessionId` é opcional e não há erro detalhado de sessão na resposta de falha |
| Enviar mensagem | `POST /api/chat/send`; resposta `{ runId }` | Correlaciona execução | Não há detalhe de erro no resultado normal |
| Descrever sessão | `GET /api/sessions/describe` com `key`, `agentId`; resposta lida: `status?`, `state?`, `endedAt?`, `hasActiveRun?`, `stopReason?` | Detecta ativo, terminal e falha | Código/mensagem/horário de falha não são lidos |
| Histórico | `GET /api/chat/history` com `sessionKey`, `agentId`; mensagens têm `id?`, `role`, `content`, `createdAt?`; assistant pode ter `stopReason?` | Recupera resposta e transcript | Histórico não é uma fonte confiável de erro estruturado até o Console expor campos próprios |
| Erro HTTP | payload aceito `{ error: { code?: string, message?: string } }`; fallback `HTTP_{status}` | `ConsoleRequestError.status/code` | A classe é privada e não chega ao coordenador como diagnóstico persistido |

Não foi encontrado neste repositório um endpoint adicional de “session error
detail”. O contrato a implementar deve consultar primeiro o `describe` e
aceitar, de forma compatível, o objeto de erro que o Console vier a expor.

## Contrato normalizado proposto

O driver deve produzir um diagnóstico imutável sempre que uma sessão/run
terminar com erro:

```ts
type RemoteSessionFailure = {
  code: string                 // obrigatório; ex.: SESSION_FAILED, HTTP_503
  message: string              // obrigatório, legível e limitado a 500 chars
  sessionKey: string           // RuntimeSession.key
  remoteSessionId?: string     // RuntimeSession.sessionId, se fornecido
  runId: string
  occurredAt: string            // ISO-8601 UTC; preferir endedAt do Console
  scope: "session" | "run" | "console"
  classification: "transient" | "definitive" | "systemic"
}
```

### Extração de campos

Ao receber `describe`, ler os aliases abaixo, nesta ordem:

- `code`: `error.code`, `failure.code`, `errorCode`; fallback
  `SESSION_<STATE>` para estados `failed/error`.
- `message`: `error.message`, `failure.message`, `errorMessage`, `message`;
  fallback `Session failed`/`Session ended with error` somente se nenhum
  detalhe existir.
- `remoteSessionId`: `sessionId`, `id`, ou o `RuntimeSession.sessionId`
  já conhecido. Não confundir `sessionKey` com o ID remoto.
- `occurredAt`: `error.occurredAt`, `failure.occurredAt`, `failedAt`,
  `endedAt`; converter número Unix (segundos ou milissegundos conforme
  magnitude) ou string ISO para ISO-8601 UTC; fallback ao instante da
  observação (`observedAt`).

Para rejeição HTTP, usar `error.code/message` do payload, `HTTP_{status}` e
o instante da resposta. Para falha de transporte, usar o código de sistema
(`ECONNREFUSED`, `ETIMEDOUT`, `AbortError` etc.), a mensagem da exceção e o
instante da tentativa.

## Taxonomia determinística

A classificação é avaliada na ordem `systemic`, `transient`, `definitive`.

### Sistêmica do Console

Classificar como `systemic` quando a evidência indica indisponibilidade do
serviço compartilhado, não defeito da tarefa/sessão:

- falha de transporte (`ECONNREFUSED`, DNS, `ETIMEDOUT`, `AbortError`) ou
  HTTP `408`, `429`, `500`, `502`, `503`, `504`; ou
- `describe` falha para **duas sessões distintas do mesmo `agentId`** dentro
  de uma janela de 2 minutos; ou
- o endpoint de saúde/diagnóstico do Console, se disponível, reporta
  `degraded/unavailable`; ou
- o mesmo `code`/fingerprint ocorre em duas tarefas/agentes diferentes no
  intervalo de 2 minutos.

Um único erro de uma sessão nunca basta para bloquear a fila. A ação é
pausar apenas a fila afetada pelo Console (idealmente global por instância
do Console; por agente quando a evidência for restrita ao agente), emitir um
alerta deduplicado por `consoleInstance + code + janela`, e retentar após
backoff. Tarefas já aguardando esse agente permanecem pausadas, não
`blocked`.

### Transitória

Classificar como `transient` se não for sistêmica e ocorrer qualquer uma das
condições:

- código HTTP `408`, `409`, `425`, `429`, `500`, `502`, `503`, `504`;
- código remoto com prefixo/valor `TIMEOUT`, `TEMPORARY`, `RATE_LIMITED`,
  `SESSION_BUSY`, `GATEWAY_UNAVAILABLE`, `UPSTREAM_RESET`;
- erro de transporte ou encerramento inesperado da sessão sem indicação de
  prompt inválido, permissão negada ou configuração inválida;
- ausência de `describe` terminal após o timeout de inatividade, desde que
  a sessão tenha reportado atividade antes.

A ação é registrar o diagnóstico, encerrar/arquivar a sessão defeituosa
quando possível, criar ou retomar uma sessão e tentar novamente. O retry é
limitado (ex.: 3 tentativas por fase); excedido o limite, converter em
definitivo com causa acumulada legível, preservando os diagnósticos.

### Definitiva

Classificar como `definitive` quando o Console atribuir a causa à entrada,
identidade ou configuração da tarefa:

- `400`, `401`, `403`, `404`, `422`;
- `INVALID_REQUEST`, `INVALID_SESSION`, `AUTH_FAILED`, `FORBIDDEN`,
  `AGENT_NOT_FOUND`, `MODEL_NOT_FOUND`, `MODEL_UNAVAILABLE` (quando o
  contrato indicar indisponibilidade permanente), `WORKSPACE_INVALID`;
- mensagem que indique prompt inválido, sessão inexistente/arquivada sem
  recuperação ou workspace/agente inexistente;
- erro determinístico repetido com o mesmo fingerprint após retry em nova
  sessão.

A ação é persistir o diagnóstico e bloquear a sessão/tarefa com código e
mensagem legíveis. Não retentar automaticamente nem bloquear outras tarefas
do agente, salvo se as regras de `systemic` também forem satisfeitas.

### Precedência e segurança

Código remoto explícito prevalece sobre inferência por texto. Em dúvida,
usar `transient` na primeira ocorrência (fail-safe operacional), registrar
`classification_reason=unknown_remote_failure` e aplicar o limite de retries;
isso evita bloquear imediatamente por um contrato ainda não conhecido.

## Persistência mínima exigida

Cada ocorrência deve ser gravada junto de `motor_agent_sessions` (ou em uma
tabela de eventos relacionada) com:

`code`, `message`, `session_key`, `runtime_session_id`, `run_id`,
`occurred_at`, `observed_at`, `scope`, `classification`, `classification_reason`
e `fingerprint`.

O estado de fila/alerta sistêmico deve ser separado do bloqueio da tarefa:
uma chave de deduplicação (`consoleInstance`, `agentId` quando aplicável,
`code`, janela) garante um único alerta, enquanto cada tarefa mantém seu
diagnóstico individual. Os critérios acima são testáveis com respostas
mockadas de `describe`, rejeições HTTP, erros de transporte e duas sessões
consecutivas.
