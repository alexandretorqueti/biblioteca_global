import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { insertDeduplicatedChatMessage } from '../execution/blockerChatAlert.js'
import { createQueueMessage, insertOutboxMessage } from '../queue/index.js'
import { SETUP_TASK_PREFIX } from './SetupCompletionConsumer.js'

/**
 * Visibilidade e auto-recuperação do gate `setup_not_verified`
 * (tarefa motor-visibilidade-setup-not-verified, brief 2026-11-19).
 *
 * Contexto (incidente 18–19/11): tarefas 1063–1070 e 1083 paradas em requeue
 * infinito `capacity_waiting('setup_not_verified')` sem que a aplicação
 * comunicasse o motivo real — projeto com `setup_status='failed'`, sem missão
 * de setup ativa, sem alerta e sem re-disparo (limbo silencioso).
 *
 * Este módulo acrescenta ao gate de capacidade (que continua sendo espera,
 * NUNCA bloqueio — docs/TAXONOMIA-ERROS-MOTOR.md):
 *
 * A. diagnóstico rico: sub-motivo derivado de `geracoes_projeto` +
 *    `projetos_captados.setup_status` (`setup_faltando` | `setup_failed` |
 *    `setup_em_andamento`), persistido em `task_runtime_facts` e projetado em
 *    `GET /api/motor/task/:id` (`capacityWait.{setupState,setupError,detail}`);
 * B. alerta único: se o sub-motivo problemático persistir além de um marco
 *    (`capacity_wait_since`), alerta legível no chat da tarefa retida com
 *    dedupe POR PROJETO e janela configurável (sem spam);
 * C. re-disparo idempotente: sem setup `queued/running/pending` no projeto,
 *    reemite a missão de setup (`TASK_ENQUEUED` durável via outbox — o
 *    `TaskEnqueuedConsumer` faz a ponte canônica para `TASK_RESUME_REQUESTED`),
 *    com backoff e contador; após o teto de tentativas, permanece em espera
 *    com alerta humano. NUNCA recria/re-dispara se já existe setup ativo
 *    (UPDATE condicional atômico).
 *
 * Sem SQL direto em tabelas de estado do motor para intervenções: o
 * re-disparo usa a fila canônica (outbox → TASK_ENQUEUED → resume com todas
 * as guardas do TaskCoordinator).
 */

/** Sub-motivos canônicos da espera `setup_not_verified` (enum fixo — o app classifica a partir dele). */
export const SETUP_GATE_SUB_REASONS = ['setup_faltando', 'setup_failed', 'setup_em_andamento'] as const
export type SetupGateSubReason = (typeof SETUP_GATE_SUB_REASONS)[number]

/** Configuração da recuperação (tudo opcional; defaults conservadores). */
export interface SetupGateRecoveryConfig {
  /** Minutos de espera persistente (capacity_wait_since) antes do primeiro alerta. Default 30. */
  alertAfterMinutes?: number
  /** Janela de dedupe do alerta POR PROJETO, em minutos. Default 60. */
  alertWindowMinutes?: number
  /** Backoff mínimo entre re-disparos automáticos, em minutos. Default 30. */
  redispatchBackoffMinutes?: number
  /** Teto de re-disparos automáticos por projeto; após isso, só alerta humano. Default 3. */
  redispatchMaxAttempts?: number
  /** Relógio injetável (testes). Default: NOW() do MySQL / Date.now(). */
  now?: () => Date
}

export const SETUP_GATE_RECOVERY_DEFAULTS = {
  alertAfterMinutes: 30,
  alertWindowMinutes: 60,
  redispatchBackoffMinutes: 30,
  redispatchMaxAttempts: 3,
} as const

/** Fatos do projeto coletados no momento da retenção pelo gate. */
export interface SetupGateHoldFacts {
  projectId: number
  slug: string | null
  setupStatus: string | null
  /** LEFT(setup_error, 300) de projetos_captados. */
  setupError: string | null
  /** Gerações do projeto em estado ativo (pending/running/awaiting_*). */
  activeGenerations: number
  lastGenerationStatus: string | null
  /** LEFT(erro, 300) da última geração (geracoes_projeto). */
  lastGenerationError: string | null
  redispatchCount: number
  redispatchLastAt: Date | string | null
}

