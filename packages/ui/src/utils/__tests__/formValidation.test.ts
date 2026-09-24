import { describe, expect, it } from "vitest"
import type { DynamicField } from "../../components/DynamicForm"
import { validateDynamicForm } from "../formValidation"

const fields: DynamicField[] = [
  {
    name: "razaoSocial",
    label: "Razão Social",
    type: "text",
    required: true,
    minLength: 3,
  },
  {
    name: "cnpj",
    label: "CNPJ",
    type: "text",
    required: true,
    validator: "cnpj",
  },
]

describe("validação centralizada", () => {
  it("identifica campos inválidos", () => {
    const errors = validateDynamicForm(fields, {
      razaoSocial: "A",
      cnpj: "11.111.111/1111-11",
    })

    expect(errors.razaoSocial).toBeTruthy()
    expect(errors.cnpj).toBeTruthy()
  })

  it("aceita valores válidos", () => {
    expect(
      validateDynamicForm(fields, {
        razaoSocial: "Global Tecnologia",
        cnpj: "05.064.544/0001-30",
      }),
    ).toEqual({})
  })
})

describe("validação de CPF", () => {
  const cpfFields: DynamicField[] = [
    { name: "cpf", label: "CPF", type: "text", validator: "cpf" },
  ]

  it("rejeita CPF inválido", () => {
    const errors = validateDynamicForm(cpfFields, { cpf: "123.456.789-00" })
    expect(errors.cpf).toBe("Informe um CPF válido.")
  })

  it("aceita CPF válido", () => {
    const errors = validateDynamicForm(cpfFields, { cpf: "123.456.789-09" })
    expect(errors.cpf).toBeUndefined()
  })
})

describe("validação de RG", () => {
  const rgFields: DynamicField[] = [
    { name: "rg", label: "RG", type: "text", validator: "rg" },
  ]

  it("rejeita RG com menos de 5 dígitos", () => {
    const errors = validateDynamicForm(rgFields, { rg: "1234" })
    expect(errors.rg).toBe("Informe um RG válido.")
  })

  it("aceita RG válido", () => {
    const errors = validateDynamicForm(rgFields, { rg: "12.345.678-9" })
    expect(errors.rg).toBeUndefined()
  })
})

describe("validação de CEP", () => {
  const cepFields: DynamicField[] = [
    { name: "cep", label: "CEP", type: "text", validator: "cep" },
  ]

  it("rejeita CEP inválido", () => {
    const errors = validateDynamicForm(cepFields, { cep: "0131-100" })
    expect(errors.cep).toBe("Informe um CEP válido.")
  })

  it("aceita CEP válido", () => {
    const errors = validateDynamicForm(cepFields, { cep: "01310-100" })
    expect(errors.cep).toBeUndefined()
  })
})

describe("validação de telefone", () => {
  const telFields: DynamicField[] = [
    { name: "tel", label: "Telefone", type: "text", validator: "telefone" },
  ]

  it("rejeita telefone com menos de 10 dígitos", () => {
    const errors = validateDynamicForm(telFields, { tel: "+55 (21) 999" })
    expect(errors.tel).toBe("Informe um telefone válido.")
  })

  it("aceita telefone celular completo", () => {
    const errors = validateDynamicForm(telFields, {
      tel: "+55 (21) 99999-8888",
    })
    expect(errors.tel).toBeUndefined()
  })

  it("aceita telefone fixo completo", () => {
    const errors = validateDynamicForm(telFields, {
      tel: "+55 (21) 3333-4444",
    })
    expect(errors.tel).toBeUndefined()
  })
})

describe("validação de nome completo", () => {
  const nomeFields: DynamicField[] = [
    {
      name: "nome",
      label: "Nome Completo",
      type: "text",
      validator: "nomeCompleto",
    },
  ]

  it("rejeita nome com apenas um nome", () => {
    const errors = validateDynamicForm(nomeFields, { nome: "João" })
    expect(errors.nome).toBe(
      "Informe o nome completo (pelo menos dois nomes).",
    )
  })

  it("aceita nome com dois nomes", () => {
    const errors = validateDynamicForm(nomeFields, { nome: "João Silva" })
    expect(errors.nome).toBeUndefined()
  })
})
