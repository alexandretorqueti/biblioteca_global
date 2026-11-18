# Runbook E2E Sandbox — Billing (Mercado Pago)

Teste ponta a ponta do fluxo de cobrança da Biblioteca Global em ambiente de
teste/sandbox: plano → assinatura → checkout hospedado → webhook do PSP →
ativação + outbox de provisionamento.

**Fontes (tudo abaixo foi conferido no código commitado na base):**

- `apps/api/src/modules/billing/` — `billing.controller.ts`,
  `billing-webhook.controller.ts`, `billing.service.ts`,
  `billing.repository.ts`, `mercado-pago.adapter.ts`,
  `billing-reconciler.ts`, `psp-billing.gateway.ts`,
  `dto/criar-assinatura.dto.ts`
- `apps/api/src/bootstrap.ts` (`setGlobalPrefix("api")`) e
  `apps/api/src/main.ts` (`rawBody: true`)
- `database/schema.ts` — tabelas `planos_produto`, `assinaturas`,
  `billing_webhook_events`, `provisionamento_pendente`, `pedidos_venda`
- `.env.example` (linhas 23–27) e `docker-compose.yml` (linhas 115–121)
- `infra/nginx/biblioteca-global.conf.template` (`server_name
  api.biblioteca.globaltecnologia.net` → proxy para a API)
- `deploy.sh` → `projects/gerenteagentes/scripts/deploy-blue-green.sh`

> ⚠️ **Sem segredos neste documento.** Todos os valores de credenciais são
> placeholders (`<...>`). Credenciais reais ficam apenas no `.env` da raiz
> (gitignored) — nunca em commits, chats ou docs.

As queries SQL assumem o banco **core** (o repositório billing injeta
`CORE_DB`), acessível via o container `biblioteca-global-mysql`
(host `localhost`, porta `3308` no host, imagem `mysql:8`):

```bash
docker exec -i biblioteca-global-mysql mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" core -e "<SQL>"
# ou, com as credenciais do .env da raiz (não expostas neste doc):
docker exec -i biblioteca-global-mysql mysql -u<usuario-core> -p core
```

---

## 1. Pré-requisitos

### 1.1 Variáveis `PSP_*` no `.env` da raiz

O módulo billing exige 5 variáveis (`.env.example` linhas 23–27; injetadas no
container da API por `docker-compose.yml` linhas 115–121):

| Variável | Obrigatória? | Default no compose | O que colocar no teste |
| --- | --- | --- | --- |
| `PSP_PROVIDER` | sim (`env.service.ts` usa `required()`) | `mercadopago` | `mercadopago` (a factory do `billing.module.ts` **lança erro** se for outro valor) |
| `PSP_ACCESS_TOKEN` | sim (`required()`) | vazio | **token de teste (credencial `TEST-...`)** do painel sandbox do Mercado Pago |
| `PSP_WEBHOOK_SECRET` | sim (`required()`) | vazio | segredo HMAC configurado na endpoint de webhook do MP (valor de teste) |
| `PSP_API_URL` | não | `https://api.mercadopago.com` | manter o default; o modo sandbox é decidido pelo token de teste |
| `PSP_TIMEOUT_MS` | não | `10000` | pode ajustar; o código valida inteiro entre 100 e 120000 (`env.service.ts`) |

No `.env` da raiz (não commitado):

```dotenv
PSP_PROVIDER=mercadopago
PSP_ACCESS_TOKEN=<tok…ando>
PSP_WEBHOOK_SECRET=<segre…endo>
PSP_API_URL=https://api.mercadopago.com
PSP_TIMEOUT_MS=10000
```

Estado atual conhecido no ambiente: **`PSP_ACCESS_TOKEN` e
`PSP_WEBHOOK_SECRET` estão vazios no container green**. Como o
`EnvService.required()` falha ao acessar essas chaves e o bootstrap do
`MercadoPagoAdapter`/validação de assinatura depende delas, o boot do Nest
**falha ou o fluxo fica inoperante sem `PSP_PROVIDER` (e sem os tokens
preenchidos)**. Preencha antes de continuar.

### 1.2 Restart / redeploy blue-green

O `.env` é lido no boot do container; alterar o arquivo **não** atualiza o
processo em execução. Após preencher as variáveis:

- **dev/local:** `docker compose up -d --force-recreate api`
- **produção/staging:** rode o deploy blue-green oficial da raiz:

```bash
./deploy.sh   # wrapper que delega a projects/gerenteagentes/scripts/deploy-blue-green.sh
```