/** Sub-motivo persistido/projetado da espera `setup_not_verified`. */
export interface SetupGateHold {
  state: SetupGateSubReason
  error: string | null
  /** Detalhe legível (inclui estado do re-disparo automático). */
  detail: string
}

/**
 * Consulta os fatos do projeto na MESMA transação do claim (consistência:
 * o sub-motivo reflete o estado visto pelo gate).
 */
export async function collectSetupGateHoldFacts(
  connection: Pick<PoolConnection, 'query'>,
  projectId: number,
): Promise<SetupGateHoldFacts | null> {
  const [rows] = await connection.query<Array<RowDataPacket & {
    slug: string | null
    setup_status: string | null
    setup_error: string | null
    geracoes_ativas: number | string
    ultima_geracao_status: string | null
    ultima_geracao_erro: string | null
    setup_redispatch_count: number | string
    setup_redispatch_last_at: Date | string | null
  }>>(
    `SELECT pc.slug, pc.setup_status, LEFT(pc.setup_error, 300) AS setup_error,
            (SELECT COUNT(*) FROM geracoes_projeto g
              WHERE g.projeto_id = pc.id
                AND g.status IN ('pending','queued','running','awaiting_clarification','awaiting_approval')) AS geracoes_ativas,
            (SELECT g.status FROM geracoes_projeto g
              WHERE g.projeto_id = pc.id ORDER BY g.id DESC LIMIT 1) AS ultima_geracao_status,
            (SELECT LEFT(g.erro, 300) FROM geracoes_projeto g
              WHERE g.projeto_id = pc.id ORDER BY g.id DESC LIMIT 1) AS ultima_geracao_erro,
            pc.setup_redispatch_count, pc.setup_redispatch_last_at
       FROM projetos_captados pc
      WHERE pc.id = ?
      LIMIT 1`,
    [projectId],
  )
  const row = rows[0]
  if (!row) return null
  return {
    projectId,
    slug: row.slug != null ? String(row.slug) : null,
    setupStatus: row.setup_status != null ? String(row.setup_status) : null,
    setupError: row.setup_error != null ? String(row.setup_error) : null,
    activeGenerations: Number(row.geracoes_ativas ?? 0),
    lastGenerationStatus: row.ultima_geracao_status != null ? String(row.ultima_geracao_status) : null,
    lastGenerationError: row.ultima_geracao_erro != null ? String(row.ultima_geracao_erro) : null,
    redispatchCount: Number(row.setup_redispatch_count ?? 0),
    redispatchLastAt: row.setup_redispatch_last_at ?? null,
  }
}

/**
 * Deriva o sub-motivo da retenção (função pura — coberta por testes unitários).
 *
 * Regras do brief (A.1), em ordem:
 * - `setup_failed`: `setup_status='failed'` OU última geração falha — o erro
 *   real (LEFT 300) acompanha (preferência: erro da geração, fallback
 *   `setup_error` do projeto);
 * - `setup_em_andamento`: setup `queued/running/pending` OU alguma geração
 *   ativa (pending/queued/running/awaiting_*) — caso transitório normal;
 * - `setup_faltando`: nenhum dos acima — projeto sem setup concluído, sem
 *   setup ativo e sem geração em andamento (limbo — alvo do re-disparo).
 */
export function deriveSetupGateHold(
  facts: SetupGateHoldFacts,
  config: SetupGateRecoveryConfig = {},
): SetupGateHold {
  const maxAttempts = config.redispatchMaxAttempts ?? SETUP_GATE_RECOVERY_DEFAULTS.redispatchMaxAttempts
  const failed = facts.setupStatus === 'failed' || facts.lastGenerationStatus === 'failed'
  const setupActive = facts.setupStatus === 'queued' || facts.setupStatus === 'running' || facts.setupStatus === 'pending'
  const emAndamento = setupActive || facts.activeGenerations > 0
  const redispatchDetail = `re-disparo automático: tentativa ${Math.min(facts.redispatchCount + 1, maxAttempts)} de ${maxAttempts}`
  if (failed) {
    const error = (facts.setupStatus === 'failed' ? facts.setupError : null) ?? facts.lastGenerationError ?? facts.setupError
    return {
      state: 'setup_failed',
      error,
      detail: `setup do projeto '${facts.slug ?? facts.projectId}' FALHOU${error ? `: ${error}` : ''} (${redispatchDetail})`,
    }
  }
  if (emAndamento) {
    return {
      state: 'setup_em_andamento',
      error: null,
      detail: `setup do projeto '${facts.slug ?? facts.projectId}' em andamento (setup_status=${facts.setupStatus ?? 'n/d'}, gerações ativas=${facts.activeGenerations})`,
    }
  }
  return {
    state: 'setup_faltando',
    error: null,
    detail: `projeto '${facts.slug ?? facts.projectId}' sem setup concluído e sem missão de setup ativa (${redispatchDetail})`,
  }
}

