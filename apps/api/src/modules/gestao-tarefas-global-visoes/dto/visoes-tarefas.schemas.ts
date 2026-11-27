/**
 * DTOs (Zod) das visões por área e por categoria (tags)
 * (gestao-de-tarefas-global — macro #8, subtarefa 1).
 *
 * Regras:
 * - Somente leitura: sem body — os schemas validam QUERY STRING de
 *   `GET /:slug/visoes/tarefas` (params chegam como string/string[]);
 * - `areaId` OU `tagId` — nunca os dois (visões são agrupamentos
 *   alternativos; sobrepor daria resultado ambíguo);
 * - `status` aceita forma multi (`?status=aberta,delegada` ou query
 *   repetida `?status=aberta&status=delegada`);
 * - Buckets de prazo são partição semântica relativa ao relógio do
 *   servidor (documentada no service): 'vencida' | 'hoje' | 'semana' |
 *   'sem_prazo'.
 */
import { z } from "zod"

/** Espelha o enum de status de `tarefas` (schema do projeto) sem import de apps. */
export const statusTarefaValues = [
  "aberta",
  "delegada",
  "concluida",
  "precisa_informacoes",
  "aguardando_terceiro",
  "cancelada",
] as const
export type StatusTarefaVisao = (typeof statusTarefaValues)[number]

export const bucketPrazoValues = ["vencida", "hoje", "semana", "sem_prazo"] as const
export type BucketPrazo = (typeof bucketPrazoValues)[number]

/** Id numérico vindo de query string (""/ausente → undefined; não-numérico → erro). */
const idQuery = z.preprocess(
  (v) => (v === "" || v == null ? undefined : Number(v)),
  z.number().int().positive().optional(),
)

/**
 * `status` multi: CSV (`aberta,delegada`) e/ou query repetida
 * (['aberta','delegada']); vazio/ausente → sem filtro.
 */
const statusMultiQuery = z.preprocess((v) => {
  if (v == null) return undefined
  const partes = (Array.isArray(v) ? v : [v])
    .flatMap((item) => String(item).split(","))
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return partes.length > 0 ? partes : undefined
}, z.array(z.enum(statusTarefaValues)).min(1).optional())

const bucketQuery = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z.enum(bucketPrazoValues).optional(),
)

export const visoesTarefasQuerySchema = z
  .object({
    /** Agrupamento por área fixa (FK `tarefas.area_id`). */
    areaId: idQuery,
    /** Agrupamento por tag (M:N via `tarefa_tags`). */
    tagId: idQuery,
    /** Filtro combinável de status (multi). */
    status: statusMultiQuery,
    /** Filtro combinável de bucket de prazo. */
    prazo: bucketQuery,
    /** Filtro combinável de responsável ativo da tarefa. */
    responsavelId: idQuery,
  })
  .superRefine((q, ctx) => {
    if (q.areaId != null && q.tagId != null) {
      ctx.addIssue({
        code: "custom",
        path: ["areaId"],
        message: "Informe areaId OU tagId — nunca os dois.",
      })
    }
  })
export type VisoesTarefasQuery = z.infer<typeof visoesTarefasQuerySchema>
