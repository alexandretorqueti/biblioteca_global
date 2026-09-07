// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { HelpDeskService } from "../helpdesk.service"
import type { ProjectDbFactory } from "../../crud/project-db.factory"

describe("HelpDeskService — criação de tarefa draft", () => {
  it("usa o database do Gerente de Agentes para um projeto da plataforma", async () => {
    const execute = vi.fn().mockResolvedValue([])
    const catalogDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ id: 7, agenteId: "taqui" }],
          }),
        }),
      }),
      execute,
    }
    const factory = {
      obter: vi.fn(async ({ id }: { id: number }) => {
        if (id !== 640) throw new Error(`database inesperado: projeto_${id}`)
        return catalogDb
      }),
    } as unknown as ProjectDbFactory
    const coreDb = {} as never
    const bridge = {} as never
    const service = new HelpDeskService(factory, coreDb, bridge)

    await (service as unknown as {
      criarTarefaDraft(projetoId: number, textoOriginal: string, solicitacao: string): Promise<void>
    }).criarTarefaDraft(
      6611,
      "Ao incluir um morador, a unidade não aparece na combo",
      "Ao incluir um morador, a unidade não aparece na combo",
    )

    expect(factory.obter).toHaveBeenCalledWith({ id: 640 })
    expect(factory.obter).not.toHaveBeenCalledWith({ id: 6611 })
    expect(execute).toHaveBeenCalledOnce()
  })
})
