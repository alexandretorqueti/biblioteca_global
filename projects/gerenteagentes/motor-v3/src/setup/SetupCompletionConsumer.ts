import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { TaskEventSink } from '../coordinator/TaskEventRecorder.js'
import { insertDeduplicatedChatMessage } from '../execution/blockerChatAlert.js'
import type { QueueMessage } from '../queue/index.js'
import {
  REQUIRED_SETUP_ARTIFACTS,
  resolveSetupProjectDir,
  validateSetupCompletion,
  type FsLike,
  type SetupGateResult,
  type SmokeTestEvidence,
} from './ProjectSetupGate.js'

/** Tipo de comando consumido por este consumidor (contrato estático). */
export const SETUP_COMPLETION_COMMAND_TYPE = 'TASK_EXECUTION_COMPLETED'

/** Prefixo canônico das tarefas de setup de projeto (external_id `setup-<slug>`). */
export const SETUP_TASK_PREFIX = 'setup-'

/**
 * task-p2-1072 (subtarefa 2) — Reconciliação de `setup_status` na conclusão
 * de tarefa `setup-*` por FLUXO DE DESENVOLVIMENTO.
 *
 * Caso real (2026-11-14): `setup-gestao-de-tarefas-global` (tarefa 1020)
 * terminou completed com 4/4 subtarefas verified, mas `projetos_captados.
 * setup_status` permaneceu 'queued'. Ao reconciliar manualmente, a tarefa
 * dependente (1063) iniciou e falhou no preflight porque o diretório do
 * projeto não continha `docs/CONTEXTO-ANALISTA.md`.
 *
 * O caminho de verificação da ANÁLISE já valida e grava o setup (subtarefa 1,
 * `MySqlTaskCoordinatorRepository.persistAnalysis`). Este consumidor cobre o
 * caminho de CONCLUSÃO POR DESENVOLVIMENTO: ao receber
 * `TASK_EXECUTION_COMPLETED` de tarefa `setup-*`, executa o MESMO validador
 * combinado (evidência JSON + artefatos em disco) e converge
 * `setup_status` para 'verified' ou 'failed' — NUNCA deixa em 'queued'
 * silenciosamente. `SetupCompletionSweeper` reutiliza `reconcileSetupCompletion`
 * como rede de segurança durável para conclusões sem evento (caminhos
 * reconciled/external-resolution e passivo histórico).
 *
 * A liberação das tarefas retidas do projeto alvo continua a cargo do loop de
 * capacity wait já existente (`recordCapacityWait` 'setup_not_verified'
 * re-enfileira e retoma sozinho após verified — ver `setupBlocksTask` em
 * MySqlTaskCoordinatorRepository). Este módulo NÃO cria mecanismo de release.
 *
 * Idempotência (redelivery/reexecução não duplica efeitos):
 * - `setup_status` já 'verified' → no-op auditado (evento, sem UPDATE);
 * - alerta no chat da tarefa com INSERT idempotente por marcador
 *   (padrão `blockerChatAlert`/`insertVerificationChatMessage`);
 * - UPDATE de verified/failed é convergente (reescrita do mesmo estado).
 */
export class SetupCompletionConsumer {
  constructor(
    private readonly pool: Pool,
    private readonly taskEvents?: TaskEventSink,
    private readonly fs?: FsLike,
  ) {}

  async handle(message: QueueMessage): Promise<void> {
    if (message.type !== SETUP_COMPLETION_COMMAND_TYPE) return
    const taskId = String(message.taskId ?? '')
    if (!taskId.startsWith(SETUP_TASK_PREFIX)) return
    const slug = taskId.slice(SETUP_TASK_PREFIX.length).trim()
    if (!slug) return
    // Erros de infraestrutura propagam para o QueueConsumer (retry/DLQ); a
    // reprovação do gate é desfecho normal ('failed') e nunca lança.
    const result = await reconcileSetupCompletion(this.pool, slug, {
      origin: 'task_execution_completed',
      taskEvents: this.taskEvents,
      fs: this.fs,
    })
    console.log(
      `[Motor v3] SetupCompletionConsumer: task=${taskId} slug=${slug} → ${result.outcome}` +
        (result.outcome === 'failed' ? ` (razões: ${result.reasons.join('; ')})` : ''),
    )
  }
}

