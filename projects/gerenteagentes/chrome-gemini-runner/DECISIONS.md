# Decisões de Arquitetura - WebAI Provider

**Data:** 2026-09-09  
**Status:** Em desenvolvimento  
**Contexto:** Fallback de emergência para quando provedores de IA (OpenAI, Anthropic, Ollama) estão indisponíveis

---

## Sumário Executivo

O WebAI Provider é um serviço independente que transforma IAs web (Gemini, GPT, Claude) em providers compatíveis com a API OpenAI, permitindo que o Motor-v2 do GerenteAgentes os utilize como fallback quando os provedores normais estão indisponíveis.

---

## Decisão 1: Serviço Independente vs. Integração no Motor

**Data:** 2026-09-09 19:54  
**Decidido por:** Alexandre  
**Contexto:** Avaliar se o WebAI Provider deveria ser parte do Motor-v2 ou um serviço separado.

### Opções Consideradas

1. **Integrar no Motor-v2** - Adicionar lógica de browser automation diretamente no código do Motor
2. **Serviço independente** - Criar um serviço separado que expõe API OpenAI-compatible

### Decisão

**Serviço independente** rodando em container separado.

### Justificativa

- **Separação de responsabilidades** - Motor não precisa saber sobre Puppeteer/Chrome
- **Deploy independente** - Atualiza sem tocar no Motor
- **Reutilizável** - Outros projetos da Global podem usar
- **Escalável** - Pode rodar múltiplas instâncias
- **Testável** - API com contratos claros

### Consequências

- ✅ Motor não precisa ser alterado
- ✅ Console não precisa ser alterado
- ⚠️ Requer gerenciamento de mais um container
- ⚠️ Latência adicional (browser automation)

---

## Decisão 2: Provider Customizado do OpenClaw

**Data:** 2026-09-09 20:06  
**Decidido por:** Alexandre  
**Contexto:** Como integrar o WebAI Provider ao ecossistema OpenClaw existente.

### Opções Consideradas

1. **Alterar o Console** - Adicionar roteamento customizado no Console
2. **Provider customizado no openclaw.json** - Registrar como provider nativo do OpenClaw

### Decisão

**Provider customizado no openclaw.json** usando o mecanismo nativo de providers do OpenClaw.

### Justificativa

- **Zero alteração no Motor** - Ele já sabe falar com providers
- **Zero alteração no Console** - Não precisa tocar
- **Zero alteração no Gateway** - Só configuração
- **Padrão existente** - Segue o mesmo modelo do Ollama
- **Extensível** - Cadastra novas IAs sem rebuild

