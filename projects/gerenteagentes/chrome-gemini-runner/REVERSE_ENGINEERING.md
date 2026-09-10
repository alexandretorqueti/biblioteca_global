# Engenharia Reversa - WebAI Provider

## Objetivo

Capturar os endpoints HTTP internos das IAs web (Gemini, GPT, Claude) para substituir a automação de browser por chamadas HTTP diretas.

## Vantagens da Abordagem HTTP Direta

| Aspecto | Browser Automation | HTTP Direto |
|---------|-------------------|-------------|
| Velocidade | 10-20s/ciclo | 1-2s/ciclo |
| Confiabilidade | Média (DOM muda) | Alta (HTTP estável) |
| Recursos | Alto (Chrome) | Baixo (HTTP) |
| Complexidade | Alta (Puppeteer) | Média (HTTP) |
| Manutenção | Difícil | Fácil |
| Debug | VNC/logs | curl/Postman |

## Metodologia

### 1. Captura de Requisições

**Ferramentas:**
- DevTools do browser (F12 → Network → XHR/Fetch)
- Proxy (mitmproxy, Charles) para capturar HTTPS
- curl para testar endpoints

**O que capturar:**
- URL completa do endpoint
- Method (GET/POST)
- Headers (especialmente Cookie, Authorization, X-* custom headers)
- Request body (payload)
- Response body (estrutura da resposta)

### 2. Análise de Autenticação

**Tipos de auth comuns:**
- Cookies de sessão (Google, Anthropic)
- Tokens Bearer (OpenAI)
- CSRF tokens (hidden inputs)
- Headers customizados (X-Same-Domain, etc.)

**Como extrair cookies:**
```bash
# Do perfil do Chrome
sqlite3 /tmp/webai-chrome-profile/Default/Cookies \
  "SELECT host_key, name, value FROM cookies WHERE host_key LIKE '%google%';"
```

### 3. Teste de Endpoints

```bash
# Testar com curl
curl -X POST "https://gemini.google.com/_/BardChatBackendData/..." \
  -H "Cookie: <cookies>" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "at=<auth_token>" \
  --data-urlencode "fz=<payload>"
```

---

## Gemini (Google)

### Endpoints Conhecidos

**Stream Generate:**
```
POST https://gemini.google.com/_/BardChatBackendData/assistant.lamda.BardFrontendService/StreamGenerate
```

**Headers necessários:**
```
Cookie: <cookies de autenticação>
Content-Type: application/x-www-form-urlencoded
X-Same-Domain: 1
X-Goog-Encode-Response-If-Executable: base64
```

**Payload (form-urlencoded):**
```
at=<AFhZ...> (auth token extraído da página)
fz=[["mensagem"],["conversation_id"],["response_id"]]
```

**Resposta:**
```json
[
  ["wrb.fr", "OqDvkb", "[[\"resposta\",\"conversation_id\",\"response_id\"]]", null, null, null, "generic"],
  ...
]
```

### Como Extrair Auth Token

1. Abrir Gemini no browser
2. DevTools → Console
3. Executar:
```javascript
// Extrair token da página
const scripts = document.querySelectorAll('script');
for (const script of scripts) {
  if (script.textContent.includes('SNlM0e')) {
    const match = script.textContent.match(/"SNlM0e":"([^"]+)"/);
    if (match) console.log('Auth token:', match[1]);
  }
}
```

---

## ChatGPT (OpenAI)

### Endpoints Conhecidos

**Chat Completion:**
```
POST https://chat.openai.com/backend-api/conversation
```

**Headers necessários:**
```
Authorization: Bearer <access_token>
Content-Type: application/json
```

**Payload:**
```json
{
  "action": "next",
  "messages": [
    {
      "id": "<uuid>",
      "author": {"role": "user"},
      "content": {"content_type": "text", "parts": ["mensagem"]}
    }
  ],
  "model": "text-davinci-002-render-sha",
  "parent_message_id": "<uuid>"
}
```

**Resposta:**
```
Event: message
data: {"message": {"id": "...", "author": {"role": "assistant"}, "content": {"parts": ["resposta"]}}}

Event: done
data: [DONE]
```

### Como Extrair Access Token

