/**
 * SetupSmokeTest — Smoke test funcional obrigatório no fim do setup de projeto novo
 *
 * PRINCÍPIO (Alexandre 2026-09-03): o controle é aplicado em CÓDIGO pelo motor,
 * não só orientado em prompt. O gate final exige evidência funcional real de que
 * o projeto novo responde (chamada HTTP a um endpoint CRUD) antes de declarar
 * o setup concluído.
 *
 * Fluxo:
 * 1. A missão de setup (montarMissaoSetup) inclui uma subtarefa obrigatória de
 *    smoke test como ÚLTIMA subtarefa do plano.
 * 2. O analista (buildAnalystPrompt) é instruído a SEMPRE incluir essa subtarefa.
 * 3. O gate (phaseVerify) valida que a subtarefa de smoke test tem evidência
 *    funcional (resultado HTTP real) antes de marcar como verified.
 *
 * Evidência esperada: o agente grava no resultado da subtarefa um JSON com:
 * {
 *   "smoke_test": {
 *     "url": "http://...",
 *     "method": "GET"|"POST",
 *     "status": 200,
 *     "response_body": "...",
 *     "timestamp": "2026-09-03T..."
 *   }
 * }
 */

import { request as httpRequest, type RequestOptions } from "node:http"
import { request as httpsRequest } from "node:https"

// ─── Tipos ─────────────────────────────────────────────────────────────────

/** Evidência de smoke test gravada pelo agente no resultado da subtarefa. */
export interface SmokeTestEvidence {
  /** URL do endpoint CRUD testado. */
  url: string
  /** Método HTTP usado. */
  method: "GET" | "POST" | "PUT" | "DELETE"
  /** Status HTTP da resposta. */
  status: number
  /** Trecho do corpo da resposta (max 2000 chars). */
  response_body: string
  /** Timestamp ISO da requisição. */
  timestamp: string
}

/** Resultado da validação de evidência de smoke test. */
export type SmokeTestValidation =
  | { ok: true; evidence: SmokeTestEvidence }
  | { ok: false; reason: string }

/** Configuração do smoke test para um projeto. */
export interface SmokeTestConfig {
  /** URL base do projeto (ex.: http://localhost:3000). */
  baseUrl: string
  /** Endpoint CRUD para testar (ex.: /api/taqui/items). */
  endpoint: string
  /** Método HTTP (default: GET). */
  method?: "GET" | "POST"
  /** Token de autenticação (se necessário). */
  authToken?: string
  /** Timeout em ms (default: 10000). */
  timeoutMs?: number
}

/** Resultado de uma execução de smoke test. */
export type SmokeTestResult =
  | { ok: true; evidence: SmokeTestEvidence }
  | { ok: false; error: string; status?: number }

// ─── Detecção de tarefa de setup ───────────────────────────────────────────

const SETUP_TASK_PATTERNS = [
  /setup\s+(do\s+)?projeto/i,
  /setup\s+de\s+/i,
  /^setup-/i,
  /configur[aA][cç][aã]o\s+inicial/i,
  /cria[cç][aã]o\s+do\s+projeto/i,
]

/**
 * Detecta se uma tarefa é de setup de projeto novo pelo título ou descrição.
 * Usado pelo motor para aplicar controles específicos (smoke test obrigatório,
 * checklist de registros, etc.).
 */
export function isSetupTask(title: string, description?: string): boolean {
  const text = (title + " " + (description || "")).trim()
  return SETUP_TASK_PATTERNS.some((pattern) => pattern.test(text))
}

// ─── Título e escopo da subtarefa de smoke test ────────────────────────────

/** Título padrão da subtarefa de smoke test no plano de setup. */
export const SMOKE_TEST_SUBTASK_TITLE = "Smoke test funcional do projeto novo"

