import { createConnection } from "mysql2/promise";

/**
 * Seed inicial idempotente do projeto Vitrine IA (ESPEC-CRUD §Seed).
 * Padrão: seed-indices da calculadora — INSERT ... ON DUPLICATE KEY UPDATE,
 * executável repetidamente sem duplicar linhas.
 *
 * Uso: node --env-file=<repo>/.env projects/vitrine-ia-loja-de-atendentes-virtuais/seed.ts
 * (o banco do projeto é derivado de MYSQL_DATABASE — projeto_8509 no deploy local.)
 */

const TEXTOS_VITRINE = [
  {
    chave: "hero.titulo",
    secao: "hero",
    titulo: "Atendentes virtuais com IA que vendem por você",
    corpo:
      "Sua empresa atende 24 horas no WhatsApp com um agente de IA treinado no seu negócio — sem contratar, sem treinar, sem perder cliente.",
  },
  {
    chave: "hero.subtitulo",
    secao: "hero",
    titulo: "Comece hoje",
    corpo:
      "Escolha um plano, envie seus documentos e receba seu atendente virtual pronto em minutos.",
  },
  {
    chave: "dores.titulo",
    secao: "dores",
    titulo: "Seu atendimento está perdendo vendas?",
    corpo: null,
  },
  {
    chave: "dores.item_1",
    secao: "dores",
    titulo: "Mensas sem resposta fora do horário",
    corpo: "Cliente que não recebe resposta rápida procura o concorrente.",
  },
  {
    chave: "dores.item_2",
    secao: "dores",
    titulo: "Equipe sobrecarregada com perguntas repetidas",
    corpo: "Horas perdidas respondendo sempre as mesmas dúvidas em vez de fechar negócios.",
  },
  {
    chave: "dores.item_3",
    secao: "dores",
    titulo: "Atendimento humano caro e difícil de escalar",
    corpo: "Escalar time custa folha, treino e turnover — a IA escala sem nada disso.",
  },
  {
    chave: "beneficios.titulo",
    secao: "beneficios",
    titulo: "O que o atendente virtual faz por você",
    corpo: null,
  },
  {
    chave: "beneficios.item_1",
    secao: "beneficios",
    titulo: "Atendimento 24/7 no WhatsApp",
    corpo: "Resposta imediata a qualquer hora, em todos os canais integrados.",
  },
  {
    chave: "beneficios.item_2",
    secao: "beneficios",
    titulo: "Treinado nos seus documentos",
    corpo: "O agente aprende com catálogo, tabela de preços e políticas da sua empresa.",
  },
  {
    chave: "beneficios.item_3",
    secao: "beneficios",
    titulo: "Personalidade da sua marca",
    corpo: "Tom de voz e estilo definidos por você — o agente fala como a sua empresa.",
  },
  {
    chave: "beneficios.item_4",
    secao: "beneficios",
    titulo: "Sem mensalidade surpresa",
    corpo: "Planos claros, implantação assistida e cancelamento quando quiser.",
  },
  {
    chave: "como_funciona.titulo",
    secao: "como_funciona",
    titulo: "Como funciona",
    corpo: null,
  },
  {
    chave: "como_funciona.passo_1",
    secao: "como_funciona",
    titulo: "Escolha o plano",
    corpo: "Selecione o plano ideal para o tamanho do seu atendimento.",
  },
  {
    chave: "como_funciona.passo_2",
    secao: "como_funciona",
    titulo: "Envie seus documentos",
    corpo: "Catálogo, preços e políticas — a base de conhecimento do seu agente.",
  },
  {
    chave: "como_funciona.passo_3",
    secao: "como_funciona",
    titulo: "Receba o link do seu agente",
    corpo: "Provisionamos tudo para você e entregamos o acesso ao painel do agente.",
  },
  {
    chave: "como_funciona.passo_4",
    secao: "como_funciona",
    titulo: "Publique no WhatsApp",
    corpo: "Pareie o número e copie o script de embed para começar a atender.",
  },
  {
    chave: "cta.titulo",
    secao: "cta",
    titulo: "Pronto para vender mais enquanto dorme?",
    corpo: "Fale com a gente no WhatsApp e ative seu atendente virtual hoje mesmo.",
  },
  {
    chave: "contato.titulo",
    secao: "contato",
    titulo: "Fale com um especialista",
    corpo: "Tire suas dúvidas antes de contratar — resposta em minutos no horário comercial.",
  },
  {
    chave: "whatsapp_link",
    secao: "contato",
    titulo: "WhatsApp",
    corpo: "https://api.whatsapp.com/send?phone=5541988880640&text=Ol%C3%A1%2C%20quero%20um%20atendente%20virtual",
  },
] as const;

