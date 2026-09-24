/**
 * Teste funcional — Validações da Tarefa 872
 *
 * Verifica as máscaras e validadores implementados para:
 * - CPF (máscara + validação de dígitos verificadores)
 * - CNPJ (máscara + validação de dígitos verificadores)
 * - Telefone (formatação brasileira com +55)
 * - CEP (máscara + validação de 8 dígitos)
 * - RG (validação básica: mínimo 5 dígitos)
 * - Nome completo (pelo menos dois nomes com 2+ caracteres)
 * - Integração com validateDynamicForm
 */
import { describe, it, expect } from "vitest"
import {
  formatCpf,
  formatCnpj,
  formatTelefone,
  formatCep,
  isValidCpf,
  isValidCnpj,
  isValidRg,
  isValidCep,
  isValidNomeCompleto,
  onlyDigits,
} from "../masks"
import { validateDynamicForm } from "../formValidation"
import type { DynamicField } from "../../types"

// ─── Máscaras ──────────────────────────────────────────────────────────────

describe("Tarefa 872 — Máscaras", () => {
  describe("formatCpf", () => {
    it("formata CPF progressivamente", () => {
      expect(formatCpf("1")).toBe("1")
      expect(formatCpf("12")).toBe("12")
      expect(formatCpf("123")).toBe("123")
      expect(formatCpf("1234")).toBe("123.4")
      expect(formatCpf("123456")).toBe("123.456")
      expect(formatCpf("1234567")).toBe("123.456.7")
      expect(formatCpf("12345678")).toBe("123.456.78")
      expect(formatCpf("123456789")).toBe("123.456.789")
      expect(formatCpf("1234567890")).toBe("123.456.789-0")
      expect(formatCpf("12345678901")).toBe("123.456.789-01")
    })

    it("limita a 11 dígitos", () => {
      expect(formatCpf("123456789012345")).toBe("123.456.789-01")
    })

    it("ignora caracteres não numéricos", () => {
      expect(formatCpf("123.456.789-01")).toBe("123.456.789-01")
    })
  })

  describe("formatCnpj", () => {
    it("formata CNPJ progressivamente", () => {
      expect(formatCnpj("12")).toBe("12")
      expect(formatCnpj("123")).toBe("12.3")
      expect(formatCnpj("12345")).toBe("12.345")
      expect(formatCnpj("123456")).toBe("12.345.6")
      expect(formatCnpj("12345678")).toBe("12.345.678")
      expect(formatCnpj("123456789")).toBe("12.345.678/9")
      expect(formatCnpj("123456780001")).toBe("12.345.678/0001")
      expect(formatCnpj("12345678000195")).toBe("12.345.678/0001-95")
    })

    it("limita a 14 dígitos", () => {
      expect(formatCnpj("12345678000195123456")).toBe("12.345.678/0001-95")
    })
  })

  describe("formatTelefone", () => {
    it("formata telefone celular (11 dígitos)", () => {
      expect(formatTelefone("21999887766")).toBe("+55 (21) 99988-7766")
    })

    it("formata telefone fixo (10 dígitos)", () => {
      expect(formatTelefone("2133445566")).toBe("+55 (21) 3344-5566")
    })

    it("remove prefixo 55 se presente", () => {
      expect(formatTelefone("5521999887766")).toBe("+55 (21) 99988-7766")
    })

    it("formata progressivamente", () => {
      expect(formatTelefone("2")).toBe("+55 2")
      expect(formatTelefone("21")).toBe("+55 21")
      expect(formatTelefone("219")).toBe("+55 (21) 9")
      expect(formatTelefone("2199")).toBe("+55 (21) 99")
      expect(formatTelefone("21999")).toBe("+55 (21) 999")
      expect(formatTelefone("219998")).toBe("+55 (21) 9998")
      expect(formatTelefone("2199988")).toBe("+55 (21) 9998-8")
      expect(formatTelefone("21999887")).toBe("+55 (21) 9998-87")
      expect(formatTelefone("219998877")).toBe("+55 (21) 9998-877")
      expect(formatTelefone("2199988776")).toBe("+55 (21) 9998-8776")
      expect(formatTelefone("21999887766")).toBe("+55 (21) 99988-7766")
    })
  })

  describe("formatCep", () => {
    it("formata CEP progressivamente", () => {
      expect(formatCep("0")).toBe("0")
      expect(formatCep("01")).toBe("01")
      expect(formatCep("01001")).toBe("01001")
      expect(formatCep("010010")).toBe("01001-0")
      expect(formatCep("01001000")).toBe("01001-000")
    })

    it("limita a 8 dígitos", () => {
      expect(formatCep("0100100012345")).toBe("01001-000")
    })
  })
})

