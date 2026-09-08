/**
 * MotorConfigService - Serviço central de leitura de configurações persistidas
 *
 * Lê as configurações operacionais do motor da tabela `motor_configuracoes`
 * e fornece um ponto centralizado de acesso para todos os componentes do motor.
 *
 * Princípios:
 * - Fallback seguro: se a configuração não existir no banco, usa o valor padrão do catálogo
 * - Observabilidade: loga quando usa valor padrão vs valor persistido
 * - Cache em memória: lê do banco uma vez na inicialização e mantém em cache
 * - Recarregável: método reload() para recarregar do banco sem reiniciar o motor
 */

import type { Db } from './types/infrastructure.js'
import { createLogger, describeError } from './logger.js'

const logger = createLogger('MotorConfigService')

// ─── Tipos do catálogo de configurações ─────────────────────────────────────

export type MotorConfiguracaoTipo = "number" | "string" | "boolean"
export type MotorConfiguracaoValor = number | string | boolean

export type MotorConfiguracaoDefinicao = {
  chave: string
  tipo: MotorConfiguracaoTipo
  valorPadrao: MotorConfiguracaoValor
  regraValidacao: string
  descricao: string
  validar: (valor: unknown) => boolean
}

const inteiroPositivo = (valor: unknown, max: number): valor is number =>
  typeof valor === "number" && Number.isInteger(valor) && valor >= 1 && valor <= max

// ─── Catálogo de configurações do motor ─────────────────────────────────────

export const MOTOR_CONFIGURACOES: readonly MotorConfiguracaoDefinicao[] = [
  { chave: "motor.max_workers", tipo: "number", valorPadrao: 1, regraValidacao: "inteiro entre 1 e 100", descricao: "Número máximo global de tarefas de desenvolvimento em paralelo.", validar: (v) => inteiroPositivo(v, 100) },
  { chave: "motor.max_workers_per_project", tipo: "number", valorPadrao: 1, regraValidacao: "inteiro entre 1 e 100", descricao: "Número máximo de tarefas em paralelo por projeto.", validar: (v) => inteiroPositivo(v, 100) },
  { chave: "motor.pump_interval_ms", tipo: "number", valorPadrao: 30000, regraValidacao: "inteiro entre 1000 e 3600000", descricao: "Intervalo de consulta da fila de tarefas.", validar: (v) => inteiroPositivo(v, 3600000) && v >= 1000 },
  { chave: "motor.reconciler_interval_ms", tipo: "number", valorPadrao: 30000, regraValidacao: "inteiro entre 1000 e 3600000", descricao: "Intervalo de reconciliação de leases e execuções órfãs.", validar: (v) => inteiroPositivo(v, 3600000) && v >= 1000 },
  { chave: "motor.worker_timeout_ms", tipo: "number", valorPadrao: 14400000, regraValidacao: "inteiro entre 60000 e 86400000", descricao: "Tempo máximo de execução de um worker.", validar: (v) => inteiroPositivo(v, 86400000) && v >= 60000 },
  { chave: "motor.worker_silence_timeout_ms", tipo: "number", valorPadrao: 600000, regraValidacao: "inteiro entre 30000 e 86400000", descricao: "Tempo sem heartbeat antes de considerar o worker travado.", validar: (v) => inteiroPositivo(v, 86400000) && v >= 30000 },
  { chave: "motor.resource_lease_ms", tipo: "number", valorPadrao: 600000, regraValidacao: "inteiro entre 30000 e 86400000", descricao: "Duração do lease de um recurso exclusivo.", validar: (v) => inteiroPositivo(v, 86400000) && v >= 30000 },
  { chave: "motor.resource_heartbeat_interval_ms", tipo: "number", valorPadrao: 30000, regraValidacao: "inteiro entre 1000 e 86400000", descricao: "Intervalo de renovação dos leases de recursos.", validar: (v) => inteiroPositivo(v, 86400000) && v >= 1000 },
  { chave: "motor.console_run_absolute_timeout_ms", tipo: "number", valorPadrao: 14400000, regraValidacao: "inteiro entre 60000 e 86400000", descricao: "Tempo máximo absoluto de uma execução remota no Console.", validar: (v) => inteiroPositivo(v, 86400000) && v >= 60000 },
  { chave: "motor.console_run_idle_timeout_ms", tipo: "number", valorPadrao: 600000, regraValidacao: "inteiro entre 30000 e 86400000", descricao: "Tempo sem progresso permitido em uma execução remota.", validar: (v) => inteiroPositivo(v, 86400000) && v >= 30000 },
  { chave: "motor.console_poll_interval_ms", tipo: "number", valorPadrao: 5000, regraValidacao: "inteiro entre 1000 e 600000", descricao: "Intervalo de consulta do estado de uma execução remota.", validar: (v) => inteiroPositivo(v, 600000) && v >= 1000 },
  { chave: "motor.console_send_timeout_ms", tipo: "number", valorPadrao: 600000, regraValidacao: "inteiro entre 10000 e 3600000", descricao: "Tempo máximo para enviar uma mensagem ao Console.", validar: (v) => inteiroPositivo(v, 3600000) && v >= 10000 },
  { chave: "motor.dependency_install_timeout_ms", tipo: "number", valorPadrao: 900000, regraValidacao: "inteiro entre 10000 e 3600000", descricao: "Tempo máximo para instalar dependências.", validar: (v) => inteiroPositivo(v, 3600000) && v >= 10000 },
  { chave: "motor.worker_shutdown_timeout_ms", tipo: "number", valorPadrao: 10000, regraValidacao: "inteiro entre 1000 e 120000", descricao: "Tempo de encerramento gracioso de workers.", validar: (v) => inteiroPositivo(v, 120000) && v >= 1000 },
  { chave: "motor.resource_event_wait_timeout_ms", tipo: "number", valorPadrao: 30000, regraValidacao: "inteiro entre 1000 e 3600000", descricao: "Tempo máximo de espera por evento de recurso.", validar: (v) => inteiroPositivo(v, 3600000) && v >= 1000 },
  { chave: "motor.baseline_confirmation_timeout_ms", tipo: "number", valorPadrao: 300000, regraValidacao: "inteiro entre 10000 e 3600000", descricao: "Tempo máximo para confirmar o baseline.", validar: (v) => inteiroPositivo(v, 3600000) && v >= 10000 },
]

