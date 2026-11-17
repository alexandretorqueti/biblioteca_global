# Isa como produto multitenant — análise (2026-11-17)

> Objetivo: vender a tecnologia da Isa (agente de atendimento/conversação com captura
> estruturada) para dezenas de clientes, cada um com suas regras de negócio.

## 1. O que temos hoje e o que ele prova

O caso Isa + Alpha já demonstra o padrão duas vezes: **mesma máquina, identidades
diferentes**. Alpha é o "cliente 2" feito por cópia. Componentes reutilizáveis:

| Camada | Peça atual | Reuso |
|---|---|---|
| Persona | Workspace OpenClaw (SOUL/IDENTITY/AGENTS.md) + Forjador (`definicaopersonalidadeagentes`) | 100% — o Forjador já gera persona a partir de uma descrição |
| Front | `isa-chat` (React + `AgentChat` da biblioteca) | ~90% — trocar hardcodes por config de tenant |
| Roteamento | `chat-proxy` (nginx, servidor por `server_name`) | base para resolver tenant por domínio |
| Backend | API Biblioteca (sessões, histórico, onboarding com verificação, ferramentas) | 100% — falta generalizar o que é específico da Isa |
| Regras de negócio | Ferramentas da LLM (`registrar_email`, `verificar_codigo`...) + módulos da API (o Alpha usa `encomendas-morador`, `ocorrencias`) | **este é o ponto-chave de expansão** |
| Modelo | ollama local (qwen3.6 35B) | compartilhável, com política de custo |

## 2. Conceito do produto

**"Isas sob demanda"**: cada cliente ganha uma agente com nome, persona, visual e
regras próprios, atendendo no domínio dele (ou no WhatsApp/site dele), capturando
dados estruturados e integrando ao que ele já usa. A Global não escreve código por
cliente — monta configuração + escolhe ferramentas de um catálogo.

O ponto de arquitetura que torna isso viável já existe na Global: o padrão
`config.json` por projeto da Biblioteca. Aplicar o mesmo padrão ao chat.

## 3. Arquitetura multitenant proposta

### 3.1 Tenant = configuração, não aplicação
- App único **`chat-universal`** (evolução do isa-chat) que no boot resolve o tenant
  pelo `Host` (domínio) ou parâmetro embutido, baixa o config do tenant e renderiza:
  persona/nome/avatar, paleta, textos, campos do sidebar, idiomas, anexos permitidos.
- Config do tenant versionado em banco + JSON servido por endpoint público
  (`GET /api/tenants/<slug>/chat-config`). Zero rebuild por cliente novo — dezenas de
  clientes = um único bundle estático.

### 3.2 Persona por tenant, agente leve
- Modelo atual: 1 sessão OpenClaw por chat (`agent:isa:<chatKey>`) com 1 agente por
  persona. Para dezenas de clientes, manteria **agente por tenant** (não por chat)
  criado pelo **Forjador automaticamente** no onboarding do cliente — hoje isso já
  acontece no fluxo `projetos_captados` → gate de agente dedicado (§12 do fluxo da Isa).
- Persona/limites ficam no SOUL.md do agente do tenant; o contexto injetado por turno
  (estado + dados coletados) é geral, não específico da Isa.

### 3.3 Regras de negócio = catálogo de ferramentas por tenant
Extensão real é **tool calling com registro por tenant**:
- Catálogo de ferramentas mantido pela Global (ex.: `registrar_lead`,
  `agendar_visita`, `abrir_chamado`, `consultar_encomenda`, `verificar_codigo`,
  `finalizar_conversa`, `criar_tarefa_interna`).
- O config do tenant escolhe quais ferramentas a agente dele expõe, com quais
  parâmetros/obrigatoriedades e para onde os dados vão (endpoint interno, webhook do
  cliente, planilha, e-mail).
- Ferramenta específica demais de um cliente entra como **adaptador** na API (padrão
  dos módulos do Alpha: `encomendas-morador`, `ocorrencias`), sem tocar no core.
