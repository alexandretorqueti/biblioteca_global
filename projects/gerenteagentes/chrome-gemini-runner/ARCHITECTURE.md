# Arquitetura do WebAI Provider

## Visão Geral

O WebAI Provider é um **serviço HTTP independente** que transforma IAs web (Gemini, GPT, Claude, etc.) em **provedores compatíveis com a API OpenAI**, permitindo que o Motor-v2 do GerenteAgentes os utilize como fallback de emergência quando os provedores normais (OpenAI, Alibaba, Ollama) estão indisponíveis.

## Diagrama de Arquitetura

```
┌─────────────────────────────────────────────────────────────────┐
│                        Motor-v2 (Biblioteca)                     │
│                                                                   │
│  - Consulta project_model_selection                              │
│  - Escolhe provider=webai, model=gemini                          │
│  - Chama API do OpenClaw Gateway                                 │
└────────────────────┬──────────────────────────────────────────────┘
                     │
                     │ HTTP (ws://127.0.0.1:18789)
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                              │
│                                                                   │
│  - Recebe requisição para provider=webai                         │
│  - Roteia para baseUrl configurada (http://localhost:3100/v1)    │
│  - Aguarda resposta                                              │
└────────────────────┬──────────────────────────────────────────────┘
                     │
                     │ HTTP (POST /v1/chat/completions)
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                    WebAI Provider (este serviço)                 │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  server.ts — API OpenAI-compatible                        │  │
│  │  - POST /v1/chat/completions                             │  │
│  │  - GET /v1/models                                        │  │
│  │  - GET/POST/DELETE /api/providers                        │  │
│  └──────────────────────────────────────────────────────────┘  │
│                           │                                      │
│                           ▼                                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  config.ts — ConfigManager                                │  │
│  │  - Carrega webai-providers.json                          │  │
│  │  - Gerencia IAs cadastradas (Gemini, GPT, Claude, etc.)  │  │
│  └──────────────────────────────────────────────────────────┘  │
│                           │                                      │
│                           ▼                                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  WebAIRunner.ts — Orquestrador                            │  │
│  │  - Abre Chrome (BrowserManager)                          │  │
│  │  - Navega para a IA (AIPage)                             │  │
│  │  - Envia prompts (PromptBuilder)                         │  │
│  │  - Loop de execução (ler → executar → colar)             │  │
│  │  - Sanitiza comandos (CommandSanitizer)                  │  │
│  └──────────────────────────────────────────────────────────┘  │
│                           │                                      │
│                           ▼                                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  BrowserManager.ts + AIPage.ts                           │  │
│  │  - Puppeteer (Chrome/Chromium)                           │  │
│  │  - Automação de browser                                  │  │
│  │  - Interação com a IA (seletores CSS)                    │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────┬──────────────────────────────────────────────┘
                     │
                     │ Puppeteer (CDP)
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Chrome/Chromium                               │
│                                                                   │
│  - Aba do Gemini/GPT/Claude                                      │
│  - Loop de execução de comandos                                  │
│  - Saída no chat da IA                                           │
└─────────────────────────────────────────────────────────────────┘
```

## Componentes

### 1. **server.ts** — Servidor HTTP
- **Responsabilidade:** expor API OpenAI-compatible
- **Endpoints:**
  - `POST /v1/chat/completions` — execução de tarefas
  - `GET /v1/models` — lista modelos disponíveis
  - `GET /api/providers` — lista providers cadastrados (admin)
  - `POST /api/providers` — cadastra novo provider (admin)
  - `DELETE /api/providers/:id` — remove provider (admin)
  - `GET /health` — health check

### 2. **config.ts** — ConfigManager
- **Responsabilidade:** gerenciar IAs cadastradas
- **Fonte:** `webai-providers.json` (ou defaults)
- **Operações:** load, get, set, remove, save

### 3. **WebAIRunner.ts** — Orquestrador
- **Responsabilidade:** orquestrar o fluxo completo de execução
- **Fluxo:**
  1. Abrir Chrome (BrowserManager)
  2. Navegar para a IA (AIPage)
  3. Enviar system prompt
  4. Enviar mensagem do usuário
  5. Loop: ler comando → executar → colar resultado → aguardar
  6. Fechar Chrome
- **Timeouts:** taskTimeoutMs (30 min), commandTimeoutMs (1 min)

### 4. **BrowserManager.ts** — Gerenciador de Browser
- **Responsabilidade:** abrir/fechar Chrome via Puppeteer
- **Configurações:** headless, debugPort, userDataDir

### 5. **AIPage.ts** — Interação com a IA
- **Responsabilidade:** abstrair a interação com a página da IA
- **Operações:** navigate, sendMessage, readLastCommand, waitForGenerationComplete
- **Seletores:** configuráveis por provider (code, editor, stopButton)

### 6. **PromptBuilder.ts** — Construtor de Prompts
- **Responsabilidade:** montar prompts de feedback (resultado do comando)

