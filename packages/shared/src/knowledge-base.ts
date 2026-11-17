import { z } from "zod"

export const knowledgeDocumentStatusSchema = z.enum([
  "pending",
  "indexing",
  "ready",
  "failed",
])
export type KnowledgeDocumentStatus = z.infer<typeof knowledgeDocumentStatusSchema>

export const knowledgeDocumentSchema = z.object({
  id: z.number().int().positive(),
  projetoId: z.number().int().positive(),
  nome: z.string().min(1),
  mimeType: z.string().min(1),
  tamanhoBytes: z.number().int().positive(),
  status: knowledgeDocumentStatusSchema,
  erro: z.string().nullable(),
  chunks: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict()
export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>

export const knowledgeSearchResultSchema = z.object({
  documentId: z.number().int().positive(),
  fonte: z.string().min(1),
  texto: z.string().min(1),
  score: z.number().min(-1).max(1),
}).strict()
export type KnowledgeSearchResult = z.infer<typeof knowledgeSearchResultSchema>