/** Desfecho de uma passagem de recuperação (auditoria/testes). */
export interface SetupGateRecoveryResult {
  alerted: boolean
  redispatched: boolean
  /** Motivo canônico quando o re-disparo NÃO ocorreu (null = não avaliado/em andamento). */
  redispatchSkippedReason: 'sub_reason_in_progress' | 'setup_task_missing' | 'setup_active' | 'backoff' | 'attempts_exhausted' | null
}

export interface SetupGateRecoveryInput {
  /** Id numérico da tarefa RETIDA (chat de destino do alerta). */
  databaseTaskId: number
  /** Id externo da tarefa retida (auditoria/log). */
  taskExternalId: string
  facts: SetupGateHoldFacts
  hold: SetupGateHold
  config?: SetupGateRecoveryConfig
}

/** Marcador de dedupe do alerta no chat (por projeto + estado + janela). */
export function setupGateAlertMarker(projectId: number, state: SetupGateSubReason, windowBucket: number): string {
  return `[motor-v3:setup-gate-alert:${projectId}:${state}:${windowBucket}]`
}

/** Marcador de dedupe do aviso de re-disparo no chat (por projeto + tentativa). */
export function setupRedispatchMarker(projectId: number, attempt: number): string {
  return `[motor-v3:setup-redispatch:${projectId}:${attempt}]`
}

/** Texto legível do alerta de setup retido (chat da tarefa + log do Monitor).
 * O `marker` recebido é embutido no final do texto — é o mesmo marcador usado
 * na dedupe do INSERT (insertDeduplicatedChatMessage procura por LIKE %marker%). */
export function buildSetupGateAlertText(input: {
  taskExternalId: string
  slug: string | null
  projectId: number
  state: SetupGateSubReason
  error: string | null
  waitSince: Date | string | null
  redispatched: boolean
  redispatchCount: number
  maxAttempts: number
  marker: string
}): string {
  const desde = input.waitSince ? new Date(input.waitSince).toISOString() : 'desconhecido'
  const projeto = input.slug ?? `#${input.projectId}`
  const lines = [
    input.state === 'setup_failed'
      ? '🚨 **Setup do projeto FALHOU — fila de tarefas retida (ação necessária)**'
      : '🚨 **Projeto sem setup concluído e sem missão de setup ativa — fila retida**',
    '',
    `**Tarefa retida:** ${input.taskExternalId}`,
    `**Projeto:** ${projeto}`,
    `**Sub-motivo:** ${input.state}`,
    `**Em espera desde:** ${desde}`,
  ]
  if (input.error) lines.push(`**Erro do setup:** ${input.error}`)
  if (input.state === 'setup_failed') {
    lines.push('', '**Ação:** corrija a causa do erro e refaça o setup em Projetos → Iniciar desenvolvimento.')
  } else if (input.redispatched) {
    lines.push('', `**Auto-recuperação:** missão de setup re-disparada pelo motor (tentativa ${input.redispatchCount} de ${input.maxAttempts}).`)
  } else if (input.redispatchCount >= input.maxAttempts) {
    lines.push('', `**Auto-recuperação:** teto de re-disparos atingido (${input.redispatchCount}/${input.maxAttempts}) — intervenção humana necessária (Projetos → Iniciar desenvolvimento).`)
  } else {
    lines.push('', '**Auto-recuperação:** sem missão de setup registrada para re-disparo — intervenção humana necessária (Projetos → Iniciar desenvolvimento).')
  }
  lines.push('', input.marker)
  return lines.join('\n')
}

/**
 * Passagem de recuperação executada APÓS o commit do claim retido
 * (melhor esforço: falhas não derrubam o claim — o loop de 30s reintenta).
 *
 * Idempotência/concorrência (várias tarefas retidas do mesmo projeto chamam
 * em paralelo a cada ciclo):
 * - alerta: UPDATE condicional em `projetos_captados.setup_alert_last_at`
 *   (janela configurável) + INSERT de chat deduplicado por marcador;
 * - re-disparo: UPDATE condicional em `setup_status`/contador/backoff — só
 *   quem vencer a corrida (affectedRows=1) emite o `TASK_ENQUEUED` no outbox.
 */
