/**
 * Seed inicial idempotente do projeto Vitrine IA (ESPEC-CRUD §Seed).
 *
 * Consertado na macro #10 (posição 2/11, subtarefa 1): a versão anterior
 * gravava colunas que NÃO existem no schema/migration 0000
 * (`textos_vitrine.titulo/corpo` → coluna real `conteudo`;
 * `planos.descricao` → `tagline` + `beneficios/texto_botao/ordem`;
 * `segmentos.nome` → `titulo` + `ordem`/`descricao`). Hoje alinha às
 * colunas reais de `schema.ts`.
 *
 * Conteúdo canônico = o material de referência da vitrine (RF-1/RF-5..RF-10:
 * planos Starter/Pro/Enterprise, métricas 24-7 / <3s / 60% / 5 dias,
 * FAQ, segmentos, textos por chave com `whatsapp_link` centralizado).
 *
 * Idempotência: `INSERT ... ON DUPLICATE KEY UPDATE` (padrão do arquivo).
 * - `textos_vitrine` tem unique em `chave` → upsert natural, sem id fixo;
 * - as demais tabelas só têm PK, então o seed gerencia ids canônicos 1..N
 *   (rodar N vezes mantém exatamente as mesmas linhas, sem duplicar);
 * - a cláusula UPDATE NUNCA toca `ativo`: conteúdo editado no painel é
 *   respeitado e linhas desativadas continuam fora da vitrine pública.
 *
 * Uso: node --env-file=<repo>/.env projects/vitrine-ia-loja-de-atendentes-virtuais/seed.ts
 * (o banco do projeto é derivado de MYSQL_DATABASE — projeto_8509 no deploy local.)
 */
import { createConnection } from "mysql2/promise";

/**
 * Textos livres da vitrine — coluna real `conteudo` (varchar `chave` é a
 * unique do upsert; sem `ordem` no schema). `whatsapp_link` é o link
 * centralizado dos botões (RF-9).
 */
const TEXTOS_VITRINE = [
  {
    chave: "hero_titulo",
    secao: "hero",
    conteudo: "Seu atendimento 24 horas com inteligência artificial",
  },
  {
    chave: "hero_subtitulo",
    secao: "hero",
    conteudo:
      "Atendente virtual que responde no seu site e no WhatsApp — qualificando leads, tirando dúvidas e vendendo enquanto você dorme.",
  },
  { chave: "hero_cta", secao: "hero", conteudo: "Experimente agora" },
  {
    chave: "dor_horario_comercial",
    secao: "dores",
    conteudo:
      "67% dos consumidores esperam resposta em até 1 hora. Se ninguém responde à noite ou no fim de semana, o cliente vai pro concorrente.",
  },
  {
    chave: "dor_fila_whatsapp",
    secao: "dores",
    conteudo:
      "Um atendente humano leva em média 4 minutos para responder. Nesse tempo, o lead já esfriou — ou desistiu.",
  },
  {
    chave: "dor_custo",
    secao: "dores",
    conteudo:
      "Cada atendente humano custa R$ 2.500–4.000/mês e só atende um por vez. Escalar o atendimento vira um pesadelo financeiro.",
  },
  {
    chave: "beneficio_humano",
    secao: "beneficios",
    conteudo:
      "IA generativa que entende contexto, gírias e perguntas complexas. Nada de menu robótico — conversa natural.",
  },
  {
    chave: "beneficio_canais",
    secao: "beneficios",
    conteudo:
      "Funciona no chat do seu site e no WhatsApp que sua empresa já usa. Sem trocar número, sem instalar nada.",
  },
  {
    chave: "beneficio_leads",
    secao: "beneficios",
    conteudo:
      "Identifica o interesse do visitante, coleta dados e encaminha leads quentes para seu time comercial.",
  },
  {
    chave: "beneficio_base_conhecimento",
    secao: "beneficios",
    conteudo:
      "Treinado com seus FAQs, catálogo, políticas e processos. Responde com precisão sobre seu negócio.",
  },
  {
    chave: "beneficio_transbordo",
    secao: "beneficios",
    conteudo:
      "Quando a conversa precisa de um humano, transfere com contexto completo. O atendente já sabe tudo.",
  },
  {
    chave: "beneficio_relatorios",
    secao: "beneficios",
    conteudo:
      "Acompanhe volume de conversas, temas mais perguntados, satisfação e taxa de resolução.",
  },
  {
    chave: "como_funciona_passo_1",
    secao: "como_funciona",
    conteudo:
      "Você nos manda o conteúdo: FAQs, catálogo, políticas, preços — tudo que o atendente precisa saber sobre sua empresa.",
  },
  {
    chave: "como_funciona_passo_2",
    secao: "como_funciona",
    conteudo:
      "Configuramos a IA: treinamos o atendente com a identidade, o tom e as regras do seu negócio. Você aprova antes de ir ao ar.",
  },
  {
    chave: "como_funciona_passo_3",
    secao: "como_funciona",
    conteudo:
      "Está funcionando: em até 5 dias, o atendente está no seu site e/ou WhatsApp. Escaneou o QR Code, começou a atender.",
  },
  {
    chave: "cta_titulo",
    secao: "cta",
    conteudo: "Pronto para transformar seu atendimento?",
  },
  {
    chave: "cta_texto",
    secao: "cta",
    conteudo:
      "Comece hoje e tenha seu atendente virtual funcionando em até 5 dias. Sem fidelidade, sem complicação.",
  },
  {
    chave: "whatsapp_link",
    secao: "contato",
    conteudo:
      "https://wa.me/5521988161553?text=Ol%C3%A1!%20Vim%20pelo%20site%20e%20quero%20saber%20mais%20sobre%20o%20Atendente%20Virtual%20IA.",
  },
  {
    chave: "contato_texto",
    secao: "contato",
    conteudo: "Fale com a gente pelo WhatsApp e receba nossa proposta sem compromisso.",
  },
] as const;

