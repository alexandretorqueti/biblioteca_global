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

// ─────────────────────────────────────────────────────────────────────────────
// Política central de classificação (subtarefa 2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Código canônico do `ApiError.code` para erro de validação da entrada do
 * usuário. É o ÚNICO marcador que torna um 400/422 não reportável: o mesmo
 * status é usado pelo CRUD genérico tanto para validação (Zod, com `details`
 * estruturado) quanto para defeitos reais (FK inexistente, coluna
 * desconhecida), então o status sozinho não basta para classificar.
 */
export const CODIGO_ERRO_VALIDACAO = "VALIDATION_ERROR"

/** Códigos que identificam validação da entrada do usuário (não reportável). */
export const CODIGOS_DE_VALIDACAO: ReadonlySet<string> = new Set([CODIGO_ERRO_VALIDACAO])

/**
 * Resources servidos por controllers dedicados, SEM slug na URL
 * (`/api/usuarios`, `/api/projetos`). Fonte única da regra: o api-client usa
 * para montar a URL e esta função para montar a chave canônica do endpoint.
 */
export const RECURSOS_SEM_SLUG: ReadonlySet<string> = new Set(["usuarios", "projetos"])

/**
 * Status HTTP que não indicam defeito real no código — não viram tarefa.
 * 400/422 ficam de fora de propósito: só são não reportáveis quando o payload
 * traz o código de validação (ver `erroReportavel`).
 */
const STATUS_NAO_REPORTAVEIS: ReadonlyMap<number, string> = new Map([
  [401, "Não autorizado (sessão/credencial)"],
  [403, "Acesso negado"],
  [404, "Recurso não encontrado"],
  [409, "Conflito (ex.: registro duplicado)"],
  [429, "Limite de requisições excedido"],
])

/** Entrada da decisão "este erro vira tarefa?" (front e back usam a mesma). */
export interface ErroReportavelInput {
  /**
   * Status HTTP recebido; `null`/ausente quando a falha ocorreu antes de
   * qualquer resposta (rede/timeout/CORS).
   */
  status?: number | null
  /** `ApiError.code` do payload, quando houver. Distingue o 400 ambíguo. */
  code?: string | null
  /** Contexto da chamada — enriquece o motivo, não muda a decisão. */
  origem?: ErrorReportOrigem
}

export interface ErroReportavelResultado {
  reportavel: boolean
  motivo: string
}

function contextoDeOrigem(origem: ErrorReportOrigem | undefined): string {
  if (!origem) return ""
  const partes = [origem.tela, origem.funcionalidade].filter(
    (parte): parte is string => typeof parte === "string" && parte.length > 0,
  )
  return partes.length === 0 ? ` — rota ${origem.rota}` : ` — rota ${origem.rota} (${partes.join("/")})`
}

/**
 * Decide se uma ocorrência vira tarefa — fonte única para front e back.
 *
 * | Situação | Decisão |
 * | --- | --- |
 * | 404, 401, 403, 409, 429 | não reportável |
 * | 400/422 com `code` de validação | não reportável |
 * | 400/422 sem marcador de validação | reportável (pode ser defeito real) |
 * | 5xx | reportável |
 * | outro 4xx não mapeado | reportável (pode ser defeito real) |
 * | sem status (rede/timeout/CORS) | reportável |
 */
export function erroReportavel(input: ErroReportavelInput): ErroReportavelResultado {
  const status = input.status ?? null
  const code = (input.code ?? "").trim()
  const onde = contextoDeOrigem(input.origem)

  if (status === null) {
    return {
      reportavel: true,
      motivo: `Falha sem resposta HTTP (rede/timeout/CORS)${onde}`,
    }
  }

  if (status >= 500 && status <= 599) {
    return { reportavel: true, motivo: `Erro do servidor (HTTP ${status})${onde}` }
  }

  if (status === 400 || status === 422) {
    if (CODIGOS_DE_VALIDACAO.has(code)) {
      return {
        reportavel: false,
        motivo: `Validação da entrada do usuário (HTTP ${status})${onde}`,
      }
    }
    return {
      reportavel: true,
      motivo:
        `HTTP ${status} sem marcador de validação (code "${code || "ausente"}")` +
        ` — pode indicar defeito real no código${onde}`,
    }
  }

  const motivoMapeado = STATUS_NAO_REPORTAVEIS.get(status)
  if (motivoMapeado !== undefined) {
    return { reportavel: false, motivo: `${motivoMapeado} (HTTP ${status})${onde}` }
  }

  if (status >= 400 && status <= 499) {
    return {
      reportavel: true,
      motivo: `HTTP ${status} não mapeado — pode indicar defeito real no código${onde}`,
    }
  }

  return {
    reportavel: false,
    motivo: `HTTP ${status} não corresponde a erro de aplicação${onde}`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Chave canônica do endpoint (subtarefa 2)
// ─────────────────────────────────────────────────────────────────────────────

const SEGMENTO_NUMERICO = /^\d+$/
const SEGMENTO_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Segmento que representa um identificador (numérico ou UUID). */
function ehSegmentoId(segmento: string): boolean {
  return SEGMENTO_NUMERICO.test(segmento) || SEGMENTO_UUID.test(segmento)
}

export interface MontarEndpointCanonicoInput {
  /** Método HTTP (ex.: "get", "POST"). */
  method: string
  /**
   * Caminho da chamada — URL completa (`/api/taqui/clientes/12?busca=x`) ou
   * rota executada. Query string e hash são descartados.
   */
  path: string
  /**
   * Slug do projeto da sessão. No front vem do projeto ativo; no back, do
   * escopo do token. Ausente quando o erro ocorre antes do escopo.
   */
  slug?: string
}

/**
 * Chave canônica do endpoint usada no título da tarefa e na deduplicação:
 * `MÉTODO /api/<slug>/<recurso>`.
 *
 * - remove query string e hash;
 * - garante UM único prefixo `/api`;
 * - não repete o slug quando ele já está no caminho e o omite nos resources
 *   sem slug na URL (`usuarios`, `projetos`);
 * - normaliza segmentos que pareçam identificador para `:id`
 *   (`GET /api/taqui/clientes/12` → `GET /api/taqui/clientes/:id`).
 *
 * Front e back chamam esta mesma função — é o que garante chave idêntica
 * (senão a deduplicação por endpoint nunca casa).
 */
export function montarEndpointCanonico(input: MontarEndpointCanonicoInput): string {
  const metodo = input.method.trim().toUpperCase() || "HTTP"
  const slug = (input.slug ?? "").trim().replace(/^\/+|\/+$/g, "")
  const semQuery = (input.path.split("#")[0] ?? "").split("?")[0] ?? ""
  const segmentos = semQuery.split("/").filter((segmento) => segmento.length > 0)
  const semPrefixoApi = segmentos[0] === "api" ? segmentos.slice(1) : segmentos
  const primeiro = semPrefixoApi[0] ?? ""
  const comSlug =
    slug !== "" && primeiro !== slug && !RECURSOS_SEM_SLUG.has(primeiro)
      ? [slug, ...semPrefixoApi]
      : semPrefixoApi
  const normalizados = comSlug.map((segmento) =>
    ehSegmentoId(segmento) ? ":id" : segmento,
  )
  if (normalizados.length === 0) return `${metodo} /api`
  return `${metodo} /api/${normalizados.join("/")}`
}
