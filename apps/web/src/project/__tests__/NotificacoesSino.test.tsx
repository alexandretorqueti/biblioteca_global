// @vitest-environment jsdom
/**
 * NotificacoesSino (macro #5, subtarefa 5) — fetch e WebSocket mockados:
 * - badge inicial a partir do GET /:slug/notificacoes;
 * - `notification.created` via canal realtime incrementa badge/lista SEM reload
 *   (revalidação por GET — o socket é sinal, a API é fonte de verdade);
 * - 'Marcar todas lidas' chama POST lidas-todas e zera o badge;
 * - clique no item chama POST /:id/lida e navega (bg:navigate) quando há tarefaId.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { describe, expect, it, vi } from "vitest"
import { NotificacoesSino, tempoRelativo, type SinoRealtimeHandlers } from "../NotificacoesSino"

interface FakeResposta {
  itens: Array<{
    id: number
    titulo: string
    corpo: string | null
    tipo: string
    tarefaId: number | null
    lida: boolean
    criadoEm: string
  }>
  naoLidas: number
}

function item(id: number, extra: Partial<FakeResposta["itens"][number]> = {}) {
  return {
    id,
    titulo: `Notificação ${id}`,
    corpo: `Corpo ${id}`,
    tipo: "lembrete",
    tarefaId: null,
    lida: false,
    criadoEm: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...extra,
  }
}

function montar(respostaInicial: FakeResposta) {
  let captured: SinoRealtimeHandlers | null = null
  let fechada = false
  const request = vi.fn(async (method: string, path: string) => {
    if (method === "GET" && path === "/gestao-de-tarefas-global/notificacoes") {
      return respostaInicial
    }
    if (method === "POST" && path === "/gestao-de-tarefas-global/notificacoes/lidas-todas") {
      return { atualizadas: respostaInicial.naoLidas, naoLidas: 0 }
    }
    if (method === "POST" && /\/notificacoes\/\d+\/lida$/.test(path)) {
      return { ok: true }
    }
    throw new Error(`request inesperado: ${method} ${path}`)
  })
  const utils = render(
    <NotificacoesSino
      slug="gestao-de-tarefas-global"
      http={{ request } as never}
      getAccessToken={() => "token"}
      criarRealtime={(handlers) => {
        captured = handlers
        return { close: () => { fechada = true } }
      }}
    />,
  )
  return {
    ...utils,
    request,
    handlers: () => {
      if (!captured) throw new Error("realtime não assinado")
      return captured
    },
    fechado: () => fechada,
  }
}

describe("NotificacoesSino", () => {
  it("exibe badge com a contagem de não lidas do GET inicial", async () => {
    montar({ itens: [item(1), item(2, { lida: true })], naoLidas: 1 })
    await waitFor(() =>
      expect(screen.getByTestId("sino-notificacoes")).toHaveAccessibleName(/1 não lidas/),
    )
    expect(screen.getByTestId("sino-badge")).toHaveTextContent("1")
    // popover fechado no mount
    expect(screen.queryByTestId("sino-popover")).not.toBeInTheDocument()
  })

  it("notification.created via realtime atualiza badge e popover sem reload", async () => {
    const resposta = { itens: [item(1)], naoLidas: 1 }
    const t = montar(resposta)
    await waitFor(() => expect(t.request).toHaveBeenCalledTimes(1))

    // Servidor cria mais 2 notificações → o push é sinal; o GET revalida.
    resposta.itens = [item(3), item(2), item(1)]
    resposta.naoLidas = 3
    act(() => t.handlers().onNotificacaoCriada())

    await waitFor(() =>
      expect(screen.getByTestId("sino-notificacoes")).toHaveAccessibleName(/3 não lidas/),
    )
    expect(t.request).toHaveBeenCalledTimes(2) // GET extra disparado pelo evento

    fireEvent.click(screen.getByTestId("sino-notificacoes"))
    await waitFor(() => expect(screen.getByTestId("sino-popover")).toBeInTheDocument())
    expect(screen.getByTestId("notificacao-3")).toBeInTheDocument()
    expect(screen.getByTestId("nao-lida-3")).toBeInTheDocument()

    // unread.changed ajusta badge direto (ex.: lida marcada em outra aba)
    act(() => t.handlers().onContagemNaoLidas(0))
    await waitFor(() =>
      expect(screen.getByTestId("sino-notificacoes")).toHaveAccessibleName(/0 não lidas/),
    )
  })

  it("'Marcar todas lidas' chama o endpoint e zera o badge imediatamente", async () => {
    const t = montar({ itens: [item(1), item(2)], naoLidas: 2 })
    await waitFor(() =>
      expect(screen.getByTestId("sino-notificacoes")).toHaveAccessibleName(/2 não lidas/),
    )
    fireEvent.click(screen.getByTestId("sino-notificacoes"))
    fireEvent.click(await screen.findByTestId("marcar-todas-lidas"))

    await waitFor(() =>
      expect(t.request).toHaveBeenCalledWith(
        "POST",
        "/gestao-de-tarefas-global/notificacoes/lidas-todas",
      ),
    )
    await waitFor(() =>
      expect(screen.getByTestId("sino-notificacoes")).toHaveAccessibleName(/0 não lidas/),
    )
    // itens perdem a marca de não lida
    expect(screen.queryByTestId("nao-lida-1")).not.toBeInTheDocument()
    expect(screen.queryByTestId("nao-lida-2")).not.toBeInTheDocument()
  })

  it("clique no item marca lida e navega para a tarefa vinculada", async () => {
    const t = montar({ itens: [item(7, { tarefaId: 42 })], naoLidas: 1 })
    await waitFor(() =>
      expect(screen.getByTestId("sino-notificacoes")).toHaveAccessibleName(/1 não lidas/),
    )
    const navegacoes: unknown[] = []
    const oyente = (e: Event) => navegacoes.push((e as CustomEvent).detail)
    window.addEventListener("bg:navigate", oyente)

    fireEvent.click(screen.getByTestId("sino-notificacoes"))
    fireEvent.click(await screen.findByTestId("notificacao-7"))

    await waitFor(() =>
      expect(t.request).toHaveBeenCalledWith(
        "POST",
        "/gestao-de-tarefas-global/notificacoes/7/lida",
      ),
    )
    expect(navegacoes).toEqual([{ path: "tarefas", tarefaId: 42 }])
    await waitFor(() =>
      expect(screen.getByTestId("sino-notificacoes")).toHaveAccessibleName(/0 não lidas/),
    )
    // popover fecha ao clicar (aguarda a transição de saída do MUI)
    await waitFor(() =>
      expect(screen.queryByTestId("sino-popover")).not.toBeInTheDocument(),
    )
    window.removeEventListener("bg:navigate", oyente)
  })

  it("item sem tarefaId marca lida mas não navega; unmount fecha o canal", async () => {
    const t = montar({ itens: [item(9, { tarefaId: null })], naoLidas: 1 })
    await waitFor(() =>
      expect(screen.getByTestId("sino-notificacoes")).toHaveAccessibleName(/1 não lidas/),
    )
    const navegacoes: unknown[] = []
    const oyente = (e: Event) => navegacoes.push((e as CustomEvent).detail)
    window.addEventListener("bg:navigate", oyente)

    fireEvent.click(screen.getByTestId("sino-notificacoes"))
    fireEvent.click(await screen.findByTestId("notificacao-9"))
    await waitFor(() =>
      expect(t.request).toHaveBeenCalledWith(
        "POST",
        "/gestao-de-tarefas-global/notificacoes/9/lida",
      ),
    )
    expect(navegacoes).toHaveLength(0)
    window.removeEventListener("bg:navigate", oyente)

    t.unmount()
    expect(t.fechado()).toBe(true)
  })

  it("lista vazia mostra mensagem amigável e desabilita 'marcar todas'", async () => {
    montar({ itens: [], naoLidas: 0 })
    fireEvent.click(screen.getByTestId("sino-notificacoes"))
    await waitFor(() => expect(screen.getByTestId("sino-vazio")).toBeInTheDocument())
    expect(screen.getByTestId("marcar-todas-lidas")).toBeDisabled()
  })

  it("tempoRelativo formata minutos/horas/dias em pt-BR", () => {
    const agora = Date.parse("2026-11-25T12:00:00Z")
    expect(tempoRelativo("2026-11-25T11:59:30Z", agora)).toBe("agora")
    expect(tempoRelativo("2026-11-25T11:55:00Z", agora)).toBe("há 5 min")
    expect(tempoRelativo("2026-11-25T09:00:00Z", agora)).toBe("há 3 h")
    expect(tempoRelativo("2026-11-23T12:00:00Z", agora)).toBe("há 2 d")
  })
})