- Validação determinística no servidor (padrão consagrado da Isa): o modelo nunca
  valida código, prazo ou elegibilidade — o código valida.

### 3.4 Isolamento e dados
- Toda tabela de conversa/definição com `tenant_id` (o schema atual já é chat 1:1
  projeto; adicionar tenant é incremental).
- Backups e retenção por tenant; LGPD: a transparência obrigatória da Isa
  (conversas gravadas + aviso) vira item do config, com base legal e retenção
  configuráveis (alinhar com a tarefa 804).
- Segredos do tenant (SMTP, webhooks, tokens) no cofre por projeto da Biblioteca,
  nunca no config público.

### 3.5 Roteamento e acesso
- `chat-proxy` generalizado: `server_name` genérico → lookup de tenant no painel →
  `agentId` + config. SSL/túnel por domínio do cliente já é processo dominado
  (Cloudflare).
- Mesma agente pode atender em web + WhatsApp (o OpenClaw já suporta multi-canal;
  sessões separadas por canal, mesmo chat canônico via identidade).

### 3.6 Capacidade e modelos
Risco principal: dezenas de clientes simultâneos num ollama local.
- Fila/PQ por tenant + política: pico → fallback para modelo pago (a cadeia de
  escalonamento de modelos do motor já existe).
- Métricas por tenant (chats/dia, tokens, tempo de resposta) → sustenta o preço.

## 4. Modelo comercial

| Plano | O cliente recebe | Preço (sugestão) |
|---|---|---|
| Setup | persona forjada, config, embed no site/domínio, N ferramentas do catálogo | taxa única |
| Mensal básico | hosting, X conversas/mês, histórico, painel simples | R$/mês |
| Integrações | webhooks/ferramentas específicas, WhatsApp, volume extra | item à parte |

Vantagem competitiva: persona + captura estruturada + validação real por SMTP +
painel — pacote que chatbot de planilha não entrega, com custo marginal ~zero por
cliente novo (só config).

## 5. Roadmap em 3 fases (cada uma já gera receita)

**Fase 1 — extrair o genérico (valida o modelo):**
1. `chat-universal` com resolução de tenant por host + config runtime.
2. Backend: `tenants` + `tenant_tools` (registro), endpoints multi-tenant
   (`tenant_id` implícito no slug).
3. Migrar Isa e Alpha como os 2 primeiros tenants (paridade obrigatória antes de
   cortar o legado). **Critério de aceite:** os dois chats atuais idênticos, rodando
   100% pelo genérico.
- Esforço estimado: 1 sprint do motor (tarefas bem recortadas; a API já tem 80% por
  projeto/slug).

**Fase 2 — onboarding self-service:**
4. Tela "criar agente de atendimento" na Biblioteca: descreve o negócio → Forjador
   gera persona → escolhe cores/ferramentas → publica domínio.
5. Painel por tenant: conversas,leads capturados, métricas, export.

**Fase 3 — escala e monetização:**
6. Billing por volume, cotas, alerta de custo de modelo.
7. Catálogo público de integrações (WhatsApp, Google Agenda, ERPs comuns).
8. LGPD self-service por tenant (direitos do titular, retenção, DPA).

## 5.5 Página comercial atual (globalsolucoesti.com.br/chatbot, lida em 17/11)
**Alinhada** no essencial: site+WhatsApp, QR no número existente, persona/tom aprovados,
go-live 5 dias, LGPD citada, Isa de demonstração na página — coerente com a proposta.
**Gap funcional real vs o que prometemos:**
1. **Base de conhecimento (RAG)** por tenant — hoje NÃO existe na engenharia; é a maior
   diferença entre a promessa comercial ("treinada com seus FAQs/catálogo") e o estado atual.
2. **Transbordo humano** com contexto completo — não existe no catálogo de ferramentas.
3. Relatórios/métricas = Fase 2 prevista.
4. "Conversas ilimitadas" no Pro precisa casar com custo real de inferência
   (fallback para modelo pago destrói a margem) — cotas reais por plano.
