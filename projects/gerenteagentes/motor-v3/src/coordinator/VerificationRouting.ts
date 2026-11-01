import { createHash } from 'node:crypto'
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { VerificationRouting } from '../analysis/AnalystReply.js'
import { insertDeduplicatedChatMessage, type ChatAlertConnection } from '../execution/blockerChatAlert.js'
import { createQueueMessage, insertOutboxMessage } from '../queue/index.js'

/**
 * Veredito cross-project do analista (task-p2-1047, caso real task-p6-1029).
 *
 * Quando a análise conclui com veredito `verification` recomendando criar a
 * tarefa em OUTRO projeto (`outcome.routing`, contrato v13), o Motor:
 *
 * 1. publica o veredito no chat da tarefa de origem (`tarefa_chats`) como
 *    mensagem legível (markdown) — não mais JSON bruto enterrado — com
 *    INSERT idempotente por marcador (padrão `blockerChatAlert.ts`);
 * 2. cria a tarefa no projeto de destino na MESMA transação, em estado
 *    PAUSADO (`paused_at=NOW()`, padrão `PostDeployVerifier`), com descrição
 *    contendo diagnóstico + evidências copiados da origem, vínculo de origem
 *    registrado em `tarefa_eventos` nas DUAS tarefas e `external_id`
 *    determinístico para idempotência (redelivery não duplica);
 * 3. notifica o usuário pelos canais da plataforma: a mensagem de chat e os
 *    eventos (`origem='motor'`) alimentam o operational-feed
 *    (`api/operational-feed.ts`), a mensagem `TASK_CREATED` no outbox aparece
 *    como `pending_action`, e o realtime usa `appendChatMessage`/`append`
 *    já existentes no repositório.
 *
 * Degradação: slug de destino inexistente/inativo NÃO cria tarefa e NÃO falha
 * a análise — o resultado `invalid_target` vira alerta explícito no chat da
 * origem (o usuário precisa saber que o roteamento não aconteceu).
 *
 * Vínculo de origem: propositalmente NÃO usamos `depends_on_task_id`/
 * `tarefa_dependencias`. Dependências são um gate de execução
 * (`TaskCoordinator.checkDependenciesSatisfied`): dependência 'desenvolvimento'
 * exige deploy succeeded — a origem fechada por veredito (closed, sem deploy)
 * bloquearia a tarefa roteada para sempre; além disso o CRUD de tarefas exige
 * dependências no MESMO projeto. O vínculo equivalente em `tarefa_eventos`
 * nas duas tarefas atende ao requisito sem esses efeitos colaterais.
 */

/** Resultado do roteamento cross-project dentro da transação do persistAnalysis. */
export type VerificationRoutingResult =
  | {
      status: 'created' | 'existing'
      targetProjectId: number
      targetProjectSlug: string
      routedTaskId: number
      routedTaskExternalId: string
      routedTaskTitle: string
    }
  | { status: 'invalid_target'; targetProjectSlug: string; reason: string }

export interface VerificationRoutingInput {
  /** Id numérico da tarefa de origem em `tarefas`. */
  originDatabaseTaskId: number
  /** Id externo/legível da tarefa de origem (ex.: task-p6-1029). */
  originExternalId: string
  /** projeto_id da tarefa de origem (para o slug no vínculo/descrição). */
  originProjectId: number | null
  routing: VerificationRouting
  verdict: string
  summary: string
  evidence: string[]
}

/** Marcador de idempotência da mensagem de veredito no chat da tarefa. */
export function verificationChatMarker(externalTaskId: string): string {
  return `[motor-v3:verification:${externalTaskId}]`
}

/**
 * External_id determinístico da tarefa roteada: mesmo projeto de destino +
 * mesma origem produzem sempre o mesmo id → redelivery da análise não cria
 * segunda tarefa (UNIQUE `tarefas_external_id_unique` + WHERE NOT EXISTS).
 * Mantém o prefixo canônico `task-p<projetoId>-` e cabe em varchar(64).
 */
export function routedTaskExternalId(targetProjectId: number, originExternalId: string): string {
  const raw = `task-p${targetProjectId}-via-${originExternalId}`
  if (raw.length <= 64) return raw
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 8)
  return `${raw.slice(0, 55)}-${digest}`
}

function clip(value: string, max: number): string {
  const text = String(value ?? '').trim()
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text
}

function evidenceLines(evidence: readonly string[], max = 20): string[] {
  return evidence.slice(0, max).map(item => `- ${clip(item, 1_000)}`)
}

/** Título da tarefa roteada (limite da coluna: varchar(200)). */
export function buildRoutedTaskTitle(input: Pick<VerificationRoutingInput, 'routing' | 'summary' | 'verdict'>): string {
  const raw = input.routing.recommendedTitle?.trim() || input.summary.trim() || input.verdict.trim() || 'Tarefa roteada pelo analista'
  return clip(raw, 200)
}

