import { z } from "zod"

export const transbordoDestinoTipoSchema = z.enum(["email", "telegram", "whatsapp"])
const horarioHora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

export const transbordoHorarioSchema = z.object({
  diasSemana: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  inicio: horarioHora,
  fim: horarioHora,
  timezone: z.string().trim().min(1).max(64),
}).strict().superRefine((horario, ctx) => {
  if (new Set(horario.diasSemana).size !== horario.diasSemana.length) {
    ctx.addIssue({ code: "custom", path: ["diasSemana"], message: "diasSemana não pode conter duplicatas" })
  }
  if (horario.inicio >= horario.fim) {
    ctx.addIssue({ code: "custom", path: ["fim"], message: "fim deve ser posterior a início" })
  }
})

export const transbordoDestinoSchema = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("email"), valor: z.string().trim().email(), nomeAtendente: z.string().trim().min(1).max(150) }).strict(),
  z.object({ tipo: z.literal("telegram"), valor: z.string().trim().regex(/^(?:-?\d{5,20}|@[A-Za-z0-9_]{5,32})$/), nomeAtendente: z.string().trim().min(1).max(150) }).strict(),
  z.object({ tipo: z.literal("whatsapp"), valor: z.string().trim().regex(/^\+?[1-9]\d{7,14}$/), nomeAtendente: z.string().trim().min(1).max(150) }).strict(),
])

export const transbordoConfigSchema = z.object({
  ativo: z.boolean(),
  destino: transbordoDestinoSchema,
  horario: transbordoHorarioSchema,
}).strict()

export type TransbordoDestinoTipo = z.infer<typeof transbordoDestinoTipoSchema>
export type TransbordoHorario = z.infer<typeof transbordoHorarioSchema>
export type TransbordoDestino = z.infer<typeof transbordoDestinoSchema>
export type TransbordoConfig = z.infer<typeof transbordoConfigSchema>