5. Marca dividida: página em `globalsolucoesti.com.br`, produto/discussão em
   `globaltecnologia.net` — unificar antes de escalar.

## 6. Riscos e mitigação

- **Contaminação de contexto entre tenants** → separação dura: agente próprio por
  tenant + `tenant_id` em toda query + testes de isolamento no gate.
- **vRAM/custo de inferência** → fila + cadeia de fallback local→pago (já
  existe); cotas por plano.
- **Cada cliente querer regra própria infinita** → catálogo fechado + adaptadores
  pagos (a exceção vira receita, não gambiarra).
- **Diluir a marca Global** → o produto é "Global Agents powered by..." com theme
  white-label; a Isa original continua flagship no site da Global.
- **Um deploy quebrar todos os tenants** (lição de hoje: 16 dias de chat morto) →
  o smoke pós-deploy agora cobre os chats; no genérico, healthchecks por tenant.

## 7. Decisões pendentes com o Alexandre
1. Nome/marca do produto (ex.: "Global Agents", "Atendente Global").
2. Fazer como **plano/projeto no motor** a partir da Fase 1, ou protótipo primeiro?
3. Primeiro cliente-piloto candidado (real, para validar preço e escopo).

---

## 8. Complementos do debate (mesma data, perguntas do Alexandre)

### 8.1 Precisa de um agente por cliente?
**Sim — um agente "magro" por tenant** (recomendação aprovada em conversa).
- Alternativa "agente universal com persona injetada por sessão" foi descartada:
  memória/workspace seriam compartilhados entre clientes (contaminação depende de
  disciplina de prompt, não de isolamento). Inaceitável em produto pago com LGPD.
- Com agente por tenant o isolamento é **estrutural**: memória (MEMORY.md, sessões)
  é por workspace. É o padrão Isa/Alpha atual, com criação automatizada pelo Forjador
  no onboarding.
- Ponto de atenção: criar agente no registro do gateway mexe em config do OpenClaw →
  exige rotina automatizada e testada pela plataforma (plano antes de executar).

### 8.2 Quanto custa um agente, em armazenamento? (medição real 17/11)
O agente NÃO contém modelo — o cérebro é compartilhado (ollama/nuvem). Ele é só texto:
- Workspace do agente (SOUL/IDENTITY/AGENTS/TOOLS + memória): **Isa 536 KB, Alpha 416 KB**
  (medidos em `/data/workspace/projects/agentes/`).
- 50 clientes ≈ **25 MB** de textos. Nada.
- O que cresce com uso: **transcrições de conversa** (estado de sessão) → mitigado por
  **retenção configurável por tenant** (ex.: 12 meses, depois arquiva). Cliente parado
  = custo zero.
- O que cobra fatura é **token de inferência durante a conversa** → cota por plano
  (ver §3.6 e §4).

### 8.3 O que é multitenant (glossário do produto)
Uma aplicação atende N clientes ("tenants") simultaneamente com **isolamento logical**,
**config por cliente** e **infra compartilhada** — prédio com apartamentos: estrutura
comum, porta trancada em cada um. Oposto (monotenant/casa por cliente) não fecha em
custo com dezenas de vendas. Requisitos do produto: (1) isolamento de dados/memória;
(2) regras em config, não em fork; (3) recursos compartilhados com fila/cota;
(4) custo marginal ~zero por cliente novo.

### 8.4 Situação dos pilotos naturais
- **Isa** = flagship no site da Global (captação comercial).
- **Alpha** (condomínio Alphavile) = candidato natural a primeiro tenant do genérico —
  validaria o modelo com um cliente real de outra área de negócio.

### 3.7 Multicanal: WhatsApp por tenant (2026-11-17)
- OpenClaw já fala WhatsApp nativamente (canal plugável no gateway; pareamento por QR
  com o tool `whatsapp_login`). Encaixe: **vínculo canal↔agente por tenant** — painel
  do tenant gera QR, cliente escaneia com seu número, o gateway roteia as mensagens
  desse número para o agente do tenant.
