/**
 * Fingerprint estável para falhas de gate.
 *
 * Objetivo: quando o mesmo gate falha com a mesma causa em tentativas diferentes,
 * o fingerprint deve ser idêntico para permitir detecção de recorrência e cálculo
 * de retrabalho.
 *
 * Regras:
 * - O fingerprint é determinístico: mesma entrada → mesma saída.
 * - Normaliza espaços, caminhos de arquivo e timestamps para evitar variação.
 * - Limita o tamanho para caber na coluna `failure_fingerprint` (varchar 128).
 * - Usa os primeiros 120 caracteres do hash SHA-256 do conteúdo normalizado.
 */

import { createHash } from "node:crypto"

/**
 * Gera um fingerprint estável para uma falha de gate.
 *
 * @param gateType - tipo do gate (build, test_unit, test_e2e, lint, smoke_test)
 * @param errorMessage - mensagem de erro do gate (será normalizada)
 * @returns fingerprint de até 128 caracteres
 */
export function stableGateFingerprint(gateType: string, errorMessage: string): string {
  const normalized = normalizeForFingerprint(errorMessage)
  const hash = createHash("sha256")
    .update(gateType + ":" + normalized)
    .digest("hex")
    .slice(0, 32)
  return gateType + ":" + hash
}

/**
 * Normaliza uma mensagem de erro para fingerprint estável.
 *
 * Remove:
 * - Caminhos absolutos (variam por máquina/worktree)
 * - Timestamps e durações
 * - Espaços extras
 * - IDs de sessão/execução voláteis
 */
function normalizeForFingerprint(message: string): string {
  return message
    // Remove caminhos absolutos comuns em worktrees
    .replace(/\/data\/workspace\/projects\/[^\s:,'"]+/g, "<PATH>")
    .replace(/\/home\/[^\s:,'"]+/g, "<PATH>")
    .replace(/\/tmp\/[^\s:,'"]+/g, "<PATH>")
    // Remove timestamps ISO
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.\d]*/g, "<TIMESTAMP>")
    // Remove durações (ex.: "1234ms", "2.5s")
    .replace(/\b\d+ms\b/g, "<DURATION>")
    .replace(/\b\d+\.\d+s\b/g, "<DURATION>")
    // Remove UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>")
    // Remove números de linha/coluna (ex.: ":123:45")
    .replace(/:\d{1,5}:\d{1,5}/g, ":<LOC>")
    // Remove hashes de commit (7-40 chars hex)
    .replace(/\b[0-9a-f]{7,40}\b/gi, "<HASH>")
    // Normaliza espaços
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500)
}

/**
 * Classifica o tipo de gate a partir do comando executado.
 */
export function classifyGateType(command: string): string {
  const cmd = command.toLowerCase()
  if (cmd.includes("smoke") || cmd.includes("curl")) return "smoke_test"
  if (cmd.includes("build") || cmd.includes("tsc")) return "build"
  if (cmd.includes("lint") || cmd.includes("eslint")) return "lint"
  if (cmd.includes("test:e2e") || cmd.includes("playwright") || cmd.includes("cypress")) return "test_e2e"
  if (cmd.includes("test") || cmd.includes("vitest") || cmd.includes("jest")) return "test_unit"
  if (cmd.includes("security") || cmd.includes("audit") || cmd.includes("npm audit")) return "security"
  return "custom"
}
