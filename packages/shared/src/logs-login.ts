import { z } from "zod"
import type { PaginatedResult } from "./entity"

export const logLoginMetodoSchema = z.enum(["senha", "codigo_email"])

export const logLoginSchema = z
  .object({
    id: z.number(),
    usuarioId: z.number().nullable(),
    email: z.string(),
    metodo: logLoginMetodoSchema,
    codigo: z.string().nullable(),
    ip: z.string().nullable(),
    timestamp: z.string(),
  })
  .strict()

export type LogLoginMetodo = z.infer<typeof logLoginMetodoSchema>
export type LogLogin = z.infer<typeof logLoginSchema>
export type LogsLoginPage = PaginatedResult<LogLogin>
