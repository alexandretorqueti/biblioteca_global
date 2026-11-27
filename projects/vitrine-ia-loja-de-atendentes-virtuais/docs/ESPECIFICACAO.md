# Especificação — Vitrine IA — loja de atendentes virtuais

## Visão geral
A Vitrine IA é um sistema em React que substitui a atual página HTML de venda do serviço de atendente virtual (globalsolucoesti.com.br/chatbot/), transformando-a em uma vitrine parametrizável com fluxo completo de compra e pagamento. Um painel administrativo permite editar os elementos comerciais (planos, preços, FAQ, métricas, segmentos, textos-chave e WhatsApp) sem tocar no código. O cliente compra de duas formas — autoatendimento via formulário com envio de arquivos, ou assistido pela ISA — e, com o pagamento aprovado via Mercado Pago, o sistema provisiona automaticamente um novo agente no OpenClaw, treinado com os dados dele, entregando link definitivo, script de embed para o site e pareamento do WhatsApp. O objetivo é vender e ativar atendentes virtuais em escala, sem intervenção manual da Global a cada pedido.

## Atores/papéis
- Administrador (Global Tecnologia): opera o painel, parametriza a vitrine e cadastra integrações de clientes.
- Visitante/Cliente: percorre a vitrine e compra um agente (autoatendimento ou assistido pela ISA).
- ISA de vendas: atendente virtual embutida na página; conduz o caminho assistido, preenchendo o formulário em tempo real.
- Agente "Definição da Personalidade": serviço interno que gera identidade/regras dos agentes provisionados (selecionável por configuração).
- Agente do cliente: robô criado sob demanda, ativo no site e/ou WhatsApp do comprador.
- Agente desenvolvedor do projeto: constrói o sistema e valida os contratos (sessão dedicada de desenvolvimento).

## Requisitos funcionais
- RF-1: Página de vendas refeita em React, mantendo o conteúdo atual da página.
- RF-2: Painel administrativo parametriza apenas as partes necessárias: preços, planos e itens do FAQ.
- RF-3: Fluxo completo de vendas com pagamento, integrado com a ISA já existente na página.
- RF-4: Cliente preenche formulário com as informações do negócio e pode enviar arquivos.
- RF-5: Seção de planos editável no painel: quantidade livre de planos, cada um com nome, tagline, preço mensal, setup, lista de benefícios, texto do botão e destaque "mais popular".
- RF-6: Seção de FAQ editável no painel, com inclusão, edição e remoção de pares de pergunta e resposta.
- RF-7: Métricas do destaque (ex.: 24/7, <3s, 60%, 5 dias) editáveis no painel.
- RF-8: Cards de segmentos editáveis no painel, com inclusão e remoção (título, descrição e ícone).
- RF-9: Número/link do WhatsApp usado nos botões centralizado e editável no painel.
- RF-10: Textos principais editáveis no painel (título e subtítulo do hero, cards de dores e benefícios, passos "como funciona" e chamada final), mantendo o layout fixo da página.
- RF-11: Pagamento processado via Mercado Pago, reaproveitando a integração de checkout já existente no motor.
- RF-12: Fluxo de compra com dois caminhos: 1) autoatendimento sem IA — usuário clica, preenche o formulário e resolve tudo sozinho; 2) assistido pela ISA — ela coleta os dados pela conversa.
- RF-13: No caminho com IA, a ISA abre o formulário ao lado e o preenche em tempo real conforme o usuário conversa, mantendo os campos editáveis pelo usuário.
- RF-14: Entrega em fases: o fluxo assistido pela ISA com formulário ao lado só entra após a parte manual (autoatendimento) estar 100% funcionando.
- RF-15: O formulário de compra vive na página (fora do iframe da ISA); a ISA conversa com a página para preencher os campos, e o backend é a fonte única dos dados do pedido.
- RF-16: Após a confirmação do pagamento, o sistema provisiona automaticamente um novo agente no OpenClaw, treinado com as informações, configurações e arquivos enviados pelo cliente.
- RF-17: Depois do provisionamento, o cliente recebe duas entregas: um link para acessar o próprio agente e um script/código para embutir a IA no site dele.
- RF-18: O agente provisionado pode ser conectado ao WhatsApp do cliente via pareamento do WhatsApp Web (QR Code), passando a responder as mensagens automaticamente.
- RF-19: Configuração de alcance do WhatsApp: o agente pode atender qualquer pessoa ou apenas uma lista de números permitidos — isso vira configuração no OpenClaw.
- RF-20: Sem etapa de aprovação prévia: com pagamento confirmado, o cliente recebe o link definitivo do agente e ativa direto em produção, testando ali mesmo.
- RF-21: Ingest de conhecimento na fase 1: PDF, DOCX, TXT e texto livre digitado pelo usuário (imagens/áudio ficam a detalhar).
- RF-22: O agente usado para gerar as personalidades é selecionável via configuração (sem hardcode), mantendo o mesmo contrato de entrada/saída para qualquer agente escolhido.
- RF-23: A chamada ao agente de personalidade é contract-first: JSON de request e response com schema versionado, validado antes de aplicar; o agente desenvolvedor trabalha com testes de contrato usando payloads de exemplo.
- RF-24: O agente provisionado consome as APIs externas do cliente como tools dinâmicas por cliente (endpoint, autenticação, schema de parâmetros), consultando dados em tempo real durante a conversa; fase 1 contempla apenas leitura (consultas).
- RF-25: O painel administrativo tem uma seção "Integrações" por cliente, onde a Global cadastra as APIs negociadas à parte: URL, autenticação (API key ou OAuth2), headers e limites de requisição, com chave liga/desliga por integração.
- RF-26: Credenciais de APIs ficam cifradas no backend e nunca aparecem na conversa; se a API do cliente estiver fora do ar ou der erro, o agente usa a base de conhecimento avisando que o dado pode estar desatualizado, ou faz transbordo para humano quando configurado.
- RF-27: Referência visual do layout: a página https://globalsolucoesti.com.br/chatbot/ (versão HTML atual) é a base a ser replicada em React, mantendo a estrutura das seções (hero, métricas, dores, benefícios, como funciona, segmentos, planos, FAQ e CTA final).

