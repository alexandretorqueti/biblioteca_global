/**
 * ConfigLintPolicy — Lint de config.ts e validação de completude no gate VERIFY
 *
 * PRINCÍPIO (Alexandre 2026-09-03): o controle é aplicado em CÓDIGO pelo motor,
 * não só orientado em prompt. O gate reprova com diagnóstico claro quando:
 *
 * 1. FK declarada como type: "number" sem multipleChoice → reprova
 *    (causa: combos exibem ID em vez de nome — lição do TaQui)
 *
 * 2. Tela custom com componentId não registrado → reprova
 *    (causa: config declara tela que não existe no código)
 *
 * 3. Declarações do config sem implementação correspondente → reprova
 *    (causa: rowActions/actions com endpoints sem handler no backend)
 *
 * Fluxo:
 * - O motor lê o config.ts do projeto (texto, sem executar)
 * - Aplica regras de lint (Zod + regras de negócio)
 * - Verifica completude (arquivos de implementação existem)
 * - Retorna diagnóstico claro com lista de pendências
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join, basename } from "node:path"

// ─── Tipos ─────────────────────────────────────────────────────────────────

/** Diagnóstico de um problema encontrado no config.ts. */
export interface ConfigLintIssue {
  /** Severidade do problema. */
  severity: "error" | "warning"
  /** Regra violada (ex.: "fk-number-without-multiple-choice"). */
  rule: string
  /** Caminho no config (ex.: "groups[0].items[2].screen.fields[3]"). */
  path: string
  /** Mensagem de diagnóstico clara. */
  message: string
  /** Sugestão de correção (opcional). */
  suggestion?: string
}

/** Resultado do lint de config.ts. */
export type ConfigLintResult =
  | { ok: true; issues: ConfigLintIssue[] }
  | { ok: false; issues: ConfigLintIssue[]; summary: string }

/** Resultado da validação de completude. */
export type CompletenessResult =
  | { ok: true; missing: [] }
  | { ok: false; missing: CompletenessIssue[]; summary: string }

/** Problema de completude encontrado. */
export interface CompletenessIssue {
  /** Tipo de declaração sem implementação. */
  kind: "custom-screen" | "row-action" | "action"
  /** Identificador da declaração (componentId, action id, etc.). */
  identifier: string
  /** Caminho no config. */
  path: string
  /** Mensagem de diagnóstico. */
  message: string
  /** Arquivo esperado (se aplicável). */
  expectedFile?: string
}

/** Resultado combinado do lint + completude. */
export type ConfigValidationResult =
  | { ok: true; lintIssues: ConfigLintIssue[]; completenessIssues: CompletenessIssue[] }
  | { ok: false; lintIssues: ConfigLintIssue[]; completenessIssues: CompletenessIssue[]; summary: string }

// ─── Regras de lint ────────────────────────────────────────────────────────

/**
 * Padrão para detectar campos FK pelo nome (terminam em "Id" ou "_id").
 * Ex.: condominioId, unidadeId, proprietario_id
 */
const FK_NAME_PATTERN = /^[a-z]+[Ii]d$|^[a-z]+_id$/

/**
 * Detecta campos FK declarados como type: "number" sem multipleChoice.
 *
 * Regra: se um campo tem nome que sugere FK (termina em "Id") E type: "number"
 * E NÃO tem multipleChoice, então é um erro — a combo vai exibir ID em vez
 * de nome (lição do TaQui).
 *
 * @param configContent - Conteúdo texto do config.ts
 * @returns Lista de issues encontrados
 */
