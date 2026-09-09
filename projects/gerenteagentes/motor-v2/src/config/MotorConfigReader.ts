/**
 * MotorConfigReader - Leitor centralizado de configurações persistidas
 * 
 * Responsável por:
 * - Ler configurações do banco de dados (tabela motor_configuracoes)
 * - Fornecer valores padrão quando a configuração não existe
 * - Cache em memória com invalidação periódica
 * - Tratamento seguro de falhas (retorna default em caso de erro)
 */

import type { Db } from '../shared/types/infrastructure.js'
import { MOTOR_CONFIGURACOES, configuracaoPorChave, type MotorConfiguracaoValor } from './motor-configuracoes.catalog.js'
import { createLogger, describeError } from '../shared/logger.js'

const logger = createLogger('MotorConfigReader')

export interface MotorConfigReaderOptions {
  db: Db
  /** Intervalo de refresh do cache em ms (padrão: 30s) */
  cacheRefreshIntervalMs?: number
}

interface CachedConfig {
  values: Map<string, MotorConfiguracaoValor>
  loadedAt: number
}

export class MotorConfigReader {
  private db: Db
  private cache: CachedConfig | null = null
  private cacheRefreshIntervalMs: number
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private refreshPromise: Promise<void> | null = null

  constructor(options: MotorConfigReaderOptions) {
    this.db = options.db
    this.cacheRefreshIntervalMs = options.cacheRefreshIntervalMs ?? 30000
  }

  /**
   * Inicia o refresh periódico do cache
   */
  start(): void {
    if (this.refreshTimer) return
    logger.info('Iniciando leitor de configurações (refresh a cada ' + this.cacheRefreshIntervalMs + 'ms)')
    // Carrega imediatamente
    void this.refreshCache()
    // Agenda refresh periódico
    this.refreshTimer = setInterval(() => {
      void this.refreshCache()
    }, this.cacheRefreshIntervalMs)
  }

  /**
   * Para o refresh periódico
   */
  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  /**
   * Obtém um valor de configuração com fallback para o padrão
   */
  getNumber(chave: string): number {
    const valor = this.getRaw(chave)
    if (typeof valor === 'number') return valor
    const definicao = configuracaoPorChave(chave)
    if (definicao && typeof definicao.valorPadrao === 'number') return definicao.valorPadrao
    logger.warn('Configuração numérica sem valor nem padrão: ' + chave)
    return 0
  }

  getString(chave: string): string {
    const valor = this.getRaw(chave)
    if (typeof valor === 'string') return valor
    const definicao = configuracaoPorChave(chave)
    if (definicao && typeof definicao.valorPadrao === 'string') return definicao.valorPadrao
    return ''
  }

  getBoolean(chave: string): boolean {
    const valor = this.getRaw(chave)
    if (typeof valor === 'boolean') return valor
    const definicao = configuracaoPorChave(chave)
    if (definicao && typeof definicao.valorPadrao === 'boolean') return definicao.valorPadrao
    return false
  }

  /**
   * Obtém o valor raw (number | string | boolean)
   */
  getRaw(chave: string): MotorConfiguracaoValor | undefined {
    if (!this.cache) {
      // Cache não carregado ainda — retorna o padrão
      const definicao = configuracaoPorChave(chave)
      return definicao?.valorPadrao
    }
    const valor = this.cache.values.get(chave)
    if (valor !== undefined) return valor
    // Não está no cache — retorna o padrão
    const definicao = configuracaoPorChave(chave)
    return definicao?.valorPadrao
  }

  /**
   * Força um refresh imediato do cache
   */
  async refreshNow(): Promise<void> {
    await this.refreshCache()
  }

  /**
   * Refresh do cache com proteção contra chamadas concorrentes
   */
  private async refreshCache(): Promise<void> {
    if (this.refreshPromise) {
      await this.refreshPromise
      return
    }
    this.refreshPromise = this.doRefreshCache()
    try {
      await this.refreshPromise
    } finally {
      this.refreshPromise = null
    }
  }

  private async doRefreshCache(): Promise<void> {
    try {
      const { rows } = await this.db.query(
        'SELECT chave, valor FROM motor_configuracoes'
      )
      const values = new Map<string, MotorConfiguracaoValor>()
      for (const row of rows) {
        const chave = String(row.chave)
        const valorRaw = row.valor
        // O valor vem como JSON (pode ser number, string, boolean)
        let valor: MotorConfiguracaoValor
        if (typeof valorRaw === 'number' || typeof valorRaw === 'string' || typeof valorRaw === 'boolean') {
          valor = valorRaw
        } else if (typeof valorRaw === 'object' && valorRaw !== null) {
          // JSON parseado — tenta extrair o valor
          valor = valorRaw as unknown as MotorConfiguracaoValor
        } else {
          continue
        }
        values.set(chave, valor)
      }
      this.cache = { values, loadedAt: Date.now() }
      logger.info('Cache de configurações atualizado (' + values.size + ' configurações)')
    } catch (error) {
      logger.error('Falha ao carregar configurações do banco: ' + describeError(error))
      // Mantém o cache anterior se existir; na primeira carga, usa os padrões
    }
  }
}

/**
 * Instância singleton do leitor de configurações
 * Deve ser inicializada com initConfigReader() antes de usar
 */
let configReaderInstance: MotorConfigReader | null = null

export function initConfigReader(options: MotorConfigReaderOptions): MotorConfigReader {
  if (configReaderInstance) {
    configReaderInstance.stop()
  }
  configReaderInstance = new MotorConfigReader(options)
  configReaderInstance.start()
  return configReaderInstance
}

export function getConfigReader(): MotorConfigReader {
  if (!configReaderInstance) {
    throw new Error('MotorConfigReader não inicializado — chame initConfigReader() primeiro')
  }
  return configReaderInstance
}

/**
 * Helper para obter um valor de configuração com fallback
 */
export function getConfigNumber(chave: string): number {
  try {
    return getConfigReader().getNumber(chave)
  } catch {
    // Reader não inicializado — retorna o padrão do catálogo
    const definicao = configuracaoPorChave(chave)
    if (definicao && typeof definicao.valorPadrao === 'number') return definicao.valorPadrao
    return 0
  }
}

export function getConfigString(chave: string): string {
  try {
    return getConfigReader().getString(chave)
  } catch {
    const definicao = configuracaoPorChave(chave)
    if (definicao && typeof definicao.valorPadrao === 'string') return definicao.valorPadrao
    return ''
  }
}

export function getConfigBoolean(chave: string): boolean {
  try {
    return getConfigReader().getBoolean(chave)
  } catch {
    const definicao = configuracaoPorChave(chave)
    if (definicao && typeof definicao.valorPadrao === 'boolean') return definicao.valorPadrao
    return false
  }
}