### Configuração Exemplo

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "webai": {
        "baseUrl": "http://webai-provider:3100/v1",
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

### Consequências

- ✅ Motor trata como qualquer outro provider
- ✅ Tela de modelos da biblioteca funciona sem alterações
- ✅ Cadeia de escalada funciona (webai → openai → alibaba)
- ⚠️ Depende do OpenClaw suportar providers customizados (suportado)

---

## Decisão 3: Arquitetura Stateless (Proxy Burro)

**Data:** 2026-09-09 22:45  
**Decidido por:** Alexandre  
**Contexto:** Definir onde fica a inteligência (personalidade, contexto, tool calls).

### Opções Consideradas

1. **WebAI Provider inteligente** - Provider gerencia personalidade, contexto e tool calls
2. **WebAI Provider stateless** - Provider só traduz formato, OpenClaw gerencia tudo

### Decisão

**WebAI Provider stateless** - apenas traduz formato OpenAI ↔ navegador.

### Justificativa

- **Simplicidade** - Provider é burro, só traduz formato
- **Stateless** - Pode escalar horizontalmente
- **Consistência** - Mesma arquitetura que OpenAI, Anthropic, etc.
- **Manutenção** - Provider não precisa entender de tool calls
- **Reutilização** - OpenClaw já sabe fazer tudo isso

### Responsabilidades

**OpenClaw gerencia:**
- ✅ Personalidade (SOUL.md, AGENTS.md)
- ✅ Contexto da sessão (messages[])
- ✅ Ferramentas (tools[])
- ✅ Execução de tool calls
- ✅ Loop de conversa

**WebAI Provider faz:**
- ✅ Recebe messages[]
- ✅ Envia para navegador
- ✅ Devolve resposta
- ❌ Não guarda estado

### Fluxo

```
OpenClaw → POST /v1/chat/completions (messages[], tools[])
         ↓
WebAI Provider → Envia para Gemini
              ← Pega resposta completa
         ↓
OpenClaw ← Response (texto completo)
         ↓
OpenClaw parse tool calls, executa, repete
```

### Consequências

- ✅ Provider simples e fácil de manter
- ✅ OpenClaw mantém controle total
- ✅ Mesma experiência para o usuário final
- ⚠️ OpenClaw precisa suportar tool calls via texto (não nativo)

---

## Decisão 4: Deploy em Container Separado

**Data:** 2026-09-09 20:18  
**Decidido por:** Alexandre  
**Contexto:** Como deployar o WebAI Provider seguindo o padrão existente.

### Opções Consideradas

1. **Rodar no mesmo container do OpenClaw** - Mais simples, mas polui o container
2. **Container separado** - Segue padrão do Ollama

### Decisão

**Container separado** conectado às redes `openclaw_default` e `ai_network`.

### Justificativa

- **Isolamento** - Chrome tem dependências pesadas
- **Padrão existente** - Ollama já roda assim
- **Escalabilidade** - Pode rodar múltiplas instâncias
- **Recursos** - Chrome consome memória/CPU

### Configuração Docker

```yaml
services:
  webai-provider:
    container_name: webai-provider
    ports:
      - "3100:3100"
    networks:
      - openclaw_default
      - ai_network
    volumes:
      - webai-data:/tmp/webai
```

### Acesso

- **Pelo OpenClaw:** `http://webai-provider:3100/v1`
- **Pelo host:** `http://localhost:3100`

### Consequências

- ✅ Segue padrão do Ollama
- ✅ Isolamento de recursos
- ✅ Fácil de debugar
- ⚠️ Requer gerenciamento de mais um container

---

## Decisão 5: Autenticação via Cópia de Cookies

**Data:** 2026-09-09 22:03  
**Decidido por:** Alexandre  
**Contexto:** Como autenticar o navegador do container nas IAs web.

### Opções Consideradas

1. **Login manual via VNC** - Rodar com display, logar manualmente
2. **Copiar cookies do host** - Pegar cookies do Chrome do host
3. **API oficial** - Usar APIs oficiais (quando disponíveis)

### Decisão

**Copiar cookies do host** automaticamente antes de cada execução.

### Justificativa

- **Automação** - Não precisa de intervenção manual
- **Reutilização** - Aproveita login existente
- **Simplicidade** - Não precisa de VNC no container

### Implementação

```yaml
volumes:
  # Monta perfil do Chrome do host (read-only)
  - /home/alexandre/.config/google-chrome/Default:/host-chrome-profile:ro
```

```typescript
// Antes de iniciar Chrome
await fs.cp(`${hostProfile}/Cookies`, `${containerProfile}/Cookies`);
await fs.cp(`${hostProfile}/Login Data`, `${containerProfile}/Login Data`);
```

### Desafios

- **Concorrência** - Chrome do host não pode estar aberto durante cópia
- **Portabilidade** - Cookies podem ter restrições de IP/user-agent
- **Segurança** - Perfil contém senhas salvas

### Consequências

- ✅ Autenticação automática
- ✅ Sem intervenção manual
- ⚠️ Requer Chrome do host logado
- ⚠️ Cookies podem expirar

### Alternativa Futura

**Login manual via VNC** para primeira configuração:
- Adicionar VNC ao Dockerfile
- Rodar com `HEADLESS=false` + VNC
- Logar manualmente uma vez
- Perfil persiste no volume

---

## Decisão 6: Futuro - Tool Calls via OpenClaw

**Data:** 2026-09-09 22:39  
**Decidido por:** Alexandre  
**Contexto:** Como tornar mais seguro (Gemini não tocar shell diretamente).

### Opções Consideradas

1. **Shell direto** - Gemini executa comandos no terminal (atual)
2. **Tool calls via OpenClaw** - Gemini usa ferramentas do OpenClaw

### Decisão

**Tool calls via OpenClaw** como evolução futura (Fase 2).

### Justificativa

- **Segurança** - Gemini nunca toca o shell diretamente
- **Sandbox** - OpenClaw executa com sandbox
- **Auditoria** - Logs completos do OpenClaw
- **Controle** - Rate limiting, timeouts, circuit breakers

### Arquitetura Futura

```
OpenClaw → WebAI Provider → Gemini
   ↑                            ↓
   └── tool call ←──────────────┘
   ↓
OpenClaw executa ferramenta (sandbox)
   ↓
OpenClaw envia resultado → Gemini
```

### Fases de Implementação

**Fase 1 (MVP - atual):**
- Shell direto
- Para validar conceito
- Menos seguro, mas funcional

**Fase 2 (produção):**
- Tool calls via OpenClaw
- Mais seguro
- Requer API no OpenClaw para executar ferramentas

### Consequências

- ✅ Muito mais seguro
- ✅ Auditoria completa
- ✅ Controle total do OpenClaw
- ⚠️ Requer desenvolvimento adicional
- ⚠️ OpenClaw precisa expor API de ferramentas

---

## Decisão 7: IAs Suportadas

**Data:** 2026-09-09 20:23  
**Decidido por:** Alexandre  
**Contexto:** Quais IAs web suportar inicialmente.

### Decisão

Suportar **Gemini, GPT e Claude** como providers iniciais.

### Justificativa

- **Cobertura** - Maiores IAs web do mercado
- **Redundância** - Se uma falhar, tem backup
- **Flexibilidade** - Cada IA tem pontos fortes diferentes

### Configuração Inicial

```json
{
  "providers": [
    {
      "id": "gemini",
      "name": "Google Gemini",
      "url": "https://gemini.google.com/",
      "selectors": {
        "code": "code",
        "editor": ".ql-editor",
        "stopButton": "button[aria-label*=\"Parar\"]"
      }
    },
    {
      "id": "gpt",
      "name": "ChatGPT",
      "url": "https://chat.openai.com/",
      "selectors": {
        "code": "pre code",
        "editor": "#prompt-textarea",
        "stopButton": "button[data-testid=\"stop-button\"]"
      }
    },
    {
      "id": "claude",
      "name": "Claude",
      "url": "https://claude.ai/",
      "selectors": {
        "code": "code",
        "editor": "[contenteditable=\"true\"]",
        "stopButton": "button[aria-label=\"Stop Response\"]"
      }
    }
  ]
}
```

### Extensibilidade

Novas IAs podem ser cadastradas via API:
```bash
POST /api/providers
{
  "id": "nova-ia",
  "name": "Nova IA",
  "url": "https://nova-ia.com/",
  "selectors": {...}
}
```

---

## Decisão 8: Segurança - CommandSanitizer

**Data:** 2026-09-09 20:23  
**Contexto:** Como prevenir comandos perigosos na Fase 1 (shell direto).

### Decisão

Implementar **CommandSanitizer** com blocklist e allowlist.

### Blocklist (bloqueia sempre)

- `rm -rf /`, `mkfs`, `dd`
- `| sh`, `| bash`, `| sudo`
- `sudo`, `chmod 777`
- `curl | sh`, `wget | bash`
- `env`, `printenv`
- `nc`, `ncat`, `socat`
- `kill -9 1`, `shutdown`, `reboot`

### Allowlist (permite)

- `ls`, `cat`, `grep`, `find`, `echo`, `mkdir`, `cp`, `mv`, `rm`
- `git`, `npm`, `node`, `npx`, `yarn`, `pnpm`
- `pwd`, `cd`, `head`, `tail`, `wc`, `sort`, `uniq`
- `touch`, `chmod`, `chown`

### Consequências

- ✅ Previne comandos destrutivos
- ✅ Permite comandos seguros
- ⚠️ Pode bloquear comandos legítimos (falsos positivos)
- ⚠️ Não protege contra todos os ataques (Fase 2 é melhor)

---

## Decisão 9: Protocolo de Término

**Data:** 2026-09-09 20:23  
**Contexto:** Como o WebAI Provider sabe que a tarefa terminou.

### Decisão

Usar **código de término único por tarefa** no system prompt.

### Implementação

```typescript
const terminationCode = `TAREFA_CONCLUIDA_${Date.now()}`;
const systemPrompt = `...
Quando terminar, envie: echo "${terminationCode}"
`;
```

### Justificativa

- **Único** - Evita término prematuro
- **Simples** - Gemini só precisa enviar um comando
- **Confiável** - Diferente de "tarefa concluída" (pode alucinar)

### Consequências

- ✅ Loop sabe quando terminar
- ✅ Não termina cedo por engano
- ⚠️ Gemini precisa seguir instrução (pode alucinar)

---

## Decisão 10: Timeouts

**Data:** 2026-09-09 20:23  
**Contexto:** Como evitar loops infinitos.

### Decisão

Implementar **dois níveis de timeout**:

1. **Timeout por comando:** 60 segundos
2. **Timeout total da tarefa:** 30 minutos

### Justificativa

- **Proteção** - Evita loops infinitos
- **Recursos** - Libera Chrome se travar
- **Previsibilidade** - Tarefa não roda para sempre

### Configuração

```typescript
{
  commandTimeoutMs: 60_000,    // 1 min por comando
  taskTimeoutMs: 30 * 60_000,  // 30 min total
  pollIntervalMs: 10_000       // 10s entre polls
}
```

### Consequências

- ✅ Evita loops infinitos
- ✅ Libera recursos
- ⚠️ Tarefas longas podem ser interrompidas
- ⚠️ Precisa ajustar conforme uso real

---

## Resumo das Decisões

| # | Decisão | Justificativa Principal |
|---|---------|-------------------------|
| 1 | Serviço independente | Separação de responsabilidades |
| 2 | Provider customizado | Zero alteração no Motor/Console |
| 3 | Stateless (proxy burro) | Simplicidade e consistência |
| 4 | Container separado | Padrão do Ollama, isolamento |
| 5 | Cópia de cookies | Automação, sem intervenção manual |
| 6 | Tool calls (futuro) | Segurança, auditoria |
| 7 | Gemini + GPT + Claude | Cobertura, redundância |
| 8 | CommandSanitizer | Segurança na Fase 1 |
| 9 | Código de término único | Confiabilidade |
| 10 | Timeouts duplos | Proteção contra loops |

---

## Próximos Passos

### Fase 1 (MVP - atual)

- [x] Implementar WebAI Provider stateless
- [x] Deploy em container separado
- [x] Testar com Gemini
- [ ] Implementar cópia automática de cookies
- [ ] Testar com GPT e Claude
- [ ] Integrar com Motor-v2 (configurar openclaw.json)
- [ ] Testar tarefa real ponta a ponta

### Fase 2 (produção)

- [ ] Definir API de tool calls no OpenClaw
- [ ] Implementar parser de tool calls
- [ ] Testar com tarefas complexas
- [ ] Implementar pool de browsers
- [ ] Adicionar métricas (Prometheus)
- [ ] Documentar troubleshooting

---

## Referências

- **Código:** `/data/workspace/projects/agentes/gerenteagentes/chrome-gemini-runner/`
- **Documentação:** `README.md`, `ARCHITECTURE.md`, `OPENCLAW_CONFIG.md`
- **Script original:** `executa-codigo-ia-online-gemini.js`
- **Ollama (referência):** Container na rede `openclaw_default`, acesso via `http://ollama:11434`

---

## Changelog

- **2026-09-09 22:48** - Documento criado com todas as decisões da sessão
- **2026-09-09 19:29** - Início da discussão sobre WebAI Provider
