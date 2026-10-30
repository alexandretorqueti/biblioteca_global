import { describe, expect, it } from 'vitest'
import { classifyMotorError, classifyMotorErrorDetail, isTransientMotorError } from '../src/queue/ErrorTaxonomy.js'

function errorWithCode(message: string, code: string): Error {
  const error = new Error(message)
  ;(error as Error & { code: string }).code = code
  return error
}

describe('ErrorTaxonomy — classifyMotorError', () => {
  it('classifica deadlock/lock-wait do MySQL como infra', () => {
    expect(classifyMotorError(errorWithCode('Deadlock found when trying to get lock', 'ER_LOCK_DEADLOCK'))).toBe('infra')
    expect(classifyMotorError(errorWithCode('Lock wait timeout exceeded', 'ER_LOCK_WAIT_TIMEOUT'))).toBe('infra')
  })

  it('classifica conexão perdida/recusada/timeout de rede como infra', () => {
    expect(classifyMotorError(errorWithCode('Lost connection', 'PROTOCOL_CONNECTION_LOST'))).toBe('infra')
    expect(classifyMotorError(errorWithCode('connect ECONNREFUSED 127.0.0.1:3306', 'ECONNREFUSED'))).toBe('infra')
    expect(classifyMotorError(errorWithCode('getaddrinfo EAI_AGAIN rabbitmq', 'EAI_AGAIN'))).toBe('infra')
    expect(classifyMotorError(new Error('read ETIMEDOUT'))).toBe('infra')
  })

  it('classifica ER_DUP_ENTRY em tabela de infra de mensagens como infra, mas não em tabela de negócio', () => {
    const outboxDup = errorWithCode("Duplicate entry 'x' for key 'motor_outbox_logical_key_unique'", 'ER_DUP_ENTRY')
    expect(classifyMotorError(outboxDup)).toBe('infra')
    const businessDup = errorWithCode("Duplicate entry '1' for key 'usuarios_email_unique'", 'ER_DUP_ENTRY')
    expect(classifyMotorError(businessDup)).toBe('work')
  })

  it('classifica erros do RabbitMQ/amqp como infra', () => {
    expect(classifyMotorError(new Error('Channel closed; process acknowledged'))).toBe('infra')
    expect(classifyMotorError(new Error('Operation interrupted: connection lost'))).toBe('infra')
  })

  it('classifica lock do motor como infra', () => {
    expect(classifyMotorError(new Error('Lock órfão detectado: .motor-v3-npm-install.lock'))).toBe('infra')
  })

  it('classifica capacidade/ambiente como capacity', () => {
    expect(classifyMotorError(new Error('HTTP 504: Gateway Timeout'))).toBe('capacity')
    expect(classifyMotorError(new Error('HTTP 429 Too Many Requests'))).toBe('capacity')
    expect(classifyMotorError(new Error('Service Unavailable'))).toBe('capacity')
    expect(classifyMotorError(new Error('model_unavailable: provider auth error'))).toBe('capacity')
    expect(classifyMotorError(new Error('Console ocupado; aguarde'))).toBe('capacity')
    const withStatus = new Error('upstream error') as Error & { statusCode: number }
    withStatus.statusCode = 503
    expect(classifyMotorError(withStatus)).toBe('capacity')
  })

  it('classifica erro de trabalho como work', () => {
    expect(classifyMotorError(new Error('Testes falharam: 3 assertions failed'))).toBe('work')
    expect(classifyMotorError(new Error('MigrationJournalIntegrityError: migrations órfãs'))).toBe('work')
    expect(classifyMotorError(new Error('max-attempts-exceeded'))).toBe('work')
    expect(classifyMotorError('string crua')).toBe('work')
    expect(classifyMotorError(null)).toBe('work')
  })

  it('percorre a cadeia de cause — infra embrulhado em erro genérico continua infra', () => {
    const wrapped = new Error('falha ao publicar verificação', {
      cause: new Error('insert cancelado', { cause: errorWithCode('Deadlock found', 'ER_LOCK_DEADLOCK') }),
    })
    expect(classifyMotorError(wrapped)).toBe('infra')
  })

  it('não percorre cause além do limite (5 níveis)', () => {
    let deep: Error = errorWithCode('Lost connection', 'PROTOCOL_CONNECTION_LOST')
    for (let i = 0; i < 6; i++) deep = new Error(`nível ${i}`, { cause: deep })
    expect(classifyMotorError(deep)).toBe('work')
  })

  it('expõe evidência da classificação para auditoria', () => {
    const detail = classifyMotorErrorDetail(errorWithCode('Deadlock found', 'ER_LOCK_DEADLOCK'))
    expect(detail.kind).toBe('infra')
    expect(detail.evidence).toContain('ER_LOCK_DEADLOCK')
    expect(classifyMotorErrorDetail(new Error('qualquer')).evidence).toBeUndefined()
  })

  it('isTransientMotorError: verdadeiro para infra/capacity, falso para work', () => {
    expect(isTransientMotorError(errorWithCode('Deadlock', 'ER_LOCK_DEADLOCK'))).toBe(true)
    expect(isTransientMotorError(new Error('HTTP 504: Gateway Timeout'))).toBe(true)
    expect(isTransientMotorError(new Error('teste falhou'))).toBe(false)
  })
})
