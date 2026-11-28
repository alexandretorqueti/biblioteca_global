// @vitest-environment node
/**
 * Testes dos contratos públicos de pedido da vitrine (macro #10, posição
 * 3/11 — subtarefa 1). `vitrinePedidoDadosSchema` é a forma exata do campo
 * `dados` no multipart de criação; os schemas de resposta são a forma exata
 * de POST/GET /api/vitrine/pedidos. `.strict()` em todos os níveis é a
 * garantia de que NENHUM campo interno/fluxo (status, pagamentoId,
 * linkAgente, scriptEmbed, id, planoId, caminhoArmazenamento,
 * textoExtraido) atravessa o contrato em qualquer ponta.
 */
import { describe, expect, it } from "vitest"
import {
  VITRINE_TEXTO_LIVRE_MAX_CHARS,
  vitrineDocumentoTipoConteudoSchema,
  vitrinePedidoAcompanhamentoSchema,
  vitrinePedidoCriacaoRespostaSchema,
  vitrinePedidoDadosSchema,
  vitrinePedidoTextoLivreSchema,
} from "../vitrine-pedidos"

/** Payload canônico mínimo de criação (mesma forma que o formulário envia). */
const DADOS_VALIDOS = {
  nomeNegocio: "Barbearia Navalha de Ouro",
  nomeContato: "João da Silva",
  email: "joao@navalhadeouro.com.br",
  telefone: "(21) 98816-1553",
  plano: "Pro",
  ciclo: "anual" as const,
  informacoesNegocio: "Atendo de terça a domingo, 3 cadeiras.",
  consentimentoLgpd: true,
}

/** Cópia sem uma chave (evita `delete` em propriedade obrigatória tipada). */
function semChave<T extends Record<string, unknown>>(obj: T, chave: keyof T): Partial<T> {
  const copia: Record<string, unknown> = { ...obj }
  delete copia[chave as string]
  return copia as Partial<T>
}

describe("vitrinePedidoDadosSchema — payload válido", () => {
  it("parseia o payload canônico", () => {
    expect(() => vitrinePedidoDadosSchema.parse(DADOS_VALIDOS)).not.toThrow()
  })

  it("informacoesNegocio é opcional", () => {
    const semInfo = semChave(DADOS_VALIDOS, "informacoesNegocio")
    expect(vitrinePedidoDadosSchema.parse(semInfo).informacoesNegocio).toBeUndefined()
  })

  it("aceita telefone com DDD 10 e 11 dígitos (regra da plataforma)", () => {
    expect(
      vitrinePedidoDadosSchema.parse({ ...DADOS_VALIDOS, telefone: "21 3456-7890" }).telefone,
    ).toBe("21 3456-7890")
    expect(
      vitrinePedidoDadosSchema.parse({ ...DADOS_VALIDOS, telefone: "21988161553" }).telefone,
    ).toBe("21988161553")
  })

  it("rejeita telefone fora da regra BR (ex.: +55 com 13 dígitos)", () => {
    expect(() =>
      vitrinePedidoDadosSchema.parse({ ...DADOS_VALIDOS, telefone: "+55 21 98816-1553" }),
    ).toThrow(/Telefone BR inválido/)
  })

  it("aceita os 2 ciclos e normaliza espaços (trim)", () => {
    expect(vitrinePedidoDadosSchema.parse({ ...DADOS_VALIDOS, ciclo: "mensal" }).ciclo).toBe("mensal")
    expect(
      vitrinePedidoDadosSchema.parse({ ...DADOS_VALIDOS, nomeNegocio: "  X  " }).nomeNegocio,
    ).toBe("X")
  })
})

