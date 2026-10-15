# Isa — Funcionamento verificado do módulo `api/isa-chat`

> **Escopo:** documentação do fluxo operacional real do módulo `api/isa-chat`
> (captação de projetos pela Isa). Nada aqui foi inferido de comportamento ausente do
> código; o que **não existe** no código está explicitamente listado na seção 13
> ("Comportamentos ausentes no código").
>
> **Fontes conferidas (código vigente deste workspace):**
> `projects/gerenteagentes/api/isa-chat/{isa-chat.controller.ts, isa-chat.service.ts, isa-chat.bridge.ts, isa-chat.types.ts, index.ts}` ·
> `projects/gerenteagentes/schema.ts` ·
> `projects/gerenteagentes/docs/isa-fluxo-sessao.md` (documento de referência da regra de sessão) ·
> `projects/gerenteagentes/api/isa-chat/__tests__/{isa-chat.controller.spec.ts, isa-chat.service.spec.ts}` ·
> front `projects/isa-chat/src/App.tsx` ·
> cliente `packages/api-client/src/agent-chat-client.ts` ·
> componente `packages/ui/src/components/AgentChat.tsx` ·
> `apps/api/src/bootstrap.ts` (prefixo global `/api`) ·
> `projects/gerenteagentes/api/gerenteagentes.module.ts` (montagem do módulo).

---

## 1. Visão geral (para o negócio)

A Isa é a assistente virtual de captação da Global Tecnologia. O fluxo de uma captação:

1. O visitante chega ao site e abre o chat (ainda anônimo).
2. Ele envia a primeira mensagem — nesse momento nasce a conversa com a agente.
3. A Isa conduz a conversa, pergunta o **nome** e o **e-mail** do cliente; o e-mail é
   confirmado por **código de verificação** enviado por SMTP.
4. Com identidade verificada, a Isa coleta **definições** (requisitos confirmados) e o
   **nome do projeto** aprovado pelo cliente.
5. Opcionalmente coleta o **telefone**.
6. A Isa **finaliza a captação**: o projeto captado é criado no banco com slug único,
   descrição e as definições vinculadas, pronto para revisão/desenvolvimento pelo motor.

Princípio central (regra de `docs/isa-fluxo-sessao.md`, confirmada no código):
**visitar a página, abrir o widget ou ler o histórico NÃO cria sessão da Isa no
OpenClaw e não registra lead**. A sessão do agente só é materializada no **primeiro
envio válido** de texto ou anexo.

## 2. Camadas e arquivos

| Camada | Arquivo | Papel |
| --- | --- | --- |
| HTTP (rotas públicas) | `isa-chat.controller.ts` | Validação/truncamento de entrada; classe `@Public()` (sem JWT, chat anônimo). O controller usa `@Controller()` sem sufixo; o prefixo global `/api` vem de `apps/api/src/bootstrap.ts` (`setGlobalPrefix("api")`). |
| Negócio | `isa-chat.service.ts` | Persistência (Drizzle/MySQL por projeto), máquina de estados do onboarding, injeção de contexto no turno, sincronização de histórico, verificação de e-mail, finalização. |
| Transporte | `isa-chat.bridge.ts` | **Único** módulo que conhece o contrato do BFF do OpenClaw Console (`POST /api/sessions`, `PATCH /api/sessions` para label, `POST /api/chat/send`, `GET /api/chat/history`, `POST /api/chat/abort`). |
| Contratos internos | `isa-chat.types.ts` | Interfaces (`IsaChatBridge`, `SessionResult`, `SendMessageResult`, `FinalizeResult`, etc.). |
| Dados | `projects/gerenteagentes/schema.ts` | Tabelas `chats`, `chat_mensagens`, `contatos`, `definicoes`, `visitas_site`, `email_verifications`, `projetos_captados`. |

Montagem: `GerenteAgentesModule` registra `IsaChatController` + `IsaChatService` +
`IsaChatBridgeService`; o service obtém conexão via `PROJECT_DB_FACTORY` (fábrica de
banco por projeto) com `projectId` de `ISA_PROJECT_ID` (fallback no código: `640`;
`docker-compose.yml`: `${ISA_PROJECT_ID:-640}`).

### Configuração que muda o comportamento (condicionais)