O script sobe o slot alternado (blue → portas 3003/3010/5174; green →
3004/3011/5175), aguarda a API responder, troca o upstream do Nginx e só então
remove a stack anterior. O MySQL é compartilhado e não é recriado.

### 1.3 Autenticação para as rotas de assinatura

`BillingController` usa `JwtAuthGuard` + `ProjectScopeGuard`
(`billing.controller.ts`):

- é preciso um **access token JWT com escopo de projeto** (`claims.projetoId`);
  sem escopo, a guard responde `403 Token sem escopo de projeto`;
- o usuário precisa ter **vínculo ativo com o projeto**
  (`AuthRepository.resolveScope`), senão `403 Vínculo com o projeto não
  encontrado ou usuário inativo`;
- o usuário precisa ter **e-mail** no perfil: `criarAssinatura` lança
  `400 Usuário sem e-mail para cobrança` se `usuario.email` estiver vazio.

Obtenha o token pelo fluxo de auth da plataforma (código por e-mail / login) e
use `Authorization: Bearer <JWT …en>`.

### 1.4 Verificação de DNS da URL canônica (antes de tudo)

O webhook do Mercado Pago é configurado para a URL canônica:

```text
https://api.biblioteca.globaltecnologia.net/api/billing/webhook
```

**Estado verificado em 2026-11-18, às 19:50–19:51 UTC:** o hostname
`api.biblioteca.globaltecnologia.net` não possui registro DNS público. Tanto no
container do motor quanto no host `serveria`, a resolução retornou
`getent ...` com **exit 2** e o `curl -sI` retornou **exit 6** (could not
resolve host). Portanto, o problema é DNS ausente no domínio — **não é uma
limitação do ambiente do motor**. O histórico de 17–18/11 estava correto,
mas não se trata de uma variação de cache ou ambiente.

Os domínios `globaltecnologia.net` e `biblioteca.globaltecnologia.net`
resolvem normalmente nos dois ambientes. Enquanto o registro canônico não
existir, use a URL alternativa pública abaixo no painel do Mercado Pago:

```text
https://biblioteca-api.webconnect.com.br/api/billing/webhook
```

Ela corresponde ao segundo `server_name` já presente em
`infra/nginx/biblioteca-global.conf.template`, resolve publicamente e, na
mesma verificação, respondeu **HTTP 401** em `curl -sI` a partir do container
do motor e do host `serveria`. O 401 é esperado sem a assinatura HMAC e prova
que a rota está alcançável.

Valide **a partir de onde o teste será executado** antes de prosseguir:

```bash
# 1) Resolução de nome (deve retornar ao menos um IP)
getent hosts api.biblioteca.globaltecnologia.net

# 2) Alcance HTTP (espera resposta 4xx/200 do Nginx/Nest, nunca "could not resolve host")
curl -sI https://api.biblioteca.globaltecnologia.net/api/billing/webhook

# Endpoint alternativo utilizável enquanto o DNS canônico não existir
getent hosts biblioteca-api.webconnect.com.br
curl -sI https://biblioteca-api.webconnect.com.br/api/billing/webhook

# 3) Dentro do container da API, se o teste for disparado de lá:
docker exec <container-api-da-stack-ativa> sh -c \
  'getent hosts api.biblioteca.globaltecnologia.net || nslookup api.biblioteca.globaltecnologia.net'
```

Se a resolução canônica continuar falhando, configure a URL alternativa no
painel do MP — o webhook só é entregue para URLs publicamente resolvidas.
Como correção definitiva, crie no DNS autoritativo/Cloudflare um registro
`CNAME` ou `A` para `api.biblioteca.globaltecnologia.net`, apontando para o
mesmo destino atendido por `biblioteca-api.webconnect.com.br`; depois de a
propagação ser confirmada, volte a usar a URL canônica. Se o painel não
aceitar o hostname alternativo, exponha temporariamente a porta da API ativa
por um túnel com URL HTTPS pública (por exemplo, um túnel gerenciado) e use a
URL `/api/billing/webhook` fornecida pelo túnel apenas durante o sandbox.

---

## 2. Criação de plano

Não há endpoint de escrita para planos — o teste insere diretamente em
`planos_produto` (colunas conferidas em `database/schema.ts`: `slug`, `nome`,
`preco_centavos`, `moeda`, `ciclo`, `limites_cotas`, `ativo`):