/**
 * Planos comerciais (RF-5) — colunas reais: tagline, beneficios (JSON),
 * texto_botao, ordem. Ids canônicos 1..3 para o upsert por PK.
 */
const PLANOS = [
  {
    id: 1,
    nome: "Starter",
    tagline: "Para quem está começando a automatizar",
    precoMensal: "297.00",
    precoSetup: "1500.00",
    beneficios: [
      "Atendente virtual no site",
      "Até 500 conversas/mês",
      "Base de conhecimento básica",
      "Respostas 24/7",
      "Relatórios mensais",
      "Suporte por email",
    ],
    textoBotao: "Começar agora",
    maisPopular: false,
    ordem: 1,
  },
  {
    id: 2,
    nome: "Pro",
    tagline: "Site + WhatsApp, sem limites",
    precoMensal: "597.00",
    precoSetup: "2500.00",
    beneficios: [
      "Atendente no site + WhatsApp",
      "Conversas ilimitadas",
      "IA treinada com seu conteúdo",
      "Qualificação de leads",
      "Transbordo para humano",
      "Relatórios semanais",
      "Suporte prioritário",
    ],
    textoBotao: "Quero o Pro",
    maisPopular: true,
    ordem: 2,
  },
  {
    id: 3,
    nome: "Enterprise",
    tagline: "Sob medida para sua operação",
    precoMensal: "1200.00",
    precoSetup: null,
    beneficios: [
      "Tudo do Pro, e mais",
      "Múltiplos canais",
      "Integração com CRM e ERP",
      "Personalização completa",
      "SLA garantido",
      "Gerente de conta dedicado",
      "Treinamento da equipe",
    ],
    textoBotao: "Falar com especialista",
    maisPopular: false,
    ordem: 3,
  },
] as const;