export async function handleSetupGateRecovery(
  pool: Pool,
  input: SetupGateRecoveryInput,
): Promise<SetupGateRecoveryResult> {
  const config = input.config ?? {}
  const { facts, hold } = input
  const alertAfterMinutes = config.alertAfterMinutes ?? SETUP_GATE_RECOVERY_DEFAULTS.alertAfterMinutes
  const alertWindowMinutes = config.alertWindowMinutes ?? SETUP_GATE_RECOVERY_DEFAULTS.alertWindowMinutes
  const redispatchBackoffMinutes = config.redispatchBackoffMinutes ?? SETUP_GATE_RECOVERY_DEFAULTS.redispatchBackoffMinutes
  const redispatchMaxAttempts = config.redispatchMaxAttempts ?? SETUP_GATE_RECOVERY_DEFAULTS.redispatchMaxAttempts
  const now = config.now ?? (() => new Date())
  const result: SetupGateRecoveryResult = { alerted: false, redispatched: false, redispatchSkippedReason: null }

  if (hold.state === 'setup_em_andamento') {
    // Caso transitório normal: sem alerta, sem re-disparo (nunca interferir
    // em setup/geração ativos).
    result.redispatchSkippedReason = 'sub_reason_in_progress'
    return result
  }

  // ── C. Re-disparo idempotente da missão de setup (B.4 do brief) ──────────
  const setupExternalId = facts.slug ? `${SETUP_TASK_PREFIX}${facts.slug}` : null
  let redispatchAttempt = facts.redispatchCount
  if (!setupExternalId) {
    result.redispatchSkippedReason = 'setup_task_missing'
  } else if (facts.setupStatus === 'queued' || facts.setupStatus === 'running' || facts.setupStatus === 'pending') {
    // Rede de segurança: o sub-motivo problemático exige setup inativo, mas a
    // decisão final é do UPDATE condicional (estado pode ter mudado).
    result.redispatchSkippedReason = 'setup_active'
  } else if (facts.redispatchCount >= redispatchMaxAttempts) {
    result.redispatchSkippedReason = 'attempts_exhausted'
  } else if (facts.redispatchLastAt != null && now().getTime() - new Date(facts.redispatchLastAt).getTime() < redispatchBackoffMinutes * 60_000) {
    result.redispatchSkippedReason = 'backoff'
  } else {
    const [taskRows] = await pool.query<Array<RowDataPacket & { id: number }>>(
      'SELECT id FROM tarefas WHERE external_id = ? LIMIT 1',
      [setupExternalId],
    )
    if (!taskRows[0]) {
      // Sem missão de setup registrada não há o que re-disparar (criar setup
      // exige briefing/plano aprovado — competência da plataforma, não do gate).
      result.redispatchSkippedReason = 'setup_task_missing'
    } else {
      const [updateResult] = await pool.query<ResultSetHeader>(
        `UPDATE projetos_captados
            SET setup_status = 'queued', setup_error = NULL,
                setup_attempts = setup_attempts + 1, setup_last_attempt_at = NOW(),
                setup_redispatch_count = setup_redispatch_count + 1,
                setup_redispatch_last_at = NOW(), updated_at = NOW()
          WHERE id = ?
            AND setup_status NOT IN ('queued','running','pending','verified')
            AND setup_redispatch_count < ?
            AND (setup_redispatch_last_at IS NULL OR setup_redispatch_last_at <= NOW() - INTERVAL ? MINUTE)`,
        [facts.projectId, redispatchMaxAttempts, redispatchBackoffMinutes],
      )
      if (Number(updateResult?.affectedRows ?? 0) === 1) {
        redispatchAttempt = facts.redispatchCount + 1
        // Fila canônica: TASK_ENQUEUED durável no outbox — o
        // TaskEnqueuedConsumer converte para TASK_RESUME_REQUESTED com todas
        // as guardas do TaskCoordinator (idempotente: resume pendente é pulado).
        const message = createQueueMessage({
          type: 'TASK_ENQUEUED',
          taskId: setupExternalId,
          executionId: `setup-redispatch-${facts.projectId}-${Date.now()}`,
          payload: {
            reason: 'setup_gate_auto_redispatch',
            projectId: facts.projectId,
            projectSlug: facts.slug,
            subReason: hold.state,
            attempt: redispatchAttempt,
            maxAttempts: redispatchMaxAttempts,
            heldTaskExternalId: input.taskExternalId,
          },
        })
        await insertOutboxMessage(pool, message, 'motor.commands')
        result.redispatched = true
        console.warn(
          `[Motor v3] SetupGateRecovery: missão de setup re-disparada (projeto=${facts.slug ?? facts.projectId} sub-motivo=${hold.state} tentativa=${redispatchAttempt}/${redispatchMaxAttempts}) — outbox TASK_ENQUEUED ${message.messageId}`,
        )
        await insertDeduplicatedChatMessage(
          pool,
          input.databaseTaskId,
          setupRedispatchMarker(facts.projectId, redispatchAttempt),
          [
            '🔁 **Setup do projeto re-disparado automaticamente pelo motor**',
            '',
            `**Tarefa retida:** ${input.taskExternalId}`,
            `**Projeto:** ${facts.slug ?? `#${facts.projectId}`}`,
            `**Sub-motivo:** ${hold.state}`,
            `**Missão de setup:** ${setupExternalId} (tentativa ${redispatchAttempt} de ${redispatchMaxAttempts})`,
            '',
            `As tarefas do projeto seguem retidas em espera de capacidade até o setup ser verificado (backoff entre tentativas: ${redispatchBackoffMinutes} min).`,
            '',
            setupRedispatchMarker(facts.projectId, redispatchAttempt),
          ].join('\n'),
        ).catch(error => {
          console.warn('[Motor v3] SetupGateRecovery: falha ao gravar aviso de re-disparo no chat:', error instanceof Error ? error.message : error)
          return null
        })
      } else {
        // Perdeu a corrida (outro ciclo já re-disparou) ou estado mudou.
        result.redispatchSkippedReason = 'backoff'
      }
    }
  }

  // ── B. Alerta único por janela quando a espera persiste (A.3 do brief) ───
  const [sinceRows] = await pool.query<Array<RowDataPacket & { capacity_wait_since: Date | string | null }>>(
    'SELECT capacity_wait_since FROM task_runtime_facts WHERE tarefa_id = ? LIMIT 1',
    [input.databaseTaskId],
  )
  const waitSince = sinceRows[0]?.capacity_wait_since ?? null
  const waitingLong = waitSince != null && now().getTime() - new Date(waitSince).getTime() >= alertAfterMinutes * 60_000
  if (waitingLong) {
    const windowMinutes = Math.max(1, alertWindowMinutes)
    const [alertResult] = await pool.query<ResultSetHeader>(
      `UPDATE projetos_captados
          SET setup_alert_last_at = NOW()
        WHERE id = ?
          AND (setup_alert_last_at IS NULL OR setup_alert_last_at <= NOW() - INTERVAL ? MINUTE)`,
      [facts.projectId, windowMinutes],
    )
    if (Number(alertResult?.affectedRows ?? 0) === 1) {
      const marker = setupGateAlertMarker(facts.projectId, hold.state, Math.floor(now().getTime() / (windowMinutes * 60_000)))
      const texto = buildSetupGateAlertText({
        taskExternalId: input.taskExternalId,
        slug: facts.slug,
        projectId: facts.projectId,
        state: hold.state,
        error: hold.error,
        waitSince,
        redispatched: result.redispatched,
        redispatchCount: redispatchAttempt,
        maxAttempts: redispatchMaxAttempts,
        marker,
      })
      const created = await insertDeduplicatedChatMessage(pool, input.databaseTaskId, marker, texto).catch(error => {
        console.warn('[Motor v3] SetupGateRecovery: falha ao gravar alerta no chat:', error instanceof Error ? error.message : error)
        return null
      })
      result.alerted = created != null
      console.warn(
        `[Motor v3] SetupGateRecovery: ALERTA setup retido (projeto=${facts.slug ?? facts.projectId} sub-motivo=${hold.state} desde=${waitSince ? new Date(waitSince).toISOString() : 'n/d'} alerta=${created ? 'emitido' : 'deduplicado'})`,
      )
    }
  }

  return result
}
