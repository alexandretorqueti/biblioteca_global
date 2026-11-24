import { beforeEach, describe, expect, it, vi } from "vitest"
import { CanaisWhatsappReconciler } from "./canais-whatsapp.reconciler"

/** Acesso ao estado privado apenas para asserção determinística (sem fake timers). */
type ReconcilerState = { nextAttemptAt: number | null; falhasConsecutivas: number }
const state = (r: CanaisWhatsappReconciler) => r as unknown as ReconcilerState

interface LogStub { lines: { level: "warn" | "log" | "debug"; message: string }[]; warn(message: string): void; log(message: string): void; debug(message: string): void }
function logStub(): LogStub {
  const stub = {
    lines: [] as { level: "warn" | "log" | "debug"; message: string }[],
    warn(message: string) { stub.lines.push({ level: "warn", message }) },
    log(message: string) { stub.lines.push({ level: "log", message }) },
    debug(message: string) { stub.lines.push({ level: "debug", message }) },
  }
  return stub
}
function withLogger(reconciler: CanaisWhatsappReconciler, stub: LogStub): void {
  ;(reconciler as unknown as { logger: LogStub }).logger = stub
}

describe("CanaisWhatsappReconciler", () => {
  beforeEach(() => {
    // Garante default ativo (enabled) para os testes que não passam options.enabled.
    delete process.env.CANAIS_WHATSAPP_RECONCILE
  })

  it("marca ativo como expirado e alerta quando a conta desconecta", async () => {
    const current = { id: 4, tenantId: 9, tenantSlug: "acme", tenantNome: "Acme", accountId: "acme", numero: "11999998888", agentId: "agent-acme", estado: "ativo" as const, ultimoStatusEm: null, createdAt: new Date(), updatedAt: new Date() }
    const repository = { list: vi.fn().mockResolvedValue([current]), update: vi.fn().mockResolvedValue(undefined) }
    const bridge = { status: vi.fn().mockResolvedValue([]) }
    const alert = { send: vi.fn().mockResolvedValue(undefined) }
    const reconciler = new CanaisWhatsappReconciler(repository as never, bridge as never, alert, { intervalMs: 999_999 })
    await reconciler.reconcile()
    expect(repository.update).toHaveBeenCalledWith(4, expect.objectContaining({ estado: "expirado" }))
    expect(alert.send).toHaveBeenCalledWith(expect.stringContaining("tenant=acme"))
  })

  it("com tabela vazia não chama bridge.status() e não emite WARN", async () => {
    const repository = { list: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue(undefined) }
    const bridge = { status: vi.fn() }
    const alert = { send: vi.fn() }
    const reconciler = new CanaisWhatsappReconciler(repository as never, bridge as never, alert, { intervalMs: 60_000 })
    const logs = logStub()
    withLogger(reconciler, logs)
    await reconciler.reconcile()
    expect(repository.list).toHaveBeenCalledTimes(1)
    expect(bridge.status).not.toHaveBeenCalled()
    expect(logs.lines.filter((l) => l.level === "warn")).toHaveLength(0)
  })

  it("em falha persistente do bridge aplica backoff 60s→120s→240s e emite WARN só na transição", async () => {
    const t = { value: 0 }
    const now = () => new Date(t.value)
    const row = { id: 1, tenantId: 1, tenantSlug: "acme", tenantNome: "Acme", accountId: "acme", numero: "11999", agentId: null, estado: "ativo" as const, ultimoStatusEm: null, createdAt: new Date(), updatedAt: new Date() }
    const repository = { list: vi.fn().mockResolvedValue([row]), update: vi.fn().mockResolvedValue(undefined) }
    const timestamps: number[] = []
    const bridge = { status: vi.fn(() => { timestamps.push(t.value); return Promise.reject(new Error("Console HTTP 404")) }) }
    const alert = { send: vi.fn() }
    const reconciler = new CanaisWhatsappReconciler(repository as never, bridge as never, alert, { intervalMs: 60_000, now })
    const logs = logStub()
    withLogger(reconciler, logs)

    t.value = 0; await reconciler.reconcile()            // tentativa 1 (transição) → nextAttempt 60s
    expect(timestamps).toEqual([0])
    t.value = 30_000; await reconciler.reconcile()        // dentro da janela → ignorado
    expect(timestamps).toEqual([0])
    t.value = 60_000; await reconciler.reconcile()        // tentativa 2 → nextAttempt 60+120=180s
    t.value = 180_000; await reconciler.reconcile()       // tentativa 3 → nextAttempt 180+240=420s
    t.value = 420_000; await reconciler.reconcile()       // tentativa 4
    expect(timestamps).toEqual([0, 60_000, 180_000, 420_000])
    expect(state(reconciler).nextAttemptAt).toBe(420_000 + Math.min(60_000 * 2 ** 3, 900_000))
    const warnLines = logs.lines.filter((l) => l.level === "warn")
    expect(warnLines).toHaveLength(1)
    expect(warnLines[0]?.message).toContain("Console HTTP 404")
    const debugCount = logs.lines.filter((l) => l.level === "debug").length
    expect(debugCount).toBeGreaterThanOrEqual(3)
  })

  it("reseta o backoff no primeiro sucesso e emite INFO de recuperação", async () => {
    const t = { value: 0 }
    const now = () => new Date(t.value)
    const row = { id: 1, tenantId: 1, tenantSlug: "acme", tenantNome: "Acme", accountId: "acme", numero: "11999", agentId: null, estado: "ativo" as const, ultimoStatusEm: null, createdAt: new Date(), updatedAt: new Date() }
    const repository = { list: vi.fn().mockResolvedValue([row]), update: vi.fn().mockResolvedValue(undefined) }
    // 1ª chamada falha; 2ª (sucesso) resolve; 3ª falha de novo
    let calls = 0
    const bridge = { status: vi.fn(() => { calls += 1; return calls === 2 ? Promise.resolve([]) : Promise.reject(new Error("Console HTTP 404")) }) }
    const alert = { send: vi.fn() }
    const reconciler = new CanaisWhatsappReconciler(repository as never, bridge as never, alert, { intervalMs: 60_000, now })
    const logs = logStub()
    withLogger(reconciler, logs)

    t.value = 0; await reconciler.reconcile()             // falha 1 → backoff base 60s
    expect(state(reconciler).falhasConsecutivas).toBe(1)
    expect(state(reconciler).nextAttemptAt).toBe(60_000)
    t.value = 60_000; await reconciler.reconcile()        // sucesso → recuperação, zera contagem
    expect(logs.lines.filter((l) => l.level === "log")).toHaveLength(1)
    expect(state(reconciler).falhasConsecutivas).toBe(0)
    expect(state(reconciler).nextAttemptAt).toBeNull()
    t.value = 120_000; await reconciler.reconcile()       // falha 2 (nova transição) → backoff volta a base 60s
    expect(logs.lines.filter((l) => l.level === "warn")).toHaveLength(2)
    // Se o backoff NÃO tivesse sido resetado, o delay seria 120s (→ 240_000); como zera, é 60s (→ 180_000)
    expect(state(reconciler).nextAttemptAt).toBe(180_000)
  })

  it("enabled:false não agenda nem executa reconcile em onModuleInit", () => {
    const repository = { list: vi.fn(), update: vi.fn() }
    const bridge = { status: vi.fn() }
    const alert = { send: vi.fn() }
    const reconciler = new CanaisWhatsappReconciler(repository as never, bridge as never, alert, { intervalMs: 60_000, enabled: false })
    reconciler.onModuleInit()
    expect(bridge.status).not.toHaveBeenCalled()
    expect(repository.list).not.toHaveBeenCalled()
    expect((reconciler as unknown as { timer: unknown }).timer).toBeNull()
    expect(() => reconciler.onModuleDestroy()).not.toThrow()
  })

  it("CANAIS_WHATSAPP_RECONCILE=0 desativa o agendamento por padrão", () => {
    process.env.CANAIS_WHATSAPP_RECONCILE = "0"
    const repository = { list: vi.fn(), update: vi.fn() }
    const bridge = { status: vi.fn() }
    const alert = { send: vi.fn() }
    const reconciler = new CanaisWhatsappReconciler(repository as never, bridge as never, alert, { intervalMs: 60_000 })
    reconciler.onModuleInit()
    expect(bridge.status).not.toHaveBeenCalled()
    expect(repository.list).not.toHaveBeenCalled()
    expect((reconciler as unknown as { timer: unknown }).timer).toBeNull()
    expect(() => reconciler.onModuleDestroy()).not.toThrow()
  })

  it("por padrão continua agendando e executando o reconcile imediato", () => {
    const repository = { list: vi.fn().mockResolvedValue([]), update: vi.fn() }
    const bridge = { status: vi.fn() }
    const alert = { send: vi.fn() }
    const reconciler = new CanaisWhatsappReconciler(repository as never, bridge as never, alert, { intervalMs: 60_000 })
    reconciler.onModuleInit()
    expect((reconciler as unknown as { timer: unknown }).timer).not.toBeNull()
    reconciler.onModuleDestroy()
    expect((reconciler as unknown as { timer: unknown }).timer).toBeNull()
  })
})