export function lintFkNumberWithoutMultipleChoice(configContent: string): ConfigLintIssue[] {
  const issues: ConfigLintIssue[] = []

  // Parse simplificado: busca padrões de campos com type: "number" e nome terminando em Id
  // Regex para capturar blocos de field: { name: "...", ..., type: "number", ... }
  const fieldPattern = /\{\s*name:\s*["']([^"']+)["'][^}]*?type:\s*["']number["'][^}]*?\}/g
  let match: RegExpExecArray | null

  while ((match = fieldPattern.exec(configContent)) !== null) {
    const fieldBlock = match[0]
    const fieldName = match[1] ?? ""

    // Verifica se o nome sugere FK
    if (FK_NAME_PATTERN.test(fieldName)) {
      // Verifica se tem multipleChoice no bloco
      if (!fieldBlock.includes("multipleChoice")) {
        issues.push({
          severity: "error",
          rule: "fk-number-without-multiple-choice",
          path: `field "${fieldName}"`,
          message: `Campo FK "${fieldName}" declarado como type: "number" sem multipleChoice. A combo exibirá ID em vez de nome. Use type: "multipleChoice" com multipleChoice: { resource: "...", idField: "id", displayField: "..." }.`,
          suggestion: `Alterar para: { name: "${fieldName}", type: "multipleChoice", multipleChoice: { resource: "<resource>", idField: "id", displayField: "nome" } }`,
        })
      }
    }
  }

  return issues
}

/**
 * Extrai todos os componentId de telas custom do config.ts.
 *
 * @param configContent - Conteúdo texto do config.ts
 * @returns Lista de { componentId, path }
 */
export function extractCustomScreenComponentIds(configContent: string): Array<{ componentId: string; path: string }> {
  const results: Array<{ componentId: string; path: string }> = []

  // Busca padrões: kind: "custom" seguido de componentId: "..."
  // Regex para capturar blocos de screen com kind: "custom"
  const customScreenPattern = /kind:\s*["']custom["'][^}]*?componentId:\s*["']([^"']+)["']/g
  let match: RegExpExecArray | null

  while ((match = customScreenPattern.exec(configContent)) !== null) {
    const componentId = match[1] ?? ""
    results.push({
      componentId,
      path: `screen with componentId "${componentId}"`,
    })
  }

  // Também busca o padrão inverso: componentId antes de kind: "custom"
  const reversePattern = /componentId:\s*["']([^"']+)["'][^}]*?kind:\s*["']custom["']/g
  while ((match = reversePattern.exec(configContent)) !== null) {
    const componentId = match[1] ?? ""
    // Evita duplicatas
    if (!results.some(r => r.componentId === componentId)) {
      results.push({
        componentId,
        path: `screen with componentId "${componentId}"`,
      })
    }
  }

  return results
}

/**
 * Extrai todos os rowActions e actions do config.ts.
 *
 * @param configContent - Conteúdo texto do config.ts
 * @returns Lista de { actionId, method, path, configPath }
 */
export function extractActions(configContent: string): Array<{
  actionId: string
  method: string
  actionPath: string
  configPath: string
}> {
  const results: Array<{
    actionId: string
    method: string
    actionPath: string
    configPath: string
  }> = []

  // Busca padrões de actions/rowActions: { id: "...", method: "...", path: "..." }
  const actionPattern = /\{\s*id:\s*["']([^"']+)["'][^}]*?method:\s*["']([^"']+)["'][^}]*?path:\s*["']([^"']+)["'][^}]*?\}/g
  let match: RegExpExecArray | null

  while ((match = actionPattern.exec(configContent)) !== null) {
    const actionId = match[1] ?? ""
    const method = match[2] ?? ""
    const actionPath = match[3] ?? ""
    results.push({
      actionId,
      method,
      actionPath,
      configPath: `action "${actionId}" (${method} ${actionPath})`,
    })
  }

  return results
}

// ─── Validação de completude ────────────────────────────────────────────────

/**
 * Verifica se um componentId tem implementação correspondente no projeto.
 *
 * Procura por:
 * - projects/<slug>/screens/<ComponentId>.tsx
 * - projects/<slug>/screens/<componentId>.tsx (lowercase)
 * - projects/<slug>/screens/*<componentId>*.tsx (contains)
 *
 * @param projectPath - Caminho raiz do monorepo
 * @param projectSlug - Slug do projeto
 * @param componentId - ID do componente
 * @returns true se existe implementação
 */
export function hasCustomScreenImplementation(
  projectPath: string,
  projectSlug: string,
  componentId: string,
): boolean {
  const screensDir = join(projectPath, "projects", projectSlug, "screens")

  if (!existsSync(screensDir)) {
    return false
  }

  try {
    const files = readdirSync(screensDir)

    // Busca correspondência exata (case-insensitive para extensão)
    const exactMatches = files.filter(f => {
      const nameWithoutExt = basename(f, ".tsx").toLowerCase()
      return nameWithoutExt === componentId.toLowerCase()
    })

    if (exactMatches.length > 0) {
      return true
    }

    // Busca correspondência parcial (componentId contido no nome)
    const partialMatches = files.filter(f => {
      const nameWithoutExt = basename(f, ".tsx").toLowerCase()
      return nameWithoutExt.includes(componentId.toLowerCase())
    })

    return partialMatches.length > 0
  } catch {
    return false
  }
}

/**
 * Verifica se existe implementação para um endpoint de action/rowAction.
 *
 * Procura por:
 * - Arquivos .ts/.tsx que contenham o path do endpoint
 * - Handlers/controllers que implementem a rota
 *
 * Nota: esta é uma verificação heurística — busca o path no código.
 *
 * @param projectPath - Caminho raiz do monorepo
 * @param actionPath - Path da action (ex.: "/api/taqui/encomendas/:id/confirmar")
 * @returns true se existe implementação (heurística)
 */