```sql
INSERT INTO planos_produto
  (slug, nome, preco_centavos, moeda, ciclo, limites_cotas, ativo)
VALUES
  ('sandbox-e2e', 'Plano Sandbox E2E', 4990, 'BRL', 'monthly',
   '{"mensagens": 100}', TRUE);
```

Notas do schema/código:

- `slug` é **unique** (100 chars); reuso do mesmo slug falha com duplicate key.
- `preco_centavos` é `int unsigned` — o adapter divide por 100 para o
  `unit_price` do MP (`mercado-pago.adapter.ts`), então `4990` = R$ 49,90.
- `moeda` é `varchar(3)` (`BRL` no exemplo, default do schema).
- `ciclo` é enum `monthly|yearly` — o `CriarAssinaturaDto.ciclo` (se enviado)
  deve ser **idêntico** ao do plano, senão o service lança
  `400 Ciclo incompatível com o plano`.
- `limites_cotas` é JSON **obrigatório** (o `provisionamento.worker.ts` lê
  `plano.limitesCotas` no provisionamento).
- `ativo` precisa ser `TRUE`: `buscarPlanoAtivo` filtra por `ativo = true`.

Confirmação pela API (rota com prefixo global `/api`, conferido em
`bootstrap.ts`):

```bash
curl -s -H "Authorization: Bearer <JWT …to>" \
  https://api.biblioteca.globaltecnologia.net/api/billing/planos
```

`GET /api/billing/planos` → `listarPlanosAtivos()` retorna apenas planos ativos,
ordenados por `preco_centavos` — o plano `sandbox-e2e` deve aparecer.

---

## 3. Criação de assinatura + checkout

`POST /api/billing/assinaturas` (rota autenticada; DTO
`CriarAssinaturaDto` validado pelo `ValidationPipe` global com
`whitelist + forbidNonWhitelisted` — **campos extras viram 400**):

| Campo | Regra (código) | Exemplo de teste |
| --- | --- | --- |
| `planoSlug` | obrigatório, string 1–100 | `"sandbox-e2e"` |
| `ciclo` | opcional, `monthly` ou `yearly`; se enviado, igual ao do plano | `"monthly"` |
| `checkoutSuccessUrl` | obrigatório, `@IsUrl({ require_tld: false })` | `"https://biblioteca.globaltecnologia.net/pagamento-ok"` |
| `checkoutFailureUrl` | obrigatório, `@IsUrl(...)` | `"https://biblioteca.globaltecnologia.net/pagamento-falhou"` |
| `checkoutPendingUrl` | obrigatório, `@IsUrl(...)` | `"https://biblioteca.globaltecnologia.net/pagamento-pendente"` |

```bash
curl -s -X POST \
  -H "Authorization: Bearer <JWT …to>" \
  -H "Content-Type: application/json" \
  https://api.biblioteca.globaltecnologia.net/api/billing/assinaturas \
  -d '{
    "planoSlug": "sandbox-e2e",
    "ciclo": "monthly",
    "checkoutSuccessUrl": "https://biblioteca.globaltecnologia.net/pagamento-ok",
    "checkoutFailureUrl": "https://biblioteca.globaltecnologia.net/pagamento-falhou",
    "checkoutPendingUrl": "https://biblioteca.globaltecnologia.net/pagamento-pendente"
  }'
```

Fluxo interno (`billing.service.ts` `criarAssinaturaParaLead`), nesta ordem:

1. busca plano ativo (senão `404 Plano ativo não encontrado`);
2. `INSERT` em `assinaturas` com `status='pending'`,
   `tenant_slug = projeto.slug`, `plano_produto_id`, `ciclo`;
3. `POST /v1/customers` no MP (external_reference `tenant:<slug>`);
4. `POST /checkout/preferences` no MP (external_reference
   `assinatura:<id>`, item com `unit_price = preco_centavos/100`, `back_urls`
   do DTO); o `checkoutUrl` retornado é **`init_point` com fallback para
   `sandbox_init_point`** (`mercado-pago.adapter.ts`) — com credencial de teste
   espera-se `sandbox_init_point`;
5. `UPDATE` em `assinaturas` ligando `psp_customer_id` e
   `psp_subscription_id`.

Resposta esperada (formato exato do service):

```json
{
  "id": 123,
  "status": "pending",
  "checkoutUrl": "https://sandbox.checkout.mercadopago.com/...",
  "pspSubscriptionId": "<id-da-preferencia-mp>"
}
```