/** FAQ (RF-6) — ids canônicos 1..7; ordenação por `ordem`. */
const ITENS_FAQ = [
  {
    id: 1,
    pergunta: "Preciso trocar meu número de WhatsApp?",
    resposta:
      "Não. O atendente virtual funciona no WhatsApp que sua empresa já usa. Você escaneia um QR Code (como no WhatsApp Web) e pronto — a IA passa a responder pelo seu número existente.",
    ordem: 1,
  },
  {
    id: 2,
    pergunta: "O que acontece quando a IA não souber responder?",
    resposta:
      "A IA detecta automaticamente quando a conversa precisa de um humano e faz o transbordo — transferindo todo o contexto para seu atendente, sem que o cliente precise repetir nada.",
    ordem: 2,
  },
  {
    id: 3,
    pergunta: "Quanto tempo leva para o atendente entrar no ar?",
    resposta:
      "Em média 5 dias úteis após recebermos seu conteúdo (FAQs, catálogo, políticas). Quanto mais material você fornecer, mais inteligente o atendente fica desde o primeiro dia.",
    ordem: 3,
  },
  {
    id: 4,
    pergunta: "A IA pode inventar informações sobre meu negócio?",
    resposta:
      "Não. A IA é treinada exclusivamente com o conteúdo da sua empresa. Ela não inventa informações — se não souber responder, transfere para um atendente humano automaticamente.",
    ordem: 4,
  },
  {
    id: 5,
    pergunta: "Existe contrato de fidelidade?",
    resposta:
      "Não. Sem contrato de fidelidade, sem multa. Você pode cancelar a qualquer momento. Acreditamos que o serviço se mantém pela qualidade, não pela burocracia.",
    ordem: 5,
  },
  {
    id: 6,
    pergunta: "As conversas são seguras e alinhadas à LGPD?",
    resposta:
      "Sim. Todas as conversas são criptografadas e armazenadas em servidores seguros. Seguimos as diretrizes da LGPD e não compartilhamos dados com terceiros.",
    ordem: 6,
  },
  {
    id: 7,
    pergunta: "Posso controlar o jeito que a IA conversa?",
    resposta:
      "Sim! Antes de ir ao ar, você aprova o tom de voz, as respostas padrão e os limites do que a IA pode ou não falar. Ela age como um extensionista da sua marca.",
    ordem: 7,
  },
] as const;

/** Métricas de destaque (RF-7) — ids canônicos 1..4. */
const METRICAS = [
  { id: 1, valor: "24/7", rotulo: "Atendimento contínuo", ordem: 1 },
  { id: 2, valor: "< 3s", rotulo: "Tempo de resposta", ordem: 2 },
  { id: 3, valor: "60%", rotulo: "Redução de custo", ordem: 3 },
  { id: 4, valor: "5 dias", rotulo: "Para estar no ar", ordem: 4 },
] as const;

/** Segmentos (RF-8) — coluna real `titulo` (+ descricao/icone/ordem). */
const SEGMENTOS = [
  {
    id: 1,
    titulo: "Clínicas e consultórios",
    descricao: "Agendamento, lembretes e dúvidas sobre procedimentos",
    icone: null,
    ordem: 1,
  },
  {
    id: 2,
    titulo: "Escritórios",
    descricao: "Captação de clientes, triagem e agendamento de reuniões",
    icone: null,
    ordem: 2,
  },
  {
    id: 3,
    titulo: "Imobiliárias",
    descricao: "Qualificação de leads, visita a imóveis e informações de listings",
    icone: null,
    ordem: 3,
  },
  {
    id: 4,
    titulo: "E-commerce",
    descricao: "Suporte pré e pós-venda, status de pedido e recomendações",
    icone: null,
    ordem: 4,
  },
  {
    id: 5,
    titulo: "Escolas e cursos",
    descricao: "Matrículas, informações sobre turmas e suporte ao aluno",
    icone: null,
    ordem: 5,
  },
  {
    id: 6,
    titulo: "Restaurantes",
    descricao: "Reservas, cardápio, delivery e horários de funcionamento",
    icone: null,
    ordem: 6,
  },
  {
    id: 7,
    titulo: "Academias",
    descricao: "Planos, horários de aula, reservas e renovação de matrícula",
    icone: null,
    ordem: 7,
  },
  {
    id: 8,
    titulo: "Indústria e serviços",
    descricao: "Orçamentos, suporte técnico e acompanhamento de pedidos",
    icone: null,
    ordem: 8,
  },
] as const;

