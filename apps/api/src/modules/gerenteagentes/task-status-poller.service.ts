import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * TaskStatusPoller — consulta o endpoint /api/tasks/by-status do motor DEV
 * para detectar mudanças de status em tempo real.
 *
 * Usado pela biblioteca para refletir status de tarefas/subtarefas no front
 * sem precisar consultar o banco diretamente (o motor é a fonte da verdade).
 */
@Injectable()
export class TaskStatusPollerService {
  private readonly logger = new Logger(TaskStatusPollerService.name);
  private readonly motorUrl: string;
  private lastTimestamp: string | null = null;
  private cache: Record<string, any[]> = {};
  private pollInterval: NodeJS.Timeout | null = null;

  constructor(private readonly configService: ConfigService) {
    // URL do motor DEV (pode ser ajustada via env)
    this.motorUrl = this.configService.get<string>('MOTOR_DEV_URL') || 'http://127.0.0.1:6284';
    this.logger.log(`TaskStatusPoller inicializado → motor: ${this.motorUrl}`);
  }

  /**
   * Inicia o polling automático (chamado no onModuleInit do módulo).
   */
  startPolling(intervalMs = 5000) {
    if (this.pollInterval) {
      this.logger.warn('Polling já está ativo');
      return;
    }
    this.pollInterval = setInterval(() => this.poll(), intervalMs);
    this.logger.log(`Polling iniciado (intervalo: ${intervalMs}ms)`);
    // Primeira consulta imediata
    this.poll();
  }

  /**
   * Para o polling automático.
   */
  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      this.logger.log('Polling parado');
    }
  }

  /**
   * Consulta o motor e atualiza o cache.
   */
  async poll(): Promise<void> {
    try {
      const url = this.lastTimestamp
        ? `${this.motorUrl}/api/tasks/by-status?since=${encodeURIComponent(this.lastTimestamp)}`
        : `${this.motorUrl}/api/tasks/by-status`;

      const response = await fetch(url);
      if (!response.ok) {
        this.logger.error(`Polling falhou: ${response.status} ${response.statusText}`);
        return;
      }

      const data = await response.json() as {
        tasks: Record<string, any[]>;
        timestamp: string;
        count: number;
      };

      if (data.count > 0) {
        // Atualiza cache com tarefas modificadas
        for (const [status, tasks] of Object.entries(data.tasks)) {
          if (!this.cache[status]) {
            this.cache[status] = [];
          }
          // Substitui tarefas existentes ou adiciona novas
          for (const task of tasks) {
            const idx = this.cache[status].findIndex((t) => t.id === task.id);
            if (idx >= 0) {
              this.cache[status][idx] = task;
            } else {
              this.cache[status].push(task);
            }
          }
        }
        this.lastTimestamp = data.timestamp;
        this.logger.debug(`Polling: ${data.count} tarefa(s) atualizada(s)`);
      }
    } catch (error) {
      this.logger.error(`Erro no polling: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Retorna o cache atual de tarefas agrupadas por status.
   */
  getTasksByStatus(): Record<string, any[]> {
    return this.cache;
  }

  /**
   * Retorna apenas tarefas de um status específico.
   */
  getTasksByStatusFilter(status: string): any[] {
    return this.cache[status] || [];
  }

  /**
   * Retorna o timestamp da última atualização.
   */
  getLastTimestamp(): string | null {
    return this.lastTimestamp;
  }
}
