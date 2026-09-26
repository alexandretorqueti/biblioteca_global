import { describe, expect, it, vi, beforeEach } from 'vitest'
import { MotorConfigReader, initConfigReader } from '../src/config/MotorConfigReader.js'
import { MOTOR_CONFIGURACOES } from '../src/config/motor-configuracoes.catalog.js'
import type { Db, QueryResult } from '../src/shared/types/infrastructure.js'

/**
 * Teste de integração ponta a ponta do fluxo de configurações:
 * 1. Tela → PUT /gerenteagentes/configuracoes → service valida → persiste no DB
 * 2. MotorConfigReader lê do DB com cache
 * 3. Motor/TaskCoordinator consomem via getConfigNumber
 * 
 * Este teste valida que uma alteração de configuração é refletida no motor
 * após o refresh do cache.
 */

describe('Fluxo de configurações ponta a ponta', () => {
  let db: Db
  let configReader: MotorConfigReader

  beforeEach(() => {
    // Mock do banco com dados iniciais
    db = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('SELECT chave, valor FROM motor_configuracoes')) {
          return Promise.resolve({
            rows: [
              { chave: 'motor.max_workers', valor: 1 },
              { chave: 'motor.max_workers_per_project', valor: 1 },
              { chave: 'motor.pump_interval_ms', valor: 30000 },
            ],
            affectedRows: 0,
            insertId: 0,
          } satisfies QueryResult)
        }
        return Promise.resolve({ rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult)
      }),
      transaction: vi.fn(),
    }

    configReader = initConfigReader({ db, cacheRefreshIntervalMs: 1000 })
  })

  it('carrega configurações do banco na inicialização', async () => {
    // Aguarda o primeiro refresh
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(configReader.getNumber('motor.max_workers')).toBe(1)
    expect(configReader.getNumber('motor.max_workers_per_project')).toBe(1)
    expect(configReader.getNumber('motor.pump_interval_ms')).toBe(30000)
  })

  it('reflete alteração de configuração após refresh do cache', async () => {
    // Estado inicial
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(configReader.getNumber('motor.max_workers')).toBe(1)

    // Simula alteração via tela (UPDATE no banco)
    vi.mocked(db.query).mockImplementation((sql: string) => {
      if (sql.includes('SELECT chave, valor FROM motor_configuracoes')) {
        return Promise.resolve({
          rows: [
            { chave: 'motor.max_workers', valor: 5 }, // Alterado de 1 para 5
            { chave: 'motor.max_workers_per_project', valor: 2 },
            { chave: 'motor.pump_interval_ms', valor: 30000 },
          ],
          affectedRows: 0,
          insertId: 0,
        } satisfies QueryResult)
      }
      return Promise.resolve({ rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult)
    })

    // Força refresh imediato
    await configReader.refreshNow()

    // Valida que o motor agora vê o novo valor
    expect(configReader.getNumber('motor.max_workers')).toBe(5)
    expect(configReader.getNumber('motor.max_workers_per_project')).toBe(2)
  })

  it('usa valor padrão quando configuração não existe no banco', async () => {
    // Simula banco vazio
    vi.mocked(db.query).mockResolvedValue({
      rows: [],
      affectedRows: 0,
      insertId: 0,
    } satisfies QueryResult)

    await configReader.refreshNow()

    // Deve retornar o padrão do catálogo
    const catalogEntry = MOTOR_CONFIGURACOES.find((c) => c.chave === 'motor.worker_timeout_ms')
    expect(catalogEntry).toBeDefined()
    expect(configReader.getNumber('motor.worker_timeout_ms')).toBe(catalogEntry!.valorPadrao as number)
  })

  it('valida que todos os parâmetros do catálogo têm defaults válidos', () => {
    for (const config of MOTOR_CONFIGURACOES) {
      expect(config.descricao).not.toBe('')
      expect(config.regraValidacao).not.toBe('')
      expect(config.validar(config.valorPadrao)).toBe(true)
    }
  })

  it('valida regras de validação do limite de tarefas paralelas', () => {
    const maxWorkers = MOTOR_CONFIGURACOES.find((c) => c.chave === 'motor.max_workers')
    expect(maxWorkers).toBeDefined()

    // Valores válidos
    expect(maxWorkers!.validar(1)).toBe(true)
    expect(maxWorkers!.validar(50)).toBe(true)
    expect(maxWorkers!.validar(100)).toBe(true)

    // Valores inválidos
    expect(maxWorkers!.validar(0)).toBe(false)
    expect(maxWorkers!.validar(101)).toBe(false)
    expect(maxWorkers!.validar(-1)).toBe(false)
    expect(maxWorkers!.validar(1.5)).toBe(false)
    expect(maxWorkers!.validar('5')).toBe(false)
  })

  it('simula fluxo completo: tela → persistência → consumo pelo motor', async () => {
    // Passo 1: Estado inicial (motor lendo do banco)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const valorInicial = configReader.getNumber('motor.max_workers')
    expect(valorInicial).toBe(1)

    // Passo 2: Usuário altera via tela (simula PUT /gerenteagentes/configuracoes)
    // O service valida e faz UPDATE no banco
    // Aqui simulamos o banco já atualizado
    vi.mocked(db.query).mockImplementation((sql: string) => {
      if (sql.includes('SELECT chave, valor FROM motor_configuracoes')) {
        return Promise.resolve({
          rows: [
            { chave: 'motor.max_workers', valor: 3 }, // Usuário alterou para 3
            { chave: 'motor.max_workers_per_project', valor: 1 },
            { chave: 'motor.pump_interval_ms', valor: 30000 },
          ],
          affectedRows: 0,
          insertId: 0,
        } satisfies QueryResult)
      }
      return Promise.resolve({ rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult)
    })

    // Passo 3: MotorConfigReader faz refresh (automático a cada 30s ou manual)
    await configReader.refreshNow()

    // Passo 4: Motor/TaskCoordinator consomem o novo valor
    const novoValor = configReader.getNumber('motor.max_workers')
    expect(novoValor).toBe(3)

    // Passo 5: Valida que o TaskCoordinator usaria esse valor
    // (Em produção, o Motor passa getConfigNumber('motor.max_workers') para o TaskCoordinator)
    expect(novoValor).toBeGreaterThan(valorInicial)
  })
})
