// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import DynamicForm from "../DynamicForm"
import type { DynamicField } from "../../types"

// vitest roda com globals:false — sem auto-cleanup do RTL.
afterEach(cleanup)

/**
 * Réplica fiel da declaração do campo telefone da tela de Colaborador do
 * sistema-adm-global (projects/sistema-adm-global/config.ts:200) — o
 * consumidor NÃO é modificado; a declaração é replicada aqui para o teste
 * de integração da biblioteca.
 */
const campoTelefoneColaborador: DynamicField = {
  name: "telefone",
  label: "Telefone",
  type: "text",
  required: true,
  maxLength: 30,
  mask: "telefone",
  defaultValue: "+55",
}

describe("DynamicForm — campo telefone do Colaborador (task-p1-1046)", () => {
  it('inicia com "+55" e a digitação tecla a tecla termina em "+55 (21) 99999-8888" sem duplicar dígitos', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<DynamicForm fields={[campoTelefoneColaborador]} onSubmit={onSubmit} />)

    const input = screen.getByLabelText(/Telefone/) as HTMLInputElement
    expect(input.value).toBe("+55")

    const digitado = "21999998888"
    const passos: string[] = []
    for (const tecla of digitado) {
      await user.type(input, tecla)
      passos.push(input.value)
    }

    expect(input.value).toBe("+55 (21) 99999-8888")
    // Primeiro dígito não contamina o restante e nada de "(55)" como DDD.
    expect(passos[0]).toBe("+55 2")
    passos.forEach((passo) => {
      expect(passo).not.toContain("(55)")
      // Sem dígitos duplicados: o que está após o "+55" renderizado é o
      // prefixo digitado (máscara progressiva), nunca uma repetição.
      const nacionais = passo.replace(/\D/g, "").slice(2)
      expect(digitado.startsWith(nacionais)).toBe(true)
    })

    // O valor formatado chega íntegro ao submit do formulário.
    await user.click(screen.getByRole("button", { name: /Enviar/ }))
    expect(onSubmit).toHaveBeenCalledWith({
      telefone: "+55 (21) 99999-8888",
    })
  })

  it("backspace não duplica dígitos e mantém o prefixo +55 único", async () => {
    const user = userEvent.setup()
    render(
      <DynamicForm fields={[campoTelefoneColaborador]} onSubmit={vi.fn()} />,
    )
    const input = screen.getByLabelText(/Telefone/) as HTMLInputElement
    await user.type(input, "21999998888")
    expect(input.value).toBe("+55 (21) 99999-8888")

    await user.keyboard("{Backspace}")
    expect(input.value).toBe("+55 (21) 9999-9888")
    expect((input.value.match(/\+55/g) ?? []).length).toBe(1)
    expect(input.value).not.toContain("(55)")

    await user.type(input, "8")
    expect(input.value).toBe("+55 (21) 99999-8888")
  })
})
