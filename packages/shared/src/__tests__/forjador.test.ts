import { describe, expect, it } from "vitest"
import {
  FORJAR_PERSONA_ARQUIVO_MAX_BYTES,
  FORJAR_PERSONA_ARQUIVOS_MAX,
  FORJAR_PERSONA_DESCRICAO_MAX,
  FORJAR_PERSONA_DESCRICAO_MIN,
  MATERIAL_HASH_REGEX,
  TENANT_SLUG_REGEX,
  forjarArquivoSchema,
  forjarPersonaRequestSchema,
  forjarPersonaResponseSchema,
} from "../index.js"

const DESCRICAO_VALIDA =
  "Escritório de advocacia trabalhista em Curitiba, atendimento WhatsApp e triagem de clientes."

describe("contrato forjar-persona — request", () => {
  it("valida requisição mínima (só descricaoNegocio)", () => {
    expect(forjarPersonaRequestSchema.safeParse({ descricaoNegocio: DESCRICAO_VALIDA }).success).toBe(true)
  })

  it("valida requisição completa com vínculo provisório, correlação e arquivos", () => {
    const result = forjarPersonaRequestSchema.safeParse({
      descricaoNegocio: DESCRICAO_VALIDA,
      tenantSlug: "atendente-meu-adv",
      tenantId: 42,
      correlationId: "forj-0001",
      arquivos: [{ nome: "site.txt", conteudo: "Texto do site institucional." }],
    })
    expect(result.success).toBe(true)
  })

  it("rejeita descricaoNegocio ausente, vazia ou fora dos limites de tamanho", () => {
    expect(forjarPersonaRequestSchema.safeParse({}).success).toBe(false)
    expect(forjarPersonaRequestSchema.safeParse({ descricaoNegocio: "   " }).success).toBe(false)
    expect(
      forjarPersonaRequestSchema.safeParse({ descricaoNegocio: "a".repeat(FORJAR_PERSONA_DESCRICAO_MIN - 1) })
        .success,
    ).toBe(false)
    expect(
      forjarPersonaRequestSchema.safeParse({ descricaoNegocio: "a".repeat(FORJAR_PERSONA_DESCRICAO_MAX + 1) })
        .success,
    ).toBe(false)
    expect(
      forjarPersonaRequestSchema.safeParse({ descricaoNegocio: "a".repeat(FORJAR_PERSONA_DESCRICAO_MAX) }).success,
    ).toBe(true)
  })

  it("rejeita descricaoNegocio que não é string (tipo)", () => {
    expect(forjarPersonaRequestSchema.safeParse({ descricaoNegocio: 123 }).success).toBe(false)
    expect(forjarPersonaRequestSchema.safeParse({ descricaoNegocio: null }).success).toBe(false)
  })

  it("aceita descricaoNegocio com espaços nas bordas (trim) e rejeita campos desconhecidos (strict)", () => {
    expect(
      forjarPersonaRequestSchema.safeParse({ descricaoNegocio: `  ${DESCRICAO_VALIDA}  ` }).success,
    ).toBe(true)
    expect(
      forjarPersonaRequestSchema.safeParse({ descricaoNegocio: DESCRICAO_VALIDA, extra: true }).success,
    ).toBe(false)
  })

  it("valida tenantSlug pela convenção de assinaturas e rejeita formatos inválidos", () => {
    expect(
      forjarPersonaRequestSchema.safeParse({ descricaoNegocio: DESCRICAO_VALIDA, tenantSlug: "acme-adv" }).success,
    ).toBe(true)
    for (const invalido of ["ACME", "-acme", "acme-", "ac me", "a".repeat(65)]) {
      expect(
        forjarPersonaRequestSchema.safeParse({ descricaoNegocio: DESCRICAO_VALIDA, tenantSlug: invalido }).success,
      ).toBe(false)
    }
  })

  it("rejeita tenantId não inteiro ou não positivo", () => {
    for (const tenantId of [0, -1, 1.5, "42"]) {
      expect(
        forjarPersonaRequestSchema.safeParse({ descricaoNegocio: DESCRICAO_VALIDA, tenantId }).success,
      ).toBe(false)
    }
  })

  it("trata correlationId como opcional, com limite de 100 caracteres", () => {
    expect(
      forjarPersonaRequestSchema.safeParse({ descricaoNegocio: DESCRICAO_VALIDA }).success,
    ).toBe(true)
    expect(
      forjarPersonaRequestSchema.safeParse({
        descricaoNegocio: DESCRICAO_VALIDA,
        correlationId: "c".repeat(100),
      }).success,
    ).toBe(true)
    expect(
      forjarPersonaRequestSchema.safeParse({
        descricaoNegocio: DESCRICAO_VALIDA,
        correlationId: "c".repeat(101),
      }).success,
    ).toBe(false)
    expect(
      forjarPersonaRequestSchema.safeParse({
        descricaoNegocio: DESCRICAO_VALIDA,
        correlationId: "",
      }).success,
    ).toBe(false)
  })

  it("limita quantidade de arquivos (máx. 10)", () => {
    const arquivo = { nome: "a.txt", conteudo: "conteudo valido" }
    expect(
      forjarPersonaRequestSchema.safeParse({
        descricaoNegocio: DESCRICAO_VALIDA,
        arquivos: Array.from({ length: FORJAR_PERSONA_ARQUIVOS_MAX }, () => arquivo),
      }).success,
    ).toBe(true)
    expect(
      forjarPersonaRequestSchema.safeParse({
        descricaoNegocio: DESCRICAO_VALIDA,
        arquivos: Array.from({ length: FORJAR_PERSONA_ARQUIVOS_MAX + 1 }, () => arquivo),
      }).success,
    ).toBe(false)
  })

  it("rejeita arquivos com tipo/estrutura inválidos", () => {
    expect(
      forjarPersonaRequestSchema.safeParse({
        descricaoNegocio: DESCRICAO_VALIDA,
        arquivos: "nao-e-array",
      }).success,
    ).toBe(false)
    expect(
      forjarPersonaRequestSchema.safeParse({
        descricaoNegocio: DESCRICAO_VALIDA,
        arquivos: [{ nome: "a.txt" }],
      }).success,
    ).toBe(false)
    expect(
      forjarPersonaRequestSchema.safeParse({
        descricaoNegocio: DESCRICAO_VALIDA,
        arquivos: [{ nome: "a.txt", conteudo: 123 }],
      }).success,
    ).toBe(false)
    expect(
      forjarPersonaRequestSchema.safeParse({
        descricaoNegocio: DESCRICAO_VALIDA,
        arquivos: [{ nome: "", conteudo: "x" }],
      }).success,
    ).toBe(false)
  })
})

