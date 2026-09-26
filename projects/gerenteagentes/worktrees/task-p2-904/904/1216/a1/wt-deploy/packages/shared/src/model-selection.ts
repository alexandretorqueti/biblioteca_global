/**
 * Seleção de modelos de IA por projeto e tipo de agente (2026-08-21).
 *
 * Cada projeto escolhe quais modelos serão usados para cada tipo de agente
 * (DEV, ANALYST, MONITOR). As entradas são ordenadas (`ordem` 1 = primeiro
 * preferido); o motor usa a primeira entrada `enabled` para cada tipo.
 *
 * Contratos espelhados do motor (GerenteAgentes `packages/contracts/src/model-selection`),
 * mantendo o mesmo shape Zod para o front da Biblioteca Global.
 */
import { z } from "zod"

export const ModelSelectionTipoSchema = z.enum(["DEV", "ANALYST", "MONITOR"])

export type ModelSelectionTipo = z.infer<typeof ModelSelectionTipoSchema>

export const ModelSelectionEntrySchema = z
  .object({
    ordem: z.number().int().min(1),
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    enabled: z.boolean().default(true),
  })
  .strict()

export type ModelSelectionEntry = z.infer<typeof ModelSelectionEntrySchema>

export const ProjectModelSelectionSchema = z
  .object({
    projectKey: z.string().trim().min(1),
    tipo: ModelSelectionTipoSchema,
    entries: z.array(ModelSelectionEntrySchema).min(1),
  })
  .strict()

export type ProjectModelSelection = z.infer<typeof ProjectModelSelectionSchema>