1. Login em chat.openai.com
2. DevTools → Application → Local Storage → https://chat.openai.com
3. Copiar `access_token` de `next-auth.session-token`

Ou via API:
```bash
curl "https://chat.openai.com/api/auth/session" \
  -H "Cookie: next-auth.session-token=<token>"
```

---

## Claude (Anthropic)

### Endpoints Conhecidos

**Chat Completion:**
```
POST https://claude.ai/api/organizations/<org_id>/chat_conversations/<conv_id>/completion
```

**Headers necessários:**
```
Cookie: sessionKey=<session_key>
Content-Type: application/json
```

**Payload:**
```json
{
  "completion": {
    "prompt": "mensagem",
    "timezone": "America/Sao_Paulo"
  },
  "organization_uuid": "<org_id>",
  "conversation_uuid": "<conv_id>"
}
```

**Resposta:**
```
event: completion
data: {"completion": "resposta parcial", "stop_reason": null}

event: done
data: {"completion": "", "stop_reason": "end_turn"}
```

### Como Extrair Session Key

1. Login em claude.ai
2. DevTools → Application → Cookies → https://claude.ai
3. Copiar valor de `sessionKey`

---

## Próximos Passos

### Fase 1: Validação Manual (curl)

1. **Gemini:**
   - [ ] Extrair cookies do perfil
   - [ ] Extrair auth token (SNlM0e)
   - [ ] Fazer POST manual com curl
   - [ ] Validar resposta

2. **ChatGPT:**
   - [ ] Extrair access_token
   - [ ] Fazer POST manual com curl
   - [ ] Validar resposta SSE

3. **Claude:**
   - [ ] Extrair sessionKey
   - [ ] Fazer POST manual com curl
   - [ ] Validar resposta SSE

### Fase 2: Implementação no Código

1. Criar `WebAIDirectProvider.ts` com:
   - `GeminiDirectProvider`
   - `GPTDirectProvider`
   - `ClaudeDirectProvider`

2. Cada provider implementa:
   - `authenticate()` - extrai tokens/cookies
   - `sendMessage(message)` - faz POST
   - `parseResponse(data)` - extrai texto da resposta

3. Integrar com `server.ts` (substituir WebAIRunner)

### Fase 3: Testes e Validação

1. Testar cada provider isoladamente
2. Comparar performance (browser vs HTTP)
3. Validar persistência de autenticação
4. Testar rate limits e erros

---

## Ferramentas Úteis

### Extração de Cookies do Chrome

```bash
# Instalar sqlite3
apt-get install sqlite3

# Listar cookies
sqlite3 /tmp/webai-chrome-profile/Default/Cookies \
  "SELECT host_key, name, value, encrypted_value FROM cookies;"

# Exportar cookies de um domínio
sqlite3 /tmp/webai-chrome-profile/Default/Cookies \
  "SELECT name, value FROM cookies WHERE host_key LIKE '%google.com%';" \
  > google_cookies.txt
```

### Proxy para Captura (mitmproxy)

```bash
# Instalar
pip install mitmproxy

# Rodar
mitmproxy --mode upstream:https://gemini.google.com

# Configurar browser para usar proxy
# Exportar certificados
```

### Teste com curl

```bash
# Gemini
curl -v -X POST "https://gemini.google.com/_/BardChatBackendData/assistant.lamda.BardFrontendService/StreamGenerate" \
  -H "Cookie: $(cat google_cookies.txt | tr '\n' ';')" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "at=AFhZ..." \
  --data-urlencode 'fz=[["olá"],["conv_id"],["resp_id"]]'

# ChatGPT
curl -X POST "https://chat.openai.com/backend-api/conversation" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"action":"next","messages":[...]}'

# Claude
curl -X POST "https://claude.ai/api/organizations/<org>/chat_conversations/<conv>/completion" \
  -H "Cookie: sessionKey=<key>" \
  -H "Content-Type: application/json" \
  -d '{"completion":{"prompt":"olá"}}'
```

---

## Referências

- [Gemini API não oficial](https://github.com/acheong08/Bard)
- [ChatGPT API não oficial](https://github.com/acheong08/ChatGPT)
- [Claude API não oficial](https://github.com/acheong08/claude)
- [Reverse Engineering Guide](https://github.com/acheong08/ChatGPT/wiki/Setup)
