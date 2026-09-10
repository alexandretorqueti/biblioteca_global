# WebAI Provider

**Executor de tarefas via Chrome + IAs web** — fallback de emergência para quando os provedores normais (OpenAI, Alibaba, Ollama) estão indisponíveis.

## O que é

O WebAI Provider é um **serviço HTTP independente** que expõe a **API OpenAI-compatible** (`POST /v1/chat/completions`) e, internamente, executa as tarefas usando IAs web (Gemini, GPT, Claude, etc.) via **automação de browser** (Puppeteer).

## Como funciona

```
┌─────────────┐         ┌─────────────────┐         ┌─────────────────────┐
│  Motor-v2   │         │  OpenClaw       │         │  WebAI Provider     │
│  (biblioteca)│  HTTP   │  Gateway        │  HTTP   │  (este serviço)     │
│             │────────▶│                 │────────▶│                     │
│  Pede       │         │  Roteia:        │         │  - Chrome/Puppeteer │
│  provedor   │         │  "webai" →      │         │  - Gemini/GPT/Claude│
│  "webai"    │         │  WebAI Provider │         │  - Loop de execução │
└─────────────┘         └─────────────────┘         └─────────────────────┘
```

1. **Motor-v2** pede `provider=webai, model=gemini`
2. **OpenClaw Gateway** roteia para `http://localhost:3100/v1/chat/completions`
3. **WebAI Provider** recebe a requisição, abre Chrome, navega para o Gemini
4. **Loop de execução**: lê comando → executa → cola resultado → aguarda próximo
5. **Devolve resposta** no formato OpenAI para o gateway
6. **Motor-v2** acha que é um provedor normal — não sabe que é browser automation

## Vantagens

- ✅ **Zero alteração no motor** — ele já sabe falar com provedores
- ✅ **Zero alteração no console** — não precisa tocar
- ✅ **Zero alteração no gateway** — só config no `openclaw.json`
- ✅ **WebAI Provider é 100% independente** — deploy separado
- ✅ **Extensível** — cadastra novas IAs sem rebuild de nada
- ✅ **Reutilizável** — outros projetos da Global podem usar

## Instalação

```bash
cd chrome-gemini-runner
npm install
```

## Uso

### 1. Iniciar o servidor

#### Modo Docker (recomendado, com VNC)

```bash
docker-compose up -d
```

O container expõe:
- **API:** `http://localhost:3100` (API OpenAI-compatible)
- **noVNC:** `http://localhost:6080/vnc.html` (VNC via navegador)

#### Modo desenvolvimento (sem Docker)

```bash
npm run dev    # desenvolvimento (com hot reload)
# ou
npm run build && npm start  # produção
```

O servidor sobe em `http://localhost:3100` por padrão.

### 2. Acessar via VNC (para logar nas IAs web)

Se estiver usando Docker com VNC habilitado:

1. **Acesse via navegador:** `http://192.168.1.8:6080/vnc.html`
2. **Senha VNC:** `global` (configurável via `VNC_PASSWORD` no docker-compose.yml)
3. **Você verá:** desktop com Chrome aberto
4. **Navegue até a IA desejada:**
   - Gemini: `https://gemini.google.com/`
   - ChatGPT: `https://chat.openai.com/`
   - Claude: `https://claude.ai/`
5. **Faça login manualmente** com sua conta
6. **Perfil é salvo** em `/tmp/webai-chrome-profile` (volume Docker persistente)

**Importante:** após logar, o perfil persiste entre restarts do container. O WebAI Provider reutiliza automaticamente o login salvo.

### 2. Configurar no OpenClaw