### 7. **CommandSanitizer.ts** — Sanitizador de Comandos
- **Responsabilidade:** bloquear comandos perigosos
- **Blocklist:** `rm -rf /`, `sudo`, `curl | sh`, etc.
- **Allowlist:** `ls`, `cat`, `git`, `npm`, etc.

## Fluxo de Execução

```
1. Motor-v2 pede provider=webai, model=gemini
   ↓
2. OpenClaw Gateway roteia para http://localhost:3100/v1/chat/completions
   ↓
3. server.ts recebe requisição
   ↓
4. config.ts busca provider "gemini"
   ↓
5. WebAIRunner.execute() é chamado
   ↓
6. BrowserManager.launch() abre Chrome
   ↓
7. AIPage.navigate() vai para https://gemini.google.com/
   ↓
8. AIPage.sendMessage(systemPrompt) envia instruções
   ↓
9. AIPage.sendMessage(userMessage) envia tarefa
   ↓
10. Loop:
    a. AIPage.readLastCommand() lê <code>
    b. CommandSanitizer.sanitize() valida
    c. exec() executa no terminal
    d. AIPage.sendMessage(resultado) cola saída
    e. AIPage.waitForGenerationComplete() aguarda IA
    f. Repete até ver código de término
   ↓
11. BrowserManager.close() fecha Chrome
   ↓
12. server.ts devolve resposta no formato OpenAI
   ↓
13. OpenClaw Gateway devolve para Motor-v2
   ↓
14. Motor-v2 trata como qualquer outro provedor
```

## Decisões de Design

### 1. **API OpenAI-compatible**
- **Por quê:** o Motor-v2 já sabe falar com provedores OpenAI-compatible
- **Benefício:** zero alteração no motor, console ou gateway

### 2. **Serviço independente**
- **Por quê:** separação de responsabilidades, deploy independente
- **Benefício:** não polui o motor com lógica de browser automation

### 3. **Seletores configuráveis**
- **Por quê:** cada IA tem sua estrutura HTML
- **Benefício:** extensível para novas IAs sem rebuild

### 4. **CommandSanitizer**
- **Por quê:** segurança (IA pode alucinar comandos perigosos)
- **Benefício:** defesa em profundidade

### 5. **Loop de execução**
- **Por quê:** IAs web não têm API de function calling
- **Benefício:** simula function calling via automação de browser

## Limitações

1. **Latência:** cada ciclo leva 10-20s (ler → executar → colar → aguardar)
2. **Fragilidade:** seletores podem quebrar com atualizações de UI
3. **Detecção:** IAs podem detectar automação e bloquear
4. **Login:** precisa de conta logada (cookies/tokens)
5. **Alucinação:** IA pode alucinar comandos perigosos (sanitizer é a defesa)

## Extensibilidade

### Adicionar nova IA

1. Edite `webai-providers.json`:
```json
{
  "id": "nova-ia",
  "name": "Nova IA",
  "url": "https://nova-ia.com/",
  "selectors": {
    "code": "code",
    "editor": "textarea",
    "stopButton": "button[aria-label='Stop']"
  },
  "promptStyle": "generic"
}
```

2. Ou via API:
```bash
curl -X POST http://localhost:3100/api/providers \
  -H "Content-Type: application/json" \
  -d '{...}'
```

3. Atualize `openclaw.json`:
```json
{
  "models": {
    "providers": {
      "webai": {
        "models": [
          { "id": "nova-ia", "contextWindow": 128000, "maxTokens": 4096 }
        ]
      }
    }
  }
}
```

4. Reinicie o OpenClaw

## Segurança

- **CommandSanitizer:** bloqueia comandos perigosos
- **Timeouts:** taskTimeoutMs (30 min), commandTimeoutMs (1 min)
- **Allowlist:** só comandos conhecidos são permitidos
- **Isolamento:** cada tarefa roda em diretório específico

## Monitoramento

- **Health check:** `GET /health` retorna status, providers, uptime
- **Logs:** console.log estruturado (pode ser enviado para ELK/Loki)
- **Métricas:** a implementar (comandos executados, tempo, taxa de sucesso)

## Deploy

### Docker (recomendado)
```bash
docker-compose up -d
```

### systemd (host)
```bash
sudo systemctl enable webai-provider
sudo systemctl start webai-provider
```

### Manual
```bash
npm run build
npm start
```

## Próximos passos

- [ ] Implementar pool de browsers (reutilizar instâncias)
- [ ] Adicionar métricas (Prometheus, Grafana)
- [ ] Implementar autenticação nas IAs (cookies, tokens, OAuth)
- [ ] Documentar troubleshooting (IA bloqueou, seletores quebraram, etc.)
- [ ] Testar com tarefas reais em produção
- [ ] Integrar com o Motor-v2 (configurar no `openclaw.json`)