// ─── Validações ─────────────────────────────────────────────────────────────

describe("Tarefa 872 — Validações", () => {
  describe("isValidCpf", () => {
    it("aceita CPFs válidos", () => {
      expect(isValidCpf("11144477735")).toBe(true)
      expect(isValidCpf("111.444.777-35")).toBe(true)
      expect(isValidCpf("52998224725")).toBe(true)
    })

    it("rejeita CPFs inválidos", () => {
      expect(isValidCpf("12345678901")).toBe(false)
      expect(isValidCpf("11111111111")).toBe(false)
      expect(isValidCpf("00000000000")).toBe(false)
      expect(isValidCpf("123")).toBe(false)
      expect(isValidCpf("")).toBe(false)
    })
  })

  describe("isValidCnpj", () => {
    it("aceita CNPJs válidos", () => {
      expect(isValidCnpj("11222333000181")).toBe(true)
      expect(isValidCnpj("11.222.333/0001-81")).toBe(true)
    })

    it("rejeita CNPJs inválidos", () => {
      expect(isValidCnpj("11222333000182")).toBe(false)
      expect(isValidCnpj("11111111111111")).toBe(false)
      expect(isValidCnpj("00000000000000")).toBe(false)
      expect(isValidCnpj("123")).toBe(false)
      expect(isValidCnpj("")).toBe(false)
    })
  })

  describe("isValidRg", () => {
    it("aceita RGs com 5+ dígitos", () => {
      expect(isValidRg("12345")).toBe(true)
      expect(isValidRg("123456789")).toBe(true)
      expect(isValidRg("12.345.678-9")).toBe(true)
    })

    it("rejeita RGs com menos de 5 dígitos", () => {
      expect(isValidRg("1234")).toBe(false)
      expect(isValidRg("")).toBe(false)
    })
  })

  describe("isValidCep", () => {
    it("aceita CEPs com 8 dígitos", () => {
      expect(isValidCep("01001000")).toBe(true)
      expect(isValidCep("01001-000")).toBe(true)
    })

    it("rejeita CEPs com menos ou mais de 8 dígitos", () => {
      expect(isValidCep("0100100")).toBe(false)
      expect(isValidCep("010010000")).toBe(false)
      expect(isValidCep("")).toBe(false)
    })
  })

  describe("isValidNomeCompleto", () => {
    it("aceita nomes com pelo menos dois nomes de 2+ caracteres", () => {
      expect(isValidNomeCompleto("João Silva")).toBe(true)
      expect(isValidNomeCompleto("Maria das Graças")).toBe(true)
      expect(isValidNomeCompleto("Ana Paula Santos")).toBe(true)
    })

    it("rejeita nomes com apenas um nome", () => {
      expect(isValidNomeCompleto("João")).toBe(false)
      expect(isValidNomeCompleto("Maria")).toBe(false)
    })

    it("rejeita nomes com partes de 1 caractere", () => {
      expect(isValidNomeCompleto("J Silva")).toBe(false)
      expect(isValidNomeCompleto("A B")).toBe(false)
    })

    it("rejeita string vazia", () => {
      expect(isValidNomeCompleto("")).toBe(false)
      expect(isValidNomeCompleto("   ")).toBe(false)
    })
  })

  describe("onlyDigits", () => {
    it("remove todos os caracteres não numéricos", () => {
      expect(onlyDigits("123.456.789-01")).toBe("12345678901")
      expect(onlyDigits("12.345.678/0001-81")).toBe("12345678000181")
      expect(onlyDigits("+55 (21) 99988-7766")).toBe("5521999887766")
      expect(onlyDigits("abc123def456")).toBe("123456")
    })
  })
})

// ─── Integração com validateDynamicForm ─────────────────────────────────────