Anote `id` (assinatura) e `pspSubscriptionId` — são as chaves dos aceites
seguintes. Em seguida, abra a `checkoutUrl` no navegador e **pague em testes**
com um comprador de teste do sandbox para o MP disparar o webhook.

---

## 4. Webhook do Mercado Pago

### 4.1 URL e assinatura HMAC

- **URL canônica pretendida no painel do MP (indisponível até criar o DNS):**
  `https://api.biblioteca.globaltecnologia.net/api/billing/webhook`
  (Nginx `server_name api.biblioteca.globaltecnologia.net` → proxy para a API;
  o prefixo `/api` vem de `setGlobalPrefix("api")`, o `/billing/webhook` de
  `@Controller("billing")` + `@Post("webhook")`).
- **URL a configurar agora no sandbox:**
  `https://biblioteca-api.webconnect.com.br/api/billing/webhook`. Ela já está
  no mesmo `server_name` do Nginx, resolve publicamente e respondeu HTTP 401
  na verificação de 2026-11-18; use-a até o registro canônico ser criado.
- **Autenticação do webhook é a assinatura HMAC, não JWT**
  (`billing-webhook.controller.ts` — sem guards).
- O controller exige o **corpo bruto** (`rawBody: true` em `main.ts`), lê os
  headers **`x-signature`** e **`x-request-id`** e extrai o `dataId` de
  `payload.data.id ?? payload.id` (`webhookDataId`).
- Validação (`mercado-pago.adapter.ts` `validateWebhookSignature`): o
  `x-signature` tem partes `ts=<timestamp>,v1=<hex>`; o manifest assinado é
  exatamente:

  ```text
  id:{dataId};request-id:{requestId};ts:{ts};
  ```

  HMAC-SHA256 com **`PSP_WEBHOOK_SECRET`**, comparado em tempo constante.
  Assinatura ausente/inválida → `400 Assinatura de webhook inválida`; corpo
  bruto ausente → `400 Corpo bruto ausente`; JSON inválido → `400 JSON
  inválido`.

### 4.2 Verificação de DNS antes do teste E2E

Refazer o passo 1.4 (`getent hosts` + `curl -sI`) a partir do ambiente de onde
o webhook será disparado/observado. A verificação de 2026-11-18 foi:

| Ambiente | `api.biblioteca.globaltecnologia.net` | `biblioteca-api.webconnect.com.br` |
| --- | --- | --- |
| Container do motor | `getent` exit 2; `curl` exit 6 | resolve; `curl` HTTP 401 |
| Host `serveria` | `getent` exit 2; `curl` exit 6 | resolve; `curl` HTTP 401 |

Assim, configure no MP a URL alternativa enquanto o DNS canônico estiver
ausente. O diagnóstico não deve ser atribuído ao pipeline de billing ou ao
ambiente do motor: é um registro DNS faltante. Após criar o `CNAME`/`A` no
Cloudflare e confirmar a propagação, valide novamente a URL canônica e troque
o endpoint no painel. Se o painel rejeitar o hostname alternativo, use o
túnel HTTPS público temporário descrito no §1.4.

### 4.3 Reenvio manual (simulação de entrega do MP)

Para reproduzir uma entrega com HMAC válido (uso operacional — não é o
caminho normal, que é o MP entregando):

```bash
DATA_ID=<id-d…o>          # ex.: id do pagamento/assinatura
REQUEST_ID=<request-id>
TS=$(date +%s)
SECRET="<confer…reto>" # mesmo valor do PSP_WEBHOOK_SECRET do .env (não versionar)
MANIFEST="id:${DATA_ID};request-id:${REQUEST_ID};ts:${TS};"
V1=$(printf '%s' "$MANIFEST" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')

curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "x-signature: ts=${TS},v1=${V1}" \
  -H "x-request-id: ${REQUEST_ID}" \
  https://api.biblioteca.globaltecnologia.net/api/billing/webhook \
  -d "{\"type\":\"subscription.payment\",\"data\":{\"id\":${DATA_ID}},\"subscription_id\":\"<pspSubscriptionId>\",\"external_reference\":\"assinatura:<id-da-assinatura>\"}"
```

O `subscriptionId` local é resolvido, nesta ordem (`billing.service.ts`
`subscriptionId`): `metadata.subscription_id` → `payload.subscription_id` →
`data.id` se `tipo` começa com `subscription.` → `external_reference` no
formato `assinatura:<id>`. Eventos aprovados/disparadores de ativação:
`payment.approved`, `payment.updated` com `status=approved`, ou qualquer
`subscription.*`.

