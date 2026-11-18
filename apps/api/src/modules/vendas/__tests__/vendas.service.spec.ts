// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BadRequestException, NotFoundException } from "@nestjs/common"
import { validate } from "class-validator"
import { afterEach, describe, expect, it } from "vitest"
import { VendasService } from "../vendas.service"
import type { Negocio, NegocioDocumento, VendasRepository } from "../vendas.repository"
import { AnotarNegocioDto, ContatoNegocioDto, TransbordoNegocioDto } from "../dto/anotar-negocio.dto"

const negocio = (id: number, chatId: string): Negocio => ({
  id, chatId, nome: "Mercado Central", segmentoDescricao: "Varejo",
  contato: { nome: "Ana", email: "ana@example.com", telefone: "5511999999999" },
  transbordo: { ativo: false }, status: "capturado",
  createdAt: new Date(), updatedAt: new Date(),
})

describe("VendasService", () => {
  const dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it("captura e atualiza o mesmo negócio por chatId sem duplicar", async () => {
    const rows = new Map<string, Negocio>()
    const repository: VendasRepository = {
      upsertNegocio: async (input) => {
        const current = rows.get(input.chatId) ?? negocio(rows.size + 1, input.chatId)
        const updated = { ...current, ...input }
        rows.set(input.chatId, updated)
        return updated
      },
      buscarNegocioPorChatId: async (chatId) => rows.get(chatId),
      criarDocumento: async () => { throw new Error("não usado") },
    }
    const service = new VendasService(repository, { vendasDocumentosMaxBytes: 1000, vendasDocumentosDir: "/tmp" } as never)
    const input = {
      chatId: "chat-1", nome: "Mercado Central", segmentoDescricao: "Varejo",
      contato: { nome: "Ana", email: "ANA@EXAMPLE.COM", telefone: "11 99999-9999" },
      transbordo: { ativo: false },
    }
    await service.anotarNegocio(input)
    await service.anotarNegocio({ ...input, nome: "Mercado Central atualizado" })
    expect(rows.size).toBe(1)
    expect(rows.get("chat-1")?.nome).toBe("Mercado Central atualizado")
  })

  it("rejeita transbordo ativo sem destino", async () => {
    const repository = { upsertNegocio: async () => { throw new Error("não deveria persistir") } } as unknown as VendasRepository
    const service = new VendasService(repository, {} as never)
    await expect(service.anotarNegocio({
      chatId: "chat-1", nome: "Loja", segmentoDescricao: "Varejo",
      contato: { nome: "Ana", email: "ana@example.com", telefone: "11" },
      transbordo: { ativo: true },
    })).rejects.toBeInstanceOf(BadRequestException)
  })

  it("valida e-mail e campos obrigatórios no DTO da rota", async () => {
    const dto = Object.assign(new AnotarNegocioDto(), { chatId: "chat-1", nome: "Loja", segmentoDescricao: "Varejo" })
    const errors = await validate(dto)
    expect(errors.map((error) => error.property)).toEqual(expect.arrayContaining(["contato", "transbordo"]))
    const contato = Object.assign(new ContatoNegocioDto(), { nome: "Ana", email: "invalido", telefone: "11" })
    const transbordo = Object.assign(new TransbordoNegocioDto(), { ativo: false })
    Object.assign(dto, { contato, transbordo })
    const invalidEmail = await validate(dto)
    const contatoError = invalidEmail.find((error) => error.property === "contato")
    expect(contatoError?.children?.find((error) => error.property === "email")?.constraints).toHaveProperty("isEmail")
  })

  it("valida mime, grava arquivo e registra uso diferido", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vendas-"))
    dirs.push(dir)
    let saved: NegocioDocumento | undefined
    const repository: VendasRepository = {
      upsertNegocio: async () => negocio(7, "chat-7"),
      buscarNegocioPorChatId: async () => negocio(7, "chat-7"),
      criarDocumento: async (input) => {
        saved = { ...input, id: 3, negocioId: 7, usoDiferido: true, createdAt: new Date() }
        return saved
      },
    }
    const service = new VendasService(repository, { vendasDocumentosDir: dir, vendasDocumentosMaxBytes: 100 } as never)
    const document = await service.anexarDocumento({
      chatId: "chat-7", nome: "regras.txt", mime: "text/plain",
      conteudoBase64: Buffer.from("regra 1").toString("base64"),
    })
    expect(document.usoDiferido).toBe(true)
    expect(saved?.tamanho).toBe(7)
    expect(await readFile(saved!.caminho, "utf8")).toBe("regra 1")
    await expect(service.anexarDocumento({
      chatId: "chat-7", nome: "regras.exe", mime: "application/x-msdownload", conteudoBase64: "YQ==",
    })).rejects.toBeInstanceOf(BadRequestException)
    const missing = { ...repository, buscarNegocioPorChatId: async () => undefined }
    await expect(new VendasService(missing, { vendasDocumentosDir: dir, vendasDocumentosMaxBytes: 100 } as never).anexarDocumento({
      chatId: "x", nome: "r.txt", mime: "text/plain", conteudoBase64: "YQ==",
    })).rejects.toBeInstanceOf(NotFoundException)
  })
})