/** Escopo padrão da subtarefa de smoke test. */
export const SMOKE_TEST_SUBTASK_SCOPE = [
  "Executar uma chamada HTTP real a um endpoint CRUD do projeto novo para",
  "confirmar que o projeto responde. A chamada deve ser feita com curl ou",
  "equivalente, testando um GET em /api/<slug>/ (endpoint CRUD da biblioteca).",
  "",
  "O resultado da subtarefa DEVE conter um JSON com a evidência:",
  '{"smoke_test":{"url":"...","method":"GET","status":200,"response_body":"...","timestamp":"..."}}',
  "",
  "Se o endpoint retornar 404/500/timeout, o smoke test FALHA e o setup NÃO",
  "pode ser concluído até que o problema seja corrigido.",
].join("\n")

/** Critérios de aceite da subtarefa de smoke test. */
export const SMOKE_TEST_ACCEPTANCE_CRITERIA = [
  "Chamada HTTP real executada com sucesso (status 2xx)",
  "Evidência JSON gravada no resultado da subtarefa",
  "Endpoint testado pertence ao projeto novo (não à biblioteca)",
]

// ─── Extração de evidência do resultado ─────────────────────────────────────

/**
 * Extrai a evidência de smoke test do resultado da subtarefa.
 * Tenta parsear o JSON do resultado e extrair o campo `smoke_test`.
 */
export function extractSmokeTestEvidence(resultContent: string | null | undefined): SmokeTestValidation {
  if (!resultContent || resultContent.trim().length === 0) {
    return { ok: false, reason: "Resultado da subtarefa vazio — sem evidência de smoke test" }
  }

  // Tenta extrair JSON do conteúdo (pode ter texto antes/depois)
  const jsonMatch = resultContent.match(/\{[\s\S]*"smoke_test"[\s\S]*\}/)
  if (!jsonMatch) {
    return { ok: false, reason: "Resultado não contém campo 'smoke_test' — evidência funcional ausente" }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
  } catch {
    return { ok: false, reason: "JSON do smoke test é inválido" }
  }

  const smokeTest = parsed.smoke_test as Record<string, unknown> | undefined
  if (!smokeTest || typeof smokeTest !== "object") {
    return { ok: false, reason: "Campo 'smoke_test' ausente ou inválido no resultado" }
  }

  // Validação dos campos obrigatórios
  const url = smokeTest.url
  const method = smokeTest.method
  const status = smokeTest.status
  const responseBody = smokeTest.response_body
  const timestamp = smokeTest.timestamp

  if (typeof url !== "string" || url.length === 0) {
    return { ok: false, reason: "smoke_test.url ausente ou vazio" }
  }
  if (typeof method !== "string" || !["GET", "POST", "PUT", "DELETE"].includes(method)) {
    return { ok: false, reason: "smoke_test.method inválido (esperado GET/POST/PUT/DELETE)" }
  }
  if (typeof status !== "number" || status < 200 || status >= 300) {
    return { ok: false, reason: `smoke_test.status = ${status} — esperado 2xx (sucesso)` }
  }
  if (typeof responseBody !== "string") {
    return { ok: false, reason: "smoke_test.response_body ausente ou não é string" }
  }
  if (typeof timestamp !== "string" || timestamp.length === 0) {
    return { ok: false, reason: "smoke_test.timestamp ausente ou vazio" }
  }

  return {
    ok: true,
    evidence: {
      url,
      method: method as SmokeTestEvidence["method"],
      status,
      response_body: responseBody.substring(0, 2000),
      timestamp,
    },
  }
}

// ─── Execução real do smoke test (pelo motor) ──────────────────────────────

/**
 * Executa o smoke test real contra o endpoint do projeto novo.
 * Usado pelo motor para validar independentemente da evidência do agente.
 */