/** Desfecho de uma passagem de reconciliação (consumidor ou varredura). */
export type SetupReconciliationResult =
  | { outcome: 'verified'; slug: string }
  | { outcome: 'failed'; slug: string; reasons: string[] }
  | { outcome: 'skipped_already_verified'; slug: string }
  | { outcome: 'project_not_found'; slug: string }
  | { outcome: 'setup_task_not_found'; slug: string }

export interface SetupReconciliationOptions {
  /** Quem disparou a reconciliação (auditoria): consumer, boot sweep, etc. */
  origin: string
  taskEvents?: TaskEventSink
  /** fs injetável para testes (padrão: node:fs/promises via ProjectSetupGate). */
  fs?: FsLike
}

/** Marcador de idempotência do alerta de reconciliação no chat da tarefa. */
export function setupReconciliationMarker(slug: string, outcome: 'verified' | 'failed'): string {
  return `[motor-v3:setup-reconciliation:${slug}:${outcome}]`
}

/** Predicado de smoke_test válido (mesma regra do gate de evidência). */
export function hasValidSmokeTest(value: unknown): value is SmokeTestEvidence {
  if (!value || typeof value !== 'object') return false
  const smoke = value as Partial<SmokeTestEvidence>
  return (
    typeof smoke.url === 'string' && smoke.url.length > 0 &&
    typeof smoke.method === 'string' && smoke.method.length > 0 &&
    Number.isInteger(smoke.status) && (smoke.status as number) >= 200 && (smoke.status as number) < 300 &&
    typeof smoke.timestamp === 'string' && smoke.timestamp.length > 0 && !Number.isNaN(Date.parse(smoke.timestamp))
  )
}

/**
 * Função ÚNICA de reconciliação de `setup_status` para o projeto alvo de uma
 * tarefa `setup-<slug>` concluída. Usada pelo consumidor (evento
 * TASK_EXECUTION_COMPLETED) e pela varredura durável (boot + periódica).
 *
 * Fluxo:
 * 1. idempotência — `setup_status` já 'verified' → no-op auditado;
 * 2. coleta evidência smoke_test varrendo `subtarefas.resultado` (text) das
 *    subtarefas verified, aceitando o primeiro JSON com smoke_test válido;
 * 3. roda o validador combinado da subtarefa 1 (evidência + artefatos em
 *    disco, `<repoRoot>/projects/<slug>` via repo_path com mapeamento
 *    cross-container);
 * 4. aprovação → verified com `setup_evidence` (smoke_test + artefatos +
 *    origem 'development_flow'); reprovação → failed com `setup_error`
 *    explícito (razões do gate) — nunca 'queued' silencioso;
 * 5. auditoria em `tarefa_eventos` + alerta legível idempotente no chat da
 *    tarefa de setup em ambos os desfechos.
 */
