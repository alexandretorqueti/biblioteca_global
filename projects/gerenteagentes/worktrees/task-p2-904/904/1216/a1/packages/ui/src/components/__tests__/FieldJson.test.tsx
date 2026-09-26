// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react"
import { useState } from "react"
import userEvent from "@testing-library/user-event"
import FieldJson from "../fields/FieldJson"

// vitest roda com globals:false — sem auto-cleanup do RTL.
afterEach(cleanup)

const onChange = vi.fn()

/** Harness controlado — espelha o DynamicForm (que guarda a string). */
function Harness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <FieldJson
      name="config"
      label="Config (JSON)"
      value={value}
      onChange={(_name, next) => {
        setValue(next)
        onChange(_name, next)
      }}
    />
  )
}

/** Linha do nó raiz (seta de expandir + chaves) para disparar o hover. */
function rootRow(container: HTMLElement): HTMLElement {
  const arrow = container.querySelector(".w-rjv-arrow")
  if (!arrow) {
    throw new Error("seta de expandir não encontrada")
  }
  return arrow.parentElement as HTMLElement
}

describe("FieldJson", () => {
  it("renderiza a árvore com o JSON inicial (chaves com aspas, valores)", () => {
    render(
      <FieldJson
        name="config"
        label="Config (JSON)"
        value={JSON.stringify({ app: { name: "Global" }, grupos: [] }, null, 2)}
        onChange={onChange}
      />,
    )

    expect(screen.getByText(/Config \(JSON\)/)).toBeInTheDocument()
    expect(screen.getByText(/"app"/)).toBeInTheDocument()
    expect(screen.getByText("Global")).toBeInTheDocument()
    expect(screen.getByText(/"grupos"/)).toBeInTheDocument()
  })

  it("editar um valor dispara onChange com o JSON atualizado", async () => {
    const user = userEvent.setup()
    render(
      <FieldJson
        name="config"
        label="Config (JSON)"
        value={JSON.stringify({ app: { name: "Global" } }, null, 2)}
        onChange={onChange}
      />,
    )

    const valor = screen.getByText("Global")
    await user.click(valor)
    // jsdom não implementa digitação real em contentEditable — simula o
    // conteúdo digitado e dispara o blur (que é onde o editor confirma).
    valor.textContent = "GlobalEditado"
    fireEvent.blur(valor)

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(
        "config",
        expect.stringContaining("GlobalEditado"),
      )
    })
  })

  it("adicionar chave: hover → add → renomear → definir valor", async () => {
    const user = userEvent.setup()
    const { container } = render(<Harness />)

    fireEvent.mouseEnter(rootRow(container))
    const svgs = container.querySelectorAll("svg")
    // [0] = seta, [1] = add, [2] = copiar
    const iconeAdd = svgs[1]
    expect(iconeAdd).toBeDefined()
    fireEvent.click(iconeAdd as Element)

    // Chave placeholder renomeada para "ativo".
    const chavePlaceholder = await screen.findByText(/"AddKeyOrValue"/)
    await user.click(chavePlaceholder)
    chavePlaceholder.textContent = "ativo"
    // jsdom não implementa innerText (o editor lê innerText no blur de chave).
    Object.defineProperty(chavePlaceholder, "innerText", {
      value: "ativo",
      configurable: true,
    })
    fireEvent.blur(chavePlaceholder)

    // Valor da chave definido como true.
    await waitFor(() => {
      expect(screen.getByText(/"ativo"/)).toBeInTheDocument()
    })
    const valorUndefined = screen.getByText("undefined")
    await user.click(valorUndefined)
    valorUndefined.textContent = "true"
    fireEvent.blur(valorUndefined)

    await waitFor(() => {
      const ultima = onChange.mock.calls.at(-1)?.[1] as string
      expect(ultima).toContain('"ativo"')
      expect(ultima).toContain("true")
    })
  })

  it("excluir chave: hover no nó → delete remove do JSON", () => {
    const { container } = render(
      <FieldJson
        name="config"
        label="Config (JSON)"
        value={JSON.stringify({ app: { name: "Global" }, grupos: [] }, null, 2)}
        onChange={onChange}
      />,
    )

    // Header do nó "app" (objeto expansível) — linha com seta + chaves.
    const headerApp = container.querySelector(".w-rjv-inner")
    expect(headerApp).not.toBeNull()
    fireEvent.mouseEnter(headerApp as HTMLElement)

    const svgs = (headerApp as HTMLElement).querySelectorAll("svg")
    // [0] = seta, [1] = add, [2] = delete, [3] = copiar
    expect(svgs.length).toBeGreaterThanOrEqual(3)
    const iconeDelete = svgs[2]
    expect(iconeDelete).toBeDefined()
    fireEvent.click(iconeDelete as Element)

    expect(onChange).toHaveBeenCalledWith(
      "config",
      expect.not.stringContaining("app"),
    )
  })

  it("campo vazio renderiza objeto vazio (permite adicionar)", () => {
    const { container } = render(
      <FieldJson
        name="config"
        label="Config (JSON)"
        value=""
        onChange={onChange}
      />,
    )

    expect(screen.getByText("{")).toBeInTheDocument()
    expect(container.querySelectorAll("svg").length).toBeGreaterThan(0)
  })

  it("mudança externa do valor re-renderiza a árvore", () => {
    const { rerender } = render(
      <FieldJson
        name="config"
        label="Config (JSON)"
        value={JSON.stringify({ antigo: "valor" }, null, 2)}
        onChange={onChange}
      />,
    )

    expect(screen.getByText("valor")).toBeInTheDocument()

    rerender(
      <FieldJson
        name="config"
        label="Config (JSON)"
        value={JSON.stringify({ novo: "outro" }, null, 2)}
        onChange={onChange}
      />,
    )

    expect(screen.getByText("outro")).toBeInTheDocument()
    expect(screen.queryByText("valor")).not.toBeInTheDocument()
  })

  it("desabilitado não habilita edição de valores", () => {
    render(
      <FieldJson
        name="config"
        label="Config (JSON)"
        value={JSON.stringify({ app: "x" }, null, 2)}
        onChange={onChange}
        disabled
      />,
    )

    const valor = screen.getByText("x")
    fireEvent.click(valor)
    expect(valor.getAttribute("contenteditable")).not.toBe("true")
  })
})