## Requisitos não-funcionais
- Isolamento por cliente: cada agente provisionado roda em ambiente/configuração próprios, com base de conhecimento e credenciais segregadas (sem contaminação entre clientes).
- Segurança: credenciais de APIs externas cifradas no backend, nunca expostas nas conversas; dados pessoais tratados conforme LGPD (detalhamento a definir pela equipe).
- Robustez: provisionamento assíncrono após o webhook de pagamento, com saída fora do contrato gerando retry e falha limpa com alerta à Global (sem agente mal-configurado em produção).
- Volume esperado de acessos/pedidos: A detalhar.
- Disponibilidade/SLA: A detalhar.
- Dispositivos-alvo da vitrine (celular/desktop): A detalhar.

## Entidades de dados
- Plano (nome, tagline, preço mensal, setup, benefícios, botão, destaque).
- Item de FAQ (pergunta, resposta, ordem).
- Métrica de destaque e Card de segmento (título, descrição, ícone).
- Texto editável de seção (chave/conteúdo).
- Pedido (dados do negócio, contatos, plano, ciclo, status: pago/provisionado/entregue).
- Documento anexado (nome, MIME, conteúdo) — arquivos de conhecimento do cliente.
- Agente provisionado (config de personalidade, base de conhecimento, canais, status).
- Integração externa (URL, autenticação, headers, limites, ativo/Inativo, vínculo ao cliente).
- Configuração de WhatsApp (pareamento QR, alcance: todos ou whitelist de números).

## Integrações
- Mercado Pago — checkout/recorrência, reaproveitando a integração já existente no motor.
- OpenClaw — criação/provisionamento dos agentes por cliente e configuração de canais (web e WhatsApp, incluindo alcance).
- Agente "Definição da Personalidade" — serviço interno contract-first (JSON versionado) que gera identidade, tom, regras e transbordo de cada agente.
- WhatsApp — pareamento via WhatsApp Web (QR Code) feito pelo próprio cliente.
- APIs externas dos clientes — cadastradas sob demanda na seção "Integrações" do painel (fase 1: somente leitura).
- Infraestrutura/publicação (túnel, domínio) — responsabilidade do Alexandre, fora do escopo de desenvolvimento.

## Fora de escopo
- Redesenho do layout da vitrine — layout fixo replicando a página de referência; apenas conteúdo parametrizável.
- Caminho assistido pela ISA (formulário preenchido pela conversa) na primeira fase — entrega condicionada ao autoatendimento 100% funcionando.
- Escrita nas APIs externas dos clientes (fase 1 é somente leitura).
- Ingestão de imagens e áudio como conhecimento (a detalhar em fase futura).
- Deploy/publicação da página (túnel e domínio) — feito pelo dono do projeto.
- Negociação individual das APIs de cada cliente — tratada à parte, fora do sistema.