export async function reconcileSetupCompletion(
  pool: Pool,
  slug: string,
  options: SetupReconciliationOptions,
): Promise<SetupReconciliationResult> {
  const externalId = `${SETUP_TASK_PREFIX}${slug}`
  const [projectRows] = await pool.query<Array<RowDataPacket & { id: number; setup_status: string }>>(
    'SELECT id, setup_status FROM projetos_captados WHERE slug = ? LIMIT 1',
    [slug],
  )
  const project = projectRows[0]
  if (!project) {
    console.warn(`[Motor v3] reconcileSetupCompletion: projeto '${slug}' não existe em projetos_captados — nada a reconciliar.`)
    return { outcome: 'project_not_found', slug }
  }
  if (String(project.setup_status) === 'verified') {
    // No-op auditado: redelivery da mensagem ou reexecução da varredura não
    // duplica efeitos quando o setup já está verificado.
    await recordSetupEvent(options.taskEvents, externalId, 'setup_reconciliation_skipped', {
      outcome: 'skipped_already_verified', slug, origin: options.origin,
    })
    return { outcome: 'skipped_already_verified', slug }
  }

  const [taskRows] = await pool.query<Array<RowDataPacket & { id: number; external_id: string | null; repo_path: string | null; project_layout: 'monorepo' | 'standalone' | null }>>(
    `SELECT t.id, t.external_id, pmc.repo_path, pmc.project_layout
       FROM tarefas t
       LEFT JOIN projeto_motor_config pmc ON pmc.projeto_id = t.projeto_id
      WHERE t.external_id = ?
      LIMIT 1`,
    [externalId],
  )
  const task = taskRows[0]
  if (!task) {
    console.warn(`[Motor v3] reconcileSetupCompletion: tarefa '${externalId}' não existe — impossível reconciliar o setup do projeto '${slug}'.`)
    return { outcome: 'setup_task_not_found', slug }
  }
  const databaseTaskId = Number(task.id)

  // (2) Evidência smoke_test: primeiro JSON válido em subtarefas.resultado
  // (coluna text) das subtarefas verified da tarefa.
  const [evidenceRows] = await pool.query<Array<RowDataPacket & { resultado: string | null }>>(
    `SELECT s.resultado
       FROM subtarefas s
      WHERE s.tarefa_id = ? AND s.status = 'verified' AND s.resultado IS NOT NULL
      ORDER BY s.id`,
    [databaseTaskId],
  )
  let candidate: unknown = null
  for (const row of evidenceRows) {
    const parsed = tryParseJsonObject(row.resultado)
    if (parsed !== null && hasValidSmokeTest((parsed as { smoke_test?: unknown }).smoke_test)) {
      candidate = parsed
      break
    }
  }

  // (3) Validador combinado da subtarefa 1: evidência JSON + artefatos em
  // disco (<repoRoot>/projects/<slug> via repo_path com mapeamento
  // cross-container). Falha de resolução de caminho vira razão explícita.
  let gate: SetupGateResult
  try {
    const projectDir = await resolveSetupProjectDir(task.repo_path ?? null, slug, task.project_layout ?? 'monorepo')
    gate = await validateSetupCompletion({
      evidence: candidate,
      projectDir,
      layout: task.project_layout ?? 'monorepo',
      fs: options.fs,
    })
  } catch (error) {
    gate = { ok: false, reasons: [error instanceof Error ? error.message : String(error)] }
  }
  const reasons = [...gate.ok ? [] : gate.reasons]
  if (!gate.ok && candidate === null) {
    reasons.unshift('nenhum resultado de subtarefa verified com evidência smoke_test JSON válida (subtarefas.resultado)')
  }

  // (4) Convergência explícita: verified ou failed — nunca 'queued' silencioso.
  if (gate.ok) {
    const setupEvidence = {
      ...gate.evidence,
      artifacts: [...REQUIRED_SETUP_ARTIFACTS],
      origin: 'development_flow',
      reconciled_by: options.origin,
      reconciled_at: new Date().toISOString(),
    }
    await pool.query(
      `UPDATE projetos_captados SET setup_status='verified', setup_error=NULL,
              setup_verified_at=NOW(), setup_evidence=?, updated_at=NOW()
        WHERE slug = ?`,
      [JSON.stringify(setupEvidence), slug],
    )
  } else {
    await pool.query(
      `UPDATE projetos_captados SET setup_status='failed', setup_error=?, updated_at=NOW()
        WHERE slug = ?`,
      [`Setup reprovado na reconciliação de conclusão (development_flow): ${reasons.join('; ')}`, slug],
    )
  }

  // (5) Auditoria + alerta legível idempotente no chat da tarefa de setup.
  const outcome = gate.ok ? 'verified' : 'failed'
  await recordSetupEvent(options.taskEvents, externalId, 'setup_reconciled', {
    outcome, slug, origin: options.origin, ...(gate.ok ? {} : { reasons }),
  })
  await insertSetupReconciliationChatAlert(pool, databaseTaskId, slug, outcome, reasons)

  if (!gate.ok) {
    console.warn(`[Motor v3] reconcileSetupCompletion: setup do projeto '${slug}' REPROVADO → failed. Razões: ${reasons.join('; ')}`)
    return { outcome: 'failed', slug, reasons }
  }
  console.log(`[Motor v3] reconcileSetupCompletion: setup do projeto '${slug}' aprovado → verified (origin=${options.origin}).`)
  return { outcome: 'verified', slug }
}

