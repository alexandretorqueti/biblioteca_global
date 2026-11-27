// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  hasUnterminatedJsonObject,
  parseGenerationReply,
} from '../src/generation/GenerationPlanContract.js'

/**
 * Regressão do incidente da geração 8 (projeto Vitrine IA, 26/11/2026):
 * qwen3.8-max com maxTokens=8192 emitiu o JSON do plano mas foi cortada no
 * meio (stopReason="length") → extractJsonObjects não achava objeto fechado →
 * erro enganoso "resposta não contém JSON (recebidos 29472 caracteres)".
 * Agora truncamento é diagnosticado como tal.
 */

describe('hasUnterminatedJsonObject — detecção de resposta cortada', () => {
  it('detecta objeto aberto sem fechamento', () => {
    expect(hasUnterminatedJsonObject('{"kind":"plano","tarefas":[{"seq":1,"titulo":"x')).toBe(true)
  })

  it('não confunde prosa sem JSON', () => {
    expect(hasUnterminatedJsonObject('desculpe, não entendi o pedido')).toBe(false)
  })

  it('ignora chaves balanceadas (JSON completo)', () => {
    expect(hasUnterminatedJsonObject('{"kind":"plano","t":{"a":1}}')).toBe(false)
  })

  it('chaves dentro de strings não contam como abertura', () => {
    expect(hasUnterminatedJsonObject('{"texto":"use {x} aqui"}')).toBe(false)
  })

  it('escapa de aspas dentro de string não desbalanceia a varredura', () => {
    // {"a":"com \" aspas e { chave dentro"} → balanceado.
    expect(hasUnterminatedJsonObject('{"a":"com \\" aspas e { chave"}')).toBe(false)
  })

  it('string quebrada no meio por truncamento mantém o diagnóstico', () => {
    expect(hasUnterminatedJsonObject('{"a":"texto que foi cortado no mei')).toBe(true)
  })
})

describe('parseGenerationReply — erro de truncamento vs ausência de JSON', () => {
  it('JSON cortado → contract_violation fala em truncamento, não em ausência de JSON', () => {
    const cortado = '{"kind":"plano","classificacaoSistema":"misto","tarefas":[{"seq":1,"titulo":"Modelo de dados"'
    expect(() => parseGenerationReply(cortado)).toThrowError(
      /^contract_violation: resposta truncada pelo limite de tokens de saída/,
    )
  })

  it('prosa sem JSON mantém a mensagem original de ausência', () => {
    expect(() => parseGenerationReply('Claro! Aqui vai meu plano em texto corrido, sem contrato.')).toThrowError(
      /^contract_violation: resposta não contém JSON/,
    )
  })
})
