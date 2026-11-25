/**
 * DTOs (Zod) do sino de notificações in-app (gestao-de-tarefas-global —
 * macro #5, subtarefa 2).
 *
 * Regras:
 * - o DESTINATÁRIO nunca vem do payload: usuarioId é sempre claims.sub da
 *   sessão (resolvido no service via CurrentUser);
 * - `apenasNaoLidas` é query string ("true"/"false") — parse explícito para
 *   não cair na pegadinha de `Boolean("false") === true`;
 * - `limite` tem teto de 100 (o service ainda re-clampa).
 */
import { z } from "zod"

export const listarNotificacoesQuerySchema = z
  .object({
    /** "true" filtra só não lidas; ausente/"false" traz todas. */
    apenasNaoLidas: z.enum(["true", "false"]).optional(),
    limite: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict()
export type ListarNotificacoesQuery = z.infer<typeof listarNotificacoesQuerySchema>