describe("vitrinePedidoDadosSchema — validação server-side (400 claro)", () => {
  it.each([
    ["nomeNegocio vazio", { nomeNegocio: "   " }],
    ["nomeContato vazio", { nomeContato: "" }],
    ["email sem formato", { email: "nao-e-email" }],
    ["email vazio", { email: "" }],
    ["telefone sem DDD (regra da plataforma)", { telefone: "98816155" }],
    ["telefone alfabético", { telefone: "oi tudo bem" }],
    ["telefone longo demais (>20)", { telefone: "55 21 98816-1553 ramal 123456" }],
    ["plano vazio", { plano: "  " }],
    ["ciclo fora de mensal|anual", { ciclo: "semanal" }],
  ])("rejeita %s", (_rotulo, mutacao) => {
    expect(() => vitrinePedidoDadosSchema.parse({ ...DADOS_VALIDOS, ...mutacao })).toThrow()
  })

  it("consentimentoLgpd ausente ou false é rejeitado (obrigatório true)", () => {
    const semConsentimento = semChave(DADOS_VALIDOS, "consentimentoLgpd")
    expect(() => vitrinePedidoDadosSchema.parse(semConsentimento)).toThrow()
    expect(() =>
      vitrinePedidoDadosSchema.parse({ ...DADOS_VALIDOS, consentimentoLgpd: false }),
    ).toThrow()
    // mensagem clara orienta o usuário final
    expect(() =>
      vitrinePedidoDadosSchema.parse({ ...DADOS_VALIDOS, consentimentoLgpd: false }),
    ).toThrowError(/consentimento LGPD é obrigatório/i)
  })

  it("maxLengths do schema.ts são impostos", () => {
    expect(() =>
      vitrinePedidoDadosSchema.parse({ ...DADOS_VALIDOS, nomeNegocio: "n".repeat(161) }),
    ).toThrow(/160/)
    expect(() =>
      vitrinePedidoDadosSchema.parse({ ...DADOS_VALIDOS, nomeContato: "c".repeat(161) }),
    ).toThrow(/160/)
    expect(() =>
      vitrinePedidoDadosSchema.parse({ ...DADOS_VALIDOS, email: `${"a".repeat(155)}@x.com` }),
    ).toThrow(/160/)
    expect(() =>
      vitrinePedidoDadosSchema.parse({ ...DADOS_VALIDOS, plano: "p".repeat(121) }),
    ).toThrow(/120/)
  })
})

describe("vitrinePedidoDadosSchema — strict: backend é a fonte única", () => {
  it.each([
    ["status", "pago"],
    ["pagamentoId", "MP-123"],
    ["linkAgente", "https://agentes.example/x"],
    ["scriptEmbed", "<script src='https://x/y.js'></script>"],
    ["id", 7],
    ["planoId", 42],
    ["tokenAcompanhamento", "a".repeat(64)],
    ["projetoId", 8509],
    ["qualquerChaveDesconhecida", true],
  ])("rejeita chave de fluxo/interna no payload (%s)", (campo, valor) => {
    expect(() => vitrinePedidoDadosSchema.parse({ ...DADOS_VALIDOS, [campo]: valor })).toThrow()
  })

  it("a rejeição cita a chave desconhecida (mensagem acionável)", () => {
    try {
      vitrinePedidoDadosSchema.parse({ ...DADOS_VALIDOS, status: "pago" })
      expect.unreachable("strict deveria rejeitar 'status'")
    } catch (erro) {
      const issues =
        (erro as { issues?: Array<{ code?: string; keys?: string[] }> }).issues ?? []
      expect(
        issues.some(
          (i) => i.code === "unrecognized_keys" && (i.keys ?? []).includes("status"),
        ),
      ).toBe(true)
    }
  })
})

describe("vitrinePedidoTextoLivreSchema", () => {
  it("aceita texto normal e rejeita acima do limite", () => {
    expect(vitrinePedidoTextoLivreSchema.parse("Aqui vai o contexto do meu negócio.")).toBeTruthy()
    expect(() =>
      vitrinePedidoTextoLivreSchema.parse("x".repeat(VITRINE_TEXTO_LIVRE_MAX_CHARS + 1)),
    ).toThrow(/50000/)
  })
})