async function main(): Promise<void> {
  const database = process.env.MYSQL_DATABASE;
  // Guarda de segurança: o seed escreve no database FÍSICO do projeto
  // (projeto_8509 no deploy local). Rodar com o .env da raiz sem override
  // apontaria para o core — onde estas tabelas não existem.
  if (!database || database === "core") {
    throw new Error(
      "MYSQL_DATABASE deve apontar para o database do projeto (ex.: projeto_8509) — nunca para o core",
    );
  }
  const conn = await createConnection({
    host: process.env.MYSQL_HOST ?? "localhost",
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "",
    database,
    multipleStatements: false,
  });

  try {
    const [rTextos] = await conn.query(
      `INSERT INTO textos_vitrine (chave, secao, conteudo, ativo) VALUES ?
       ON DUPLICATE KEY UPDATE secao = VALUES(secao), conteudo = VALUES(conteudo)`,
      [TEXTOS_VITRINE.map((t) => [t.chave, t.secao, t.conteudo, true])],
    );
    const [rPlanos] = await conn.query(
      `INSERT INTO planos (id, nome, tagline, preco_mensal, preco_setup, beneficios, texto_botao, mais_popular, ordem, ativo) VALUES ?
       ON DUPLICATE KEY UPDATE nome = VALUES(nome), tagline = VALUES(tagline), preco_mensal = VALUES(preco_mensal), preco_setup = VALUES(preco_setup), beneficios = VALUES(beneficios), texto_botao = VALUES(texto_botao), mais_popular = VALUES(mais_popular), ordem = VALUES(ordem)`,
      [
        PLANOS.map((p) => [
          p.id,
          p.nome,
          p.tagline,
          p.precoMensal,
          p.precoSetup,
          JSON.stringify(p.beneficios),
          p.textoBotao,
          p.maisPopular,
          p.ordem,
          true,
        ]),
      ],
    );
    const [rFaq] = await conn.query(
      `INSERT INTO itens_faq (id, pergunta, resposta, ordem, ativo) VALUES ?
       ON DUPLICATE KEY UPDATE pergunta = VALUES(pergunta), resposta = VALUES(resposta), ordem = VALUES(ordem)`,
      [ITENS_FAQ.map((f) => [f.id, f.pergunta, f.resposta, f.ordem, true])],
    );
    const [rMetricas] = await conn.query(
      `INSERT INTO metricas_destaque (id, valor, rotulo, ordem, ativo) VALUES ?
       ON DUPLICATE KEY UPDATE valor = VALUES(valor), rotulo = VALUES(rotulo), ordem = VALUES(ordem)`,
      [METRICAS.map((m) => [m.id, m.valor, m.rotulo, m.ordem, true])],
    );
    const [rSegmentos] = await conn.query(
      `INSERT INTO segmentos (id, titulo, descricao, icone, ordem, ativo) VALUES ?
       ON DUPLICATE KEY UPDATE titulo = VALUES(titulo), descricao = VALUES(descricao), icone = VALUES(icone), ordem = VALUES(ordem)`,
      [SEGMENTOS.map((s) => [s.id, s.titulo, s.descricao, s.icone, s.ordem, true])],
    );

    console.log(
      JSON.stringify({
        database,
        textos_vitrine: { enviados: TEXTOS_VITRINE.length, resultado: rTextos },
        planos: { enviados: PLANOS.length, resultado: rPlanos },
        itens_faq: { enviados: ITENS_FAQ.length, resultado: rFaq },
        metricas_destaque: { enviados: METRICAS.length, resultado: rMetricas },
        segmentos: { enviados: SEGMENTOS.length, resultado: rSegmentos },
      }),
    );
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error("seed-falha", error);
  process.exitCode = 1;
});