describe("Tarefa 872 — Integração validateDynamicForm", () => {
  const fields: DynamicField[] = [
    { name: "cpf", label: "CPF", type: "text", validator: "cpf" },
    { name: "cnpj", label: "CNPJ", type: "text", validator: "cnpj" },
    { name: "rg", label: "RG", type: "text", validator: "rg" },
    { name: "cep", label: "CEP", type: "text", validator: "cep" },
    { name: "telefone", label: "Telefone", type: "text", validator: "telefone" },
    { name: "nome", label: "Nome Completo", type: "text", validator: "nomeCompleto" },
  ]

  describe("validação de CPF no formulário", () => {
    it("não retorna erro para CPF válido", () => {
      const errors = validateDynamicForm(fields, { cpf: "11144477735" })
      expect(errors.cpf).toBeUndefined()
    })

    it("retorna erro para CPF inválido", () => {
      const errors = validateDynamicForm(fields, { cpf: "12345678901" })
      expect(errors.cpf).toBe("Informe um CPF válido.")
    })

    it("aceita CPF formatado", () => {
      const errors = validateDynamicForm(fields, { cpf: "111.444.777-35" })
      expect(errors.cpf).toBeUndefined()
    })
  })

  describe("validação de CNPJ no formulário", () => {
    it("não retorna erro para CNPJ válido", () => {
      const errors = validateDynamicForm(fields, { cnpj: "11222333000181" })
      expect(errors.cnpj).toBeUndefined()
    })

    it("retorna erro para CNPJ inválido", () => {
      const errors = validateDynamicForm(fields, { cnpj: "11222333000182" })
      expect(errors.cnpj).toBe("Informe um CNPJ válido.")
    })
  })

  describe("validação de RG no formulário", () => {
    it("não retorna erro para RG válido", () => {
      const errors = validateDynamicForm(fields, { rg: "12345678" })
      expect(errors.rg).toBeUndefined()
    })

    it("retorna erro para RG inválido", () => {
      const errors = validateDynamicForm(fields, { rg: "123" })
      expect(errors.rg).toBe("Informe um RG válido.")
    })
  })

  describe("validação de CEP no formulário", () => {
    it("não retorna erro para CEP válido", () => {
      const errors = validateDynamicForm(fields, { cep: "01001000" })
      expect(errors.cep).toBeUndefined()
    })

    it("retorna erro para CEP inválido", () => {
      const errors = validateDynamicForm(fields, { cep: "0100100" })
      expect(errors.cep).toBe("Informe um CEP válido.")
    })
  })

  describe("validação de telefone no formulário", () => {
    it("não retorna erro para celular válido", () => {
      const errors = validateDynamicForm(fields, { telefone: "21999887766" })
      expect(errors.telefone).toBeUndefined()
    })

    it("não retorna erro para telefone fixo válido", () => {
      const errors = validateDynamicForm(fields, { telefone: "2133445566" })
      expect(errors.telefone).toBeUndefined()
    })

    it("não retorna erro para telefone com prefixo 55", () => {
      const errors = validateDynamicForm(fields, { telefone: "5521999887766" })
      expect(errors.telefone).toBeUndefined()
    })

    it("retorna erro para telefone curto", () => {
      const errors = validateDynamicForm(fields, { telefone: "2199988" })
      expect(errors.telefone).toBe("Informe um telefone válido.")
    })
  })

  describe("validação de nome completo no formulário", () => {
    it("não retorna erro para nome completo válido", () => {
      const errors = validateDynamicForm(fields, { nome: "João Silva" })
      expect(errors.nome).toBeUndefined()
    })

    it("retorna erro para nome incompleto", () => {
      const errors = validateDynamicForm(fields, { nome: "João" })
      expect(errors.nome).toBe("Informe o nome completo (pelo menos dois nomes).")
    })
  })

  describe("campos opcionais vazios", () => {
    it("não valida campos vazios (não obrigatórios)", () => {
      const errors = validateDynamicForm(fields, {
        cpf: "",
        cnpj: "",
        rg: "",
        cep: "",
        telefone: "",
        nome: "",
      })
      expect(Object.keys(errors)).toHaveLength(0)
    })
  })

  describe("campos obrigatórios", () => {
    it("retorna erro para campos obrigatórios vazios", () => {
      const requiredFields = fields.map(f => ({ ...f, required: true }))
      const errors = validateDynamicForm(requiredFields, {
        cpf: "",
        cnpj: "",
        rg: "",
        cep: "",
        telefone: "",
        nome: "",
      })
      expect(errors.cpf).toBe("CPF é obrigatório.")
      expect(errors.cnpj).toBe("CNPJ é obrigatório.")
      expect(errors.rg).toBe("RG é obrigatório.")
      expect(errors.cep).toBe("CEP é obrigatório.")
      expect(errors.telefone).toBe("Telefone é obrigatório.")
      expect(errors.nome).toBe("Nome Completo é obrigatório.")
    })
  })
})

// ─── Schema Zod (field.ts do shared) ────────────────────────────────────────
// O schema está em packages/shared/src/field.ts, testado separadamente
// Aqui testamos apenas a integração via validateDynamicForm
