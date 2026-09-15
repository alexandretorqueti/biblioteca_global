import { describe, expect, it } from 'vitest'
import {
  parseGlobalModelSelection,
  GlobalModelSelectionValidationError,
} from '../src/shared/global-model-selection.js'

const valid = {
  DEV: [{ ordem: 1, provider: 'openai', model: 'gpt-5', enabled: true }],
  ANALYST: [{ ordem: 1, provider: 'anthropic', model: 'claude', enabled: true }],
  MONITOR: [{ ordem: 1, provider: 'ollama', model: 'qwen', enabled: false }],
}

describe('contrato de seleção global de modelos', () => {
  it('aceita exatamente as três filas com ao menos um modelo', () => {
    expect(parseGlobalModelSelection(valid)).toEqual(valid)
  })

  it('rejeita fila vazia e campos extras antes da persistência', () => {
    expect(() => parseGlobalModelSelection({ ...valid, MONITOR: [] })).toThrow(GlobalModelSelectionValidationError)
    expect(() => parseGlobalModelSelection({ ...valid, extra: [] })).toThrow(GlobalModelSelectionValidationError)
  })
})