describe("contrato forjar-persona — arquivo de material", () => {
  it("aceita conteúdo no limite de bytes UTF-8 e rejeita acima dele", () => {
    expect(
      forjarArquivoSchema.safeParse({
        nome: "limite.txt",
        conteudo: "a".repeat(FORJAR_PERSONA_ARQUIVO_MAX_BYTES),
      }).success,
    ).toBe(true)
    expect(
      forjarArquivoSchema.safeParse({
        nome: "acima.txt",
        conteudo: "a".repeat(FORJAR_PERSONA_ARQUIVO_MAX_BYTES + 1),
      }).success,
    ).toBe(false)
  })

  it("conta bytes UTF-8, não caracteres (acentos contam 2 bytes)", () => {
    const quase = "á".repeat(Math.floor(FORJAR_PERSONA_ARQUIVO_MAX_BYTES / 2))
    expect(forjarArquivoSchema.safeParse({ nome: "acentos.txt", conteudo: quase }).success).toBe(true)
    const excede = "á".repeat(Math.floor(FORJAR_PERSONA_ARQUIVO_MAX_BYTES / 2) + 1)
    expect(forjarArquivoSchema.safeParse({ nome: "acentos.txt", conteudo: excede }).success).toBe(false)
  })

  it("rejeita conteúdo vazio e nome acima de 200 caracteres", () => {
    expect(forjarArquivoSchema.safeParse({ nome: "a.txt", conteudo: "" }).success).toBe(false)
    expect(
      forjarArquivoSchema.safeParse({ nome: "n".repeat(201), conteudo: "conteudo valido" }).success,
    ).toBe(false)
  })
})

describe("contrato forjar-persona — response", () => {
  const RESPOSTA_VALIDA = {
    personaId: 7,
    versao: 1,
    tenantSlug: "acme-adv",
    soul: "# SOUL",
    identity: "# IDENTITY",
    agents: "# AGENTS",
    status: "completed",
  }

  it("valida resposta completa nos quatro status", () => {
    for (const status of ["pending", "completed", "failed", "timeout"]) {
      expect(
        forjarPersonaResponseSchema.safeParse({ ...RESPOSTA_VALIDA, status }).success,
      ).toBe(true)
    }
  })

  it("aceita resposta sem tenantSlug (vínculo provisório opcional)", () => {
    const { personaId, versao, soul, identity, agents, status } = RESPOSTA_VALIDA
    expect(forjarPersonaResponseSchema.safeParse({ personaId, versao, soul, identity, agents, status }).success).toBe(true)
  })

  it("rejeita personaId/versao não positivos, textos vazios e status desconhecido", () => {
    expect(
      forjarPersonaResponseSchema.safeParse({ ...RESPOSTA_VALIDA, personaId: 0 }).success,
    ).toBe(false)
    expect(
      forjarPersonaResponseSchema.safeParse({ ...RESPOSTA_VALIDA, versao: -2 }).success,
    ).toBe(false)
    expect(forjarPersonaResponseSchema.safeParse({ ...RESPOSTA_VALIDA, soul: "" }).success).toBe(false)
    expect(
      forjarPersonaResponseSchema.safeParse({ ...RESPOSTA_VALIDA, status: "cancelado" }).success,
    ).toBe(false)
    expect(forjarPersonaResponseSchema.safeParse({ ...RESPOSTA_VALIDA, extra: 1 }).success).toBe(false)
  })
})

describe("contrato forjar-persona — convenções constantes", () => {
  it("TENANT_SLUG_REGEX casa os mesmos formatos aceitos pelo request", () => {
    expect(TENANT_SLUG_REGEX.test("acme")).toBe(true)
    expect(TENANT_SLUG_REGEX.test("acme-2")).toBe(true)
    expect(TENANT_SLUG_REGEX.test("Acme")).toBe(false)
    expect(TENANT_SLUG_REGEX.test("acme_2")).toBe(false)
  })

  it("MATERIAL_HASH_REGEX exige sha256 hex de 64 caracteres", () => {
    expect(MATERIAL_HASH_REGEX.test("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")).toBe(true)
    expect(MATERIAL_HASH_REGEX.test("A".repeat(64))).toBe(false)
    expect(MATERIAL_HASH_REGEX.test("g".repeat(64))).toBe(false)
    expect(MATERIAL_HASH_REGEX.test("ab")).toBe(false)
  })
})
