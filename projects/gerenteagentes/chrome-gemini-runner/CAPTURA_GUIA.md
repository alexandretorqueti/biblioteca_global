# Guia de Captura - Engenharia Reversa

## Passo a Passo no VNC

### 1. Acessar o VNC

```
http://192.168.1.8:6080/vnc.html
Senha: global
```

### 2. Abrir Chrome e Navegar para Gemini

No desktop do VNC:
1. Abrir terminal (botão direito → Terminal)
2. Executar:
```bash
DISPLAY=:99 chromium --no-sandbox --user-data-dir=/tmp/webai-chrome-profile https://gemini.google.com/ &
```

### 3. Abrir DevTools

No Chrome:
1. Pressionar `F12` ou `Ctrl+Shift+I`
2. Ir para aba **Network**
3. Marcar **Preserve log**
4. Filtrar por **Fetch/XHR**

### 4. Fazer uma Pergunta no Gemini

1. Digitar algo simples: "olá"
2. Pressionar Enter
3. Aguardar resposta

### 5. Capturar Requisição

No DevTools → Network:
1. Procurar requisição para `StreamGenerate` ou `assistant.lamda`
2. Clicar na requisição
3. Copiar:
   - **URL completa** (Request URL)
   - **Method** (POST/GET)
   - **Headers** (Request Headers)
   - **Payload** (Request Payload / Form Data)
   - **Response** (Response tab)

### 6. Salvar Dados

Criar arquivo `/tmp/webai-capture.txt` com:

```
=== GEMINI ===

URL: https://gemini.google.com/_/BardChatBackendData/...
Method: POST

Headers:
  Cookie: <colar cookie completo>
  Content-Type: application/x-www-form-urlencoded
  X-Same-Domain: 1
  ...

Payload:
  at=AFhZ...
  fz=[["olá"],["conv_id"],["resp_id"]]

Response:
  [["wrb.fr","OqDvkb","[[\"resposta\"]]...",null,null,null,"generic"],...]
```

### 7. Repetir para GPT e Claude

**ChatGPT:**
```bash
DISPLAY=:99 chromium --no-sandbox --user-data-dir=/tmp/webai-chrome-profile https://chat.openai.com/ &
```

**Claude:**
```bash
DISPLAY=:99 chromium --no-sandbox --user-data-dir=/tmp/webai-chrome-profile https://claude.ai/ &
```

Capturar as mesmas informações (URL, Headers, Payload, Response).

---

## Script de Extração Automática

Alternativamente, rodar este script no console do DevTools (F12 → Console):

### Para Gemini:

```javascript
// Extrair cookies
const cookies = document.cookie;
console.log('=== COOKIES ===');
console.log(cookies);

// Extrair auth token
const scripts = document.querySelectorAll('script');
let authToken = null;
for (const script of scripts) {
  const content = script.textContent || '';
  const match = content.match(/"SNlM0e":"([^"]+)"/);
  if (match) {
    authToken = match[1];
    break;
  }
}
console.log('\n=== AUTH TOKEN ===');
console.log(authToken);

// Copiar tudo
copy({ cookies, authToken });
console.log('\n✅ Dados copiados para clipboard!');
```

### Para ChatGPT:

```javascript
// Extrair access_token do localStorage
const sessionToken = localStorage.getItem('next-auth.session-token');
console.log('=== SESSION TOKEN ===');
console.log(sessionToken);

// Fazer request para pegar access_token
fetch('/api/auth/session')
  .then(r => r.json())
  .then(data => {
    console.log('\n=== ACCESS TOKEN ===');
    console.log(data.accessToken);
    copy(data.accessToken);
    console.log('\n✅ Access token copiado!');
  });
```

### Para Claude:

```javascript
// Extrair sessionKey dos cookies
const cookies = document.cookie;
const sessionKeyMatch = cookies.match(/sessionKey=([^;]+)/);
const sessionKey = sessionKeyMatch ? sessionKeyMatch[1] : null;

console.log('=== SESSION KEY ===');
console.log(sessionKey);

// Extrair organization UUID
const orgMatch = window.location.pathname.match(/\/organizations\/([^\/]+)/);
const orgId = orgMatch ? orgMatch[1] : null;

console.log('\n=== ORGANIZATION ID ===');
console.log(orgId);

copy({ sessionKey, orgId });
console.log('\n✅ Dados copiados!');
```

---

## Validação com curl

Depois de capturar os dados, testar com curl:

### Gemini:

```bash
curl -X POST "https://gemini.google.com/_/BardChatBackendData/assistant.lamda.BardFrontendService/StreamGenerate" \
  -H "Cookie: <cookies>" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "X-Same-Domain: 1" \
  --data-urlencode "at=<auth_token>" \
  --data-urlencode 'fz=[["olá"],["conversation_id"],["response_id"]]' \
  -v
```

### ChatGPT:

```bash
curl -X POST "https://chat.openai.com/backend-api/conversation" \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "next",
    "messages": [{
      "id": "'$(uuidgen)'",
      "author": {"role": "user"},
      "content": {"content_type": "text", "parts": ["olá"]}
    }],
    "model": "text-davinci-002-render-sha"
  }' \
  -v
```

### Claude:

```bash
curl -X POST "https://claude.ai/api/organizations/<org_id>/chat_conversations/<conv_id>/completion" \
  -H "Cookie: sessionKey=<session_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "completion": {
      "prompt": "olá",
      "timezone": "America/Sao_Paulo"
    }
  }' \
  -v
```

---

## Checklist

- [ ] Gemini: Cookies extraídos
- [ ] Gemini: Auth token (SNlM0e) extraído
- [ ] Gemini: URL do endpoint capturada
- [ ] Gemini: Payload formatado corretamente
- [ ] Gemini: curl funcionou

- [ ] ChatGPT: Access token extraído
- [ ] ChatGPT: URL do endpoint capturada
- [ ] ChatGPT: Payload formatado corretamente
- [ ] ChatGPT: curl funcionou

- [ ] Claude: Session key extraído
- [ ] Claude: Organization ID extraído
- [ ] Claude: URL do endpoint capturada
- [ ] Claude: Payload formatado corretamente
- [ ] Claude: curl funcionou

---

## Próximos Passos

Depois de validar com curl:

1. Implementar `WebAIDirectProvider.ts`
2. Criar classes `GeminiDirectProvider`, `GPTDirectProvider`, `ClaudeDirectProvider`
3. Integrar com `server.ts`
4. Testar performance
5. Comparar com browser automation
