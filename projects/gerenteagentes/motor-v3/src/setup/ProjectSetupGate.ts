import { access as fsAccess, stat as fsStat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { mapHostRepoPathToContainer } from '../execution/GitWorktreePreparer.js'

export type SetupChecklist = {
  structure: boolean
  configSchemaMigrations: boolean
  registries: boolean
  repoPath: boolean
  agentLink?: boolean
  repoInspected?: boolean
  analystContext?: boolean
  commitPush?: boolean
}

export type SmokeTestEvidence = {
  url: string
  method: string
  status: number
  response_body?: string
  timestamp: string
}

export type SetupEvidence = {
  checklist: SetupChecklist
  smoke_test?: SmokeTestEvidence
  [key: string]: unknown
}

export type SetupGateResult =
  | { ok: true; evidence: SetupEvidence }
  | { ok: false; reasons: string[] }

export type ProjectLayout = 'monorepo' | 'standalone'

/**
 * Validação determinística do resultado do setup. O prompt é apenas uma
 * orientação: o projeto só pode virar `verified` quando esta função aceitar
 * todos os itens aplicáveis e uma evidência JSON de HTTP 2xx.
 */
export function validateProjectSetupEvidence(input: unknown, layout: ProjectLayout = 'monorepo'): SetupGateResult {
  if (!input || typeof input !== 'object') return { ok: false, reasons: ['evidência de setup ausente'] }
  const evidence = input as Partial<SetupEvidence>
  const checklist = evidence.checklist
  const reasons: string[] = []
  if (!checklist || typeof checklist !== 'object') {
    reasons.push('checklist ausente')
  } else {
    const requiredItems = layout === 'standalone'
      ? ['repoInspected', 'analystContext', 'commitPush'] as const
      : ['structure', 'configSchemaMigrations', 'registries', 'repoPath'] as const
    for (const item of requiredItems) {
      if (checklist[item] !== true) reasons.push(`checklist incompleto: ${item}`)
    }
    if ('agentLink' in checklist && checklist.agentLink !== true) reasons.push('checklist incompleto: agentLink')
  }
  const smoke = evidence.smoke_test
  if (!smoke || typeof smoke !== 'object') {
    reasons.push('evidência smoke_test ausente')
  } else {
    if (typeof smoke.url !== 'string' || !smoke.url) reasons.push('smoke_test.url inválida')
    if (typeof smoke.method !== 'string' || !smoke.method) reasons.push('smoke_test.method inválido')
    if (!Number.isInteger(smoke.status) || smoke.status < 200 || smoke.status >= 300) reasons.push('smoke_test.status não é 2xx')
    if (typeof smoke.timestamp !== 'string' || !smoke.timestamp || Number.isNaN(Date.parse(smoke.timestamp))) reasons.push('smoke_test.timestamp inválido')
  }
  return reasons.length ? { ok: false, reasons } : { ok: true, evidence: evidence as SetupEvidence }
}

/**
 * fs injetável para testes (padrão: node:fs/promises). Apenas as operações
 * usadas pela checagem de artefatos fazem parte do contrato.
 */
export type FsLike = {
  access(path: string): Promise<unknown>
  stat(path: string): Promise<{ isDirectory(): boolean }>
}

const defaultFs: FsLike = {
  access: (path) => fsAccess(path),
  stat: (path) => fsStat(path),
}

/**
 * Artefatos OBRIGATÓRIOS em disco no diretório do projeto alvo do setup.
 * `docs/CONTEXTO-ANALISTA.md` é o mesmo artefato exigido pelo preflight do
 * ConsoleAnalystRunner (preflightWorkspace): sem ele, qualquer tarefa
 * dependente falha ao iniciar a análise — por isso o setup não pode ser
 * dado como `verified` enquanto ele não existir.
 */
export const REQUIRED_SETUP_ARTIFACTS: readonly string[] = ['docs/CONTEXTO-ANALISTA.md']

export type SetupArtifactResult =
  | { ok: true }
  | { ok: false; reasons: string[] }

/**
 * Validação determinística dos artefatos de setup em disco. Retorna razões
 * explícitas de falha (diretório ausente/inacessível e cada artefato
 * obrigatório faltante) em vez de lançar exceção.
 */
export async function validateProjectSetupArtifacts(projectDir: string, fs: FsLike = defaultFs): Promise<SetupArtifactResult> {
  const dir = String(projectDir ?? '').trim()
  if (!dir) return { ok: false, reasons: ['diretório do projeto ausente para validação de artefatos de setup'] }
  const reasons: string[] = []
  try {
    if (!(await fs.stat(resolve(dir))).isDirectory()) {
      reasons.push(`diretório do projeto não é um diretório: ${dir}`)
    }
  } catch {
    reasons.push(`diretório do projeto inexistente ou inacessível: ${dir}`)
  }
  for (const artifact of REQUIRED_SETUP_ARTIFACTS) {
    const artifactPath = resolve(dir, ...artifact.split('/'))
    try {
      await fs.access(artifactPath)
    } catch {
      reasons.push(`artefato obrigatório ausente: ${artifact}`)
    }
  }
  return reasons.length ? { ok: false, reasons } : { ok: true }
}

/**
 * task-p2-1072: resolve o diretório do projeto alvo do gate de artefatos de
 * setup: `<repoRoot>/projects/<slug>` para monorepo ou a própria raiz do
 * repositório para standalone, onde repoRoot vem do repo_path do
 * projeto_motor_config com o mapeamento cross-container host↔container
 * (mesmo padrão de GitWorktreePreparer.resolveRepoPath / preflight do
 * ConsoleAnalystRunner). Sem caminho hardcoded; lança erro descritivo quando
 * o repo_path está ausente ou o repositório está inacessível no container.
 *
 * Fonte única compartilhada entre o caminho de verificação da análise
 * (MySqlTaskCoordinatorRepository) e a reconciliação de conclusão por fluxo
 * de desenvolvimento (SetupCompletionConsumer/SetupCompletionSweeper).
 */
export async function resolveSetupProjectDir(
  repoPath: string | null,
  projectSlug: string,
  layout: ProjectLayout = 'monorepo',
): Promise<string> {
  const trimmed = String(repoPath ?? '').trim()
  if (!trimmed) {
    throw new Error(`repo_path do projeto ausente para slug '${projectSlug}' — impossível validar artefatos de setup`)
  }
  const original = resolve(trimmed)
  const candidates = [...new Set([original, mapHostRepoPathToContainer(original)].filter((path): path is string => Boolean(path)))]
  for (const repoRoot of candidates) {
    try {
      if ((await fsStat(repoRoot)).isDirectory()) {
        return layout === 'standalone' ? repoRoot : join(repoRoot, 'projects', projectSlug)
      }
    } catch { /* tenta o próximo candidato (host ↔ container) */ }
  }
  throw new Error(`repositório inacessível no container do Motor: ${original}`)
}

/**
 * Checklist monorepo derivado DETERMINISTICAMENTE do disco (incidente
 * 2026-11-23 — setups históricos travados em 'checklist ausente').
 *
 * Contexto: o gate exige `checklist` + `smoke_test` no MESMO objeto JSON da
 * evidência, mas a missão de setup monorepo só passou a pedir o checklist em
 * 3936d637 (22/11). Setups concluídos antes disso (gerenteagentes, gestao-de-
 * tarefas-global) gravaram evidência com smoke_test válido e SEM checklist —
 * e como a tarefa já está completed, nenhuma re-execução gera evidência nova:
 * a re-verificação do sweeper reprova em loop permanente sem caminho de
 * correção (re-disparo esgotado, resume de tarefa completed é no-op).
 *
 * Em vez de exigir autodeclaração do DEV, os itens do checklist monorepo são
 * fatos objetivos verificáveis em disco — e para projetos cujo deploy já
 * succeeded e o smoke_test retornou 2xx, os registros estão empiricamente
 * funcionando (DynamicSchemaRegistry carrega projects/<slug>/schema.ts por
 * autodescoberta no boot; o registry do front usa import.meta.glob em
 * projects/<slug>/config.ts — a presença dos arquivos É o registro).
 *
 * Itens derivados:
 * - structure: diretório do projeto com package.json;
 * - configSchemaMigrations: config.ts|config.json + schema.ts + migrations/;
 * - registries: schema.ts + config.ts (autodescoberta — sem arquivo manual);
 * - repoPath: o diretório do projeto resolveu (resolveSetupProjectDir).
 *
 * O smoke_test NUNCA é derivado — continua exigindo evidência HTTP 2xx real
 * gravada pelo DEV. Usado apenas quando a evidência tem smoke_test válido e o
 * checklist está ausente; procedência auditável via `checklist_source`.
 * Layout standalone NÃO é derivável (repoInspected/analystContext/commitPush
 * são julgamentos do agente, não fatos de disco) — mantém a reprovação.
 */
export async function deriveSetupChecklist(projectDir: string, fs: FsLike = defaultFs): Promise<SetupChecklist> {
  const exists = async (path: string): Promise<boolean> => {
    try {
      await fs.access(resolve(path))
      return true
    } catch {
      return false
    }
  }
  const isDir = async (path: string): Promise<boolean> => {
    try {
      return (await fs.stat(resolve(path))).isDirectory()
    } catch {
      return false
    }
  }
  const dir = String(projectDir ?? '').trim()
  const dirOk = dir !== '' && (await isDir(dir))
  const packageOk = dirOk && (await exists(join(dir, 'package.json')))
  const hasConfig = dirOk && ((await exists(join(dir, 'config.ts'))) || (await exists(join(dir, 'config.json'))))
  const hasSchema = dirOk && (await exists(join(dir, 'schema.ts')))
  const hasMigrations = dirOk && (await isDir(join(dir, 'migrations')))
  return {
    structure: packageOk,
    configSchemaMigrations: hasConfig && hasSchema && hasMigrations,
    registries: hasSchema && hasConfig,
    repoPath: dirOk,
  }
}

/**
 * Validador combinado da conclusão do setup: agrega a evidência JSON
 * (checklist + smoke_test 2xx) com a checagem de artefatos em disco.
 * O projeto só pode virar `verified` quando AMBOS passam; caso contrário,
 * retorna todas as razões de falha (evidência + artefatos) de uma vez.
 */
export async function validateSetupCompletion(input: {
  evidence: unknown
  projectDir: string
  layout?: ProjectLayout
  fs?: FsLike
}): Promise<SetupGateResult> {
  const evidenceGate = validateProjectSetupEvidence(input.evidence, input.layout ?? 'monorepo')
  const artifactGate = await validateProjectSetupArtifacts(input.projectDir, input.fs)
  if (!evidenceGate.ok && !artifactGate.ok) {
    return { ok: false, reasons: [...evidenceGate.reasons, ...artifactGate.reasons] }
  }
  if (!evidenceGate.ok) return { ok: false, reasons: evidenceGate.reasons }
  if (!artifactGate.ok) return { ok: false, reasons: artifactGate.reasons }
  return { ok: true, evidence: evidenceGate.evidence }
}
