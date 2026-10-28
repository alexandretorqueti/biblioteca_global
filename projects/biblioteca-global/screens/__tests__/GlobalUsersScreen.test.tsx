// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"
import GlobalUsersScreen from "../GlobalUsersScreen"

const state = vi.hoisted(() => ({ users: [{ id: 1, nome: "Ana", username: "ana", email: "ana@x.test", telefone: null, cpf: null, ativo: true, createdAt: "", updatedAt: "" }], links: [] as Array<{ projetoId: number; projetoNome: string; projetoSlug: string; perfil: "admin" | "operador" }>, requests: [] as string[] }))
vi.mock("../../../../apps/web/src/hooks/useApi", () => {
  const bundle = { http: { request: async (method: string, path: string, options?: { body?: unknown }) => { state.requests.push(`${method} ${path}`); if (path === "/usuarios/gerais") return { items: state.users, total: 1, page: 1, pageSize: 100 }; if (path === "/projetos") return { items: [{ id: 2, nome: "Projeto X", slug: "x", ativo: true, config: {}, createdAt: "", updatedAt: "" }], total: 1, page: 1, pageSize: 100 }; if (path === "/usuarios/gerais/1") return { ...state.users[0], vinculos: state.links }; if (method === "PUT" && path === "/usuarios/1/vinculos") { const body = options?.body as { adicionar?: Array<{ projetoId: number; perfil: "admin" | "operador" }>; remover?: number[] }; state.links = body.adicionar?.map((v) => ({ projetoId: v.projetoId, projetoNome: "Projeto X", projetoSlug: "x", perfil: v.perfil })) ?? []; return { usuarioId: 1 }; } return {}; } } }
  return { useApi: () => bundle }
})

beforeEach(() => { state.links = []; state.requests.length = 0 })

function renderScreen() { return render(<BibliotecaThemeProvider><GlobalUsersScreen /></BibliotecaThemeProvider>) }

describe("GlobalUsersScreen", () => {
  it("carrega contas sem duplicar por vínculo e abre a gestão de vínculos", async () => {
    renderScreen()
    expect(await screen.findByText("Ana")).toBeInTheDocument()
    expect(screen.getAllByText("Ana")).toHaveLength(1)
    await userEvent.click(screen.getByRole("button", { name: "Vínculos" }))
    expect(await screen.findByText("Vínculos de Ana")).toBeInTheDocument()
    expect(screen.getByText("Nenhum vínculo.")).toBeInTheDocument()
  })

  it("exige projeto e perfil para criar vínculo e envia o perfil escolhido", async () => {
    renderScreen()
    await userEvent.click(await screen.findByRole("button", { name: "Vínculos" }))
    const vincular = screen.getByRole("button", { name: "Vincular" })
    expect(vincular).toBeDisabled()
    const comboboxes = screen.getAllByRole("combobox")
    await userEvent.click(comboboxes[0]!)
    await userEvent.click(await screen.findByRole("option", { name: "Projeto X" }))
    expect(vincular).toBeDisabled()
    await userEvent.click(comboboxes[1]!)
    await userEvent.click(await screen.findByRole("option", { name: "Operador" }))
    await userEvent.click(vincular)
    await waitFor(() => expect(state.requests).toContain("PUT /usuarios/1/vinculos"))
    expect(await screen.findByText("Projeto X")).toBeInTheDocument()
  })
})