export function hasActionImplementation(
  projectPath: string,
  actionPath: string,
): boolean {
  // Remove parâmetros de rota para busca (:id → *)
  const normalizedPath = actionPath.replace(/:[^/]+/g, "*")

  // Busca em apps/api e projects/<slug> por handlers
  const searchDirs = [
    join(projectPath, "apps", "api", "src"),
    join(projectPath, "projects"),
  ]

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue

    try {
      if (searchForPathInFiles(dir, normalizedPath, actionPath)) {
        return true
      }
    } catch {
      continue
    }
  }

  return false
}

/**
 * Busca recursivamente por arquivos que contenham o path especificado.
 */
function searchForPathInFiles(dir: string, normalizedPath: string, originalPath: string): boolean {
  const MAX_DEPTH = 5
  const MAX_FILES = 100

  let filesChecked = 0

  function search(currentDir: string, depth: number): boolean {
    if (depth > MAX_DEPTH || filesChecked > MAX_FILES) return false

    try {
      const entries = readdirSync(currentDir)

      for (const entry of entries) {
        if (filesChecked > MAX_FILES) return false

        const fullPath = join(currentDir, entry)
        const stat = statSync(fullPath)

        if (stat.isDirectory()) {
          if (search(fullPath, depth + 1)) return true
        } else if (stat.isFile() && (entry.endsWith(".ts") || entry.endsWith(".tsx"))) {
          filesChecked++
          try {
            const content = readFileSync(fullPath, "utf8")
            // Busca o path original ou normalizado no conteúdo
            if (content.includes(originalPath) || content.includes(normalizedPath)) {
              return true
            }
            // Também busca o último segmento do path (ex.: "confirmar")
            const lastSegment = originalPath.split("/").pop()
            if (lastSegment && content.includes(lastSegment)) {
              return true
            }
          } catch {
            continue
          }
        }
      }
    } catch {
      // Ignora erros de leitura
    }

    return false
  }

  return search(dir, 0)
}

// ─── API principal ──────────────────────────────────────────────────────────

/**
 * Lê o config.ts do projeto e retorna o conteúdo texto.
 *
 * @param projectPath - Caminho raiz do monorepo
 * @param projectSlug - Slug do projeto
 * @returns Conteúdo do config.ts ou null se não existir
 */
export function readProjectConfig(projectPath: string, projectSlug: string): string | null {
  const configPath = join(projectPath, "projects", projectSlug, "config.ts")

  if (!existsSync(configPath)) {
    return null
  }

  try {
    return readFileSync(configPath, "utf8")
  } catch {
    return null
  }
}

/**
 * Aplica todas as regras de lint no config.ts.
 *
 * @param configContent - Conteúdo texto do config.ts
 * @returns Resultado do lint com lista de issues
 */
export function lintConfig(configContent: string): ConfigLintResult {
  const issues: ConfigLintIssue[] = []

  // Regra 1: FK number sem multipleChoice
  issues.push(...lintFkNumberWithoutMultipleChoice(configContent))

  // Regra 2: componentId de tela custom (validação básica de formato)
  const customScreens = extractCustomScreenComponentIds(configContent)
  for (const { componentId, path } of customScreens) {
    // Valida formato do componentId (deve ser kebab-case ou camelCase)
    if (!/^[a-z][a-z0-9-]*$/.test(componentId)) {
      issues.push({
        severity: "warning",
        rule: "component-id-format",
        path,
        message: `componentId "${componentId}" não segue o padrão kebab-case recomendado.`,
        suggestion: `Usar formato kebab-case: "${componentId.replace(/([A-Z])/g, "-$1").toLowerCase().replace(/^-/, "")}"`,
      })
    }
  }

  if (issues.some(i => i.severity === "error")) {
    return {
      ok: false,
      issues,
      summary: `Lint do config.ts falhou com ${issues.filter(i => i.severity === "error").length} erro(s) e ${issues.filter(i => i.severity === "warning").length} aviso(s).`,
    }
  }

  return { ok: true, issues }
}

/**
 * Valida a completude das declarações do config.ts.
 *
 * Verifica se:
 * - Telas custom têm implementação correspondente
 * - Actions/rowActions têm handlers implementados
 *
 * @param projectPath - Caminho raiz do monorepo
 * @param projectSlug - Slug do projeto
 * @param configContent - Conteúdo texto do config.ts
 * @returns Resultado da validação de completude
 */
