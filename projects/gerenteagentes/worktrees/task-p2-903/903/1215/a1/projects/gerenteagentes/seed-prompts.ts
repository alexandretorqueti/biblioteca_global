import { AGENT_PROMPT_CATALOG } from "./motor-v2/src/prompts/prompt-catalog"

/**
 * Carga inicial do catálogo persistido.
 *
 * O seed é deliberadamente exportado como dados puros para que o comando de
 * seed da Biblioteca possa executar um upsert na conexão correta do projeto.
 * A chave é estável e permite executar esta carga mais de uma vez.
 */
export const PROMPTS_AGENTES_SEED = AGENT_PROMPT_CATALOG.map((entry) => ({
  chave: entry.key,
  tipoAgente: entry.agentType,
  situacao: entry.situation,
  // O conteúdo é um contrato inicial editável; a substituição dos marcadores
  // pelo runtime será feita na etapa de consumo do catálogo.
  conteudo: `Prompt ${entry.key}: ${entry.markers.join(" ")}`,
  origem: entry.source,
  marcadores: [...entry.markers],
  ativo: true,
}))

export type PromptAgenteSeed = (typeof PROMPTS_AGENTES_SEED)[number]

export interface PromptSeedDatabase {
  execute(sql: string, params: unknown[]): Promise<unknown>
}

/** Executa a carga inicial sem depender de uma implementação específica de DB. */
export async function seedPromptsAgentes(db: PromptSeedDatabase): Promise<void> {
  for (const prompt of PROMPTS_AGENTES_SEED) {
    await db.execute(
      `INSERT INTO prompts_agentes
        (chave, tipo_agente, situacao, conteudo, origem, marcadores, ativo)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         tipo_agente = VALUES(tipo_agente),
         situacao = VALUES(situacao),
         conteudo = VALUES(conteudo),
         origem = VALUES(origem),
         marcadores = VALUES(marcadores),
         ativo = VALUES(ativo)`,
      [
        prompt.chave,
        prompt.tipoAgente,
        prompt.situacao,
        prompt.conteudo,
        prompt.origem,
        JSON.stringify(prompt.marcadores),
        prompt.ativo,
      ],
    )
  }
}
