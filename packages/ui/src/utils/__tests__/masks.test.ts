import { describe, expect, it } from "vitest"
import {
  formatCnpj,
  isValidCnpj,
  formatCpf,
  isValidCpf,
  formatTelefone,
  formatCep,
  isValidCep,
  isValidRg,
  isValidNomeCompleto,
} from "../masks"

describe("máscara e validação de CNPJ", () => {
  it("formata CNPJ progressivamente", () => {
    expect(formatCnpj("05064544000130")).toBe("05.064.544/0001-30")
  })

  it("valida um CNPJ correto", () => {
    expect(isValidCnpj("05.064.544/0001-30")).toBe(true)
  })

  it("rejeita CNPJ repetido", () => {
    expect(isValidCnpj("11.111.111/1111-11")).toBe(false)
  })
})

describe("máscara e validação de CPF", () => {
  it("formata CPF progressivamente", () => {
    expect(formatCpf("12345678909")).toBe("123.456.789-09")
  })

  it("formata CPF parcialmente digitado", () => {
    expect(formatCpf("123456")).toBe("123.456")
  })

  it("valida um CPF correto", () => {
    expect(isValidCpf("123.456.789-09")).toBe(true)
  })

  it("rejeita CPF com dígitos verificadores errados", () => {
    expect(isValidCpf("123.456.789-00")).toBe(false)
  })

  it("rejeita CPF com todos os dígitos iguais", () => {
    expect(isValidCpf("111.111.111-11")).toBe(false)
  })

  it("rejeita CPF com menos de 11 dígitos", () => {
    expect(isValidCpf("1234567890")).toBe(false)
  })
})

describe("formatação de telefone", () => {
  it("formata telefone celular (11 dígitos) com +55", () => {
    expect(formatTelefone("21999998888")).toBe("+55 (21) 99999-8888")
  })

  it("formata telefone fixo (10 dígitos) com +55", () => {
    expect(formatTelefone("2133334444")).toBe("+55 (21) 3333-4444")
  })

  it("formata parcialmente", () => {
    expect(formatTelefone("21999")).toBe("+55 (21) 999")
  })

  it("remove 55 inicial se presente", () => {
    expect(formatTelefone("5521999998888")).toBe("+55 (21) 99999-8888")
  })

  it("retorna +55 quando vazio", () => {
    expect(formatTelefone("")).toBe("+55")
  })

  it("mantém um único +55 quando a entrada já traz o prefixo renderizado", () => {
    expect(formatTelefone("+5521999998888")).toBe("+55 (21) 99999-8888")
    expect(formatTelefone("+55 (21) 99999-8888")).toBe("+55 (21) 99999-8888")
    expect(formatTelefone("+55 2133334444")).toBe("+55 (21) 3333-4444")
  })

  it("não duplica o prefixo nem cria DDD (55) na digitação progressiva a partir de +55", () => {
    // Reproduz a sequência controlada do bug: campo com defaultValue "+55"
    // e o usuário digitando o DDD em seguida.
    expect(formatTelefone("+55")).toBe("+55")
    expect(formatTelefone("+552")).toBe("+55 2")
    expect(formatTelefone("+5521")).toBe("+55 21")
    expect(formatTelefone("+55219")).toBe("+55 (21) 9")
    expect(formatTelefone("+552199")).toBe("+55 (21) 99")
    expect(formatTelefone("+5521999")).toBe("+55 (21) 999")
    expect(formatTelefone("+55219999")).toBe("+55 (21) 9999")
    expect(formatTelefone("+552199999")).toBe("+55 (21) 9999-9")
    expect(formatTelefone("+5521999998")).toBe("+55 (21) 9999-98")
    expect(formatTelefone("+55219999988")).toBe("+55 (21) 9999-988")
    expect(formatTelefone("+552199999888")).toBe("+55 (21) 9999-9888")
    expect(formatTelefone("+5521999998888")).toBe("+55 (21) 99999-8888")
  })

  it("preserva DDD 55 digitado após o prefixo +55", () => {
    expect(formatTelefone("+555533334444")).toBe("+55 (55) 3333-4444")
    expect(formatTelefone("+5555999998888")).toBe("+55 (55) 99999-8888")
  })

  it("não remove 55 progressivo sem marcação de código do país", () => {
    // Sem "+", dois dígitos "55" são tratados como DDD parcial, não prefixo.
    expect(formatTelefone("55")).toBe("+55 55")
    expect(formatTelefone("552")).toBe("+55 (55) 2")
    expect(formatTelefone("5533334444")).toBe("+55 (55) 3333-4444")
  })
})

describe("máscara e validação de CEP", () => {
  it("formata CEP", () => {
    expect(formatCep("01310100")).toBe("01310-100")
  })

  it("valida CEP com 8 dígitos", () => {
    expect(isValidCep("01310-100")).toBe(true)
    expect(isValidCep("01310100")).toBe(true)
  })

  it("rejeita CEP com menos de 8 dígitos", () => {
    expect(isValidCep("0131-100")).toBe(false)
  })
})

describe("validação de RG", () => {
  it("aceita RG com 5 ou mais dígitos", () => {
    expect(isValidRg("12345")).toBe(true)
    expect(isValidRg("12.345.678-9")).toBe(true)
  })

  it("rejeita RG com menos de 5 dígitos", () => {
    expect(isValidRg("1234")).toBe(false)
    expect(isValidRg("")).toBe(false)
  })
})

describe("validação de nome completo", () => {
  it("aceita nome com pelo menos dois nomes de 2+ caracteres", () => {
    expect(isValidNomeCompleto("João Silva")).toBe(true)
    expect(isValidNomeCompleto("Maria das Dores")).toBe(true)
  })

  it("rejeita nome com apenas um nome", () => {
    expect(isValidNomeCompleto("João")).toBe(false)
    expect(isValidNomeCompleto("Maria")).toBe(false)
  })

  it("rejeita nome com parte de 1 caractere", () => {
    expect(isValidNomeCompleto("J Silva")).toBe(false)
  })

  it("rejeita string vazia", () => {
    expect(isValidNomeCompleto("")).toBe(false)
    expect(isValidNomeCompleto("   ")).toBe(false)
  })
})
