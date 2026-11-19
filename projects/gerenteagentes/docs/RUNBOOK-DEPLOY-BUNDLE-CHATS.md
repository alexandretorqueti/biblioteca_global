# Runbook — Bundle de chats no deploy blue-green

> Tarefa 19/11: o blue-green publicava apenas api/web, e o front novo do
> produto (`projects/chat-universal`, que substitui isa-chat/alpha-chat no
> `docker-compose.yml` da raiz) nunca era recriado pelo fluxo oficial —
> `biblioteca-global-chat-universal` chegou a não existir enquanto o
> chat-proxy no ar ainda era build de 17/11. Desde então,
> `scripts/deploy-blue-green.sh` inclui a etapa `deploy_chat_bundle` após a
> troca de slot. O `docker-compose.yml` da raiz **não** foi alterado.

## Contexto: por que o bundle não entra no blue-green

- Os serviços do bundle (`chat-universal` na porta host
  `${CHAT_UNIVERSAL_HOST_PORT:-8084}`, `chat-proxy` na `8080`) têm
  `container_name` fixo (`biblioteca-global-chat-universal`,
  `biblioteca-global-chat-proxy`) e vivem no compose padrão da raiz
  (projeto `biblioteca-global`), não nos slots blue/green.
- São nginx estáticos: recriação rápida, sem necessidade de swap de
  tráfego. A API é resolvida pelo alias estável `biblioteca-api` na rede
  externa `biblioteca-global_default`, que o slot ativo assume a cada swap.

## Ordem completa dos passos do deploy

1. Sincronização com `origin/<base>` e verificação do commit pré-validado.
2. `docker compose -p biblioteca-{blue|green} build api web`.
3. Materialização do `dist` do motor-v3 a partir da imagem da API nova.
4. Limpeza de slot residual (com dump de logs) e `up -d --no-deps api` do
   slot novo, depois `up -d --no-deps web` (o web espera o alias DNS da API).
5. Validações do slot novo: workspace Git do Motor, Console OpenClaw,
   health de web/api/motor, consumers RabbitMQ.
6. Migrations dos projetos ativos (aplicadas pelo Motor, antes do tráfego).
7. **Swap Nginx** (`update_nginx`) → remoção da stack antiga →
   `write_active_slot` (tráfego comutado; ponto de não-retorno mecânico).
8. **`deploy_chat_bundle`** (este runbook): rebuild/recreate + smoke dos
   chats, logo após o swap.
9. Smoke legado isa-chat/alpha-chat (somente se os containers legacy
   estiverem em execução).
10. Log `SUCESSO` + callback ao Motor (`notify_deploy_on_exit`).

## Etapa de chats (`deploy_chat_bundle`)

Comando executado:

```bash
docker compose -p "${CHAT_COMPOSE_PROJECT:-biblioteca-global}" \
  -f docker-compose.yml up -d --build --no-deps chat-universal chat-proxy
```

- `--no-deps` é **obrigatório**: `chat-universal` tem `depends_on: api` e,
  sem ele, o compose criaria uma API paralela no projeto padrão, colidindo
  portas com o slot ativo. A API correta já é alcançada pelo alias
  `biblioteca-api`.
- Smoke (exige HTTP 200):
  - `http://127.0.0.1:${CHAT_UNIVERSAL_HOST_PORT:-8084}/health` — nginx do
    chat-universal expõe `/health`;
  - `http://127.0.0.1:${CHAT_PROXY_HOST_PORT:-8080}/` com
    `-H 'Host: isa.globaltecnologia.net'` e `-H 'Host:
    alpha.globaltecnologia.net'` — o chat-proxy roteia por `server_name`
    para `biblioteca-global-chat-universal`.

### Política de falha (degradável)

- Qualquer falha (compose indisponível, build quebrado, smoke sem 200)
  produz linha visível `[deploy-blue-green] ALERTA CHATS: ...` no log do
  deploy (capturado pelos diagnósticos do Motor → chat da tarefa) e
  notificação Telegram best-effort via `TELEGRAM_BOT_TOKEN` /
  `TELEGRAM_DLQ_CHAT_ID` (carregados do `.env` pelo script; pulada em
  silêncio se vazios).
- O resultado consolidado sai no log como `chats_status=ok(...)` ou
  `chats_status=falha(...)`.
- **Nunca** altera o exit code do deploy, o callback ao Motor nem reverte o
  blue-green — o tráfego da API já foi comutado no passo 7.

## Smoke legado (isa-chat/alpha-chat, portas 8082/8083)

Desde 19/11 o smoke legado só executa quando o container correspondente
(`biblioteca-global-isa-chat` / `biblioteca-global-alpha-chat`) está em
execução. Os serviços têm `profiles: ['legacy']` — no fluxo normal do
bundle novo eles ficam baixados, e cobrar 200 de container parado geraria
falso alerta. O log registra `smoke legado pulado` nesses casos.

## Rollback dos chats (profile legacy)

Se o bundle novo falhar e for preciso voltar aos chats isós (a profile
`legacy` continua mantida exatamente para isso):

```bash
cd <raiz do repositório no host>
docker compose up -d --no-deps --profile legacy isa-chat alpha-chat
docker stop biblioteca-global-chat-universal biblioteca-global-chat-proxy
```

(ou `docker compose stop chat-universal chat-proxy`). Os chats legados
resolvem a API pelo mesmo alias `biblioteca-api`, então o rollback não
depende do slot ativo. O blue-green da API **não** é revertido por este
caminho — rollback de API segue o fluxo normal (deploy para o outro slot).

## Como validar manualmente

```bash
docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'chat|biblioteca-(blue|green)'
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8084/health
curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: isa.globaltecnologia.net'   http://127.0.0.1:8080/
curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: alpha.globaltecnologia.net' http://127.0.0.1:8080/
grep -E 'ALERTA CHATS|chats_status' <log do deploy>
```

Todos os curls devem responder 200. Em caso de `chats_status=falha`,
verificar `docker logs biblioteca-global-chat-universal` /
`biblioteca-global-chat-proxy` e se o compose da raiz está íntegro.

## Validação automatizada

- `tests/deploy-script.spec.ts`: invariantes das três chamadas `docker
  compose ... up` (todas `--no-deps`, nenhuma `mysql`), presença da etapa
  de chats com `--build chat-universal chat-proxy` no projeto
  `biblioteca-global`, posição após `write_active_slot`, chamada
  degradaível (`deploy_chat_bundle || true`), alerta/log consolidado,
  Telegram best-effort e condicionamento do smoke legado.
- Executar: `npx vitest run tests/deploy-script.spec.ts`.
