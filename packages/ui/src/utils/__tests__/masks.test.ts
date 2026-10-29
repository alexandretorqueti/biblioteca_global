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
  onlyDigits,
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

describe("formatTelefone — digitação tecla a tecla (regressão task-p1-1046)", () => {
  /**
   * Simula digitação real: aplica formatTelefone iterativamente sobre a
   * saída anterior + tecla digitada (mesmo fluxo do estado controlado do
   * FieldText mask="telefone").
   */
  const digitar = (inicial: string, teclas: string): string[] => {
    let estado = inicial
    const passos: string[] = []
    for (const tecla of teclas) {
      estado = formatTelefone(estado + tecla)
      passos.push(estado)
    }
    return passos
  }

  /** Simula um backspace: remove o último caractere e reformata. */
  const apagarUltimo = (estado: string): string =>
    formatTelefone(estado.slice(0, -1))

  /** Dígitos exibidos sem o prefixo nacional renderizado ("+55"). */
  const digitosNacionais = (estado: string): string => {
    const digits = onlyDigits(estado)
    expect(digits.startsWith("55")).toBe(true)
    return digits.slice(2)
  }

  /** O DDD falso "(55)" pode aparecer no máximo uma vez por passo. */
  const contarDdd55 = (estado: string): number =>
    (estado.match(/\(55\)/g) ?? []).length

  it("vazio → 21999998888: cada passo sem dígitos duplicados", () => {
    const digitado = "21999998888"
    const passos = digitar("", digitado)

    expect(passos).toEqual([
      "+55 2",
      "+55 21",
      "+55 (21) 9",
      "+55 (21) 99",
      "+55 (21) 999",
      "+55 (21) 9999",
      "+55 (21) 9999-9",
      "+55 (21) 9999-98",
      "+55 (21) 9999-988",
      "+55 (21) 9999-9888",
      "+55 (21) 99999-8888",
    ])
    passos.forEach((passo, i) => {
      // Sem duplicação: os dígitos exibidos são exatamente o prefixo digitado.
      expect(digitosNacionais(passo)).toBe(digitado.slice(0, i + 1))
      expect(contarDdd55(passo)).toBe(0)
    })
  })

  it("'+55' → 21999998888: defaultValue não contamina a digitação", () => {
    const digitado = "21999998888"
    const passos = digitar("+55", digitado)

    expect(passos).toEqual([
      "+55 2",
      "+55 21",
      "+55 (21) 9",
      "+55 (21) 99",
      "+55 (21) 999",
      "+55 (21) 9999",
      "+55 (21) 9999-9",
      "+55 (21) 9999-98",
      "+55 (21) 9999-988",
      "+55 (21) 9999-9888",
      "+55 (21) 99999-8888",
    ])
    passos.forEach((passo, i) => {
      expect(digitosNacionais(passo)).toBe(digitado.slice(0, i + 1))
      expect(contarDdd55(passo)).toBe(0)
    })
  })

  it("'+55' → 2133334444 (fixo): cada passo sem dígitos duplicados", () => {
    const digitado = "2133334444"
    const passos = digitar("+55", digitado)

    expect(passos).toEqual([
      "+55 2",
      "+55 21",
      "+55 (21) 3",
      "+55 (21) 33",
      "+55 (21) 333",
      "+55 (21) 3333",
      "+55 (21) 3333-4",
      "+55 (21) 3333-44",
      "+55 (21) 3333-444",
      "+55 (21) 3333-4444",
    ])
    passos.forEach((passo, i) => {
      expect(digitosNacionais(passo)).toBe(digitado.slice(0, i + 1))
      expect(contarDdd55(passo)).toBe(0)
    })
  })

  it("país manual 5521999998888: '(55)' no máximo uma vez e autocorreção a partir do 12º dígito", () => {
    const digitado = "5521999998888"
    const passos = digitar("", digitado)

    expect(passos).toEqual([
      "+55 5",
      "+55 55",
      "+55 (55) 2",
      "+55 (55) 21",
      "+55 (55) 219",
      "+55 (55) 2199",
      "+55 (55) 2199-9",
      "+55 (55) 2199-99",
      "+55 (55) 2199-999",
      "+55 (55) 2199-9998",
      "+55 (55) 21999-9988",
      "+55 (21) 9999-9888",
      "+55 (21) 99999-8888",
    ])
    passos.forEach((passo, i) => {
      const prefixo = digitado.slice(0, i + 1)
      // Sem duplicação: os dígitos exibidos são o prefixo digitado — ou o
      // prefixo sem o "55" do país manual após a autocorreção (12º dígito).
      const nacionais = digitosNacionais(passo)
      expect([prefixo, prefixo.slice(2)]).toContain(nacionais)
      expect(contarDdd55(passo)).toBeLessThanOrEqual(1)
    })
    // Não trava em "+55 (55) ...": autocorrigiu e o resultado final é o celular.
    expect(passos.at(-1)).toBe("+55 (21) 99999-8888")
    expect(passos.at(-2)).not.toContain("(55)")
  })

  it("estado travado legado '+55 (55) 21999-9988' se autocorrige ao continuar digitando", () => {
    const travado = "+55 (55) 21999-9988"
    const passo12 = formatTelefone(travado + "8")
    expect(passo12).toBe("+55 (21) 9999-9888")
    expect(formatTelefone(passo12 + "8")).toBe("+55 (21) 99999-8888")
  })

  it("backspace não duplica dígitos e redigitar restaura o celular completo", () => {
    const cheio = "+55 (21) 99999-8888"
    const umBackspace = apagarUltimo(cheio)
    expect(umBackspace).toBe("+55 (21) 9999-9888")
    expect(digitosNacionais(umBackspace)).toBe("2199999888")

    const doisBackspaces = apagarUltimo(umBackspace)
    expect(doisBackspaces).toBe("+55 (21) 9999-988")

    expect(formatTelefone(umBackspace + "8")).toBe(cheio)
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
