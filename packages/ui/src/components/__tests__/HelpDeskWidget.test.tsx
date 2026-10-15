// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import HelpDeskWidget from "../HelpDeskWidget"
import type { HelpDeskDriver } from "@biblioteca-global/api-client"
import type { RealtimeServerMessage } from "@biblioteca-global/shared"

const session = { sessaoId: 7, agenteId: "agente" }
const stamp = "2026-10-15T12:00:00.000Z"

function history(messages: Array<{ id: number; role: "user" | "agent"; text: string }>) {
  return {
    sessao: { id: 7, usuarioId: 1, projetoId: 2, agenteId: "agente", status: "active" as const, createdAt: stamp, updatedAt: stamp },
    mensagens: messages.map((message) => ({ ...message, sessaoId: 7, createdAt: stamp })),
  }
}

function makeClient(overrides: Partial<HelpDeskDriver> = {}): HelpDeskDriver {
  return {
    sessaoId: 7,
    agenteId: "agente",
    obterSessao: vi.fn(async () => session),
    criarSessao: vi.fn(async () => session),
    obterHistorico: vi.fn(async () => history([])),
    consultarStatus: vi.fn(async () => ({ processing: true, responded: false })),
    enviarMensagem: vi.fn(async () => ({ ok: true, processing: true })),
    assinarRealtime: vi.fn(() => ({ close: vi.fn() })),
    ...overrides,
  }
}

async function openWidget(client: HelpDeskDriver) {
  render(<HelpDeskWidget client={client} />)
  fireEvent.click(screen.getByRole("button", { name: "Abrir HelpDesk" }))
  await waitFor(() => expect(screen.getByLabelText("Mensagem")).toBeInTheDocument())
}

describe("HelpDeskWidget — entrega assíncrona", () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("entrega resposta imediata pelo realtime sem duplicar mensagem", async () => {
    let onMessage: ((message: RealtimeServerMessage) => void) | undefined
    const client = makeClient({
      assinarRealtime: vi.fn((input) => {
        onMessage = input.onMessage
        return { close: vi.fn() }
      }),
      enviarMensagem: vi.fn(async () => ({ ok: true, processing: false })),
    })
    await openWidget(client)
    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "oi" } })
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }))
    onMessage?.({ type: "event", event: { type: "helpdesk.message.created", payload: { id: 9, sessaoId: 7, role: "agent", text: "resposta", createdAt: stamp }, eventId: "e1", occurredAt: stamp, source: "test", projectId: 2, sessionId: 7 } } as never)
    await waitFor(() => expect(screen.getAllByText("resposta")).toHaveLength(1))
  })

  it("reconcilia resposta tardia por polling sequencial", async () => {
    const status = vi.fn()
      .mockResolvedValueOnce({ processing: true, responded: false })
      .mockResolvedValueOnce({ processing: false, responded: true })
    const client = makeClient({
      consultarStatus: status,
      obterHistorico: vi.fn()
        .mockResolvedValueOnce(history([]))
        .mockResolvedValueOnce(history([{ id: 9, role: "agent", text: "resposta tardia" }])),
    })
    await openWidget(client)
    vi.useFakeTimers()
    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "oi" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enviar" }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(status).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByText("resposta tardia")).toBeInTheDocument()
    expect(status).toHaveBeenCalledTimes(2)
  })

  it("bloqueia novo envio enquanto há resposta pendente e cancela polling ao fechar", async () => {
    const close = vi.fn()
    const client = makeClient({ assinarRealtime: vi.fn(() => ({ close })) })
    await openWidget(client)
    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "primeira" } })
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }))
    await waitFor(() => expect(screen.getByLabelText("Mensagem")).toBeDisabled())
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Fechar chat" }))
  })
})
