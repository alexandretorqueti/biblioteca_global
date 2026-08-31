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
