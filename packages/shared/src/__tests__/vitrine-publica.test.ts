// @vitest-environment node
/**
 * Testes do contrato público da vitrine (macro #10, posição 2/11).
 * `vitrinePublicaConteudoSchema` é a forma exata de
 * `GET /api/vitrine/conteudo` — a API serializa por allow-list e o front
 * só conhece estes campos. strict() em todos os níveis é a garantia de que
 * NENHUM campo interno (id, ativo, ordem, pedidos, credenciais, fluxos)
 * atravessa o contrato.
 */
import { describe, expect, it } from "vitest"
import { vitrinePublicaConteudoSchema } from "../vitrine-publica"

/** Payload canônico mínimo (mesma forma que a API devolve). */
const CONTEUDO_VALIDO = {
  textos: [
    { chave: "hero_titulo", secao: "hero", conteudo: "Seu atendimento 24 horas" },
    { chave: "whatsapp_link", secao: "contato", conteudo: "https://wa.me/5521988161553" },
    { chave: "chave_sem_secao", secao: null, conteudo: "texto solto" },
  ],
  planos: [
    {
      nome: "Pro",
      tagline: "Site + WhatsApp, sem limites",
      precoMensal: 597,
      precoSetup: 2500,
      beneficios: ["Conversas ilimitadas", "IA treinada com seu conteúdo"],
      textoBotao: "Quero o Pro",
      maisPopular: true,
    },
    {
      nome: "Enterprise",
      tagline: null,
      precoMensal: 1200,
      precoSetup: null,
      beneficios: [],
      textoBotao: null,
      maisPopular: false,
    },
  ],
  metricas: [
    { valor: "24/7", rotulo: "Atendimento contínuo" },
    { valor: "< 3s", rotulo: null },
  ],
  faq: [{ pergunta: "Preciso trocar meu número?", resposta: "Não." }],
  segmentos: [
    { titulo: "Clínicas e consultórios", descricao: "Agendamento e lembretes", icone: null },
    { titulo: "Imobiliárias", descricao: null, icone: "Home" },
  ],
}

describe("vitrinePublicaConteudoSchema — resposta válida", () => {
  it("parseia o payload canônico por inteiro", () => {
    expect(() => vitrinePublicaConteudoSchema.parse(CONTEUDO_VALIDO)).not.toThrow()
  })

  it("aceita coleções vazias (projeto recém-criado sem conteúdo ativo)", () => {
    const vazio = { textos: [], planos: [], metricas: [], faq: [], segmentos: [] }
    expect(vitrinePublicaConteudoSchema.parse(vazio)).toEqual(vazio)
  })

  it("textos carregam a chave whatsapp_link (WhatsApp centralizado)", () => {
    const parseado = vitrinePublicaConteudoSchema.parse(CONTEUDO_VALIDO)
    const link = parseado.textos.find((t) => t.chave === "whatsapp_link")
    expect(link?.conteudo).toContain("wa.me")
  })
})

describe("vitrinePublicaConteudoSchema — strict: nada interno atravessa", () => {
  it("rejeita chave extra no topo (ex.: pedidos)", () => {
    expect(() =>
      vitrinePublicaConteudoSchema.parse({ ...CONTEUDO_VALIDO, pedidos: [] }),
    ).toThrow()
  })

  it.each([
    ["plano", "id", 1],
    ["plano", "ativo", true],
    ["plano", "ordem", 1],
  ])("rejeita campo interno em plano (%s.%s)", (_rotulo, campo, valor) => {
    expect(() =>
      vitrinePublicaConteudoSchema.parse({
        ...CONTEUDO_VALIDO,
        planos: [{ ...CONTEUDO_VALIDO.planos[0], [campo]: valor }],
      }),
    ).toThrow()
  })

  it.each(["id", "ativo", "ordem", "pedidoId", "credenciaisCifradas"])(
    "rejeita campo interno em texto (%s)",
    (campo) => {
      expect(() =>
        vitrinePublicaConteudoSchema.parse({
          ...CONTEUDO_VALIDO,
          textos: [{ ...CONTEUDO_VALIDO.textos[0], [campo]: "x" }],
        }),
      ).toThrow()
    },
  )

  it("rejeita secao fora do enum do schema", () => {
    expect(() =>
      vitrinePublicaConteudoSchema.parse({
        ...CONTEUDO_VALIDO,
        textos: [{ chave: "x", secao: "campanhas", conteudo: "y" }],
      }),
    ).toThrow()
  })

  it("rejeita precoMensal como string decimal (deve vir normalizado a número)", () => {
    expect(() =>
      vitrinePublicaConteudoSchema.parse({
        ...CONTEUDO_VALIDO,
        planos: [{ ...CONTEUDO_VALIDO.planos[0], precoMensal: "597.00" }],
      }),
    ).toThrow()
  })

  it("rejeita beneficios com itens não-string", () => {
    expect(() =>
      vitrinePublicaConteudoSchema.parse({
        ...CONTEUDO_VALIDO,
        planos: [{ ...CONTEUDO_VALIDO.planos[0], beneficios: [{ url: "interno" }] }],
      }),
    ).toThrow()
  })
})