export function configuracaoPorChave(chave: string): MotorConfiguracaoDefinicao | undefined {
  return MOTOR_CONFIGURACOES.find((configuracao) => configuracao.chave === chave)
}

export interface MotorConfigServiceConfig {
  db: Db
}

export class MotorConfigService {
  private db: Db
  private cache: Map<string, MotorConfiguracaoValor> = new Map()
  private initialized = false

  constructor(config: MotorConfigServiceConfig) {
    this.db = config.db
  }

  /**
   * Inicializa o serviço carregando as configurações do banco.
   * Deve ser chamado uma vez na inicialização do motor.
   */
  async initialize(): Promise<void> {
    try {
      await this.loadFromDatabase()
      this.initialized = true
      logger.info('Serviço de configurações inicializado', { totalConfiguracoes: this.cache.size })
    } catch (error) {
      logger.error('Falha ao carregar configurações do banco, usando valores padrão', { error: describeError(error) })
      // Popula cache com valores padrão para fallback
      for (const definicao of MOTOR_CONFIGURACOES) {
        this.cache.set(definicao.chave, definicao.valorPadrao)
      }
      this.initialized = true
    }
  }

  /**
   * Recarrega as configurações do banco.
   * Útil quando as configurações são alteradas pela tela de configurações.
   */
  async reload(): Promise<void> {
    try {
      await this.loadFromDatabase()
      logger.info('Configurações recarregadas', { totalConfiguracoes: this.cache.size })
    } catch (error) {
      logger.error('Falha ao recarregar configurações, mantendo cache atual', { error: describeError(error) })
    }
  }

  /**
   * Obtém o valor de uma configuração pela chave.
   * Retorna o valor persistido no banco, ou o valor padrão se não existir.
   *
   * @param chave - Chave da configuração (ex.: "motor.max_workers")
   * @returns Valor da configuração (persistido ou padrão)
   */
  get(chave: string): MotorConfiguracaoValor | undefined {
    if (!this.initialized) {
      logger.warn('Serviço não inicializado, retornando valor padrão', { chave })
      const definicao = configuracaoPorChave(chave)
      return definicao?.valorPadrao
    }

    const valor = this.cache.get(chave)
    if (valor !== undefined) {
      return valor
    }

    // Configuração não encontrada no banco, usa valor padrão
    const definicao = configuracaoPorChave(chave)
    if (definicao) {
      logger.debug('Configuração não encontrada no banco, usando valor padrão', { chave, valorPadrao: definicao.valorPadrao })
      return definicao.valorPadrao
    }

    logger.warn('Chave de configuração desconhecida', { chave })
    return undefined
  }