/** Descrição da tarefa roteada: diagnóstico + evidências copiados da origem. */
export function buildRoutedTaskDescription(input: VerificationRoutingInput & { originProjectSlug: string | null }): string {
  const origin = `${input.originExternalId}${input.originProjectSlug ? ` (projeto ${input.originProjectSlug})` : ''}`
  const lines = [
    'Tarefa criada automaticamente pelo Motor a partir de veredito cross-project do analista',
    `(análise da tarefa de origem ${origin}).`,
    '',
    `**Veredito:** ${clip(input.verdict, 500)}`,
    `**Resumo da origem:** ${clip(input.summary, 2_000)}`,
  ]
  if (input.routing.diagnosis) lines.push(`**Diagnóstico do analista:** ${clip(input.routing.diagnosis, 2_000)}`)
  if (input.evidence.length > 0) lines.push('', '**Evidências (copiadas da origem):**', ...evidenceLines(input.evidence))
  lines.push(
    '',
    'Esta tarefa nasce PAUSADA e nunca executa sem ação humana: revise o diagnóstico,',
    'ajuste título/descrição se necessário e retome a tarefa no Mapa de agentes.',
    'Vínculo de origem registrado em tarefa_eventos (evento verification_routing_origin).',
  )
  return lines.join('\n')
}

/**
 * Mensagem legível do veredito no chat da origem (markdown), incluindo o
 * resultado do roteamento cross-project quando houver (criado, já existente
 * em redelivery, ou destino inválido → alerta de degradação).
 */
export function buildVerificationChatText(
  input: { taskId: string; verdict: string; summary: string; evidence: string[] },
  routing: VerificationRoutingResult | null,
): string {
  const lines = [
    '✅ **Análise concluída — veredito de verificação**',
    '',
    `**Tarefa:** ${input.taskId}`,
    `**Veredito:** ${clip(input.verdict, 500)}`,
    `**Resumo:** ${clip(input.summary, 2_000)}`,
  ]
  if (input.evidence.length > 0) {
    lines.push('', '**Evidências:**', ...evidenceLines(input.evidence))
  }
  if (routing) {
    lines.push('')
    if (routing.status === 'invalid_target') {
      lines.push(
        '⚠️ **Roteamento cross-project NÃO executado**',
        `O analista recomendou criar a tarefa no projeto "${routing.targetProjectSlug}", mas ${clip(routing.reason, 300)}.`,
        'Nenhuma tarefa foi criada. **Ação recomendada:** crie manualmente a tarefa no projeto correto com base no diagnóstico acima.',
      )
    } else {
      const verb = routing.status === 'created' ? 'criada' : 'já existe (redelivery — nada duplicado)'
      lines.push(
        '🔀 **Recomendação cross-project — tarefa proposta no projeto de destino**',
        'O analista concluiu que o trabalho pertence a outro projeto.',
        `**Projeto de destino:** ${routing.targetProjectSlug} (id ${routing.targetProjectId})`,
        `**Tarefa ${verb}:** ${routing.routedTaskExternalId} (id ${routing.routedTaskId}) — "${routing.routedTaskTitle}"`,
      )
      if (routing.status === 'created') {
        lines.push('**Estado:** PAUSADA — nunca executa sem ação humana. **Próximo passo:** revise a tarefa no Mapa de agentes do projeto de destino e retome-a para análise/execução.')
      }
    }
  }
  // O marcador de idempotência NÃO pode ser truncado (ancora a deduplicação
  // no redelivery): trunca o corpo e anexa o marcador ao final.
  const marker = verificationChatMarker(input.taskId)
  const body = lines.join('\n').slice(0, Math.max(1_000, 8_000 - marker.length - 2))
  return `${body}\n\n${marker}`
}

/**
 * Executa o roteamento cross-project na transação do `persistAnalysis`:
 * resolve o slug em `projetos_captados`, cria a tarefa de destino pausada com
 * external_id determinístico (idempotente), registra o vínculo em
 * `tarefa_eventos` nas duas tarefas e enfileira `TASK_CREATED` no outbox
 * (pending_action do operational-feed; message_id determinístico).
 *
 * Slug inexistente/inativo → `invalid_target` (sem tarefa, sem erro): o
 * chamador degrada para alerta no chat da origem.
 */
