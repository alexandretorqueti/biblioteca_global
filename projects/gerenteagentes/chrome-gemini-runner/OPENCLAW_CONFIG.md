# Configuração do OpenClaw para WebAI Provider

## Como o Ollama está configurado

O **Ollama** está em um container separado, conectado às redes:
- `openclaw_default` — rede do OpenClaw
- `ai_network` — rede compartilhada de IA
- `ollama_default` — rede própria do Ollama

O OpenClaw acessa o Ollama via: `http://ollama:11434` (usando o nome do container como hostname).

## Como configurar o WebAI Provider (mesmo padrão)

### 1. Instalar o WebAI Provider no host

```bash
# No host (via SSH)
cd /home/alexandre/docker
git clone <repo> webai-provider
cd webai-provider
./install.sh
```

Ou manualmente:

```bash
# Copiar arquivos para o host
scp -r /data/workspace/projects/agentes/gerenteagentes/chrome-gemini-runner alexandre@192.168.1.8:/home/alexandre/docker/webai-provider

# No host
ssh alexandre@192.168.1.8
cd /home/alexandre/docker/webai-provider
docker build -t webai-provider .
docker-compose up -d
```

### 2. Verificar se o container está rodando

```bash
docker ps | grep webai-provider
curl http://localhost:3100/health
```

### 3. Adicionar provider no openclaw.json

Edite o arquivo de configuração do OpenClaw (geralmente em `/home/alexandre/.openclaw/config.json` ou via UI) e adicione:

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "webai": {
        "baseUrl": "http://webai-provider:3100/v1",
        "api": "openai-completions",
        "models": [
          {
            "id": "gemini",
            "name": "Google Gemini (via Chrome)",
            "contextWindow": 1000000,
            "maxTokens": 8192
          },
          {
            "id": "gpt",
            "name": "ChatGPT (via Chrome)",
            "contextWindow": 128000,
            "maxTokens": 4096
          },
          {
            "id": "claude",
            "name": "Claude (via Chrome)",
            "contextWindow": 200000,
            "maxTokens": 8192
          }
        ]
      }
    }
  }
}
```

**Nota:** Use `http://webai-provider:3100/v1` (nome do container), não `http://localhost:3100/v1`.

### 4. Reiniciar o OpenClaw Gateway

```bash
# No host
docker restart openclaw
```

Ou via UI do OpenClaw.

### 5. Verificar se o provider foi carregado

```bash
# Via API do OpenClaw
curl http://localhost:18789/api/models | jq '.[] | select(.provider == "webai")'
```

Ou verifique nos logs do OpenClaw:

```bash
docker logs openclaw | grep -i webai
```

### 6. Testar no Motor-v2

Na tela de modelos da biblioteca:
1. Selecione **Provider:** `webai`
2. Selecione **Model:** `gemini` (ou `gpt`, `claude`)
3. Salve

Crie uma tarefa simples e verifique se executa.

## Arquitetura final

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│  Motor-v2       │         │  OpenClaw       │         │  WebAI Provider │
│  (biblioteca)   │  HTTP   │  Gateway        │  HTTP   │  (container)    │
│                 │────────▶│  (container)    │────────▶│                 │
│  provider=webai │         │  roteia para    │         │  Chrome + IA    │
│  model=gemini   │         │  webai-provider │         │  (Puppeteer)    │
└─────────────────┘         └─────────────────┘         └─────────────────┘
         │                            │                            │
         └──────────── openclaw_default network ────────────────────┘
                              (http://webai-provider:3100)
```

## Troubleshooting

### Container não acessível pelo OpenClaw

Verifique se o container está na rede correta:

```bash
docker inspect webai-provider --format="{{json .NetworkSettings.Networks}}" | jq
```

Deve mostrar `openclaw_default`.

Se não estiver, conecte manualmente:

```bash
docker network connect openclaw_default webai-provider
```

### OpenClaw não encontra o provider

Verifique se o `baseUrl` está correto no `openclaw.json`:

```bash
cat /home/alexandre/.openclaw/config.json | jq '.models.providers.webai'
```

Deve mostrar:
```json
{
  "baseUrl": "http://webai-provider:3100/v1",
  "api": "openai-completions",
  "models": [...]
}
```

### WebAI Provider não responde

Verifique os logs:

```bash
docker logs webai-provider
```

Verifique se o Chrome está instalado:

```bash
docker exec webai-provider which chromium
```

## Comparação com Ollama

| Aspecto | Ollama | WebAI Provider |
|---------|--------|----------------|
| Container | `ollama` | `webai-provider` |
| Porta | 11434 | 3100 |
| Rede | `openclaw_default`, `ai_network` | `openclaw_default`, `ai_network` |
| Acesso pelo OpenClaw | `http://ollama:11434` | `http://webai-provider:3100/v1` |
| API | Ollama API | OpenAI-compatible |
| Modelos | Modelos locais (qwen, llama, etc.) | IAs web (Gemini, GPT, Claude) |
| Latência | Baixa (local) | Alta (browser automation) |
| Custo | Grátis (local) | Grátis (IAs web) |
| Uso | Produção | Emergência/fallback |

## Próximos passos

1. ✅ Instalar WebAI Provider no host
2. ✅ Configurar no `openclaw.json`
3. ✅ Reiniciar OpenClaw Gateway
4. ⏳ Testar com tarefa real no Motor-v2
5. ⏳ Monitorar performance e ajustar timeouts
6. ⏳ Documentar troubleshooting
