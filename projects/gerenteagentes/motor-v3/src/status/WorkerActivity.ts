import type { Pool, RowDataPacket } from 'mysql2/promise'

export type WorkerRole = 'analyst' | 'developer' | 'manager'

/** Atividade de um dos três papéis exibidos no Mapa de agentes. */
export interface WorkerActivity {
  role: WorkerRole
  active: boolean
  /** null é deliberado: não há modelo conhecido, não inventamos um fallback. */
  model: string | null
  executionId: string | null
  taskId: string | null
  subtaskId: number | null
  phase: string | null
  startedAt: number | null
  lastHeartbeat: number | null
}

export interface MotorActivityDescription {
  kind: 'testing' | 'worktree' | 'deploying' | 'executing'
  message: string
  taskIds: string[]
}

export interface WorkerActivityResponse {
  motor: {
    /** Estado configurado do motor (compatível com o gate existente). */
    isActive: boolean
    /** Indica se existe ao menos uma execução vigente neste instante. */
    isRunning: boolean
    activeExecutionsCount: number
    activity: MotorActivityDescription | null
  }
  /** Sempre contém analyst, developer e manager, inclusive quando inativos. */
  workers: WorkerActivity[]
}

interface ExecutionLike {
  taskId: string
  subtaskId?: number
  executionId: string
  startedAt: number
  lastHeartbeat: number
  context?: {
    agentId?: string
    model?: string
    phase?: string
    metadata?: Record<string, unknown>
  }
}

interface PersistedExecution extends RowDataPacket {
  execution_id: string
  task_id: string
  subtask_id: number | null
  phase: string
  model: string | null
  agent_id: string | null
  started_at: Date | string
  heartbeat_at: Date | string
}

const ROLES: WorkerRole[] = ['analyst', 'developer', 'manager']

function epoch(value: Date | string | number | null | undefined): number | null {
  if (value == null) return null
  const result = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(result) ? result : null
}

function emptyWorker(role: WorkerRole): WorkerActivity {
  return { role, active: false, model: null, executionId: null, taskId: null, subtaskId: null, phase: null, startedAt: null, lastHeartbeat: null }
}

export class WorkerActivityService {
  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly schedulerActiveExecutions: () => ExecutionLike[],
    private readonly motorActivityGate?: { isActive: () => Promise<boolean> },
  ) {}

  async getActivity(): Promise<WorkerActivityResponse> {
    const isActive = await this.readMotorState()
    const schedulerExecutions = this.schedulerActiveExecutions()
    const persistedExecutions = await this.readPersistedExecutions()
    const allExecutions = [...schedulerExecutions.map(execution => this.fromScheduler(execution)), ...persistedExecutions.map(execution => this.fromPersisted(execution))]
    const executions = [...new Map(allExecutions.map(execution => [execution.executionId, execution])).values()]

    const workers = new Map<WorkerRole, WorkerActivity>(ROLES.map(role => [role, emptyWorker(role)]))
    for (const execution of executions) {
      const previous = workers.get(execution.role)
      // A role has one visual worker; show its most recently started execution.
      if (!previous?.active || (execution.startedAt ?? 0) > (previous.startedAt ?? 0)) workers.set(execution.role, execution)
    }
    const activeWorkers = [...workers.values()].filter(worker => worker.active)
    const activity = this.describeActivity(activeWorkers)

    return {
      motor: { isActive, isRunning: executions.length > 0, activeExecutionsCount: executions.length, activity },
      workers: ROLES.map(role => workers.get(role)!),
    }
  }

  private async readMotorState(): Promise<boolean> {
    try { return await this.motorActivityGate?.isActive() ?? true } catch { return true }
  }

  private async readPersistedExecutions(): Promise<PersistedExecution[]> {
    try {
      const [rows] = await this.pool.query<PersistedExecution[]>(`
        SELECT e.execution_id, CAST(COALESCE(t.external_id, t.id) AS CHAR) AS task_id,
               e.subtarefa_id, e.phase, COALESCE(ats.model, mas.model) AS model,
               COALESCE(ats.agent_id, mas.agent_id) AS agent_id,
               e.started_at, e.heartbeat_at
          FROM motor_active_executions e
          INNER JOIN tarefas t ON t.id = e.tarefa_id
          LEFT JOIN analyst_task_sessions ats
            ON ats.analysis_execution_id = e.execution_id AND ats.status = 'active'
          LEFT JOIN motor_agent_sessions mas
            ON mas.subtarefa_id = e.subtarefa_id AND mas.status = 'active'
         WHERE e.expires_at > NOW()
         ORDER BY e.started_at DESC`)
      return rows ?? []
    } catch {
      // O endpoint continua disponível durante uma migração/indisponibilidade do banco.
      return []
    }
  }

  private fromScheduler(execution: ExecutionLike): WorkerActivity {
    const context = execution.context ?? {}
    return this.makeWorker(this.roleFor(context.agentId, context.phase, execution.executionId), execution.executionId, execution.taskId, execution.subtaskId ?? null, context.phase ?? null, context.model ?? null, execution.startedAt, execution.lastHeartbeat)
  }

  private fromPersisted(execution: PersistedExecution): WorkerActivity {
    return this.makeWorker(this.roleFor(execution.agent_id ?? undefined, execution.phase, execution.execution_id), execution.execution_id, execution.task_id, execution.subtask_id, execution.phase, execution.model, epoch(execution.started_at), epoch(execution.heartbeat_at))
  }

  private makeWorker(role: WorkerRole, executionId: string, taskId: string, subtaskId: number | null, phase: string | null, model: string | null, startedAt: number | null, lastHeartbeat: number | null): WorkerActivity {
    return { role, active: true, model: model?.trim() || null, executionId, taskId, subtaskId, phase, startedAt, lastHeartbeat }
  }

  private roleFor(agentId?: string, phase?: string, executionId?: string): WorkerRole {
    const value = `${agentId ?? ''} ${phase ?? ''} ${executionId ?? ''}`.toLowerCase()
    if (value.includes('monitor') || value.includes('deploy') || value.includes('test') || value.includes('pre_deploy')) return 'manager'
    if (value.includes('analys') || value.includes('analyst')) return 'analyst'
    return 'developer'
  }

  private describeActivity(workers: WorkerActivity[]): MotorActivityDescription | null {
    if (!workers.length) return null
    const manager = workers.find(worker => worker.role === 'manager')
    const developer = workers.find(worker => worker.role === 'developer')
    const source = (manager ?? developer ?? workers[0])!
    const taskIds = [...new Set(workers.map(worker => worker.taskId).filter((taskId): taskId is string => Boolean(taskId)))]
    const phase = `${source.phase ?? ''}`.toLowerCase()
    if (phase.includes('test') || phase.includes('verify')) return { kind: 'testing', message: `testando tarefa ${source.taskId ?? ''}`.trim(), taskIds }
    if (phase.includes('worktree')) return { kind: 'worktree', message: `criando worktree da tarefa ${source.taskId ?? ''}`.trim(), taskIds }
    if (phase.includes('deploy')) return { kind: 'deploying', message: `fazendo deploy das tarefas ${taskIds.join(', ')}`, taskIds }
    return { kind: 'executing', message: `motor executando tarefa ${source.taskId ?? ''}`.trim(), taskIds }
  }
}
