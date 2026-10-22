// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import LogsLoginScreen, { formatarMetodo, formatarTimestamp } from "../LogsLoginScreen"

const { listar } = vi.hoisted(() => ({ listar: vi.fn() }))

listar.mockResolvedValue({
  items: [
    {
      id: 1,
      usuarioId: 7,
      email: "admin@example.com",
      metodo: "codigo_email",
      codigo: "123456",
      ip: null,
      timestamp: "2026-10-22T15:30:00.000Z",
    },
    {
      id: 2,
      usuarioId: 7,
      email: "admin@example.com",
      metodo: "senha",
      codigo: null,
      ip: null,
      timestamp: "2026-10-22T16:30:00.000Z",
    },
  ],
  total: 2,
  page: 1,
  pageSize: 20,
})

vi.mock("../../../../apps/web/src/hooks/useApi", () => ({
  useApi: () => ({ logsLogin: { list: listar } }),
}))

describe("LogsLoginScreen", () => {
  it("formata método e timestamp para a apresentação", () => {
    expect(formatarMetodo("senha")).toBe("Senha")
    expect(formatarMetodo("codigo_email")).toBe("Código por e-mail")
    expect(formatarTimestamp("2026-10-22T15:30:00.000Z")).toContain("22/10/2026")
  })

  it("renderiza usuário, data, método e código, sem código para senha", async () => {
    render(<LogsLoginScreen />)

    await waitFor(() => expect(screen.getAllByText("admin@example.com")).toHaveLength(2))
    expect(screen.getByText("Código por e-mail")).toBeInTheDocument()
    expect(screen.getByText("Senha")).toBeInTheDocument()
    expect(screen.getByText("123456")).toBeInTheDocument()
    expect(screen.getAllByText("—")).toHaveLength(1)
    expect(screen.getByText("Data e hora")).toBeInTheDocument()
    expect(screen.getByText("Usuário / e-mail")).toBeInTheDocument()
    expect(listar).toHaveBeenCalledWith({ page: 1, pageSize: 20, search: undefined })
  })
})
