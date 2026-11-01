import type { Pool, RowDataPacket } from 'mysql2/promise'

/**
 * Entradas montadas pelo ProjectGenerationWorker para o prompt de geração
 * macro (chave `geracao.plano_macro_projeto`, §5 da proposta). Os nomes
 * casam com os marcadores do template versionado no catálogo de prompts.
 */
export interface GenerationPromptInput {
  nome: string
  slug: string
  /** F1: a especificação de entrada ainda é projetos_captados.descricao. */
  especificacao: string
  descricao: string
  /** Conteúdo de docs/CATALOGO-CAPACIDADES-BIBLIOTECA.md (monorepo). */
  catalogoCrud: string
  docs: string
  chat: string
  feedback: string
}

export interface ResolvedGenerationPrompt {
  text: string
  contractText: string
}

export interface GenerationPromptResolver {
  resolve(input: GenerationPromptInput): Promise<ResolvedGenerationPrompt>
}

export const GENERATION_PROMPT_KEY = "geracao.plano_macro_projeto"

const MARKERS: Record<keyof GenerationPromptInput, string> = {
  nome: '**NOME**',
  slug: '**SLUG**',
  especificacao: '**ESPECIFICACAO**',
  descricao: '**DESCRICAO**',
  catalogoCrud: '**CATALOGO_CRUD**',
  docs: '**DOCS**',
  chat: '**CHAT**',
  feedback: '**FEEDBACK**',
}

/**
 * Resolve a versão ativa do prompt de geração macro no banco
 * (`prompts_agentes` → `prompts_versoes` → `prompts_contratos_versoes`),
 * mesmo padrão do ManagedAnalysisPromptResolver da análise. Fallback de
 * código não prevalece sobre versão ativa (docs/CONTEXTO-ANALISTA.md);
 * ausência de prompt ativo é erro de configuração (`prompt_configuration_missing`).
 *
 * Diferença deliberada em relação à análise: não materializa artefato de
 * contrato nem audita em prompts_execucoes — a geração macro não tem
 * tarefa_id (a auditoria da rodada vive na própria geracoes_projeto:
 * session_key, modelo, tasks, erro).
 */
export class ManagedGenerationPromptResolver implements GenerationPromptResolver {
  constructor(private readonly pool: Pool) {}

  async resolve(input: GenerationPromptInput): Promise<ResolvedGenerationPrompt> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT v.texto, cv.instrucoes
         FROM prompts_agentes p
         INNER JOIN prompts_versoes v ON v.id = p.versao_ativa_id
         LEFT JOIN prompts_contratos_versoes cv ON cv.id = v.contrato_versao_id
        WHERE p.chave = ? AND p.status = 'active' LIMIT 1`,
      [GENERATION_PROMPT_KEY],
    )
    const row = rows[0]
    if (!row?.texto) {
      throw new Error(`prompt_configuration_missing: prompt ativo não encontrado: ${GENERATION_PROMPT_KEY}`)
    }
    const contractText = String(row.instrucoes ?? '').trim()
    let text = render(String(row.texto), input)
    // O template canônico termina com o marcador **CONTRATOSAIDA**;
    // substitui pelo texto do contrato ativo (como na análise).
    text = text.split('**CONTRATOSAIDA**').join(contractText)
    if (contractText && !String(row.texto).includes('**CONTRATOSAIDA**')) {
      text = `${text}\n\nCONTRATO DE SAÍDA OBRIGATÓRIO:\n${contractText}`
    }
    return { text, contractText }
  }
}

function render(template: string, input: GenerationPromptInput): string {
  return (Object.entries(MARKERS) as Array<[keyof GenerationPromptInput, string]>)
    .reduce((text, [field, marker]) => text.split(marker).join(input[field]), template)
}
