import { describe, expect, it } from "vitest"
import {
  consentimentoRequestSchema,
  dadosExportResponseSchema,
  exclusaoResponseSchema,
  loginRequestSchema,
  retificacaoRequestSchema,
} from "../index.js"

describe("contratos LGPD", () => {
  it("valida um pedido de consentimento", () => {
    expect(
      consentimentoRequestSchema.safeParse({
        usuario_id: 42,
        versao_politica: "2026-09-01",
        ip: "192.168.1.10",
      }).success,
    ).toBe(true)
  })

  it("rejeita consentimento sem usuário ou com campo desconhecido", () => {
    expect(
      consentimentoRequestSchema.safeParse({
        versao_politica: "2026-09-01",
        ip: "192.168.1.10",
      }).success,
    ).toBe(false)
    expect(
      consentimentoRequestSchema.safeParse({
        usuario_id: 42,
        versao_politica: "2026-09-01",
        ip: "192.168.1.10",
        extra: true,
      }).success,
    ).toBe(false)
  })

  it("valida exportação com dados, consentimentos e vínculos", () => {
    expect(
      dadosExportResponseSchema.safeParse({
        dados: {
          id: 42,
          username: "alexandre",
          email: "alexandre@example.com",
          telefone: null,
          cpf: null,
          nome: "Alexandre",
          ativo: true,
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:00:00.000Z",
          consentimentos: [],
          vinculos: [],
        },
      }).success,
    ).toBe(true)
  })

  it("aceita retificação parcial e rejeita objeto vazio", () => {
    expect(retificacaoRequestSchema.safeParse({ nome: "Novo nome" }).success).toBe(true)
    expect(retificacaoRequestSchema.safeParse({}).success).toBe(false)
  })

  it("mantém consentimento de login opcional para contas existentes", () => {
    expect(
      loginRequestSchema.safeParse({
        identifier: "alexandre",
        password: "senha-secreta",
        identifierType: "username",
      }).success,
    ).toBe(true)
    expect(
      loginRequestSchema.safeParse({
        identifier: "alexandre",
        password: "senha-secreta",
        identifierType: "username",
        consentimentoAceito: true,
      }).success,
    ).toBe(true)
  })

  it("valida resposta de exclusão", () => {
    expect(
      exclusaoResponseSchema.safeParse({
        ok: true,
        usuario_id: 42,
        excluido_em: "2026-09-01T10:00:00.000Z",
      }).success,
    ).toBe(true)
  })
})
