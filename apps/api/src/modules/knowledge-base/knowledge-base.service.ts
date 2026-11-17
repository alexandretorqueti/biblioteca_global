import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common"
import { and, eq } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { extractTextFromFile } from "@biblioteca-global/file-extract"
import { knowledgeChunks, knowledgeDocuments } from "../../../../../database/schema"
import { CORE_DB, type CoreDb } from "../../database/database.module"
import { EnvService } from "../../config/env.service"

const ALLOWED = new Map([
  [".pdf", "application/pdf"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".txt", "text/plain"],
  [".md", "text/markdown"],
])
const CHUNK_SIZE = 1800
const CHUNK_OVERLAP = 200

type Upload = { originalname: string; mimetype: string; size: number; buffer: Buffer }

@Injectable()
export class KnowledgeBaseService {
  constructor(
    @Inject(CORE_DB) private readonly db: CoreDb,
    private readonly env: EnvService,
  ) {}

  async indexar(projetoId: number, file: Upload) {
    const ext = this.extensao(file.originalname)
    const expectedMime = ALLOWED.get(ext)
    if (!expectedMime || !this.mimeAceito(ext, file.mimetype)) {
      throw new BadRequestException("Formato não suportado; aceitos: PDF, DOCX, TXT e MD")
    }
    if (!file.size || !file.buffer.length) throw new BadRequestException("O arquivo está vazio")
    if (file.size > this.env.knowledgeMaxBytes) throw new BadRequestException("Arquivo excede o limite configurado")
    if (!this.assinaturaAceita(ext, file.buffer)) throw new BadRequestException("Assinatura do arquivo inválida")

    const extracted = await extractTextFromFile({ name: file.originalname, mime: file.mimetype, data: file.buffer })
    if (!extracted.ok || !extracted.text.trim()) throw new BadRequestException(extracted.message ?? "Texto não extraível")
    const chunks = this.chunk(extracted.text)
    if (!chunks.length) throw new BadRequestException("Texto não extraível")

    const caminho = join(this.env.knowledgeStoragePath, String(projetoId), `${randomUUID()}${ext}`)
    await mkdir(join(this.env.knowledgeStoragePath, String(projetoId)), { recursive: true })
    await writeFile(caminho, file.buffer, { flag: "wx" })
    let documentoId = 0
    try {
      const inserted = await this.db.insert(knowledgeDocuments).values({
        projetoId, nome: this.nomeSeguro(file.originalname), mimeType: expectedMime,
        tamanhoBytes: file.size, caminhoStorage: caminho, status: "pending",
      })
      documentoId = Number(inserted[0].insertId)
      await this.db.update(knowledgeDocuments).set({ status: "indexing", erro: null }).where(and(eq(knowledgeDocuments.id, documentoId), eq(knowledgeDocuments.projetoId, projetoId)))
      const embeddings: number[][] = []
      for (const texto of chunks) embeddings.push(await this.embedding(texto))
      await this.db.insert(knowledgeChunks).values(chunks.map((texto, ordem) => ({ projetoId, documentoId, ordem, texto, embedding: embeddings[ordem]! })))
      await this.db.update(knowledgeDocuments).set({ status: "ready", erro: null }).where(and(eq(knowledgeDocuments.id, documentoId), eq(knowledgeDocuments.projetoId, projetoId)))
      return this.status(projetoId, documentoId)
    } catch (error) {
      if (documentoId) await this.db.update(knowledgeDocuments).set({ status: "failed", erro: this.erroSeguro(error) }).where(and(eq(knowledgeDocuments.id, documentoId), eq(knowledgeDocuments.projetoId, projetoId)))
      await rm(caminho, { force: true })
      if (documentoId) return this.status(projetoId, documentoId)
      throw new BadRequestException("Não foi possível indexar o documento")
    }
  }

