// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { useState } from "react"
import userEvent from "@testing-library/user-event"
import FieldText from "../FieldText"

// vitest roda com globals:false — sem auto-cleanup do RTL.
afterEach(cleanup)

/** Harness controlado — espelha o DynamicForm (que guarda a string). */
function Harness({ initialValue = "" }: { initialValue?: string }) {
  const [value, setValue] = useState(initialValue)
  return (
    <FieldText
      name="telefone"
      label="Telefone"
      value={value}
      required
      maxLength={30}
      mask="telefone"
      onChange={(_name, next) => setValue(next)}
    />
  )
}

const obterInput = (): HTMLInputElement =>
  screen.getByLabelText(/Telefone/) as HTMLInputElement

/** Digita tecla a tecla, retornando o valor do input após cada tecla. */
async function digitarTeclaATecla(
  input: HTMLInputElement,
  teclas: string,
): Promise<string[]> {
  const user = userEvent.setup()
  const passos: string[] = []
  for (const tecla of teclas) {
    await user.type(input, tecla)
    passos.push(input.value)
  }
  return passos
}

describe('FieldText mask="telefone" — digitação real tecla a tecla (task-p1-1046)', () => {
  const passosCelular = [
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
  ]

  it('defaultValue "+55": primeiro dígito não contamina e não duplica', async () => {
    render(<Harness initialValue="+55" />)
    const input = obterInput()
    expect(input.value).toBe("+55")

    const passos = await digitarTeclaATecla(input, "21999998888")

    expect(passos).toEqual(passosCelular)
    expect(input.value).toBe("+55 (21) 99999-8888")
    // "(55)" nunca aparece e nenhum dígito é duplicado durante a digitação.
    passos.forEach((passo) => {
      expect(passo).not.toContain("(55)")
    })
  })

  it("sem defaultValue: mesmo resultado final sem duplicação", async () => {
    render(<Harness />)
    const input = obterInput()
    expect(input.value).toBe("")

    const passos = await digitarTeclaATecla(input, "21999998888")

    expect(passos).toEqual(passosCelular)
    expect(input.value).toBe("+55 (21) 99999-8888")
  })

  it("backspace remove o último dígito sem duplicar; redigitar restaura", async () => {
    const user = userEvent.setup()
    render(<Harness initialValue="+55" />)
    const input = obterInput()
    await digitarTeclaATecla(input, "21999998888")
    expect(input.value).toBe("+55 (21) 99999-8888")

    await user.keyboard("{Backspace}")
    expect(input.value).toBe("+55 (21) 9999-9888")

    await user.type(input, "8")
    expect(input.value).toBe("+55 (21) 99999-8888")
  })

  it('país "55" digitado manualmente: autocorrige a partir do 12º dígito sem travar em "+55 (55) ..."', async () => {
    render(<Harness />)
    const input = obterInput()

    const passos = await digitarTeclaATecla(input, "5521999998888")

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
    // "(55)" no máximo uma vez por passo; após a autocorreção não volta.
    passos.forEach((passo) => {
      expect((passo.match(/\(55\)/g) ?? []).length).toBeLessThanOrEqual(1)
    })
    const corrigido = passos.findIndex((passo) => passo.includes("(21)"))
    expect(corrigido).toBe(11)
    passos.slice(corrigido).forEach((passo) => {
      expect(passo).not.toContain("(55)")
    })
    expect(input.value).toBe("+55 (21) 99999-8888")
  })
})