export function executeSmokeTest(config: SmokeTestConfig): Promise<SmokeTestResult> {
  const url = new URL(config.endpoint, config.baseUrl)
  const isHttps = url.protocol === "https:"
  const method = config.method ?? "GET"
  const timeoutMs = config.timeoutMs ?? 10_000

  const options: RequestOptions = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + (url.search || ""),
    method,
    headers: {
      Accept: "application/json",
      ...(config.authToken ? { Authorization: `Bearer ${config.authToken}` } : {}),
    },
    timeout: timeoutMs,
  }

  return new Promise((resolve) => {
    const startTime = Date.now()
    const req = (isHttps ? httpsRequest : httpRequest)(options, (res) => {
      let data = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => (data += chunk))
      res.on("end", () => {
        const status = res.statusCode ?? 0
        const timestamp = new Date().toISOString()

        if (status >= 200 && status < 300) {
          resolve({
            ok: true,
            evidence: {
              url: url.toString(),
              method,
              status,
              response_body: data.substring(0, 2000),
              timestamp,
            },
          })
        } else {
          resolve({
            ok: false,
            error: `HTTP ${status}: ${data.substring(0, 500)}`,
            status,
          })
        }
      })
    })

    req.on("timeout", () => {
      req.destroy()
      resolve({
        ok: false,
        error: `Timeout após ${timeoutMs}ms`,
      })
    })

    req.on("error", (error) => {
      resolve({
        ok: false,
        error: `Erro de conexão: ${error.message}`,
      })
    })

    req.end()
  })
}

// ─── Validação no gate ─────────────────────────────────────────────────────

/**
 * Valida se a subtarefa de smoke test tem evidência funcional válida.
 * Chamado pelo gate (phaseVerify) quando a tarefa é de setup e a subtarefa
 * atual é a de smoke test.
 *
 * Regras:
 * 1. O resultado da subtarefa DEVE conter JSON com campo `smoke_test`.
 * 2. O `status` do smoke test DEVE ser 2xx.
 * 3. A `url` DEVE apontar para o projeto novo (não para a biblioteca).
 */
export function validateSmokeTestGate(
  subtaskTitle: string,
  resultContent: string | null | undefined,
  projectSlug: string | null,
): SmokeTestValidation {
  // Só aplica a validação se a subtarefa É a de smoke test
  if (!isSmokeTestSubtask(subtaskTitle)) {
    return { ok: true, evidence: { url: "", method: "GET", status: 200, response_body: "", timestamp: "" } }
  }

  const validation = extractSmokeTestEvidence(resultContent)
  if (!validation.ok) {
    return validation
  }

  // Validação adicional: URL deve apontar para o projeto novo
  if (projectSlug && validation.evidence.url) {
    const urlContainsSlug = validation.evidence.url.includes(projectSlug) ||
      validation.evidence.url.includes(`/api/${projectSlug}`)
    if (!urlContainsSlug) {
      return {
        ok: false,
        reason: `smoke_test.url (${validation.evidence.url}) não aponta para o projeto novo (${projectSlug})`,
      }
    }
  }

  return validation
}

/**
 * Detecta se o título da subtarefa é o de smoke test (pelo título padrão
 * ou por palavras-chave).
 */
export function isSmokeTestSubtask(title: string): boolean {
  const normalized = title.toLowerCase().trim()
  return (
    normalized.includes("smoke test") ||
    normalized.includes("smoke-test") ||
    normalized.includes("teste funcional") ||
    normalized === SMOKE_TEST_SUBTASK_TITLE.toLowerCase()
  )
}

// ─── Geração da subtarefa para o plano ─────────────────────────────────────

/**
 * Gera a subtarefa de smoke test para ser adicionada ao plano do analista.
 * O motor injeta essa subtarefa como ÚLTIMA do plano de setup se o analista
 * não a incluiu (garantia de código, não só de prompt).
 */
export function generateSmokeTestSubtask(seq: number): {
  seq: number
  titulo: string
  scope: string
  acceptance_criteria: string[]
} {
  return {
    seq,
    titulo: SMOKE_TEST_SUBTASK_TITLE,
    scope: SMOKE_TEST_SUBTASK_SCOPE,
    acceptance_criteria: SMOKE_TEST_ACCEPTANCE_CRITERIA,
  }
}

/**
 * Verifica se um plano de subtarefas já inclui o smoke test.
 * Se não incluir e a tarefa for de setup, o motor deve injetar.
 */
export function planHasSmokeTest(subtasks: Array<{ titulo: string }>): boolean {
  return subtasks.some((st) => isSmokeTestSubtask(st.titulo))
}