const PLANOS = [
  { nome: "Essencial", descricao: "Para quem está começando no atendimento com IA.", precoMensal: 97.0, precoSetup: 0.0, maisPopular: false },
  { nome: "Profissional", descricao: "Para negócios que precisam de atendimento completo e integrações.", precoMensal: 197.0, precoSetup: 297.0, maisPopular: true },
  { nome: "Empresarial", descricao: "Para operações com alto volume e necessidades sob medida.", precoMensal: 497.0, precoSetup: 997.0, maisPopular: false },
] as const;

const ITENS_FAQ = [
  { pergunta: "Preciso entender de tecnologia para usar?", resposta: "Não. Você escolhe o plano, envia seus documentos e nós provisionamos o agente para você. O painel é simples e guiado." },
  { pergunta: "Em quanto tempo meu agente fica pronto?", resposta: "O provisionamento é automático após a confirmação do pagamento — normalmente em minutos." },
  { pergunta: "Posso trocar de plano depois?", resposta: "Sim, a qualquer momento pelo painel ou falando com nosso time." },
  { pergunta: "O atendente funciona no meu número de WhatsApp?", resposta: "Sim. Você pareia o seu número nas Configurações do WhatsApp e o agente passa a responder por ele." },
  { pergunta: "E se eu quiser cancelar?", resposta: "Você pode cancelar quando quiser, sem multa — os dados ficam disponíveis para exportação por 30 dias." },
] as const;

const METRICAS = [
  { valor: "24/7", rotulo: "disponibilidade de atendimento" },
  { valor: "+60%", rotulo: "respostas rápidas que viram vendas" },
  { valor: "3 min", rotulo: "tempo médio de primeira resposta" },
] as const;

const SEGMENTOS = [
  "Clínicas e consultórios",
  "Imobiliárias",
  "E-commerces",
  "Serviços locais",
  "Escritórios de advocacia",
  "Academias e estúdios",
] as const;

async function main(): Promise<void> {
  const conn = await createConnection({
    host: process.env.MYSQL_HOST ?? "localhost",
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "",
    database: process.env.MYSQL_DATABASE,
    multipleStatements: false,
  });

  try {
    const [rTextos] = await conn.query(
      `INSERT INTO textos_vitrine (chave, secao, titulo, corpo) VALUES ?
       ON DUPLICATE KEY UPDATE secao = VALUES(secao), titulo = VALUES(titulo), corpo = VALUES(corpo)`,
      [[TEXTOS_VITRINE.map((t) => [t.chave, t.secao, t.titulo, t.corpo])]],
    );
    const [rPlanos] = await conn.query(
      `INSERT INTO planos (nome, descricao, preco_mensal, preco_setup, mais_popular) VALUES ?
       ON DUPLICATE KEY UPDATE descricao = VALUES(descricao), preco_mensal = VALUES(preco_mensal), preco_setup = VALUES(preco_setup), mais_popular = VALUES(mais_popular)`,
      [[PLANOS.map((p) => [p.nome, p.descricao, p.precoMensal, p.precoSetup, p.maisPopular])]],
    );
    const [rFaq] = await conn.query(
      `INSERT INTO itens_faq (pergunta, resposta, ordem, ativo) VALUES ?
       ON DUPLICATE KEY UPDATE resposta = VALUES(resposta), ordem = VALUES(ordem), ativo = VALUES(ativo)`,
      [[ITENS_FAQ.map((f, i) => [f.pergunta, f.resposta, i + 1, true])]],
    );
    const [rMetricas] = await conn.query(
      `INSERT INTO metricas_destaque (valor, rotulo, ordem, ativo) VALUES ?
       ON DUPLICATE KEY UPDATE valor = VALUES(valor), rotulo = VALUES(rotulo), ordem = VALUES(ordem), ativo = VALUES(ativo)`,
      [[METRICAS.map((m, i) => [m.valor, m.rotulo, i + 1, true])]],
    );
    const [rSegmentos] = await conn.query(
      `INSERT IGNORE INTO segmentos (nome, ativo) VALUES ?`,
      [[SEGMENTOS.map((s) => [s, true])]],
    );

    console.log(
      JSON.stringify({
        database: process.env.MYSQL_DATABASE,
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