Processamento (`processarWebhook` → `claimWebhook` → `processarAprovacao`):
em **uma transação**, a assinatura `pending` vira `active`, `pedidos_venda`
vinculados `pending` viram `paid`, e há `INSERT` no outbox
`provisionamento_pendente` com `tipo='billing.provision'` (unique por
`assinatura_id + tipo + ciclo`). Sucesso → evento `done`; erro → evento
`failed` com retry em +60s (o `BillingReconciler` roda a cada 5 min,
exponencial até 5 tentativas → `dead` + alerta).

---

## 5. Os 4 aceites

Substitua `<id-assinatura>` / `<pspSubscriptionId>` / `<dataId>` pelos valores
da execução. Todas as colunas abaixo foram conferidas em
`database/schema.ts`.

### Aceite 1 — assinatura sandbox criada (pending + psp_subscription_id)

```sql
SELECT id, tenant_slug, plano_produto_id, status, ciclo,
       psp_customer_id, psp_subscription_id, created_at
FROM assinaturas
WHERE id = <id-assinatura>;
```

**Passa quando:** `status = 'pending'` e `psp_subscription_id` preenchido com
o `pspSubscriptionId` retornado pelo `POST /api/billing/assinaturas`.

### Aceite 2 — webhook processado (status done)

O `dedupe_key` é montado como `tipo:dataId` (`receberWebhook`). Após o MP (ou
o reenvio do §4.3) entregar o evento:

```sql
SELECT id, dedupe_key, tipo, status, tentativas,
       proxima_tentativa_em, created_at, updated_at
FROM billing_webhook_events
WHERE dedupe_key = '<tipo>:<dataId>';
```

**Passa quando:** existe a linha e `status = 'done'`. (Se `failed`, ver
`tentativas`/`proxima_tentativa_em` e os logs do `BillingReconciler`; `dead`
após 5 tentativas gera alerta Telegram/log e marca a assinatura reembolsável.)

### Aceite 3 — assinatura ativa + outbox de provisionamento

Reflete a transação de `processarAprovacao` (assinatura `active`,
`pedidos_venda` → `paid`, outbox inserido):

```sql
SELECT id, status, psp_subscription_id, updated_at
FROM assinaturas
WHERE id = <id-assinatura>;

SELECT id, assinatura_id, tipo, ciclo, status, created_at
FROM provisionamento_pendente
WHERE assinatura_id = <id-assinatura> AND tipo = 'billing.provision';

SELECT id, status
FROM pedidos_venda
WHERE assinatura_id = <id-assinatura>;
```

**Passa quando:** `assinaturas.status = 'active'`; há **exatamente uma** linha
em `provisionamento_pendente` com `tipo = 'billing.provision'` (default
`status='pending'` — será consumida pelo worker de provisionamento) e
`pedidos_venda` vinculados estão `paid` (se existirem).

### Aceite 4 — duplicata idempotente

Reenvie **o mesmo webhook** (mesmo `tipo`/`dataId`, nova assinatura
`x-signature` com `ts` atualizado — o HMAC cobre `ts`, mas o `dedupe_key` não).
Resposta HTTP esperada:

```json
{ "received": true, "duplicate": true }
```

E no banco, a unicidade de `billing_webhook_events.dedupe_key` garante uma
linha única:

```sql
SELECT COUNT(*) AS linhas
FROM billing_webhook_events
WHERE dedupe_key = '<tipo>:<dataId>';
```

**Passa quando:** a resposta traz `duplicate: true` e `linhas = 1` (o
`onDuplicateKeyUpdate` no repositório não cria segunda linha nem reprocessa o
evento).

---

## 6. Checklist de execução

- [ ] `PSP_*` de **teste** preenchidos no `.env` da raiz (placeholders deste
      doc trocados por valores reais apenas localmente)
- [ ] Restart/redeploy executado e API responding (boot falha sem
      `PSP_PROVIDER`/tokens)
- [ ] DNS da URL canônica resolvido no ambiente do teste (1.4)
- [ ] Plano `sandbox-e2e` visível em `GET /api/billing/planos`
- [ ] `POST /api/billing/assinaturas` → `checkoutUrl` + `pspSubscriptionId`
- [ ] Pagamento de teste no checkout sandbox concluído
- [ ] Aceite 1 ✅ · Aceite 2 ✅ · Aceite 3 ✅ · Aceite 4 ✅