Adicione no `openclaw.json`:

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "webai": {
        "baseUrl": "http://localhost:3100/v1",
        "api": "openai-completions",
        "models": [
          { "id": "gemini", "contextWindow": 1000000, "maxTokens": 8192 },
          { "id": "gpt", "contextWindow": 128000, "maxTokens": 4096 },
          { "id": "claude", "contextWindow": 200000, "maxTokens": 8192 }
        ]
      }
    }
  }
}
```

### 3. Usar no Motor-v2

Na tela de modelos, selecione:
- **Provider:** `webai`
- **Model:** `gemini` (ou `gpt`, `claude`, etc.)

O motor vai tratar como qualquer outro provedor.

## API

### `POST /v1/chat/completions` — API OpenAI-compatible

**Request:**
```json
{
  "model": "gemini",
  "messages": [
    { "role": "system", "content": "Você é um executor de terminal..." },
    { "role": "user", "content": "Crie um arquivo README.md..." }
  ]
}
```

**Response:**
```json
{
  "id": "chatcmpl-1234567890",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "gemini",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Tarefa concluída com sucesso..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

### `GET /v1/models` — lista modelos disponíveis

**Response:**
```json
{
  "object": "list",
  "data": [
    { "id": "gemini", "object": "model", "owned_by": "webai" },
    { "id": "gpt", "object": "model", "owned_by": "webai" },
    { "id": "claude", "object": "model", "owned_by": "webai" }
  ]
}
```

### `GET /api/providers` — lista providers cadastrados (admin)

### `POST /api/providers` — cadastra novo provider (admin)

**Request:**
```json
{
  "id": "perplexity",
  "name": "Perplexity AI",
  "url": "https://www.perplexity.ai/",
  "selectors": {
    "code": "code",
    "editor": "textarea",
    "stopButton": "button[aria-label='Stop']"
  },
  "promptStyle": "generic",
  "contextWindow": 128000,
  "maxTokens": 4096
}
```

### `DELETE /api/providers/:id` — remove provider (admin)

### `GET /health` — health check

## Configuração

Variáveis de ambiente:

```bash
PORT=3100                          # Porta do servidor
HEADLESS=false                     # Chrome headless? (default: false)
DEBUG_PORT=9222                    # Porta de debug do Chrome
TASK_TIMEOUT_MS=1800000            # Timeout total da tarefa (30 min)
COMMAND_TIMEOUT_MS=60000           # Timeout por comando (1 min)
POLL_INTERVAL_MS=10000             # Intervalo de polling (10s)
WEBAI_CONFIG_FILE=./webai-providers.json  # Arquivo de config
```

## IAs suportadas (padrão)

### Gemini
- **URL:** `https://gemini.google.com/`
- **Seletores:** `code`, `.ql-editor`, `button[aria-label*="Parar"]`
- **Context:** 1M tokens

### ChatGPT
- **URL:** `https://chat.openai.com/`
- **Seletores:** `pre code`, `#prompt-textarea`, `button[data-testid="stop-button"]`
- **Context:** 128K tokens

### Claude
- **URL:** `https://claude.ai/`
- **Seletores:** `code`, `[contenteditable="true"]`, `button[aria-label="Stop Response"]`
- **Context:** 200K tokens

## Cadastro de novas IAs

Via API:

```bash
curl -X POST http://localhost:3100/api/providers \
  -H "Content-Type: application/json" \
  -d '{
    "id": "copilot",
    "name": "GitHub Copilot Chat",
    "url": "https://github.com/copilot",
    "selectors": {
      "code": "code",
      "editor": "textarea",
      "stopButton": "button[aria-label=\"Stop\"]"
    },
    "promptStyle": "generic"
  }'
```

Ou edite diretamente `webai-providers.json`.

## Segurança

O `CommandSanitizer` bloqueia:
- Comandos de destruição em massa (`rm -rf /`, `mkfs`, `dd`)
- Pipes perigosos (`| sh`, `| bash`, `| sudo`)
- Privilégios elevados (`sudo`, `chmod 777`)
- Download e execução remota (`curl | sh`)
- Variáveis de ambiente sensíveis (`env`, `printenv`)
- Rede (`nc`, `ncat`, `socat`)
- Processos críticos (`kill -9 1`, `shutdown`, `reboot`)

Allowlist de comandos seguros:
- `ls`, `cat`, `grep`, `find`, `echo`, `mkdir`, `cp`, `mv`, `rm`
- `git`, `npm`, `node`, `npx`, `yarn`, `pnpm`
- `pwd`, `cd`, `head`, `tail`, `wc`, `sort`, `uniq`
- `touch`, `chmod`, `chown`
- `test`, `[`, `[[`

## Limitações

1. **Latência**: cada ciclo (ler → executar → colar → aguardar) leva 10-20s. Tarefas complexas podem demorar horas.
2. **Fragilidade**: depende de seletores da IA que podem mudar com atualizações de UI.
3. **Detecção**: a IA pode detectar automação e bloquear. Usar `headless: false` reduz esse risco.
4. **Login**: precisa de conta logada na IA. Usar `userDataDir` persistente com perfil já logado.
5. **Alucinação**: a IA pode alucinar comandos perigosos. O `CommandSanitizer` é a defesa.

## Arquitetura

```
chrome-gemini-runner/
├── src/
│   ├── server.ts              (servidor HTTP + API OpenAI-compatible)
│   ├── config.ts              (gerenciador de providers)
│   ├── WebAIRunner.ts         (orquestrador principal)
│   ├── BrowserManager.ts      (abre/fecha Chrome)
│   ├── AIPage.ts              (interage com a página da IA)
│   ├── PromptBuilder.ts       (monta prompts)
│   ├── CommandSanitizer.ts    (bloqueia comandos perigosos)
│   ├── types.ts               (contratos)
│   └── index.ts               (exports)
├── webai-providers.json       (config dos providers — gerado automaticamente)
├── package.json
├── tsconfig.json
└── README.md
```

## Deploy

### Docker (recomendado)

```dockerfile
FROM node:22-slim

# Instala Chrome
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist ./dist

ENV PORT=3100
ENV HEADLESS=true
ENV DEBUG_PORT=9222

EXPOSE 3100
CMD ["node", "dist/server.js"]
```

### systemd (host)

```ini
[Unit]
Description=WebAI Provider
After=network.target

[Service]
Type=simple
User=node
WorkingDirectory=/opt/webai-provider
ExecStart=/usr/bin/node dist/server.js
Restart=always
Environment=PORT=3100
Environment=HEADLESS=true

[Install]
WantedBy=multi-user.target
```

## Próximos passos

- [ ] Testar com tarefas reais
- [ ] Integrar com o Motor-v2 (configurar no `openclaw.json`)
- [ ] Implementar pool de browsers (reutilizar instâncias)
- [ ] Adicionar métricas (comandos executados, tempo, taxa de sucesso)
- [ ] Documentar troubleshooting (IA bloqueou, seletores quebraram, etc.)
- [ ] Implementar autenticação nas IAs (cookies, tokens, OAuth)

## Licença

Uso interno — Global Tecnologia.