  /**
   * Obtém o valor de uma configuração como número.
   * Conveniente para configurações numéricas.
   *
   * @param chave - Chave da configuração
   * @param fallback - Valor fallback se a configuração não existir ou não for número
   * @returns Valor numérico da configuração
   */
  getNumber(chave: string, fallback?: number): number {
    const valor = this.get(chave)
    if (typeof valor === 'number' && Number.isFinite(valor)) {
      return valor
    }
    if (fallback !== undefined) {
      return fallback
    }
    const definicao = configuracaoPorChave(chave)
    if (definicao && typeof definicao.valorPadrao === 'number') {
      return definicao.valorPadrao
    }
    return 0
  }

  /**
   * Obtém o valor de uma configuração como string.
   *
   * @param chave - Chave da configuração
   * @param fallback - Valor fallback se a configuração não existir ou não for string
   * @returns Valor string da configuração
   */
  getString(chave: string, fallback?: string): string {
    const valor = this.get(chave)
    if (typeof valor === 'string') {
      return valor
    }
    if (fallback !== undefined) {
      return fallback
    }
    const definicao = configuracaoPorChave(chave)
    if (definicao && typeof definicao.valorPadrao === 'string') {
      return definicao.valorPadrao
    }
    return ''
  }

  /**
   * Obtém o valor de uma configuração como boolean.
   *
   * @param chave - Chave da configuração
   * @param fallback - Valor fallback se a configuração não existir ou não for boolean
   * @returns Valor boolean da configuração
   */
  getBoolean(chave: string, fallback?: boolean): boolean {
    const valor = this.get(chave)
    if (typeof valor === 'boolean') {
      return valor
    }
    if (fallback !== undefined) {
      return fallback
    }
    const definicao = configuracaoPorChave(chave)
    if (definicao && typeof definicao.valorPadrao === 'boolean') {
      return definicao.valorPadrao
    }
    return false
  }

  /**
   * Retorna todas as configurações carregadas.
   * Útil para debug e para a API de configurações.
   */
  getAll(): Map<string, MotorConfiguracaoValor> {
    return new Map(this.cache)
  }

  /**
   * Carrega as configurações do banco e popula o cache.
   */
  private async loadFromDatabase(): Promise<void> {
    const result = await this.db.query(
      'SELECT chave, valor FROM motor_configuracoes'
    )

    const newCache = new Map<string, MotorConfiguracaoValor>()

    // Popula com valores do banco
    for (const row of result.rows) {
      const chave = row.chave as string
      const valorJson = row.valor
      // O valor vem como JSON (pode ser string JSON ou objeto já parseado)
      let valor: MotorConfiguracaoValor
      if (typeof valorJson === 'string') {
        try {
          valor = JSON.parse(valorJson) as MotorConfiguracaoValor
        } catch {
          valor = valorJson as MotorConfiguracaoValor
        }
      } else {
        valor = valorJson as MotorConfiguracaoValor
      }

      // Valida o valor contra a definição do catálogo
      const definicao = configuracaoPorChave(chave)
      if (definicao && definicao.validar(valor)) {
        newCache.set(chave, valor)
      } else if (definicao) {
        logger.warn('Valor inválido no banco, usando valor padrão', { chave, valorInvalido: valor, valorPadrao: definicao.valorPadrao })
        newCache.set(chave, definicao.valorPadrao)
      } else {
        logger.warn('Chave desconhecida no banco, ignorando', { chave })
      }
    }

    // Popula com valores padrão para configurações não encontradas no banco
    for (const definicao of MOTOR_CONFIGURACOES) {
      if (!newCache.has(definicao.chave)) {
        newCache.set(definicao.chave, definicao.valorPadrao)
      }
    }

    this.cache = newCache
  }
}

// ─── Singleton opcional para acesso global ──────────────────────────────────

let globalConfigService: MotorConfigService | null = null

export function setGlobalConfigService(service: MotorConfigService | null): void {
  globalConfigService = service
}

export function getGlobalConfigService(): MotorConfigService | null {
  return globalConfigService
}

/**
 * Helper para obter uma configuração numérica globalmente.
 * Retorna o valor padrão se o serviço não estiver inicializado.
 */
export function getConfigNumber(chave: string, fallback?: number): number {
  if (!globalConfigService) {
    const definicao = configuracaoPorChave(chave)
    if (definicao && typeof definicao.valorPadrao === 'number') {
      return definicao.valorPadrao
    }
    return fallback ?? 0
  }
  return globalConfigService.getNumber(chave, fallback)
}