  async status(projetoId: number, id: number) {
    const rows = await this.db.select().from(knowledgeDocuments).where(and(eq(knowledgeDocuments.id, id), eq(knowledgeDocuments.projetoId, projetoId))).limit(1)
    const row = rows.at(0)
    if (!row) throw new NotFoundException("Documento não encontrado")
    const chunkRows = await this.db.select({ id: knowledgeChunks.id }).from(knowledgeChunks).where(and(eq(knowledgeChunks.documentoId, id), eq(knowledgeChunks.projetoId, projetoId)))
    return { id: row.id, projetoId: row.projetoId, nome: row.nome, mimeType: row.mimeType, tamanhoBytes: row.tamanhoBytes, status: row.status, erro: row.erro ?? null, chunks: chunkRows.length, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }
  }

  async remover(projetoId: number, id: number): Promise<void> {
    const rows = await this.db.select({ caminho: knowledgeDocuments.caminhoStorage }).from(knowledgeDocuments).where(and(eq(knowledgeDocuments.id, id), eq(knowledgeDocuments.projetoId, projetoId))).limit(1)
    const row = rows.at(0)
    if (!row) throw new NotFoundException("Documento não encontrado")
    await this.db.delete(knowledgeDocuments).where(and(eq(knowledgeDocuments.id, id), eq(knowledgeDocuments.projetoId, projetoId)))
    await rm(row.caminho, { force: true })
  }

  async buscar(projetoId: number, consulta: string, topK = 5, scoreMinimo = 0.35) {
    const query = await this.embedding(consulta)
    const rows = await this.db.select({ id: knowledgeChunks.id, documentoId: knowledgeChunks.documentoId, texto: knowledgeChunks.texto, embedding: knowledgeChunks.embedding, nome: knowledgeDocuments.nome }).from(knowledgeChunks).innerJoin(knowledgeDocuments, eq(knowledgeChunks.documentoId, knowledgeDocuments.id)).where(and(eq(knowledgeChunks.projetoId, projetoId), eq(knowledgeDocuments.projetoId, projetoId), eq(knowledgeDocuments.status, "ready")))
    return rows.map((row) => ({ documentId: row.documentoId, fonte: row.nome, texto: row.texto, score: this.cosine(query, row.embedding) })).filter((row) => row.score >= scoreMinimo).sort((a, b) => b.score - a.score).slice(0, Math.max(0, Math.min(20, topK)))
  }

  private async embedding(input: string): Promise<number[]> {
    const response = await fetch(`${this.env.ollamaUrl}/api/embeddings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: this.env.ollamaEmbeddingModel, prompt: input }) })
    if (!response.ok) throw new Error("embedding indisponível")
    const body: unknown = await response.json()
    if (!body || typeof body !== "object" || !("embedding" in body) || !Array.isArray(body.embedding) || !body.embedding.every((v) => typeof v === "number")) throw new Error("resposta de embedding inválida")
    return body.embedding
  }

  private chunk(text: string): string[] { const normalized = text.replace(/\r\n/g, "\n").trim(); const result: string[] = []; for (let start = 0; start < normalized.length; start += CHUNK_SIZE - CHUNK_OVERLAP) result.push(normalized.slice(start, start + CHUNK_SIZE).trim()); return result.filter(Boolean) }
  private cosine(a: number[], b: number[]): number { if (!a.length || a.length !== b.length) return -1; let dot = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { const av = a[i] ?? 0; const bv = b[i] ?? 0; dot += av * bv; na += av ** 2; nb += bv ** 2 } return na && nb ? dot / Math.sqrt(na * nb) : -1 }
  private extensao(name: string): string { const index = name.lastIndexOf("."); return index >= 0 ? name.slice(index).toLowerCase() : "" }
  private nomeSeguro(name: string): string { return Array.from(name).map((char) => char.charCodeAt(0) < 32 || char === "/" || char === "\\" ? "_" : char).join("").slice(0, 255) || "documento" }
  private mimeAceito(ext: string, mime: string): boolean { return mime === ALLOWED.get(ext) || (ext === ".md" && mime === "text/plain") }
  private assinaturaAceita(ext: string, data: Buffer): boolean { if (ext === ".pdf") return data.subarray(0, 4).toString() === "%PDF"; if (ext === ".docx") return data.subarray(0, 4).toString("hex") === "504b0304"; return !data.includes(0) }
  private erroSeguro(error: unknown): string { return error instanceof Error ? error.message.slice(0, 1000) : "Falha desconhecida ao indexar documento" }
}