| Variável | Efeito no código |
| --- | --- |
| `ISA_BFF_UPSTREAM` | Base URL do BFF. **Se vazia, `bridge.isConfigured()` é `false`** e o comportamento do módulo muda (ver §12). |
| `ISA_BFF_TOKEN` | Bearer opcional nas chamadas à ponte. |
| `ISA_BFF_TIMEOUT_MS` | Timeout HTTP da ponte (fallback 10 000 ms). |
| `ISA_PROJECT_ID` | Projeto dono dos dados de captação (fallback `640`). |
| `ISA_AGENT_ID` | Agente padrão (`isa`) quando a requisição não traz `agentId`. |
| `ISA_VERIFICATION_SECRET` | Segredo do hash do código de verificação. **Se ausente, usa o fallback hardcoded `globalia-onboarding-dev-secret`** (condicionado pela configuração). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` | Se `SMTP_HOST` ausente: `mailer = null` e o código **não é enviado por e-mail** (ver §7.2 e §12). |
| `AUTH_CODE_DEBUG_LOG` | Se `"true"` **e** SMTP não configurado, o código é logado no logger da API. |

## 3. Identificadores (glossário)

| Identificador | Onde nasce | O que é |
| --- | --- | --- |
| `visitorKey` | Front `App.tsx`: `localStorage["isa.chatId"]`, formato `visitor-<uuid>` (`crypto.randomUUID` com fallback manual) | Chave anônima estável do navegador. |
| `chatKey` | Enviado como `chatKey` em `POST /api/session` e persistido em `chats.chat_key` | Vínculo navegador ↔ linha de `chats`. O front da Isa mapeia `{ chatKey: visitorKey }`. |
| `chatId` | Retornado pela API como string | `chats.id` numérico após criação; antes disso, o próprio `chatKey`. **Todos os endpoints aceitam id numérico ou `chatKey`** (helper `findChat`). |
| `sessionKey` | Ponte, no primeiro envio válido | Sessão do agente no OpenClaw: `agent:<agentId>:<slug do chatKey>` (slug: minúsculas, só `a-z0-9` e `-`). Gravado em `chats.session_key`. |
| `contatoId` | Verificação de e-mail (§7.3) ou modo legado (§8) | Id em `contatos`. **Presença = identidade verificada** (pré-requisito de definições, telefone e finalização). |
| `projetoId` | Finalização (§11) | Id em `projetos_captados`; `slug` único derivado do nome do projeto. |

## 4. Etapa 0 — Visita ao site (`POST /api/site-visit`)

- Ao montar, o componente `AgentChat` chama `client.recordVisit()` (body `{ visitorKey, pageUrl }`; o controller acrescenta `referrer`/`user-agent` dos headers e o IP de `X-Forwarded-For` (primeiro valor) ou `socket.remoteAddress`).
- O service insere apenas em `visitas_site`: `visitor_key` (≤255), `page_url` (≤4000), `referrer` (≤4000), `user_agent` (≤2000) e `ip_hash` = **SHA-256 do IP** (nunca IP em claro — confirmado por teste). Sem IP, `ip_hash = null`. Retorna `{ ok: true }` (HTTP 201).
- **Não cria chat, não cria contato, não chama a ponte.** O front trata falha como silenciosa (`recordVisit` → `false`).
- O `visitorKey` pode persistir por visitas sem que nunca exista lead: visita ≠ contato.

## 5. Etapa 1 — Abertura do chat local (`POST /api/session`) — NÃO materializa sessão do agente

Entrada mínima: `chatKey` **ou** `email` (senão `400 "chatKey ou email é obrigatório"`). O controller trunca: `chatKey`≤255, `email`≤200, `nome`≤150, `agentId`≤100.

> Nota de schema: `chats.chat_key` é `varchar(200)`, mas o controller aceita `chatKey` até 255 caracteres. Fato registrado do código; nenhum tratamento adicional existe.

### 5.1 Modo anônimo (`{ chatKey }`) — fluxo padrão do site

- Busca `chats` por `chat_key`.
- **Chat novo:** insere `chats` com `status = "aberto"` (sem `contatoId`, **sem `sessionKey`**) e grava em `chat_mensagens` a **saudação estática** (`role: "agent"`), escolhida por `getWelcomeMessage(agentId)`: Isa por padrão; texto próprio do Grupo Alphaville quando `agentId === "alpha"`. Retorna `{ ok, chatId, existing: false, onboarding: { state: "novo", verified: false } }`.
- **Chat existente:** retorna `existing: true`, `chatId` e o estado de onboarding reconstruído por `buildOnboardingState` (verificado se `contatoId` aponta para um contato real; senão nome/e-mail pendentes do próprio chat), mais `contactId` quando houver vínculo.
- **A ponte não é chamada em nenhum dos dois casos** — confirmado por teste ("não deve criar sessão OpenClaw ao abrir um chat anônimo") e por inspeção do código de `createSession`.

No front, enquanto não há envio, o `AgentChat` mostra apenas uma saudação **local** (a mesma mensagem) e o `api-client` nem chama `/session` nem `/history` — `loadHistory` retorna vazio sem tocar a rede enquanto a sessão local não começou. `POST /api/session` é a rota que materializa/recupera o chat local quando o cliente decide iniciar a sessão (no primeiro envio, §6).

### 5.2 Modo legado (`{ email, nome? }`) — descrito na §8

## 6. Etapa 2 — Primeira mensagem e sessão OpenClaw (`POST /api/chat/send`)

**O envio é o único evento que materializa a sessão do agente.** Ordem exata em `sendMessage`:

1. Valida: `chatId` presente e (`text` não vazio **ou** ≥1 anexo); senão `400`.
2. `findChat` por id numérico ou `chatKey`.
3. **Chat inexistente + `chatId` ≤255 caracteres + ponte configurada → materializa o chat local** (`status = "novo"`, `chat_key = chatId`) e grava a saudação estática. Sem ponte configurada, o chat não é criado aqui.
4. Chat não resolvido → `{ ok: false, reason: "chat_not_found", retryable: false }`.
5. **Anexos processados antes de persistir:** cada anexo base64 → `Uint8Array`; vazio/inválido → marcador `[Arquivo anexado: … — não foi possível ler (vazio ou inválido)]`. Demais passam por `extractTextFromFile` (`@biblioteca-global/file-extract`): texto extraído é embutido no corpo entre `--- Início do anexo: nome ---` / `--- Fim do anexo: nome ---`, com **truncamento a 8 000 caracteres** + `[... truncado ...]`; falha de extração vira marcador com o motivo. Referências `{ name, size, kind, extracted }` são gravadas no JSON `chat_mensagens.attachments`.
6. **Persiste a mensagem do usuário** em `chat_mensagens` (`role: "user"`, texto final = texto + blocos de anexo) — **antes** de qualquer chamada à ponte.
7. Ponte não configurada → `{ ok: false, reason: "unavailable", retryable: true }` (a mensagem do usuário já ficou gravada; o agente não foi chamado).
8. **Sessão OpenClaw:** se `chats.session_key` está ausente **ou** o `agentId` embutido no `sessionKey` ≠ agente pedido (ex.: chat criado para a Isa e reatribuído à Alpha), chama `bridge.resolveSession({ agentId, chatKey: chat.chatKey ?? String(chat.id) })` e **grava o novo `sessionKey` no chat**. A chave canônica é `agent:<agentId>:<slug>`; o BFF é chamado via `POST /api/sessions` (com `label` = chatKey minúsculo) e, se a sessão já existia, a label é atualizada via `PATCH /api/sessions`. **Em erro/timeout do `resolveSession`, a ponte devolve a chave determinística de qualquer forma** (`{ sessionKey: key, existing: false }`) — o envio continua e o `sessionKey` é persistido mesmo sem confirmação do BFF (comportamento do código).
9. **Injeção de contexto:** o texto enviado à agente é prefixado por `describeOnboardingState(...)` (§7.5) + lembrete de transparência. Isso acontece **em todo turno**, não só no primeiro. Falha ao montar o contexto é engolida (`try/catch`): o turno é enviado sem prefixo (best-effort).
10. `bridge.send(...)` → `POST /api/chat/send` do BFF com `{ sessionKey, message, agentId }`. Sucesso → `{ ok: true, messageId? }` (usa `runId` ou `messageId` do BFF). Exceção/timeout → `{ ok: false, reason: "offline", retryable: true }`; HTTP ≥500 → `offline` retryable; HTTP 4xx → `http_error` não retryable.
11. **Lazy sync:** `syncAgentMessages` busca `GET /api/chat/history` da sessão (limit 500) e insere em `chat_mensagens` (`role: "agent"`) toda mensagem de agente ainda não presente **por igualdade exata de texto** (Set sobre `trim()`). Falha do sync é apenas logada (`warn`).

**Reutilização:** mensagens seguintes seguem o mesmo caminho e **reutilizam** o `sessionKey` gravado; nova resolução só ocorre com troca explícita de `agentId` ou ausência de chave (confirmado em §6.8).

**Camada cliente (front):** `createAgentChatClient` mantém uma promessa compartilhada de sessão para não criar duas em envios rápidos e, no primeiro `sendMessage`, chama `startSession()` (que consome `POST /api/session` com `{ chatKey: visitorKey }`). Em falha de transporte da sessão, a mensagem vai para o **outbox em memória** (`enqueue`) — recuperável por `flushOutbox()`, que nenhum chamador no front da Isa invoca hoje (§13). O componente `AgentChat` habilita o polling de histórico (`historyRefreshIntervalMs = 5000` no front da Isa) **após o primeiro envio** (`sessionReady`).

## 7. Etapa 3 — Onboarding de nome, e-mail e telefone (`POST /api/onboarding/*`)

Todos os endpoints recebem `chatId` (numérico ou `chatKey`) e são anônimos. Quem conduz a conversa é a Isa (agente no OpenClaw); as rotas abaixo são a superfície de dados usada pelas ferramentas da agente. O bloco injetado em cada turno (§6.10, detalhe em §7.5) é que orienta o que ela deve pedir — **as definições das ferramentas em si não vivem neste módulo** (§13).

### 7.1 Nome (`POST /api/onboarding/name`)

- Body `{ chatId, nome }` (ambos obrigatórios, senão `400`).
- Grava `chats.visitor_name` (trim, cortado a 150). Retorna `{ ok: true, chatId }`.
- Chat inexistente → `400 "Chat não encontrado"`. Idempotente por sobrescrita.

### 7.2 E-mail → código (`POST /api/onboarding/email`)

- Valida formato com `EMAIL_RE` (`^[^\s@]+@[^\s@]+\.[^\s@]{2,}$`); inválido → `{ ok: false, reason: "invalid_email" }` (HTTP 200).
- Gera **código de 6 dígitos** e calcula `codeHash = SHA-256("código::email::secret")` (secret = `ISA_VERIFICATION_SECRET` ou fallback dev — §2). O código em claro **não é persistido**.
- **Expiração: 10 minutos** (`CODE_TTL_MS = 600 000 ms`), retornada como `expiresAt`.
- Insere `email_verifications` (`chat_id`, `email` minúsculo, `code_hash`, `expires_at`, `attempts = 0`, `used = false`).
- Atualiza `chats`: `pending_email` (minúsculo) e **`status = "aguardando_codigo"`**.
- **Envio por SMTP (condicional — depende da configuração `SMTP_*`):** se `SMTP_HOST` existe, envia e-mail com o código (HTML + texto; remetente `SMTP_FROM`, fallback `noreply@globaltecnologia.com.br`; `secure = true` apenas na porta 465; auth omitida sem `SMTP_USER`). **Se o envio falhar (exceção do nodemailer) ou não houver SMTP, a API ainda retorna `{ ok: true, expiresAt }`** — a falha de envio é apenas logada. Nuance verificada no código: quando o SMTP está ausente, **o código é sempre logado em claro** pela rota (`warn` "SMTP não configurado. Código: …"), independentemente de `AUTH_CODE_DEBUG_LOG` — que só controla um log adicional no caminho do transportador. Sem SMTP configurado, o visitante não tem como receber o código pela API.

### 7.3 Verificação (`POST /api/onboarding/verify`)

- Busca a verificação **mais recente não usada** do par (chat, e-mail minúsculo). Sem registro → `{ ok: false, reason: "no_active_code" }`.
- Ordem exata das checagens:
  1. `expires_at ≤ agora` → `reason: "expired"` (não incrementa tentativas);
  2. `attempts ≥ 5` (`MAX_ATTEMPTS = 5`) → `reason: "too_many_attempts"`;
  3. hash divergente → incrementa `attempts` no registro e retorna `reason: "wrong_code"`.
- Código correto: marca `used = true`; **busca ou cria `contatos`** (`email` minúsculo, `origem = "isa-chat"`, `nome = chats.visitor_name`; se o contato já existia sem nome e o chat tem nome, preenche o nome); **vincula `chats.contato_id`, grava `status = "verificado"` e limpa `pending_email`**. Retorna `{ ok: true }`.
- As 5 tentativas são **por registro de código**; reenviar (§7.4) cria novo registro com `attempts = 0`.

### 7.4 Reenvio (`POST /api/onboarding/resend`)

- Exige `chats.pending_email` (senão `{ ok: false, reason: "no_pending_email" }`).
- Reexecuta `startEmailVerification` com o e-mail pendente: **novo registro** em `email_verifications` (novo código, novo prazo de 10 min, tentativas zeradas). A verificação sempre considera o registro **mais recente não usado**; o código antigo fica invalidado por posição (deixa de ser o mais recente), sem marcação explícita de revogação.

### 7.5 Contexto injetado (`describeOnboardingState`) — como a Isa "sabe" o que pedir

Bloco `[Estado do onboarding]` prefixado em **todo** turno enviado à agente, com o `chatId` técnico e uma destas ramificações:

- `contatoEmail` presente → "Identidade verificada: … NÃO peça nome ou email novamente." + telefone registrado ("NÃO peça o telefone novamente") **ou** "Telefone: (não coletado). Quando for o momento natural da conversa, peça o telefone do cliente (com DDD) e registre com a ferramenta registrar_telefone."
- `status = "aguardando_codigo"` → nome coletado + "Email informado, aguardando o código de confirmação enviado para …". "Quando o cliente disser o código, chame a ferramenta de verificação. Se disser que não recebeu, chame a ferramenta de reenvio. Nunca invente ou exiba o código."
- Demais → "Visitante ainda não verificado. … conduza a conversa naturalmente e, quando for o momento, colete nome e email usando as ferramentas de registro."

Sempre encerrado com `TRANSPARENCY_REMINDER`: a Isa deve deixar claro que **(1) todas as conversas são gravadas** e **(2) o sistema está em modo DEMO**.

### 7.6 Telefone — opcional (`POST /api/onboarding/phone`)

- Valida formato BR `BR_PHONE_RE` (DDD + 10–11 dígitos com separadores, ex. `(11) 91234-5678`); inválido → `{ ok: false, reason: "invalid_phone" }`.
- Exige `chats.contato_id` (sem identidade verificada → `reason: "contact_not_found"`). Grava `contatos.telefone`. Idempotente por sobrescrita. Retorna `{ ok, chatId }`.

## 8. Modo legado por e-mail (`POST /api/session` com `email`)

- **Portão:** exige ponte configurada; sem `ISA_BFF_UPSTREAM` → `400 "Ponte OpenClaw não configurada"` (única validação de ponte nessa rota).
- Busca ou cria `contatos` pelo e-mail (trim/lowercase; `nome` opcional; `origem = "isa-chat"`).
- Busca chat por join `chats ⋈ contatos` no e-mail do contato. **Novo:** insere `chats` com `status = "autenticado"` + saudação personalizada em `chat_mensagens` (`Olá[, nome]! Sou a Isa, …`). **Existente:** reusa o chat e devolve o status atual.
- Retorna `{ ok, chatId, existing, contactId, onboarding: { state, verified: true, name, email } }`.
- **Mesma regra do modo anônimo: além do portão, nenhuma chamada à ponte — a sessão OpenClaw continua nascendo só no primeiro `chat/send` válido.**
- Limitações registradas do código (não são intenção deduzida): o `name/email` do `onboarding` retornado refletem a entrada da requisição (em reuso sem `nome` no corpo, `name` volta `null` mesmo havendo contato com nome); o join de reuso não filtra chats por `contatoId` nulo.

## 9. Histórico (`GET /api/chat/:id/history`) — somente leitura em relação à sessão

- Chat não encontrado → `{ ok: false, chatId, messages: [], project: { name: null, definitions: [] }, onboarding: { state: "novo", verified: false } }` (HTTP 200).
- **Não resolve sessão:** faz lazy sync **apenas se** `chats.session_key` existe e a ponte está configurada (comentário no código: "Se o chat ainda não tem sessionKey, a sessão será criada no primeiro envio válido" — coerente com `docs/isa-fluxo-sessao.md`).
- Retorna mensagens de `chat_mensagens` ordenadas por `created_at` (mapeamento defensivo `assistant → agent`), o estado de onboarding e o bloco `project`:
  - **Com `chats.projeto_id`** (pós-finalização): nome de `projetos_captados` + definições do projeto ordenadas por `seq`.
  - **Sem `projeto_id`**: nome de `chats.nome_projeto` + definições do **buffer do chat** (`definicoes.chat_id = chat` e `projeto_id IS NULL`, por `seq`, limit 10 000).
- É assim que o front mostra as respostas da agente: `POST /chat/send` **não devolve o texto da resposta** (devolve apenas `ok/messageId`); a resposta chega pelo sync (lazy, §6.11) e é lida no polling de 5 s do histórico iniciado após o primeiro envio.

## 10. Definições e nome do projeto (`POST /api/definition`, `POST /api/definition/update`, `POST /api/project/name`)

### 10.1 Registrar definição (`POST /api/definition`)

- Body `{ chatId, definition }` (campo alternativo aceito: `texto`); texto vazio após trim → `400` no controller; sem `chatId` → `400`.
- **Pré-requisito:** chat existe (senão `chat_not_found`) **e** `chats.contato_id` — identidade verificada. Sem isso → `{ ok: false, reason: "not_verified" }` (confirmado por teste).
- `seq` estável: `max(seq)+1` sobre o projeto (se `projetoId` existe) ou sobre o buffer do chat. Insere em `definicoes` com `projetoId = chat.projetoId ?? null` e `chatId = projetoId ? null : chat.id` — ou seja, **antes da finalização a definição fica no buffer do chat; depois, diretamente no projeto**.
- **Não é idempotente:** cada chamada cria uma linha nova (repetir a confirmação duplica a definição). Retorna `{ ok: true, id }` e loga o registro.

### 10.2 Alterar definição (`POST /api/definition/update`)

- Exige `chatId`, `id` e texto (trim não vazio; senão `400`). Pré-requisitos de estado iguais a §10.1 (chat existe; `not_verified` sem contato; texto vazio → `definition_not_found`).
- `id` precisa ser inteiro; a definição precisa **pertencer ao chat (buffer) ou ao projeto do chat** — definição alheia → `{ ok: false, reason: "definition_not_found" }` (confirmado por teste: recusa definição de outro chat).
- Substitui `texto` (UPDATE). Idempotente por sobrescrita. Retorna `{ ok: true, id }` (o `id` enviado, como string).

### 10.3 Nome do projeto (`POST /api/project/name`)

- Body `{ chatId, projectName }` (alias aceito: `nome`; vazio → `400`). **Não exige verificação nem projeto existente.**
- Grava `chats.nome_projeto` (trim, cortado a 200). **Se o chat já tem `projeto_id`** (cliente voltou após fechar), atualiza também `projetos_captados.nome`. Idempotente por sobrescrita.
- Retorna `{ ok: true, chatId }`; chat inexistente → `{ ok: false, reason: "chat_not_found" }`.

## 11. Finalização da captação (`POST /api/onboarding/finalize`)

Pré-requisitos na ordem exata do código (`finalizeOnboarding(chatId, descricao?)`):

1. Chat existe — senão `{ ok: false, reason: "chat_not_found" }`.
2. **Identidade verificada** (`chats.contato_id`) — senão `reason: "not_verified"`.
3. **Idempotência:** se `chats.projeto_id` já existe → **não cria nada**: atualiza `projetos_captados.descricao` apenas se `descricao` veio no corpo, marca `chats.status = "finalizado"` e retorna `{ ok: true, chatId, projetoId }`.
4. **Nome do projeto obrigatório** (`chats.nome_projeto`, preenchido via §10.3) — senão `reason: "project_name_required"`; também se o slug derivado ficar vazio (nome sem nenhum caractere `a-z0-9`).
5. **Ao menos 1 definição no buffer do chat** — senão `reason: "no_definitions"`.

Ação (chamadas sequenciais via Drizzle; **não há transação única explícita** no código):

- **Slug:** `slugDoNomeProjeto` = NFD → remove acentos → minúsculas → não-`a-z0-9` colapsados em `-`, sem hífens nas bordas, ≤80 caracteres; colisões recebem sufixo `-2`, `-3`… (loop de checagem contra `projetos_captados.slug`, coluna UNIQUE).
- **Descrição:** a `descricao` enviada (trim) ou **fallback determinístico** = definições numeradas (`1. …\n2. …`).
- **Insere `projetos_captados`** (`nome`, `slug`, `descricao`, `contatoId`, `ativo = true`).
- **Vincula as definições do buffer** ao projeto novo (`UPDATE definicoes SET projeto_id = novo, chat_id = NULL` onde `chat_id = chat` e `projeto_id IS NULL`) — preservando `seq`.
- **Atualiza o chat:** `projeto_id = novo` + `status = "finalizado"`; loga a conclusão.
- Retorna `{ ok: true, chatId, projetoId, slug }`.

Depois da finalização: novas definições entram direto no projeto (§10.1), o nome pode seguir sendo ajustado (§10.3), o histórico reflete o projeto vinculado (§9) e refinalizar é idempotente (item 3 acima).

## 12. Condições de falha e comportamentos condicionados à configuração

| Situação | Comportamento verificado no código |
| --- | --- |
| **Ponte não configurada** (`ISA_BFF_UPSTREAM` vazio) | `POST /session` anônimo **funciona** (chat local + saudação; nenhuma chamada à ponte). `POST /session` legado: `400 "Ponte OpenClaw não configurada"`. `POST /chat/send`: chat inexistente **não é materializado** → `chat_not_found` (não retryable); chat existente persiste a mensagem do usuário e retorna `{ ok: false, reason: "unavailable", retryable: true }` sem chamar a agente. `GET /history`: funciona, sem sync de respostas. |
| **BFF fora do ar / timeout / 5xx no send** | `bridge.send` → `{ ok: false, retryable: true }` → API responde `{ reason: "offline", retryable: true }`; o `api-client` enfileira a mensagem no outbox em memória. A mensagem do usuário **já foi persistida** antes da tentativa. |
| **HTTP 4xx do BFF no send** | `{ ok: false, reason: "http_error", retryable: false }`. |
| **Erro/timeout em `resolveSession`** | A ponte **degrada devolvendo a chave determinística** e o fluxo segue; o `sessionKey` é persistido no chat mesmo sem confirmação do BFF. |
| **Falha no `history` da ponte (lazy sync)** | Silenciosa (log `warn`); respostas da agente podem atrasar para o próximo sync. |
| **Falha no `PATCH` de label de sessão** | Silenciosa — label é estético e não bloqueia. |
| **SMTP ausente** | Fluxo de verificação prossegue com `{ ok: true, expiresAt }`; **o código é logado em claro no `warn` da rota** (sempre, nesse caminho — ver §7.2). Sem SMTP, o visitante não tem canal oficial para receber o código; `AUTH_CODE_DEBUG_LOG=true` gera apenas um log adicional. |
| **SMTP presente, envio falha** | Mesmo retorno `{ ok: true, expiresAt }`; erro apenas logado. O código gravado continua valendo (não há reemissão automática). |
| **Código errado** | `wrong_code` + 1 tentativa consumida (máx. 5 por código). |
| **Código expirado (>10 min)** | `expired`; a checagem de expiração vem **antes** da de tentativas e não incrementa `attempts`. |
| **5 tentativas erradas** | `too_many_attempts` (o registro continua não-usado; a saída no fluxo é o reenvio, que gera código novo). |
| **Sem código ativo para (chat, e-mail)** | `no_active_code`. |
| **Sem identidade verificada** | `definition`/`definition/update` → `not_verified`; `finalize` → `not_verified`; `phone` → `contact_not_found`. |
| **Finalizar sem nome ou sem definições** | `project_name_required` / `no_definitions`. |
| **`chatId` desconhecido em `onboarding/name·email·verify·resend·phone`** | `400 "Chat não encontrado"` (diferente dos endpoints de captação `definition*`/`project/name`/`finalize`, que devolvem HTTP 200 com `ok:false` + reason). |
| **Falha ao montar o contexto de onboarding** | Engolida (`try/catch`): turno enviado à agente sem o prefixo de contexto. |

## 13. O que o código NÃO faz (para não inferir comportamento)

Conferido por busca no workspace (código vigente; checkouts legados como `wt-deploy/` e `projects/isa-chat` antigo ignorados quando divergem):

- **Nenhuma definição de ferramenta da agente (`registrar_telefone`, verificação, reenvio, registro de nome/definição) existe neste repositório/módulo.** O prompt injetado (§7.5) nomeia as ferramentas, mas o catálogo vive na configuração da Isa no OpenClaw/Console — fora do escopo deste módulo.
- **Nenhum consumidor no front chama `POST /api/onboarding/*`, `/api/definition*` ou `/api/project/name`.** O site da Isa usa apenas `site-visit`, `session`, `chat/send` e `history` (via `createAgentChatClient`); as demais rotas são superfície para as ferramentas da agente/integrações.
- **A ponte expõe `abort` e `renameSession`, mas o service nunca as chama** — não há endpoint de abort/renomeação no controller.
- **`flushOutbox` existe no `api-client` mas nenhum chamador no front da Isa o invoca** — mensagens em outbox só saem se algum consumidor chamar explicitamente.
- **Colunas do schema não escritas por este módulo:** `chats.merged_into` (fusão "1 chat por email" é regra de schema/motor, não de `isa-chat`), `chats.handoffs`/`chats.session_keys` (json de handoff), `chats.email`/`chats.name` (usados por caminhos do motor), `chat_mensagens.typing`/`chat_mensagens.seq`.
- **Status que nenhum código deste módulo grava:** `em_andamento` (comentário do schema) e `conversando` (rótulo do front). Os status gravados são os da §15.
- **A criação de `projetos_captados` pelo `finalizeOnboarding` não popula `repoPath`/`buildCommand`/`unitTestCommand`** (esses campos vivem em `projeto_motor_config`, alimentado fora do fluxo da Isa) nem `plataformaProjetoId`/`agenteId`/`regras`; o ambiente de execução e o vínculo com a plataforma são preenchidos por outros caminhos.
- **Nenhuma rota de `isa-chat` lê `projetos_captados`/`contatos` diretamente** — para o visitante anônimo, a leitura do projeto captado é feita pelo bloco `project` do histórico (§9). A revisão administrativa desses dados existe em outro controller autenticado (`gerenteagentes.controller.ts`, rotas `/api/gerenteagentes/contatos` e `/api/gerenteagentes/projetos-captados`, fora do escopo deste módulo).

## 14. Resumo sequencial (tabela dos eventos)

| # | Evento | Endpoint | Efeito no banco | Chama o OpenClaw? |
| --- | --- | --- | --- | --- |
| 0 | Chegada à página | `POST /api/site-visit` | `visitas_site` (+`ip_hash`) | Não |
| 1 | Abertura do widget | `POST /api/session` (`chatKey`) | `chats` (`aberto`) + saudação estática em `chat_mensagens` | Não |
| 2 | Primeira mensagem | `POST /api/chat/send` | `chat_mensagens` (user) → `chats.session_key` → `chat_mensagens` (agent via sync) | **Sim: resolveSession + send + history** |
| 3 | Mensagens seguintes | `POST /api/chat/send` | idem, reusa `sessionKey` | Sim (send + lazy sync) |
| 4 | Nome | `POST /api/onboarding/name` | `chats.visitor_name` | Não |
| 5 | E-mail → código | `POST /api/onboarding/email` | `email_verifications` + `chats.pending_email`, `status=aguardando_codigo` | Não (SMTP sim) |
| 6 | Cliente informa o código | `POST /api/onboarding/verify` | `email_verifications.used`, `contatos` (novo/vínculo), `chats.contato_id`, `status=verificado` | Não |
| 7 | Telefone (opcional) | `POST /api/onboarding/phone` | `contatos.telefone` | Não |
| 8 | Definições | `POST /api/definition` · `/api/definition/update` | `definicoes` (buffer do chat → após finalizar, do projeto) | Não |
| 9 | Nome do projeto | `POST /api/project/name` | `chats.nome_projeto` (+`projetos_captados.nome` se já criado) | Não |
| 10 | Finalizar captação | `POST /api/onboarding/finalize` | `projetos_captados` + `definicoes.projeto_id` + `chats.projeto_id`, `status=finalizado` | Não |
| — | Reabrir a página / reler | `POST /api/session` + `GET /api/chat/:id/history` | nada novo (histórico do que já existe; sync se houver `sessionKey`) | Só history (se `sessionKey`) |

## 15. Estados do chat (`chats.status`)

| Valor | Quem grava | Significado |
| --- | --- | --- |
| `aberto` | `createSession` anônima | Chat local criado pela abertura do widget. |
| `novo` | `sendMessage` (materialização por `chatKey` desconhecido) | Chat nascido junto do primeiro envio. |
| `aguardando_codigo` | `startEmailVerification` | E-mail informado, código emitido (10 min). |
| `verificado` | `verifyEmailCode` (código correto) | Contato criado/vinculado — identidade verificada. |
| `autenticado` | `createSession` legado (e-mail) | Modo legado entra já "verificado". |
| `finalizado` | `finalizeOnboarding` | Captação fechada, projeto criado. |

## 16. Máquina de estados em uma linha

`visita → chat local (sem agente) → 1º envio (sessão OpenClaw nasce) → conversa + nome → e-mail (código SMTP) → verificação (contato) → telefone (opcional) → definições (só com contato verificado) → nome do projeto → finalizar (projeto captado + slug + vínculo das definições) → [idempotente: re-finalizar só atualiza descrição]`
