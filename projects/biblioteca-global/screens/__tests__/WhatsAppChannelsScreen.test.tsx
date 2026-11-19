// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"
import WhatsAppChannelsScreen from "../WhatsAppChannelsScreen"

const state = vi.hoisted(() => ({
  requests: [] as Array<{ method: string; path: string }>,
  links: [] as Array<Record<string, unknown>>,
  pairingStatuses: [] as Array<Record<string, unknown>>,
}))

vi.mock("../../../../apps/web/src/hooks/useApi", () => ({
  useApi: (() => {
    const bundle = { http: { request: async (method: string, path: string) => {
    state.requests.push({ method, path })
    if (path === "/projetos") return { items: [{ id: 7, nome: "Tenant Demo", slug: "tenant-demo", ativo: true }], total: 1, page: 1, pageSize: 100 }
    if (path === "/tenants/7/whatsapp") return state.links
    if (path === "/tenants/7/whatsapp/pairing" && method === "POST") return { accountId: "tenant-demo", qr: "data:image/png;base64,qr", expiresAt: "2026-11-18T12:00:00.000Z" }
    if (path === "/tenants/7/whatsapp/pairing/tenant-demo") return state.pairingStatuses.shift() ?? { accountId: "tenant-demo", estado: "pareando", numero: null, agentId: "agent-demo", ultimoStatusEm: null }
    if (path === "/tenants/7/whatsapp/tenant-demo" && method === "DELETE") return { ok: true, accountId: "tenant-demo" }
    return {}
    } } }
    return () => bundle
  })(),
}))

function renderScreen() {
  return render(<BibliotecaThemeProvider><WhatsAppChannelsScreen /></BibliotecaThemeProvider>)
}

beforeEach(() => {
  state.requests.length = 0
  state.links = [{ id: 1, tenantId: 7, accountId: "tenant-demo", numero: "11999998888", agentId: "agent-demo", estado: "ativo", ultimoStatusEm: null, createdAt: "2026-11-18T10:00:00.000Z", updatedAt: "2026-11-18T10:00:00.000Z" }]
  state.pairingStatuses = []
  vi.stubGlobal("confirm", vi.fn(() => true))
})

describe("WhatsAppChannelsScreen", () => {
  it("renderiza a lista de vínculos", async () => {
    renderScreen()
    expect(await screen.findByText("Tenant Demo")).toBeInTheDocument()
    expect(screen.getByText("11999998888")).toBeInTheDocument()
    expect(screen.getByText("Ativo")).toBeInTheDocument()
    expect(screen.getByText("agent-demo")).toBeInTheDocument()
  })

  it("exibe o QR ao iniciar pareamento", async () => {
    renderScreen()
    await screen.findByText("Tenant Demo")
    await userEvent.click(screen.getByRole("combobox"))
    await userEvent.click(screen.getByRole("option", { name: /Tenant Demo/ }))
    const connect = screen.getByRole("button", { name: "Conectar WhatsApp" })
    expect(connect).not.toBeDisabled()
    await userEvent.click(connect)
    await waitFor(() => expect(state.requests).toContainEqual({ method: "POST", path: "/tenants/7/whatsapp/pairing" }))
    expect(await screen.findByAltText("QR Code para pareamento do WhatsApp")).toHaveAttribute("src", "data:image/png;base64,qr")
    expect(screen.getByText(/QR válido até/)).toHaveTextContent(/18\/11\/2026/)
  })

  it("reflete pareando e depois ativo no poll", async () => {
    state.links = [{ ...state.links[0]!, estado: "pareando" }]
    state.pairingStatuses = [{ accountId: "tenant-demo", estado: "ativo", numero: "11999998888", agentId: "agent-demo", ultimoStatusEm: "2026-11-18T12:01:00.000Z" }]
    renderScreen()
    await screen.findByText("Tenant Demo")
    await userEvent.click(screen.getByRole("combobox"))
    await userEvent.click(screen.getByRole("option", { name: /Tenant Demo/ }))
    await userEvent.click(screen.getByRole("button", { name: "Conectar WhatsApp" }))
    expect(await screen.findByText("Ativo")).toBeInTheDocument()
  })

  it("mostra pareamento expirado", async () => {
    state.links = [{ ...state.links[0]!, estado: "pareando" }]
    state.pairingStatuses = [{ accountId: "tenant-demo", estado: "expirado", numero: null, agentId: "agent-demo", ultimoStatusEm: null }]
    renderScreen()
    await screen.findByText("Tenant Demo")
    await userEvent.click(screen.getByRole("combobox"))
    await userEvent.click(screen.getByRole("option", { name: /Tenant Demo/ }))
    await userEvent.click(screen.getByRole("button", { name: "Conectar WhatsApp" }))
    expect(await screen.findByText("Expirado")).toBeInTheDocument()
  })

  it("confirma a remoção do vínculo", async () => {
    renderScreen()
    await screen.findByText("Tenant Demo")
    await userEvent.click(screen.getByRole("button", { name: "Remover" }))
    await waitFor(() => expect(state.requests).toContainEqual({ method: "DELETE", path: "/tenants/7/whatsapp/tenant-demo" }))
    expect(window.confirm).toHaveBeenCalled()
  })
})
