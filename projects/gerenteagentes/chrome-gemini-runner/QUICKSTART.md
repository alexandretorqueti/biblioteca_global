# Quick Start — WebAI Provider

## 1. Instalar dependências

```bash
cd chrome-gemini-runner
npm install
```

## 2. Iniciar o servidor (desenvolvimento)

```bash
npm run dev
```

O servidor sobe em `http://localhost:3100`.

## 3. Testar a API

```bash
# Health check
curl http://localhost:3100/health

# Lista modelos disponíveis
curl http://localhost:3100/v1/models

# Lista providers cadastrados
curl http://localhost:3100/api/providers
```

## 4. Configurar no OpenClaw

Edite o `openclaw.json` e adicione:

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

Reinicie o OpenClaw para carregar a configuração.

## 5. Usar no Motor-v2

Na tela de modelos da biblioteca:
1. Selecione **Provider:** `webai`
2. Selecione **Model:** `gemini` (ou `gpt`, `claude`)
3. Salve

O motor vai tratar como qualquer outro provedor.

## 6. Testar com uma tarefa

Crie uma tarefa simples no Motor-v2 e selecione o modelo `webai/gemini`. O motor vai:
1. Chamar o WebAI Provider
2. Abrir Chrome + Gemini
3. Executar a tarefa via loop de comandos
4. Devolver o resultado

## 7. Deploy (produção)

### Opção A: Docker

```bash
docker-compose up -d
```

### Opção B: systemd (host)

Crie `/etc/systemd/system/webai-provider.service`:

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

Inicie:

```bash
sudo systemctl enable webai-provider
sudo systemctl start webai-provider
```

## Troubleshooting

### Chrome não abre
- Verifique se o Chromium está instalado: `which chromium`
- No Docker, o Dockerfile já instala automaticamente
- No host, instale: `sudo apt-get install chromium`

### IA não responde
- Verifique se está logado na IA (Gemini, GPT, Claude)
- Use `HEADLESS=false` para ver o navegador e debugar
- Verifique os seletores em `webai-providers.json`

### Timeout
- Aumente `TASK_TIMEOUT_MS` (default: 30 min)
- Verifique se a IA não está bloqueando automação

### Comandos perigosos bloqueados
- O `CommandSanitizer` bloqueia comandos como `rm -rf /`, `sudo`, etc.
- Se precisar permitir, edite `src/CommandSanitizer.ts`

## Próximos passos

- Testar com tarefas reais
- Ajustar seletores conforme as IAs atualizam a UI
- Implementar autenticação (cookies/tokens) para IAs que exigem login
- Adicionar métricas e logs estruturados

## Suporte

Para dúvidas ou problemas, consulte o `README.md` completo ou abra uma issue no repositório do GerenteAgentes.
