import { Injectable, Logger, Optional } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { RealtimeService } from '../../../apps/api/src/modules/realtime/realtime.service';
import {
  bloqueios,
  realtimeEventOutbox,
  subtarefas,
  taskRuntimeFacts,
  tarefas,
} from '../schema';

export type CanonicalTaskStatus =
  | 'draft' | 'planned' | 'analyzing' | 'awaiting_clarification' | 'awaiting_interaction'
  | 'ready' | 'running' | 'paused' | 'completed' | 'closed' | 'deployed'
  | 'blocked' | 'motor_fix' | 'failed' | 'cancelled';

export interface RealtimeMutationResult {
  before: CanonicalTaskStatus;
  after: CanonicalTaskStatus;
  eventIds: string[];
}

type TaskRow = { id: number; externalId: string | null; projetoId: number; pausedAt: Date | null };

/** O WebSocket é roteado pelo tenant da Biblioteca, não pelo projeto gerenciado. */
const REALTIME_TENANT_PROJECT_ID = 640;

/**
 * Fronteira da API: mutação/fato e outbox são gravados pelo mesmo tx Drizzle.
 * A publicação é deliberadamente feita somente depois que transaction() retorna.
 */
@Injectable()
export class RealtimeMutationBoundaryService {
  private readonly logger = new Logger(RealtimeMutationBoundaryService.name);

  constructor(@Optional() private readonly realtime?: RealtimeService) {}

  async executar(
    db: any,
    taskId: number,
    mutate: (tx: any, tarefa: TaskRow) => Promise<void>,
    options: { type?: string; payload?: Record<string, unknown>; force?: boolean; previousStatus?: string } = {},
  ): Promise<RealtimeMutationResult> {
    const result = await db.transaction(async (tx: any) => {
      const [tarefa] = await tx.select().from(tarefas).where(eq(tarefas.id, taskId)).limit(1);
      if (!tarefa) throw new Error(`Tarefa ${taskId} não encontrada para mutação realtime`);
      const before = await this.status(tx, tarefa);
      await mutate(tx, tarefa);
      const [tarefaAtualizada] = await tx.select().from(tarefas).where(eq(tarefas.id, taskId)).limit(1);
      const after = await this.status(tx, tarefaAtualizada ?? tarefa);
      const eventIds: string[] = [];
      if (options.force || before !== after) {
        const previousStatus = options.previousStatus ?? before;
        const [ultimo] = await tx.select({
          previousStatus: realtimeEventOutbox.previousStatus,
          status: realtimeEventOutbox.status,
          type: realtimeEventOutbox.type,
          eventId: realtimeEventOutbox.eventId,
        }).from(realtimeEventOutbox)
          .where(eq(realtimeEventOutbox.taskId, taskId))
          .orderBy(desc(realtimeEventOutbox.perTaskSeq)).limit(1);
        if (options.force && ultimo?.type === (options.type ?? 'task.status.changed')
          && ultimo.previousStatus === previousStatus && ultimo.status === after) {
          return { before, after, eventIds };
        }
        const eventId = randomUUID();
        const [last] = await tx.select({ seq: realtimeEventOutbox.perTaskSeq })
          .from(realtimeEventOutbox)
          .where(eq(realtimeEventOutbox.taskId, taskId))
          .orderBy(desc(realtimeEventOutbox.perTaskSeq)).limit(1);
        await tx.insert(realtimeEventOutbox).values({
          eventId,
          taskId,
          sourceTaskId: tarefa.externalId,
          projectId: REALTIME_TENANT_PROJECT_ID,
          subtaskId: null,
          type: options.type ?? 'task.status.changed',
          previousStatus,
          status: after,
          payload: {
            previousStatus,
            status: after,
            managedProjectId: Number(tarefa.projetoId),
            ...(options.payload ?? {}),
          },
          perTaskSeq: Number(last?.seq ?? 0) + 1,
          deliveryStatus: 'pending',
          attempts: 0,
        });
        eventIds.push(eventId);
      }
      return { before, after, eventIds };
    });
    await this.despachar(db, taskId, result.eventIds);
    return result;
  }

  /** Reenvia um evento já persistido sem criar outro evento para o cliente. */
  async despachar(db: any, taskId: number, eventIds: string[]): Promise<void> {
    if (!this.realtime || eventIds.length === 0) return;
    try {
      const rows = await db.select().from(realtimeEventOutbox)
        .where(eq(realtimeEventOutbox.taskId, taskId));
      for (const row of rows.filter((item: any) => eventIds.includes(item.eventId))) {
        try {
          this.realtime.publicar({
            eventId: row.eventId,
            occurredAt: new Date(row.createdAt ?? Date.now()).toISOString(),
            source: 'gerenteagentes-api',
            projectId: Number(row.projectId),
            taskId: Number(row.taskId),
            ...(row.sourceTaskId ? { sourceTaskId: row.sourceTaskId } : {}),
            type: row.type,
            payload: row.payload ?? {},
          });
        } catch (error) {
          this.logger.error(`Falha ao publicar realtime da tarefa ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      this.logger.error(`Falha ao despachar realtime da tarefa ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async status(tx: any, tarefa: TaskRow): Promise<CanonicalTaskStatus> {
    const [facts] = await tx.select().from(taskRuntimeFacts)
      .where(eq(taskRuntimeFacts.tarefaId, tarefa.id)).limit(1);
    const subs = await tx.select({ status: subtarefas.status }).from(subtarefas)
      .where(eq(subtarefas.tarefaId, tarefa.id));
    const [blocker] = await tx.select({ id: bloqueios.id }).from(bloqueios)
      .where(and(eq(bloqueios.tarefaId, tarefa.id), isNull(bloqueios.resolvedAt))).limit(1);
    const statuses = subs.map((item: any) => String(item.status));
    const terminal = String(facts?.terminalStatus ?? '').toLowerCase();
    if (['cancelled', 'failed', 'motor_fix'].includes(terminal)) return terminal as CanonicalTaskStatus;
    if (tarefa.pausedAt) return statuses.length ? 'paused' : 'draft';
    if (facts?.analysisStartedAt && statuses.length === 0) return 'analyzing';
    if (facts?.clarificationPendingAt) return 'awaiting_clarification';
    if (blocker) return 'blocked';
    if (statuses.includes('failed')) return 'failed';
    if (statuses.includes('blocked')) return 'blocked';
    if (statuses.some((status: string) => ['running', 'delivered', 'verifying'].includes(status))) return 'running';
    if (statuses.length && statuses.every((status: string) => ['verified', 'superseded'].includes(status))) return 'completed';
    return statuses.length ? 'ready' : 'planned';
  }
}