- **Cadastrar só o número NÃO basta** (limite do WhatsApp, não nosso): pareamento
  exige escanear QR (ou API oficial Cloud). Fluxo automatizável: cadastro → QR no
  painel → escaneou → atende. Dois modos:
  - **Pro (pairing/Baileys):** número existente, sem custo por conversa, risco de
    bloqueio (WhatsApp não-oficial), sessão precisa de keep-alive.
  - **Enterprise (Cloud API oficial):** estável/auditável, mas exige Meta Business por
    cliente, templates aprovados (janela 24h) e custo por conversa → item de preço.
- **Identidade unificada:** telefone passa a ser identidade do chat canônico
  (mesmo padrão do e-mail no fluxo atual) → site + WhatsApp na mesma conversa.

## 6.5 Checkout self-service da venda (ideação 2026-11-17, Alexandre)
Funil: Isa-agente vende → cliente preenche formulário (dados do negócio) → upload de
arquivos com regras → configura transbordo humano → paga no cartão → provisionamento
automático do tenant, sem humano Global no loop.

**Já temos:** conversa de venda com captura estruturada (padrão da Isa com tool calling
— `criar_pedido`, `anexar_documento`, `escolher_plano`...), upload de arquivos (chat da
Isa já aceita anexos), storage de documentos por projeto, Forjador (persona), auth/RBAC
da Biblioteca, provisionamento programático (padrão `projetos_captados` → INICIAR
DESENVOLVIMENTO, aqui seria → criar tenant).

**Falta construir (em ordem de dependência):**
1. **Billing/checkout recorrente** — integração com PSP (Pagar.me ou Mercado Pago p/
   cartão+PIX+boleto e recorrência no Brasil; Stripe se quiser internacional).
   Checkout hospedado (checkout transparente do PSP embutido em iframe/modal) = PCI
   delegado; webhook `payment.approved` dispara o provisionamento. Nada disso existe hoje.
2. **RAG por tenant** (pré-requisito das vendas que sobem arquivos de regras — hoje o
   upload seria engolido sem uso). Sem RAG, o funil pode ir ao ar com escopo reduzido
   (persona + ferramentas de catálogo só).
3. **Passo transbordo como config** — campo simples no onboarding (ativo/inativo,
   horário, destino: número WhatsApp/nome do atendente); a mecânica de handoff em si é
   o gap §5.5-2. MVP pode ser: transbordo = notificar o número do cliente com o resumo.
4. **Orquestrador pós-pagamento** — a "missão do provisioning do tenant": Forjador gera
   persona dos dados+arquivos → cria tenant no banco → config inicial → envia credenciais
   e QR de WhatsApp por e-mail. É o mesmo padrão §11.2 do fluxo da Isa (INICIAR
   DESENVOLVIMENTO), adaptado.
5. **Agente-vendedor** — pode ser a própria Isa com modo/prompts de venda do produto
   (custo zero) ou agente irmão "Comercial" forjado para isso. Recomendo Isa primeiro:
   a página já usa ela como demo ("ela pode fazer o mesmo pelo seu negócio" — usar a
   Isa vendendo a si mesma É o argumento).

**Ordem recomendada:** MVP do funil = formulário + persona forjada + plano Starter sem
arquivos de regra (ou arquivos guardados p/ fase manual) + checkout. RAG e transbordo
entram como upsell quando a mecânica nascer. Venda automatizada não depende de RAG —
depende de checkout.

**Riscos específicos:**
- Fraude de cartão → usar PSP com antifraude embutido; nunca tocar em dados de cartão.
- Cliente paga e o provisionamento falha → fila durável + reconciliação (padrão dos
  reconciliadores do motor) + reembolsável; NUNCA perder pagamento sem tenant.
- "Regras" em arquivos de formatos malucos → RAG lida, mas validar tipo/tamanho no upload.
