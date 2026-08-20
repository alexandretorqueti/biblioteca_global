import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** Task do motor (subconjunto usado pelo cache do poller). */
interface MotorTask {
  id: string;
  agentId?: string;
  title?: string;
  status?: string;
  projectSlug?: string | null;
}

/** Resposta de /api/tasks/by-status do motor. */
interface ByStatusResponse {
  tasks: Record<string, MotorTask[]>;
  timestamp: string;
  count: number;
}

/**
 * TaskStatusPoller — consulta o endpoint /api/tasks/by-status do motor
 * para detectar mudanças de status em tempo real.
 *
 * O motor roda no container `openclaw` (porta 6283) e é exposto via proxy
 * NPM em `api.tarefas.localhost`. A API da biblioteca roda com network_mode
 * host e alcança o proxy pelo IP do host (192.168.1.16), enviando o Host
 * header para o roteamento virtual do Nginx Proxy Manager.
 *
 * Configuração (env):
 *   MOTOR_DEV_URL   — base URL do motor (default: http://192.168.1.16, via proxy NPM)
 *   MOTOR_URL_HOST  — Host header p/ roteamento no proxy (default: api.tarefas.localhost)
 *                     Vazio/omitido quando MOTOR_DEV_URL já é a URL direta do motor.
 */
@Injectable()
export class TaskStatusPollerService {
  private readonly logger = new Logger(TaskStatusPollerService.name);
  private readonly motorUrl: string;
  private readonly motorHostHeader: string;
  private lastTimestamp: string | null = null;
  private cache: Record<string, MotorTask[]> = {};
  private pollInterval: NodeJS.Timeout | null = null;

  constructor(private readonly configService: ConfigService) {
    // URL do motor (via proxy NPM por padrão — a API alcança o host publicado)
    this.motorUrl =
      this.configService.get<string>('MOTOR_DEV_URL') || 'http://192.168.1.16';
    this.motorHostHeader =
      this.configService.get<string>('MOTOR_URL_HOST') || 'api.tarefas.localhost';
    this.logger.log(
      `TaskStatusPoller inicializado → motor: ${this.motorUrl} (Host: ${this.motorHostHeader || '—'})`,
    );
  }

  /**
   * Inicia o polling automático (chamado no onModuleInit do módulo).
   */
  startPolling(intervalMs = 5000) {
    if (this.pollInterval) {
      this.logger.warn('Polling já está ativo');
      return;
    }
    this.pollInterval = setInterval(() => void this.poll(), intervalMs);
    this.logger.log(`Polling iniciado (intervalo: ${intervalMs}ms)`);
    // Primeira consulta imediata
    void this.poll();
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
   * GET na API do motor respeitando o Host header do proxy (quando configurado).
   */
  private motorGet(path: string): Promise<{ ok: boolean; status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.motorUrl}${path}`);
      const isHttps = url.protocol === 'https:';
      const options: RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(this.motorHostHeader ? { Host: this.motorHostHeader } : {}),
        },
        timeout: 5000,
      };
      const req = (isHttps ? httpsRequest : httpRequest)(options, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () =>
          resolve({ ok: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode ?? 0, body }),
        );
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Consulta o motor e atualiza o cache.
   */
  async poll(): Promise<void> {
    try {
      const path = this.lastTimestamp
        ? `/api/tasks/by-status?since=${encodeURIComponent(this.lastTimestamp)}`
        : '/api/tasks/by-status';

      const response = await this.motorGet(path);
      if (!response.ok) {
        this.logger.error(`Polling falhou: ${response.status} ${response.body.slice(0, 120)}`);
        return;
      }

      const data = JSON.parse(response.body) as ByStatusResponse;

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
  getTasksByStatus(): Record<string, MotorTask[]> {
    return this.cache;
  }

  /**
   * Retorna apenas tarefas de um status específico.
   */
  getTasksByStatusFilter(status: string): MotorTask[] {
    return this.cache[status] || [];
  }

  /**
   * Retorna o timestamp da última atualização.
   */
  getLastTimestamp(): string | null {
    return this.lastTimestamp;
  }
}