describe("vitrinePedidoCriacaoRespostaSchema — resposta do POST", () => {
  const RESPOSTA_VALIDA = {
    tokenAcompanhamento: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    status: "criado",
    criadoEm: "2026-11-28T12:00:00.000Z",
    mensagem: "Pedido recebido.",
  }

  it("parseia a resposta canônica", () => {
    expect(() => vitrinePedidoCriacaoRespostaSchema.parse(RESPOSTA_VALIDA)).not.toThrow()
  })

  it("exige token hex de 64 caracteres (32 bytes)", () => {
    expect(() =>
      vitrinePedidoCriacaoRespostaSchema.parse({ ...RESPOSTA_VALIDA, tokenAcompanhamento: "curto" }),
    ).toThrow()
    expect(() =>
      vitrinePedidoCriacaoRespostaSchema.parse({ ...RESPOSTA_VALIDA, tokenAcompanhamento: "Z".repeat(64) }),
    ).toThrow()
  })

  it.each([
    ["id", 9],
    ["pedidoId", 9],
    ["planoId", 3],
    ["pagamentoId", "mp-1"],
    ["linkAgente", "x"],
    ["scriptEmbed", "x"],
    ["caminhoArmazenamento", "pedido/..."],
    ["email", "vazar@x.com"],
  ])("rejeita campo interno na resposta (%s)", (campo, valor) => {
    expect(() => vitrinePedidoCriacaoRespostaSchema.parse({ ...RESPOSTA_VALIDA, [campo]: valor })).toThrow()
  })

  it("status só pode ser 'criado' na resposta de criação", () => {
    expect(() =>
      vitrinePedidoCriacaoRespostaSchema.parse({ ...RESPOSTA_VALIDA, status: "pago" }),
    ).toThrow()
  })
})

describe("vitrinePedidoAcompanhamentoSchema — resposta do GET", () => {
  const PEDIDO_VALIDO = {
    nomeNegocio: "Barbearia Navalha de Ouro",
    nomeContato: "João da Silva",
    email: "joao@navalhadeouro.com.br",
    telefone: "(21) 98816-1553",
    informacoesNegocio: null,
    planoNome: "Pro",
    ciclo: "anual",
    status: "criado",
    criadoEm: "2026-11-28T12:00:00.000Z",
    documentos: [
      { nomeOriginal: "cardapio.pdf", tipoConteudo: "pdf", tamanhoBytes: 10240 },
      { nomeOriginal: null, tipoConteudo: "texto_livre", tamanhoBytes: 320 },
    ],
  }

  it("parseia o pedido canônico", () => {
    expect(() => vitrinePedidoAcompanhamentoSchema.parse(PEDIDO_VALIDO)).not.toThrow()
  })

  it("espelha o enum tipo_conteudo do schema.ts (pdf|docx|txt|texto_livre)", () => {
    for (const tipo of ["pdf", "docx", "txt", "texto_livre"]) {
      expect(vitrineDocumentoTipoConteudoSchema.parse(tipo)).toBe(tipo)
    }
    expect(() => vitrineDocumentoTipoConteudoSchema.parse("exe")).toThrow()
  })

  it.each([
    ["id", 1],
    ["pedidoId", 1],
    ["planoId", 3],
    ["pagamentoId", "mp-1"],
    ["linkAgente", "https://x"],
    ["scriptEmbed", "<script>"],
    ["caminhoArmazenamento", "pedido/uuid/uuid.pdf"],
    ["textoExtraido", "segredo do cliente"],
    ["tokenAcompanhamento", "a".repeat(64)],
    ["consentimentoLgpd", true],
    ["emAtualizacao", "2026-11-28"],
  ])("rejeita campo interno exposto (%s)", (campo, valor) => {
    expect(() =>
      vitrinePedidoAcompanhamentoSchema.parse({ ...PEDIDO_VALIDO, [campo]: valor }),
    ).toThrow()
  })

  it("documento não expõe mimeType/caminho/textoExtraido (allow-list)", () => {
    expect(() =>
      vitrinePedidoAcompanhamentoSchema.parse({
        ...PEDIDO_VALIDO,
        documentos: [
          {
            nomeOriginal: "a.pdf",
            tipoConteudo: "pdf",
            tamanhoBytes: 1,
            mimeType: "application/pdf",
          },
        ],
      }),
    ).toThrow()
  })

  it("status restrito ao enum do fluxo (criado→falha)", () => {
    expect(() =>
      vitrinePedidoAcompanhamentoSchema.parse({ ...PEDIDO_VALIDO, status: "estornado" }),
    ).toThrow()
    expect(
      vitrinePedidoAcompanhamentoSchema.parse({ ...PEDIDO_VALIDO, status: "entregue" }).status,
    ).toBe("entregue")
  })
})
