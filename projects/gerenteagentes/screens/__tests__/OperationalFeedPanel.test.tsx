// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"
import OperationalFeedPanel from "../OperationalFeedPanel"
import type { OperationalFeedItem } from "../../api/operational-feed"

const items: OperationalFeedItem[] = [
  { id: "message:1", type: "message", projectId: 1, taskId: 10, taskTitle: "Implementar mapa", agentId: "claude", state: "delivered", role: "assistant", text: "A implementação foi entregue.", occurredAt: "2026-09-29T10:00:00Z" },
  { id: "event:2", type: "event", projectId: 1, taskId: 11, taskTitle: "Revisar API", agentId: "Motor", event: "task.status.changed", occurredAt: "2026-09-29T10:01:00Z" },
  { id: "action:3", type: "pending_action", projectId: 1, taskId: 12, taskTitle: "Publicar release", actionType: "deploy", priority: 10, state: "pending", occurredAt: "2026-09-29T10:02:00Z", reason: "Aguardando aprovação" },
]

function renderPanel(feedItems = items, onSelectTask = vi.fn()) {
  return render(<BibliotecaThemeProvider><OperationalFeedPanel items={feedItems} connection="open" recovered onSelectTask={onSelectTask} /></BibliotecaThemeProvider>)
}

describe("OperationalFeedPanel", () => {
  it("separa timeline de mensagens/atividades e ações pendentes com contadores", () => {
    renderPanel()
    expect(screen.getByTestId("operational-feed-panel")).toBeInTheDocument()
    expect(screen.getByText("Quadro operacional")).toBeInTheDocument()
    expect(screen.getByText("A implementação foi entregue.")).toBeInTheDocument()
    expect(screen.getByText("Aguardando aprovação")).toBeInTheDocument()
    expect(screen.getByText("Dados recuperados")).toBeInTheDocument()
    expect(screen.getByText(/1 mensagens · 1 atividades · 1 pendências/)).toBeInTheDocument()
  })

  it("filtra por categoria e estado e navega para a tarefa sem executar ação", async () => {
    const onSelectTask = vi.fn()
    renderPanel(items, onSelectTask)
    await userEvent.click(screen.getByRole("combobox", { name: "Categoria" }))
    await userEvent.click(screen.getByRole("option", { name: /Mensagens \(1\)/ }))
    expect(screen.getByText("A implementação foi entregue.")).toBeInTheDocument()
    expect(screen.queryByText("Aguardando aprovação")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("operational-feed-item-message:1"))
    expect(onSelectTask).toHaveBeenCalledWith(10)
    expect(onSelectTask).toHaveBeenCalledTimes(1)
  })

  it("recolhe e expande sem perder os itens recebidos", async () => {
    renderPanel()
    fireEvent.click(screen.getByRole("button", { name: "Recolher quadro operacional" }))
    await waitFor(() => expect(screen.queryByText("A implementação foi entregue.")).not.toBeVisible())
    fireEvent.click(screen.getByRole("button", { name: "Expandir quadro operacional" }))
    await waitFor(() => expect(screen.getByText("A implementação foi entregue.")).toBeVisible())
  })

  it("informa estado vazio de pendências e indisponibilidade da atualização", () => {
    render(<BibliotecaThemeProvider><OperationalFeedPanel items={[]} connection="closed" recovered={false} onSelectTask={vi.fn()} /></BibliotecaThemeProvider>)
    expect(screen.getByText("Atualização indisponível")).toBeInTheDocument()
    expect(screen.getByText("Nenhuma ação pendente.")).toBeInTheDocument()
    expect(screen.getByText("Nenhuma mensagem ou atividade para estes filtros.")).toBeInTheDocument()
  })
})