export function validateCompleteness(
  projectPath: string,
  projectSlug: string,
  configContent: string,
): CompletenessResult {
  const missing: CompletenessIssue[] = []

  // Verifica telas custom
  const customScreens = extractCustomScreenComponentIds(configContent)
  for (const { componentId, path } of customScreens) {
    if (!hasCustomScreenImplementation(projectPath, projectSlug, componentId)) {
      missing.push({
        kind: "custom-screen",
        identifier: componentId,
        path,
        message: `Tela custom "${componentId}" declarada no config.ts mas sem implementação em projects/${projectSlug}/screens/.`,
        expectedFile: `projects/${projectSlug}/screens/${componentId}.tsx`,
      })
    }
  }

  // Verifica actions/rowActions
  const actions = extractActions(configContent)
  for (const { actionId, actionPath, configPath } of actions) {
    // Pula actions com paths externos (http/https)
    if (actionPath.startsWith("http://") || actionPath.startsWith("https://")) {
      continue
    }

    if (!hasActionImplementation(projectPath, actionPath)) {
      missing.push({
        kind: "row-action",
        identifier: actionId,
        path: configPath,
        message: `Action "${actionId}" com endpoint "${actionPath}" declarada no config.ts mas sem implementação encontrada.`,
      })
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      summary: `Validação de completude falhou: ${missing.length} declaração(ões) do config.ts sem implementação correspondente.`,
    }
  }

  return { ok: true, missing: [] }
}

/**
 * Validação completa do config.ts: lint + completude.
 *
 * @param projectPath - Caminho raiz do monorepo
 * @param projectSlug - Slug do projeto
 * @returns Resultado combinado
 */
export function validateProjectConfig(
  projectPath: string,
  projectSlug: string,
): ConfigValidationResult {
  const configContent = readProjectConfig(projectPath, projectSlug)

  if (configContent === null) {
    return {
      ok: false,
      lintIssues: [],
      completenessIssues: [{
        kind: "custom-screen",
        identifier: "config.ts",
        path: `projects/${projectSlug}/config.ts`,
        message: `Arquivo config.ts não encontrado em projects/${projectSlug}/.`,
        expectedFile: `projects/${projectSlug}/config.ts`,
      }],
      summary: `config.ts do projeto "${projectSlug}" não encontrado.`,
    }
  }

  const lintResult = lintConfig(configContent)
  const completenessResult = validateCompleteness(projectPath, projectSlug, configContent)

  const allOk = lintResult.ok && completenessResult.ok

  if (allOk) {
    return {
      ok: true,
      lintIssues: lintResult.issues,
      completenessIssues: [],
    }
  }

  const lintErrors = lintResult.issues.filter(i => i.severity === "error").length
  const completenessErrors = completenessResult.ok ? 0 : completenessResult.missing.length

  return {
    ok: false,
    lintIssues: lintResult.issues,
    completenessIssues: completenessResult.ok ? [] : completenessResult.missing,
    summary: `Validação do config.ts falhou: ${lintErrors} erro(s) de lint, ${completenessErrors} declaração(ões) sem implementação.`,
  }
}

// ─── Formatação de diagnóstico ──────────────────────────────────────────────

/**
 * Formata o resultado da validação em mensagem legível para o gate.
 *
 * @param result - Resultado da validação
 * @returns Mensagem formatada
 */
export function formatConfigValidationReport(result: ConfigValidationResult): string {
  if (result.ok) {
    const warnings = result.lintIssues.filter(i => i.severity === "warning")
    if (warnings.length === 0) {
      return "✅ Config.ts validado com sucesso (lint + completude)."
    }
    return `✅ Config.ts validado com ${warnings.length} aviso(s).`
  }

  const lines: string[] = [
    "❌ VALIDAÇÃO DO CONFIG.TS FALHOU",
    "",
    result.summary,
    "",
  ]

  // Issues de lint
  const lintErrors = result.lintIssues.filter(i => i.severity === "error")
  if (lintErrors.length > 0) {
    lines.push("## Erros de Lint:")
    for (const issue of lintErrors) {
      lines.push(`  - [${issue.rule}] ${issue.path}: ${issue.message}`)
      if (issue.suggestion) {
        lines.push(`    Sugestão: ${issue.suggestion}`)
      }
    }
    lines.push("")
  }

  // Issues de completude
  if (result.completenessIssues.length > 0) {
    lines.push("## Declarações sem Implementação:")
    for (const issue of result.completenessIssues) {
      lines.push(`  - [${issue.kind}] ${issue.identifier}: ${issue.message}`)
      if (issue.expectedFile) {
        lines.push(`    Arquivo esperado: ${issue.expectedFile}`)
      }
    }
    lines.push("")
  }

  lines.push("Corrija os problemas acima antes de prosseguir.")

  return lines.join("\n")
}
