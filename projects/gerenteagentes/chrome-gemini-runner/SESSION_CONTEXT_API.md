# API de sessão WebAI — MVP

O Motor inicia uma conversa enviando `agent_id`, `session_id` opcional e `agent_context` na primeira chamada de `POST /v1/chat/completions`.

```json
{
  "model": "gemini",
  "session_id": "motor-tarefa-123",
  "agent_id": "gerenteagentes",
  "agent_context": {
    "agent_id": "gerenteagentes",
    "workspace": "/data/workspace/projects/agentes/gerenteagentes",
    "files": [
      {"path": "SOUL.md", "content": "..."},
      {"path": "AGENTS.md", "content": "..."}
    ],
    "tools": [
      {"name": "exec", "description": "Executa comando", "parameters": {}}
    ]
  },
  "tool_relay_url": "http://motor:3000/internal/webai/tool-result",
  "messages": [
    {"role": "user", "content": "primeira mensagem do Motor"}
  ]
}
```

Na primeira chamada, o WebAI monta uma única mensagem de bootstrap com os arquivos, as tools e a mensagem do Motor. Nas chamadas seguintes, o Motor reutiliza o mesmo `session_id`; o WebAI envia somente a nova mensagem, preservando o histórico da aba do Gemini.

Quando o Gemini precisar de uma tool, deve responder:

```text
<tool_call>{"name":"exec","arguments":{"command":"pwd"}}</tool_call>
```

O WebAI encaminha ao `tool_relay_url`:

```json
{
  "session_id": "motor-tarefa-123",
  "agent_id": "gerenteagentes",
  "tool_call": {"name":"exec","arguments":{"command":"pwd"}}
}
```

O relay deve responder JSON no formato `{ "success": true, "output": "..." }` ou `{ "success": false, "error": "..." }`. O WebAI devolve o resultado ao Gemini como `<tool_result>...</tool_result>` e repete o ciclo, no máximo, oito vezes por chamada.

## Logs

Todas as mensagens/contextos/chamadas/resultados ficam em `conversation_events`. Consulte:

```text
GET /api/sessions/:session_id/events
```

Os logs antigos de requisição/resposta continuam disponíveis em `/api/logs`.

## Limite atual do MVP

As sessões ficam em memória no processo e usam a aba autenticada do Gemini. Portanto, o Motor deve manter um `session_id` estável e não deve executar duas sessões Gemini simultaneamente na mesma instância do WebAI. A próxima evolução pode adicionar fila, persistência e autorização por tool.
