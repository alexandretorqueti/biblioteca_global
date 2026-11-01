import type { Pool, RowDataPacket } from 'mysql2/promise'

/**
 * Cadeia de modelos da Geração Macro (regra §1.6 da proposta: planejamento
 * NUNCA vai para modelo local — default pago).
 *
 * Resolução (documentada como decisão da subtarefa 4):
 * 1. `motor_configuracoes` chave `motor.geracao.modelos` — override explícito
 *    do operador (string CSV ou array JSON de modelos `provider/model`);
 * 2. `global_model_selection` tipo ANALYST habilitados (a mesma cadeia global
 *    paga que alimenta a análise, editável na tela da Biblioteca);
 * 3. fallback de código `DEFAULT_GENERATION_MODEL_CHAIN` (pago).
 *
 * Em qualquer etapa, modelos locais (ollama) são FILTRADOS. Se o filtro
 * esvaziar a cadeia configurada, o fallback pago de código é usado — a
 * geração macro nunca roda sem um modelo pago.
 */

/** Fallback de último recurso (pago); só usado se nenhuma configuração existir. */
export const DEFAULT_GENERATION_MODEL_CHAIN: readonly string[] = [
  'openai/gpt-5.6-sol',
  'alibaba/qwen3.8-max',
]

export const GENERATION_MODEL_CONFIG_KEY = 'motor.geracao.modelos'

/** Modelo local = servido por Ollama (vRAM do host; vetado para planejamento). */
export function isLocalModel(model: string): boolean {
  return /^ollama[/:]/i.test(model.trim()) || /\bollama\b/i.test(model)
}

function parseModelList(raw: unknown): string[] {
  if (raw == null) return []
  if (Array.isArray(raw)) return raw.map(item => String(item).trim()).filter(Boolean)
  const text = String(raw).trim()
  if (!text) return []
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (Array.isArray(parsed)) return parsed.map(item => String(item).trim()).filter(Boolean)
    } catch { /* cai no split por vírgula */ }
  }
  return text.split(',').map(item => item.trim()).filter(Boolean)
}

export async function resolveGenerationModelChain(pool: Pool): Promise<string[]> {
  const configured: string[] = []

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT valor FROM motor_configuracoes WHERE chave = ? LIMIT 1',
      [GENERATION_MODEL_CONFIG_KEY],
    )
    // valor é coluna json: pode vir como string CSV, array ou já parseado.
    configured.push(...parseModelList(rows[0]?.valor))
  } catch { /* sem configuração explícita — segue para o global */ }

  if (configured.length === 0) {
    try {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT model FROM global_model_selection
          WHERE tipo = 'ANALYST' AND enabled = 1
          ORDER BY ordem ASC`,
      )
      configured.push(...rows.map(row => String(row.model ?? '').trim()).filter(Boolean))
    } catch { /* sem seleção global — segue para o fallback */ }
  }

  const paid = configured.filter(model => !isLocalModel(model))
  if (paid.length > 0) return paid
  // Cadeia configurada inexistente ou 100% local: fallback pago de código.
  return [...DEFAULT_GENERATION_MODEL_CHAIN]
}
