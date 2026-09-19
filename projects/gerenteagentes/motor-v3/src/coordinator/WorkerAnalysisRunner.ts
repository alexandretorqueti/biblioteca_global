import type { PrimitiveContext } from '../primitives/types.js'
import { WorkerLauncher } from '../worker-launcher/WorkerLauncher.js'
import type { AnalysisRunner, TaskSnapshot } from './TaskCoordinator.js'

export type AnalysisContextFactory = (task: TaskSnapshot, executionId: string) => Promise<PrimitiveContext>
export type AnalysisPromptFactory = (task: TaskSnapshot) => string

/** Adapta o WorkerLauncher existente ao contrato do TaskCoordinator. */
export class WorkerAnalysisRunner implements AnalysisRunner {
  constructor(
    private readonly launcher: WorkerLauncher,
    private readonly contextFactory: AnalysisContextFactory,
    private readonly promptFactory: AnalysisPromptFactory = defaultAnalysisPrompt,
  ) {}

  async start(task: TaskSnapshot, executionId: string): Promise<void> {
    const context = await this.contextFactory(task, executionId)
    const result = await this.launcher.executeTask(context, this.promptFactory(task))
    if (!result.success) {
      throw new Error(result.error ?? `Análise falhou para a tarefa ${task.taskId}`)
    }
  }
}

function defaultAnalysisPrompt(task: TaskSnapshot): string {
  return [
    'Você é o analista técnico do Motor v3.',
    `Tarefa: ${task.title}`,
    `ID: ${task.taskId}`,
    `Repositório autorizado: ${task.repoPath}`,
    '',
    'Descrição:',
    task.description,
    '',
    'Analise a tarefa, identifique requisitos e proponha subtarefas executáveis.',
    'Responda ao contrato de análise configurado pelo motor e finalize com ::DONE::.',
  ].join('\n')
}
