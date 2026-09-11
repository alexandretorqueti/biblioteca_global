/**
 * Contrato único do "relato de erro" (front↔back).
 *
 * O front — via api-client, a única camada HTTP do front (PoC §3/§7.4) — observa
 * a falha e monta este payload com todo o contexto disponível no momento do
 * erro (usuário, tela, origem e transporte). O back é a única autoridade de
 * criação da tarefa: o escopo do projeto vem do access token, nunca do corpo
 * (PoC §5.3), por isso o payload NÃO carrega projeto/projetoId.
 *
 * Este é o artefato-base consumido pelas subtarefas seguintes: a política de
 * classificação e a chave canônica de endpoint (`erroReportavel` /
 * `montarEndpointCanonico`, subtarefa 2), o repositório de tarefas em
 * `projeto_640` (subtarefa 3), o módulo `POST /api/erros` (subtarefa 4) e a
 * captura no transporte do front (subtarefa 5).
 *
 * Regra de ouro: nenhum `any` e nenhuma credencial no payload (MANUAL §7).
 */
import { z } from "zod"

/**
 * Usuário logado no momento do erro. Apenas identificação não sensível —
 * senha, tokens e `Authorization` nunca entram no relato.
 */
export const errorReportUsuarioSchema = z
  .object({
    id: z.number().int().positive(),
    nome: z.string().trim().min(1).optional(),
    login: z.string().trim().min(1).optional(),
  })
  .strict()

export type ErrorReportUsuario = z.infer<typeof errorReportUsuarioSchema>

/**
 * Origem da chamada: em qual funcionalidade/rota/tela o endpoint foi chamado.
 * `rota` é o caminho da aplicação (ex.: "/clientes"); `tela` e `funcionalidade`
 * ajudam a localizar o ponto do código que disparou a chamada.
 */
export const errorReportOrigemSchema = z
  .object({
    rota: z.string().trim().min(1),
    tela: z.string().trim().min(1).optional(),
    funcionalidade: z.string().trim().min(1).optional(),
  })
  .strict()

export type ErrorReportOrigem = z.infer<typeof errorReportOrigemSchema>

/**
 * Erro capturado no front. Cobre tanto falha com resposta HTTP quanto falha
 * antes de haver resposta (rede/timeout/CORS), em que `code` normalmente fica
 * ausente e `name` traz o construtor do erro (ex.: "TypeError").
 */
export const errorReportErroSchema = z
  .object({
    name: z.string().trim().min(1),
    message: z.string(),
    code: z.string().trim().min(1).optional(),
    details: z.unknown().optional(),
  })
  .strict()

export type ErrorReportErro = z.infer<typeof errorReportErroSchema>

/**
 * Relato de erro enviado pelo front ao back (POST /api/erros).
 *
 * - `endpoint`: chave canônica do endpoint (`montarEndpointCanonico`, subtarefa 2);
 *   é o que alimenta o título da tarefa e a deduplicação.
 * - `url`: pathname da chamada, sem query string.
 * - `query`: parâmetros de query string, quando houver.
 * - `requestBody`: objeto efetivamente enviado (dados do formulário).
 * - `responseStatus`: status HTTP recebido; `null` quando a falha ocorreu antes
 *   de qualquer resposta (rede/timeout/CORS).
 * - `responseBody`: objeto/erro recebido do servidor, quando houver.
 * - `error`: erro capturado no front, quando houver.
 * - `ocorridoEm`: instante ISO-8601 do ocorrido.
 */
export const errorReportRequestSchema = z
  .object({
    endpoint: z.string().trim().min(1),
    url: z.string().trim().min(1),
    query: z.record(z.string(), z.unknown()).optional(),
    requestBody: z.unknown().optional(),
    responseStatus: z.number().int().min(100).max(599).nullable(),
    responseBody: z.unknown().optional(),
    error: errorReportErroSchema.optional(),
    usuario: errorReportUsuarioSchema,
    origem: errorReportOrigemSchema,
    ocorridoEm: z.string().datetime({ offset: true }),
  })
  .strict()

export type ErrorReportRequest = z.infer<typeof errorReportRequestSchema>

/**
 * Resultado do relato: o back informa se a ocorrência virou tarefa.
 * Quando `registrada` é `false`, `motivo` explica (ex.: erro não reportável
 * pela política, tarefa do mesmo endpoint ainda ativa).
 */
export const errorReportResultSchema = z
  .object({
    registrada: z.boolean(),
    tarefaId: z.number().int().positive().optional(),
    motivo: z.string().trim().min(1).optional(),
  })
  .strict()

export type ErrorReportResult = z.infer<typeof errorReportResultSchema>
