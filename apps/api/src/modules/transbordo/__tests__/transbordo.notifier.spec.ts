// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { formatarResumoTransbordo, SmtpTransbordoAdapter, TelegramTransbordoAdapter, WhatsAppTransbordoAdapter } from "../transbordo.notifier"

const resumo = { nome: "Ana", assunto: "Cobrança", coletado: ["Unidade 12"], pendencia: "Análise do boleto", historicoUrl: "https://hist/1", liberacaoUrl: "https://lib/1" }
const input = { tipo: "telegram" as const, destino: "12345", atendenteNome: "Equipe", resumo }

describe("TransbordoNotifier adapters", () => {
  it("renderiza resumo estruturado com histórico e liberação", () => {
    const text = formatarResumoTransbordo(resumo)
    expect(text).toContain("Nome: Ana")
    expect(text).toContain("Assunto: Cobrança")
    expect(text).toContain("- Unidade 12")
    expect(text).toContain("https://hist/1")
    expect(text).toContain("https://lib/1")
  })

  it("retorna indisponibilidade explícita para WhatsApp", async () => {
    await expect(new WhatsAppTransbordoAdapter().enviar({ ...input, tipo: "whatsapp" })).resolves.toEqual(expect.objectContaining({ ok: false, reason: "unsupported" }))
  })

  it("envia Telegram pelo adapter mockado", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal("fetch", fetchMock)
    await expect(new TelegramTransbordoAdapter({ get: () => "bot-token" } as never).enviar(input)).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("bot-token"), expect.objectContaining({ method: "POST" }))
    vi.unstubAllGlobals()
  })

  it("não informa entrega quando SMTP não está configurado", async () => {
    await expect(new SmtpTransbordoAdapter({ get: () => undefined } as never).enviar({ ...input, tipo: "email" })).resolves.toEqual({ ok: false, reason: "not_configured" })
  })
})