/** Texto legível do alerta de reconciliação no chat da tarefa de setup. */
export function buildSetupReconciliationChatText(
  slug: string,
  outcome: 'verified' | 'failed',
  reasons: string[],
): string {
  const header = outcome === 'verified'
    ? '✅ **Setup do projeto verificado — conclusão por fluxo de desenvolvimento**'
    : '🚨 **Setup reprovado na reconciliação de conclusão — projeto NÃO liberado**'
  const lines = [
    header,
    '',
    `**Projeto:** ${slug}`,
    `**Tarefa de setup:** ${SETUP_TASK_PREFIX}${slug}`,
  ]
  if (outcome === 'verified') {
    lines.push(
      `**Validação:** evidência smoke_test 2xx + artefatos em disco (${REQUIRED_SETUP_ARTIFACTS.join(', ')})`,
      '**Efeito:** `projetos_captados.setup_status=verified` com `setup_evidence` (origem development_flow).',
      '',
      'As tarefas do projeto retidas pelo gate de setup serão retomadas automaticamente pelo loop de capacity wait.',
    )
  } else {
    lines.push(
      '**Motivo (razões do gate):**',
      ...reasons.map(reason => `- ${reason}`),
      '',
      '**Efeito:** `projetos_captados.setup_status=failed` com `setup_error` explícito. As tarefas do projeto continuam retidas pelo gate de setup.',
      '**Próximo passo:** corrigir as pendências (artefatos/evidência) e reexecutar/concluir o setup; a reconciliação converge o status automaticamente.',
    )
  }
  lines.push('', setupReconciliationMarker(slug, outcome))
  return lines.join('\n')
}

/** INSERT idempotente por marcador (padrão blockerChatAlert); best-effort. */
async function insertSetupReconciliationChatAlert(
  pool: Pool,
  databaseTaskId: number,
  slug: string,
  outcome: 'verified' | 'failed',
  reasons: string[],
): Promise<void> {
  try {
    const texto = buildSetupReconciliationChatText(slug, outcome, reasons)
    const created = await insertDeduplicatedChatMessage(pool, databaseTaskId, setupReconciliationMarker(slug, outcome), texto)
    if (!created) {
      console.log(`[Motor v3] reconcileSetupCompletion: alerta de setup (${outcome}) já existente no chat da tarefa ${databaseTaskId} — deduplicado.`)
    }
  } catch (error) {
    console.warn(
      `[Motor v3] reconcileSetupCompletion: falha ao gravar alerta de setup no chat da tarefa ${databaseTaskId}:`,
      error instanceof Error ? error.message : String(error),
    )
  }
}

/** Auditoria best-effort em `tarefa_eventos` (nunca derruba a reconciliação). */
async function recordSetupEvent(
  taskEvents: TaskEventSink | undefined,
  externalId: string,
  evento: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!taskEvents) return
  try {
    await taskEvents.record(externalId, evento, 'motor', payload)
  } catch (error) {
    console.warn(
      `[Motor v3] reconcileSetupCompletion: falha ao registrar evento ${evento} da tarefa ${externalId}:`,
      error instanceof Error ? error.message : String(error),
    )
  }
}

/** JSON.parse defensivo: retorna objeto (não-array) ou null. */
function tryParseJsonObject(value: string | null | undefined): unknown | null {
  const text = String(value ?? '').trim()
  if (!text) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}