export async function applyVerificationRouting(
  connection: PoolConnection,
  input: VerificationRoutingInput,
): Promise<VerificationRoutingResult> {
  const targetSlug = input.routing.targetProjectSlug.trim()
  const [projectRows] = await connection.query<Array<RowDataPacket & { id: number; slug: string }>>(
    'SELECT id, slug FROM projetos_captados WHERE slug = ? AND ativo = 1 LIMIT 1',
    [targetSlug],
  )
  const project = Array.isArray(projectRows) ? projectRows[0] : undefined
  if (!project) {
    return {
      status: 'invalid_target',
      targetProjectSlug: targetSlug,
      reason: `o projeto de destino não foi encontrado em projetos_captados (ou está inativo)`,
    }
  }
  const targetProjectId = Number(project.id)
  const originProjectSlug = await resolveProjectSlug(connection, input.originProjectId)
  const externalId = routedTaskExternalId(targetProjectId, input.originExternalId)
  const title = buildRoutedTaskTitle(input)
  const description = buildRoutedTaskDescription({ ...input, originProjectSlug })

  // INSERT idempotente por external_id determinístico: redelivery da mesma
  // análise não cria segunda tarefa (UNIQUE tarefas_external_id_unique).
  const [insertResult] = await connection.query<ResultSetHeader>(
    `INSERT INTO tarefas
       (external_id, projeto_id, titulo, descricao, tipo, paused_at, auto_start, created_at, updated_at)
     SELECT ?, ?, ?, ?, 'desenvolvimento', NOW(), 0, NOW(), NOW()
       WHERE NOT EXISTS (SELECT 1 FROM tarefas existing WHERE existing.external_id = ?)`,
    [externalId, targetProjectId, title, description, externalId],
  )
  const affected = Number(insertResult?.affectedRows ?? 0)
  if (affected === 0) {
    const [existingRows] = await connection.query<Array<RowDataPacket & { id: number }>>(
      'SELECT id FROM tarefas WHERE external_id = ? LIMIT 1',
      [externalId],
    )
    const existing = Array.isArray(existingRows) ? existingRows[0] : undefined
    return {
      status: 'existing',
      targetProjectId,
      targetProjectSlug: String(project.slug ?? targetSlug),
      routedTaskId: Number(existing?.id ?? 0),
      routedTaskExternalId: externalId,
      routedTaskTitle: title,
    }
  }
  const routedTaskId = Number(insertResult.insertId ?? 0)

  // Vínculo de origem equivalente registrado nas DUAS tarefas (feed operacional
  // inclui tarefa_eventos com origem='motor'; evento varchar(40)).
  await connection.query(
    `INSERT INTO tarefa_eventos (tarefa_id, tarefa_external_id, evento, ator, origem, payload, created_at)
     VALUES (?, ?, 'verification_routing', 'motor-v3', 'motor', ?, NOW())`,
    [input.originDatabaseTaskId, input.originExternalId, JSON.stringify({
      routedTaskId,
      routedTaskExternalId: externalId,
      targetProjectId,
      targetProjectSlug: String(project.slug ?? targetSlug),
      verdict: clip(input.verdict, 500),
    })],
  )
  await connection.query(
    `INSERT INTO tarefa_eventos (tarefa_id, tarefa_external_id, evento, ator, origem, payload, created_at)
     VALUES (?, ?, 'verification_routing_origin', 'motor-v3', 'motor', ?, NOW())`,
    [routedTaskId, externalId, JSON.stringify({
      originTaskId: input.originDatabaseTaskId,
      originExternalId: input.originExternalId,
      originProjectSlug,
      verdict: clip(input.verdict, 500),
      diagnosis: input.routing.diagnosis ? clip(input.routing.diagnosis, 2_000) : null,
    })],
  )

  // Notificação pending_action no operational-feed (motor_outbox status
  // 'pending') — mesmo padrão da criação canônica de tarefas da API e do
  // PostDeployVerifier. message_id determinístico: redelivery não duplica
  // (ON DUPLICATE KEY do insertOutboxMessage).
  await insertOutboxMessage(connection, createQueueMessage({
    type: 'TASK_CREATED',
    taskId: externalId,
    executionId: `analysis-routing-${input.originExternalId}`,
    messageId: `task-created-${externalId}`,
    correlationId: `task-created-${externalId}`,
    causationId: undefined,
    payload: {
      taskId: externalId,
      taskDatabaseId: routedTaskId,
      managedProjectId: targetProjectId,
      status: 'planned',
      paused: true,
      origin: 'analyst_verification_cross_project',
      originTaskId: input.originExternalId,
      actor: 'motor-v3',
    },
  }))

  return {
    status: 'created',
    targetProjectId,
    targetProjectSlug: String(project.slug ?? targetSlug),
    routedTaskId,
    routedTaskExternalId: externalId,
    routedTaskTitle: title,
  }
}

/**
 * Publica o veredito de verificação no chat da origem com INSERT idempotente
 * por marcador (padrão `blockerChatAlert.ts`). Retorna a mensagem criada ou
 * `null` quando já existia (redelivery seguro — o chamador não reemite realtime).
 */
export async function insertVerificationChatMessage(
  connection: ChatAlertConnection,
  databaseTaskId: number,
  externalTaskId: string,
  outcome: { verdict: string; summary: string; evidence: string[] },
  routing: VerificationRoutingResult | null,
): Promise<{ id: number; texto: string } | null> {
  const texto = buildVerificationChatText({ taskId: externalTaskId, ...outcome }, routing)
  return insertDeduplicatedChatMessage(connection, databaseTaskId, verificationChatMarker(externalTaskId), texto)
}

async function resolveProjectSlug(connection: PoolConnection, projectId: number | null): Promise<string | null> {
  if (projectId == null) return null
  const [rows] = await connection.query<Array<RowDataPacket & { slug: string | null }>>(
    'SELECT slug FROM projetos_captados WHERE id = ? LIMIT 1',
    [projectId],
  )
  const row = Array.isArray(rows) ? rows[0] : undefined
  return row?.slug ? String(row.slug) : null
}
